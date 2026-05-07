/**
 * Scheduler unit tests with the in-package `FakeClock`.
 *
 * Coverage cross-walks against
 * `openspec/changes/cron-scheduler-with-pause/specs/scheduler/spec.md`
 * (and, post-archive, `openspec/specs/scheduler/spec.md`):
 *
 *  (a) default cadence per role                            → "Engineer default cadence is 60 seconds"
 *  (b) per-agent override beats per-role override          → "Per-agent override wins over per-role override"
 *  (c) unparseable schedule warns and uses default          → "Unparseable schedule falls back to the role default"
 *  (d) paused agent ticks silently                          → "Paused tick is silent"
 *  (e) pause flip during in-flight cycle does not abort     → "Pausing during an in-flight cycle does not abort"
 *  (f) precheck=skip short-circuits                         → "A `skip` precheck does not call `startCycle`"
 *  (g) precheck=proceed invokes startCycle with runner      → "A `proceed` precheck invokes `startCycle` with the registered runner's fields"
 *  (h) coalesce on second tick when active != null          → "A second tick for the same agent coalesces while the first is in flight"
 *  (i) cross-agent parallelism                              → "Bob's tick runs while alice's cycle is in flight"
 *  (j) timeout fires abort + appends session_timeout        → "A 30-minute engineer cycle fires the timeout"
 *  (k) timeout cleared on early resolution                  → "A cycle that resolves before the timeout clears the timer"
 *  (l) interrupt aborts and appends session_interrupted     → "`interrupt` against a running cycle aborts and appends `session_interrupted`"
 *  (m) interrupt on idle returns no_active_cycle            → "`interrupt` against an idle agent reports `no_active_cycle`"
 *  (n) interrupt on unknown agent returns unknown_agent     → "`interrupt` against an unknown agent reports `unknown_agent`"
 *  (o) interrupt does not auto-revert ticket status         → covered indirectly: scheduler issues no TicketStore writes (source-scan test)
 *  (p) unregistered role warns and skips                    → "An unregistered role logs once and skips"
 *  (q) start() is idempotent                                → "start() is idempotent"
 *  (r) stop() is idempotent and resolves immediately        → "stop() is idempotent and resolves immediately on the second call"
 *  (s) timeout < idle threshold logs once                   → "A timeout shorter than the idle threshold logs a warning"
 *  (t) activity-post failure does not crash interrupt()     → "An activity-post failure does not crash the scheduler"
 *
 * `parseDurationShorthand`, `resolveCadenceMs`, and `resolveTimeoutMs`
 * scenarios live in `schedule_test.ts`; activity-client header / 5xx /
 * network-failure scenarios live in `activityClient_test.ts`; the
 * source-scan invariants live in `runnerSourceScan_test.ts`; and the
 * registry idempotence + insertion-order scenarios live in
 * `registry_test.ts`. End-to-end (`runServer` lifecycle, on-disk
 * activity log) coverage lives in `integration_test.ts`. Together the
 * five files back every scheduler-spec scenario.
 *
 * The fake activity-log endpoint is a tiny `Deno.serve` stub so the
 * scheduler's `POST /activity` reaches a real network listener and
 * the orchestration server's role-identity middleware contract is
 * exercised verbatim.
 */

import { assert, assertEquals } from "@std/assert";
import type {
  CodingAgentInvoker,
  CodingAgentLifecycle,
  CodingAgentOutcome,
  RoleCycleParams,
  RoleCycleResult,
} from "@keni/runtime-common";
import { createInMemoryAgentRuntimeStateStore } from "../../../src/agentState.ts";
import { createFakeClock, type FakeClockHandle } from "../../fakes/scheduler/fakeClock.ts";
import { captureSchedulerLogger, type SchedulerLogEntry } from "../../../src/scheduler/log.ts";
import { type AgentRunner, createAgentRunnerRegistry } from "../../../src/scheduler/registry.ts";
import { createScheduler } from "../../../src/scheduler/scheduler.ts";

interface ActivityRow {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: {
    readonly session_id: string;
    readonly agent: string;
    readonly role: string;
    readonly event: string;
    readonly summary: string | null;
    readonly refs?: Readonly<Record<string, string>>;
  };
}

interface ActivityStub {
  readonly url: string;
  readonly captured: ActivityRow[];
  stop: () => Promise<void>;
}

function startActivityStub(
  responder: (req: Request) => Response | Promise<Response> = () =>
    new Response("{}", { status: 201 }),
): ActivityStub {
  const captured: ActivityRow[] = [];
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => (headers[key] = value));
      let body: ActivityRow["body"];
      try {
        body = (await req.clone().json()) as ActivityRow["body"];
      } catch {
        body = {} as ActivityRow["body"];
      }
      captured.push({ headers, body });
      return await responder(req);
    },
  );
  return {
    url: `http://${server.addr.hostname}:${server.addr.port}`,
    captured,
    stop: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

function fakeRunner(
  role: AgentRunner["role"],
  override: Partial<AgentRunner> = {},
): AgentRunner {
  return {
    role,
    precheck: () => ({ kind: "skip", reason: "default-fake" }),
    promptResolver: () => ({ name: "placeholder", body: "PROMPT" }),
    codingAgentInvoker: {
      invoke: () => Promise.resolve({ kind: "completed", exitCode: 0 }),
    },
    mcpServerConfig: { command: "echo", args: [] },
    ...override,
  };
}

/**
 * Build a `CodingAgentInvoker` with externally-controlled outcome and
 * abort handling, modeled on the role-runtime fake.
 */
interface SlowInvokerHandle {
  readonly invoker: CodingAgentInvoker;
  readonly invocationCount: () => number;
  readonly lifecycle: () => CodingAgentLifecycle | null;
  readonly resolveCompleted: (exitCode: number) => void;
  readonly resolveTerminated: (terminatedBy: "sigterm" | "sigkill") => void;
}

function slowInvoker(
  options: {
    readonly autoTerminateOnAbort?: boolean;
  } = {},
): SlowInvokerHandle {
  let captured: CodingAgentLifecycle | null = null;
  let invocationCount = 0;
  let resolveOutcome: ((outcome: CodingAgentOutcome) => void) | null = null;
  const invoker: CodingAgentInvoker = {
    invoke: (_invocation, lifecycle) => {
      invocationCount++;
      captured = lifecycle;
      if (
        options.autoTerminateOnAbort !== false &&
        lifecycle.abortSignal !== undefined
      ) {
        const sig = lifecycle.abortSignal;
        const onAbort = () => {
          if (resolveOutcome !== null) {
            resolveOutcome({
              kind: "terminated",
              exitCode: 143,
              terminatedBy: "sigterm",
            });
            resolveOutcome = null;
          }
        };
        if (sig.aborted) onAbort();
        else sig.addEventListener("abort", onAbort, { once: true });
      }
      return new Promise<CodingAgentOutcome>((r) => (resolveOutcome = r));
    },
  };
  return {
    invoker,
    invocationCount: () => invocationCount,
    lifecycle: () => captured,
    resolveCompleted: (exitCode) => {
      if (resolveOutcome !== null) {
        resolveOutcome({ kind: "completed", exitCode });
        resolveOutcome = null;
      }
    },
    resolveTerminated: (terminatedBy) => {
      if (resolveOutcome !== null) {
        resolveOutcome({
          kind: "terminated",
          exitCode: terminatedBy === "sigterm" ? 143 : 137,
          terminatedBy,
        });
        resolveOutcome = null;
      }
    },
  };
}

interface Harness {
  readonly clock: FakeClockHandle;
  readonly logBuffer: SchedulerLogEntry[];
  readonly stub: ActivityStub;
  readonly stop: () => Promise<void>;
}

function makeHarness(opts?: {
  responder?: (req: Request) => Response | Promise<Response>;
}): Harness {
  const stub = opts?.responder !== undefined
    ? startActivityStub(opts.responder)
    : startActivityStub();
  const clock = createFakeClock();
  const logBuffer: SchedulerLogEntry[] = [];
  return {
    clock,
    logBuffer,
    stub,
    stop: async () => {
      await stub.stop();
    },
  };
}

// (a) Default cadence per role: engineer is 60 s, no schedules in config.
Deno.test("scheduler — engineer default cadence is 60s", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    let prechecks = 0;
    const runner = fakeRunner("engineer", {
      precheck: () => {
        prechecks++;
        return { kind: "skip", reason: "test" };
      },
    });
    registry.register(runner);
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(59_000);
    assertEquals(prechecks, 0);
    await h.clock.tick(1_000);
    assertEquals(prechecks, 1);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (b) Per-agent override beats per-role override.
Deno.test("scheduler — per-agent cadence beats per-role cadence", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    let prechecks = 0;
    registry.register(
      fakeRunner("engineer", {
        precheck: () => {
          prechecks++;
          return { kind: "skip", reason: "test" };
        },
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "10s", engineer: "30s" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(10_000);
    assertEquals(prechecks, 1);
    await h.clock.tick(10_000);
    assertEquals(prechecks, 2);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (c) Unparseable schedule warns and uses default.
Deno.test("scheduler — unparseable schedule warns and uses role default", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    let prechecks = 0;
    registry.register(
      fakeRunner("engineer", {
        precheck: () => {
          prechecks++;
          return { kind: "skip", reason: "test" };
        },
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "totally-bogus" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    const warnings = h.logBuffer.filter((b) =>
      b.event === "schedule.invalid" && b.fields.key === "alice"
    );
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0]!.fields.fallback, 60_000);
    scheduler.start();
    await h.clock.tick(60_000);
    assertEquals(prechecks, 1);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (d) Paused agent ticks silently.
Deno.test("scheduler — paused tick is silent", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    let prechecks = 0;
    registry.register(
      fakeRunner("engineer", {
        precheck: () => {
          prechecks++;
          return { kind: "proceed" };
        },
      }),
    );
    runtime.setPaused("alice", true);
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(500);
    assertEquals(prechecks, 0);
    assertEquals(h.stub.captured.length, 0);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (e) Pause flip during in-flight cycle does not abort.
Deno.test("scheduler — pause flip during in-flight cycle does not abort", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const inv = slowInvoker({ autoTerminateOnAbort: false });
    registry.register(
      fakeRunner("engineer", {
        precheck: () => ({ kind: "proceed" }),
        codingAgentInvoker: inv.invoker,
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        timeouts: { alice: "10m" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(100); // first tick fires
    assertEquals(inv.invocationCount(), 1);
    runtime.setPaused("alice", true);
    const sig = inv.lifecycle()?.abortSignal;
    assertEquals(sig?.aborted, false);
    inv.resolveCompleted(0);
    await h.clock.tick(100);
    assertEquals(sig?.aborted, false); // pause does not abort
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (f) precheck=skip short-circuits with no activity entries.
Deno.test("scheduler — precheck skip short-circuits, no startCycle and no activity", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    let invokerCalls = 0;
    registry.register(
      fakeRunner("engineer", {
        precheck: () => ({ kind: "skip", reason: "no_ticket_to_pick_up" }),
        codingAgentInvoker: {
          invoke: () => {
            invokerCalls++;
            return Promise.resolve({ kind: "completed", exitCode: 0 });
          },
        },
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(100);
    assertEquals(invokerCalls, 0);
    assertEquals(h.stub.captured.length, 0);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (g) precheck=proceed invokes startCycle with the registered runner's fields.
Deno.test("scheduler — proceed precheck invokes startCycle with registered runner's fields", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const runner = fakeRunner("engineer", {
      precheck: () => ({ kind: "proceed", roleContext: { summary: "ticket-0001" } }),
      codingAgentInvoker: {
        invoke: () => Promise.resolve({ kind: "completed", exitCode: 0 }),
      },
      envAllowlist: ["PATH"],
      expectedPromptName: "placeholder",
    });
    registry.register(runner);

    const startCycleCalls: RoleCycleParams[] = [];
    const fakeStartCycle: typeof import("@keni/runtime-common").startCycle = (
      params,
    ): Promise<RoleCycleResult> => {
      startCycleCalls.push(params);
      return Promise.resolve({
        outcome: "completed",
        sessionId: "s-fake",
        exitCode: 0,
        summary: "ok",
      });
    };

    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
        startCycle: fakeStartCycle,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(100);
    assertEquals(startCycleCalls.length, 1);
    const params = startCycleCalls[0]!;
    // Verbatim references, not deep clones.
    assertEquals(params.precheck, runner.precheck);
    assertEquals(params.promptResolver, runner.promptResolver);
    assertEquals(params.codingAgentInvoker, runner.codingAgentInvoker);
    assertEquals(params.expectedPromptName, "placeholder");
    assertEquals(params.envAllowlist, runner.envAllowlist);
    assertEquals(params.mcpServerConfig, runner.mcpServerConfig);
    assertEquals(params.role, "engineer");
    assertEquals(params.agentId, "alice");
    assertEquals(params.serverUrl, h.stub.url);
    assertEquals(params.projectName, "test");
    assert(params.signal !== undefined);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (g.1) Per-runner workspacePath wins over project-level opts.workspacePath
// — a regression test for the bug where the engineer runner had a workspace
// path on hand (used to build mcpServerConfig) but never propagated it to
// `RoleCycleParams.workspacePath`. The workspace-rooted MCP-config strategies
// then threw `workspace_required_for_strategy` and the cycle exited with
// `spawn_failed: true, exit_code: -1` and no other diagnostic.
Deno.test(
  "scheduler — runner.workspacePath is forwarded to RoleCycleParams.workspacePath",
  async () => {
    const h = makeHarness();
    try {
      const runtime = createInMemoryAgentRuntimeStateStore([
        { id: "alice", role: "engineer" },
      ]);
      const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
      registry.register(
        fakeRunner("engineer", {
          precheck: () => ({ kind: "proceed" }),
          workspacePath: "/tmp/ws/alice",
        }),
      );

      const startCycleCalls: RoleCycleParams[] = [];
      const fakeStartCycle: typeof import("@keni/runtime-common").startCycle = (
        params,
      ): Promise<RoleCycleResult> => {
        startCycleCalls.push(params);
        return Promise.resolve({
          outcome: "completed",
          sessionId: "s-fake",
          exitCode: 0,
          summary: "ok",
        });
      };

      const scheduler = createScheduler(
        {
          runtimeStore: runtime,
          logger: captureSchedulerLogger(h.logBuffer),
          registry,
          clock: h.clock.clock,
          startCycle: fakeStartCycle,
        },
        {
          agents: [{ id: "alice", role: "engineer" }],
          schedules: { alice: "100ms" },
          serverUrl: h.stub.url,
          projectName: "test",
          // The legacy project-level workspacePath is still accepted but
          // MUST lose to the per-runner value when both are set.
          workspacePath: "/tmp/ws/PROJECT",
        },
      );
      scheduler.start();
      await h.clock.tick(100);
      assertEquals(startCycleCalls.length, 1);
      assertEquals(startCycleCalls[0]?.workspacePath, "/tmp/ws/alice");
      await scheduler.stop();
    } finally {
      await h.stop();
    }
  },
);

// (g.2) When the runner does not set workspacePath, the legacy project-level
// `opts.workspacePath` is still honoured (back-compat with the cron-scheduler
// design that predates per-agent workspaces).
Deno.test(
  "scheduler — falls back to opts.workspacePath when runner.workspacePath is unset",
  async () => {
    const h = makeHarness();
    try {
      const runtime = createInMemoryAgentRuntimeStateStore([
        { id: "alice", role: "engineer" },
      ]);
      const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
      registry.register(
        fakeRunner("engineer", {
          precheck: () => ({ kind: "proceed" }),
        }),
      );

      const startCycleCalls: RoleCycleParams[] = [];
      const fakeStartCycle: typeof import("@keni/runtime-common").startCycle = (
        params,
      ): Promise<RoleCycleResult> => {
        startCycleCalls.push(params);
        return Promise.resolve({
          outcome: "completed",
          sessionId: "s-fake",
          exitCode: 0,
          summary: "ok",
        });
      };

      const scheduler = createScheduler(
        {
          runtimeStore: runtime,
          logger: captureSchedulerLogger(h.logBuffer),
          registry,
          clock: h.clock.clock,
          startCycle: fakeStartCycle,
        },
        {
          agents: [{ id: "alice", role: "engineer" }],
          schedules: { alice: "100ms" },
          serverUrl: h.stub.url,
          projectName: "test",
          workspacePath: "/tmp/ws/PROJECT",
        },
      );
      scheduler.start();
      await h.clock.tick(100);
      assertEquals(startCycleCalls.length, 1);
      assertEquals(startCycleCalls[0]?.workspacePath, "/tmp/ws/PROJECT");
      await scheduler.stop();
    } finally {
      await h.stop();
    }
  },
);

// (h) Coalesce on second tick when active != null.
Deno.test("scheduler — second tick coalesces while first cycle is in flight", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const inv = slowInvoker({ autoTerminateOnAbort: false });
    registry.register(
      fakeRunner("engineer", {
        precheck: () => ({ kind: "proceed" }),
        codingAgentInvoker: inv.invoker,
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        timeouts: { alice: "10m" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(100);
    assertEquals(inv.invocationCount(), 1);
    await h.clock.tick(100);
    // Coalesced: invoker count remains 1
    assertEquals(inv.invocationCount(), 1);
    const coalesced = h.logBuffer.filter((b) =>
      b.event === "tick.coalesced" && b.fields.agent === "alice"
    );
    assertEquals(coalesced.length >= 1, true);
    inv.resolveCompleted(0);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (i) Cross-agent parallelism.
Deno.test("scheduler — cross-agent parallelism: bob ticks while alice is in-flight", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
      { id: "bob", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const aliceInv = slowInvoker({ autoTerminateOnAbort: false });
    let bobCalls = 0;
    registry.register(
      fakeRunner("engineer", {
        precheck: (ctx) => ({ kind: "proceed", roleContext: { summary: ctx.agentId } }),
        codingAgentInvoker: {
          invoke: (invocation, lifecycle) => {
            if (invocation.agentId === "bob") {
              bobCalls++;
              return Promise.resolve({ kind: "completed", exitCode: 0 });
            }
            return aliceInv.invoker.invoke(invocation, lifecycle);
          },
        },
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }, { id: "bob", role: "engineer" }],
        schedules: { engineer: "100ms" },
        timeouts: { engineer: "10m" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(100);
    assertEquals(aliceInv.invocationCount(), 1);
    assertEquals(bobCalls, 1);
    aliceInv.resolveCompleted(0);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (j) Timeout fires abort + appends session_timeout.
Deno.test("scheduler — wall-clock timeout fires abort and appends session_timeout", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const inv = slowInvoker(); // auto-terminates on abort
    registry.register(
      fakeRunner("engineer", {
        precheck: () => ({ kind: "proceed" }),
        codingAgentInvoker: inv.invoker,
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        timeouts: { alice: "1s" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(100); // tick fires
    assertEquals(inv.invocationCount(), 1);
    const sig = inv.lifecycle()?.abortSignal;
    assert(sig !== undefined);
    assertEquals(sig.aborted, false);
    await h.clock.tick(1_000); // timeout fires at startedAt + 1000
    assertEquals(sig.aborted, true);
    // Wait for the timeout's POST + cycle resolution to settle.
    for (let i = 0; i < 20 && h.stub.captured.length === 0; i++) {
      await h.clock.tick(0);
    }
    const timeoutEntries = h.stub.captured.filter((row) => row.body.event === "session_timeout");
    assertEquals(timeoutEntries.length, 1);
    assertEquals(timeoutEntries[0]!.body.refs?.reason, "timeout");
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (k) Timeout cleared on early resolution.
Deno.test("scheduler — timeout cleared when cycle resolves before deadline", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const inv = slowInvoker({ autoTerminateOnAbort: false });
    registry.register(
      fakeRunner("engineer", {
        precheck: () => ({ kind: "proceed" }),
        codingAgentInvoker: inv.invoker,
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        timeouts: { alice: "30m" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(100);
    inv.resolveCompleted(0);
    await h.clock.tick(60_000); // well past idle threshold but well below 30m
    const timeoutEntries = h.stub.captured.filter((row) => row.body.event === "session_timeout");
    assertEquals(timeoutEntries.length, 0);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (l) Interrupt aborts and appends session_interrupted.
Deno.test("scheduler — interrupt aborts in-flight cycle and appends session_interrupted", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const inv = slowInvoker(); // auto-terminate on abort
    registry.register(
      fakeRunner("engineer", {
        precheck: () => ({ kind: "proceed" }),
        codingAgentInvoker: inv.invoker,
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        timeouts: { alice: "30m" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(100); // alice tick fires; cycle in flight
    const sig = inv.lifecycle()?.abortSignal;
    assert(sig !== undefined);
    const result = await scheduler.interrupt("alice");
    assertEquals(result.interrupted, true);
    if (result.interrupted) assert(result.sessionId.length > 0);
    assertEquals(sig.aborted, true);
    const interruptedEntries = h.stub.captured.filter(
      (row) => row.body.event === "session_interrupted",
    );
    assertEquals(interruptedEntries.length, 1);
    assertEquals(interruptedEntries[0]!.body.refs?.reason, "interrupt");
    if (result.interrupted) {
      assertEquals(interruptedEntries[0]!.body.session_id, result.sessionId);
    }
    assertEquals(interruptedEntries[0]!.headers["x-keni-role"], "engineer");
    assertEquals(interruptedEntries[0]!.headers["x-keni-agent"], "alice");
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (m) Interrupt on idle returns no_active_cycle.
Deno.test("scheduler — interrupt on idle agent returns no_active_cycle", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    registry.register(fakeRunner("engineer"));
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    const result = await scheduler.interrupt("alice");
    assertEquals(result, { interrupted: false, reason: "no_active_cycle" });
    assertEquals(h.stub.captured.length, 0);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// (n) Interrupt on unknown agent returns unknown_agent.
Deno.test("scheduler — interrupt on unknown agent returns unknown_agent", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [],
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    const result = await scheduler.interrupt("ghost");
    assertEquals(result, { interrupted: false, reason: "unknown_agent" });
    assertEquals(h.stub.captured.length, 0);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// Unregistered role logs `runner.missing` and skips.
Deno.test("scheduler — agent with no registered runner warns once and skips ticks", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "ghost", role: "writer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "ghost", role: "writer" }],
        schedules: { ghost: "100ms" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    const startWarn = h.logBuffer.filter((b) =>
      b.event === "runner.missing" && b.fields.role === "writer"
    );
    assertEquals(startWarn.length >= 1, true);
    await h.clock.tick(100);
    assertEquals(h.stub.captured.length, 0);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// `start()` is idempotent.
Deno.test("scheduler — start is idempotent", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    registry.register(fakeRunner("engineer"));
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    scheduler.start();
    const warns = h.logBuffer.filter((b) => b.event === "scheduler.already_started");
    assertEquals(warns.length, 1);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// `stop()` is idempotent.
Deno.test("scheduler — stop is idempotent", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    registry.register(fakeRunner("engineer"));
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await scheduler.stop();
    await scheduler.stop();
    const stops = h.logBuffer.filter((b) => b.event === "scheduler.stopped");
    assertEquals(stops.length, 1);
  } finally {
    await h.stop();
  }
});

// Timeout shorter than idle threshold logs a warning.
Deno.test("scheduler — timeout shorter than idle threshold logs once per cycle", async () => {
  const h = makeHarness();
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    registry.register(
      fakeRunner("engineer", {
        precheck: () => ({ kind: "proceed" }),
        codingAgentInvoker: {
          invoke: () => Promise.resolve({ kind: "completed", exitCode: 0 }),
        },
        idleThresholdMs: 250,
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "1000ms" },
        timeouts: { alice: "100ms" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(1000);
    const warns = h.logBuffer.filter((b) => b.event === "timeout.shorter_than_idle");
    assertEquals(warns.length >= 1, true);
    assertEquals(warns[0]!.fields.role, "engineer");
    assertEquals(warns[0]!.fields.timeout_ms, 100);
    assertEquals(warns[0]!.fields.idle_threshold_ms, 250);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});

// Activity-post failure does not crash the scheduler — the interrupt
// returns its outcome regardless. The stub returns 500 only for the
// `session_interrupted` POST so the cycle's own `session_start` /
// `session_end` round-trips succeed normally.
Deno.test("scheduler — activity post 500 does not crash interrupt() return", async () => {
  const h = makeHarness({
    responder: async (req) => {
      const body = (await req.clone().json()) as { event?: string };
      if (body.event === "session_interrupted") {
        return new Response("{}", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          data: {
            id: "01900000-0000-7000-8000-000000000001",
            timestamp: new Date().toISOString(),
            session_id: body.event === undefined ? "" : "x",
            agent: "alice",
            role: "engineer",
            event: body.event ?? "",
            summary: null,
            refs: {},
          },
          project_id: "p",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  try {
    const runtime = createInMemoryAgentRuntimeStateStore([
      { id: "alice", role: "engineer" },
    ]);
    const registry = createAgentRunnerRegistry(captureSchedulerLogger(h.logBuffer));
    const inv = slowInvoker();
    registry.register(
      fakeRunner("engineer", {
        precheck: () => ({ kind: "proceed" }),
        codingAgentInvoker: inv.invoker,
      }),
    );
    const scheduler = createScheduler(
      {
        runtimeStore: runtime,
        logger: captureSchedulerLogger(h.logBuffer),
        registry,
        clock: h.clock.clock,
      },
      {
        agents: [{ id: "alice", role: "engineer" }],
        schedules: { alice: "100ms" },
        timeouts: { alice: "10m" },
        serverUrl: h.stub.url,
        projectName: "test",
      },
    );
    scheduler.start();
    await h.clock.tick(100);
    const result = await scheduler.interrupt("alice");
    assertEquals(result.interrupted, true);
    const warns = h.logBuffer.filter((b) => b.event === "scheduler.activity_post_failed");
    assertEquals(warns.length >= 1, true);
    await scheduler.stop();
  } finally {
    await h.stop();
  }
});
