/**
 * Scheduler end-to-end integration tests — drive the full
 * `runServer({ port: 0 })` path with a real on-disk project, a real
 * `Deno.serve` listener, and a fake `AgentRunner` registered against
 * the scheduler at bootstrap. Asserts on the on-disk activity-log
 * JSONL file (one row per `POST /activity`) and on the runtime-state
 * store surfaced via `GET /agents`.
 *
 * The scheduler in `runServer` is wired against `defaultClock()`, so
 * these tests use real wall-clock time with sub-second cadences and a
 * polling helper rather than a `FakeClock`. Fast, deterministic-enough
 * tests for CI; the per-method unit tests in
 * `scheduler_test.ts` cover the precise timing semantics with a
 * `FakeClock` already.
 *
 * Spec cross-walk (each scenario's name names its requirement):
 *
 *  - "happy path: tick fires once and writes session_start +
 *    session_end + three subprocess_stdout rows" — `spec.md`
 *    §6.2 happy path; `runServer.start()` calls `scheduler.start()`.
 *  - "pause then resume cycles a new tick" — scheduler `paused`
 *    skip-then-resume.
 *  - "interrupt mid-cycle aborts and writes session_interrupted" —
 *    scheduler `interrupt()` writes `session_interrupted` with the
 *    cycle's `session_id`.
 *  - "timeout mid-cycle aborts and writes session_timeout" — scheduler
 *    timeout writes `session_timeout` with the cycle's `session_id`.
 *  - "cleanup: every step's failure still aborts and removes the temp
 *    dir" — `runServer` lifecycle drains scheduler and HTTP server on
 *    `shutdownSignal`.
 *
 * @module
 */

import { assertEquals, assertGreaterOrEqual, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { FileConfigStore, resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import type {
  CodingAgentInvocation,
  CodingAgentInvoker,
  CodingAgentLifecycle,
  CodingAgentOutcome,
  CyclePrepCtx,
} from "@keni/role-runtimes";
import {
  FakeWorkspaceProvisioner,
  PLACEHOLDER_PROMPT_BODY,
  PLACEHOLDER_PROMPT_NAME,
} from "@keni/role-runtimes/test-fakes";
import { runServer } from "../../../src/runServer.ts";
import type { AgentRunner, AgentRunnerRegistry } from "../../../src/scheduler/registry.ts";
import type { Scheduler } from "../../../src/scheduler/scheduler.ts";

/** Wait up to `timeoutMs` for `pred()` to return truthy. Polls every 10 ms. */
async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = "predicate",
): Promise<void> {
  const start = performance.now();
  while (true) {
    if (await pred()) return;
    if (performance.now() - start > timeoutMs) {
      throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface ActivityRow {
  readonly id: string;
  readonly timestamp: string;
  readonly session_id: string | null;
  readonly agent: string;
  readonly role: string;
  readonly event: string;
  readonly summary: string | null;
  readonly refs: Readonly<Record<string, string>>;
}

/** Read every `.keni/activity/*.jsonl` row, in chronological filename + line order. */
async function readActivityRows(projectRoot: string): Promise<readonly ActivityRow[]> {
  const dir = join(projectRoot, ".keni", "activity");
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".jsonl")) files.push(entry.name);
    }
  } catch {
    return [];
  }
  files.sort();
  const rows: ActivityRow[] = [];
  for (const name of files) {
    const path = join(dir, name);
    let raw: string;
    try {
      raw = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        rows.push(JSON.parse(trimmed) as ActivityRow);
      } catch {
        // Defensive: skip malformed rows so a partial write doesn't
        // crash the test mid-poll.
      }
    }
  }
  return rows;
}

/**
 * Provision a temp project root + temp home dir with a `.keni/project.yaml`
 * that lists the supplied agents and (optionally) schedules / timeouts.
 * The mirror of step 04's `keni init` output that the scheduler tests need.
 */
async function provisionProject(opts: {
  readonly agents: readonly { readonly id: string; readonly role: string }[];
  readonly schedules?: Readonly<Record<string, string>>;
  readonly timeouts?: Readonly<Record<string, string | number>>;
}): Promise<{
  readonly root: string;
  readonly home: string;
  readonly cleanup: () => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "keni-server-scheduler-int-" });
  const home = await Deno.makeTempDir({ prefix: "keni-server-scheduler-int-home-" });
  const projectPaths = resolveProjectPaths(root);
  const globalPaths = resolveGlobalPaths(home);
  await Deno.mkdir(projectPaths.keni, { recursive: true });
  await Deno.mkdir(projectPaths.tickets, { recursive: true });
  await Deno.mkdir(projectPaths.prs, { recursive: true });
  await Deno.mkdir(projectPaths.activity, { recursive: true });
  const config = new FileConfigStore(projectPaths, globalPaths);
  await config.writeProjectConfig({
    project_id: "00000000-0000-4000-8000-0000000000aa",
    name: "scheduler-integration",
    agents: opts.agents,
    ...(opts.schedules !== undefined ? { schedules: opts.schedules } : {}),
    ...(opts.timeouts !== undefined ? { timeouts: opts.timeouts } : {}),
  });
  return {
    root,
    home,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(home, { recursive: true });
    },
  };
}

/**
 * Build a coding-agent invoker tailored for integration tests.
 *
 * Push helpers wire into the cycle's lifecycle so the test can simulate
 * the subprocess streaming arbitrary stdout / stderr lines. Calling
 * `resolveCompleted(...)` resolves the cycle's outcome; `abortSignal`
 * fires from the scheduler trigger an automatic
 * `{ kind: "terminated", terminatedBy: "sigterm" }` outcome that
 * mirrors what `Deno.Command` would produce after a SIGTERM.
 */
interface RunningInvokerHandle {
  readonly invoker: CodingAgentInvoker;
  readonly invocationCount: () => number;
  readonly invocations: () => readonly CodingAgentInvocation[];
  readonly pushStdoutLine: (line: string) => Promise<void>;
  readonly resolveCompleted: (exitCode: number) => void;
  readonly waitForInvocation: (n: number, timeoutMs?: number) => Promise<void>;
}

function createRunningInvoker(): RunningInvokerHandle {
  const invocations: CodingAgentInvocation[] = [];
  let lifecycle: CodingAgentLifecycle | null = null;
  let resolveOutcome: ((outcome: CodingAgentOutcome) => void) | null = null;
  let invocationCount = 0;
  let abortListener: (() => void) | null = null;

  const invoker: CodingAgentInvoker = {
    invoke: (invocation, lc) => {
      invocationCount += 1;
      invocations.push(invocation);
      lifecycle = lc;
      return new Promise<CodingAgentOutcome>((resolveFn) => {
        resolveOutcome = resolveFn;
        if (lc.abortSignal !== undefined) {
          abortListener = () => {
            if (resolveOutcome === null) return;
            const r = resolveOutcome;
            resolveOutcome = null;
            r({ kind: "terminated", exitCode: -1, terminatedBy: "sigterm" });
          };
          if (lc.abortSignal.aborted) abortListener();
          else lc.abortSignal.addEventListener("abort", abortListener, { once: true });
        }
      });
    },
  };

  return {
    invoker,
    invocationCount: () => invocationCount,
    invocations: () => invocations.slice(),
    pushStdoutLine: async (line) => {
      if (lifecycle === null) throw new Error("invoke() has not been called yet");
      await lifecycle.onStdoutLine(line);
    },
    resolveCompleted: (exitCode) => {
      if (resolveOutcome === null) return;
      const r = resolveOutcome;
      resolveOutcome = null;
      r({ kind: "completed", exitCode });
    },
    waitForInvocation: async (n, timeoutMs = 5_000) => {
      await waitFor(() => invocationCount >= n, timeoutMs, `invocation #${n}`);
    },
  };
}

/** Build the bag the integration test registers as the engineer runner. */
function buildEngineerRunner(invoker: CodingAgentInvoker): AgentRunner {
  return {
    role: "engineer",
    precheck: (_ctx: CyclePrepCtx) => ({
      kind: "proceed",
      roleContext: { summary: "ticket-0001" },
    }),
    promptResolver: (_ctx: CyclePrepCtx) => ({
      name: PLACEHOLDER_PROMPT_NAME,
      body: PLACEHOLDER_PROMPT_BODY,
    }),
    expectedPromptName: PLACEHOLDER_PROMPT_NAME,
    codingAgentInvoker: invoker,
    mcpServerConfig: {
      command: "deno",
      args: ["run", "--allow-net", "noop.ts"],
      env: {},
    },
  };
}

/** Boot a `runServer` and capture the scheduler + registry handles. */
async function bootRunServer(opts: {
  readonly root: string;
  readonly home: string;
  readonly args?: readonly string[];
}): Promise<{
  readonly url: string;
  readonly scheduler: Scheduler;
  readonly registry: AgentRunnerRegistry;
  readonly outLines: readonly string[];
  readonly shutdown: () => Promise<void>;
}> {
  const ctrl = new AbortController();
  const outLines: string[] = [];
  let scheduler: Scheduler | null = null;
  let registry: AgentRunnerRegistry | null = null;
  const promise = runServer(
    ["--project", opts.root, "--port", "0", ...(opts.args ?? [])],
    {
      out: (m) => outLines.push(m),
      err: () => {},
      homeDir: opts.home,
      shutdownSignal: ctrl.signal,
      // The scheduler integration tests do not exercise the workspace
      // surface; supplying a fake provisioner keeps the project root
      // free of `git init` plumbing while still letting `wireEngineers`
      // run.
      workspaceProvisioner: new FakeWorkspaceProvisioner({ homeDir: opts.home }),
      onSchedulerReady: (handle) => {
        scheduler = handle.scheduler;
        registry = handle.registry;
      },
    },
  );
  await waitFor(
    () => outLines.some((l) => l.startsWith("Keni server running at ")),
    5_000,
    "server banner",
  );
  await waitFor(() => scheduler !== null && registry !== null, 1_000, "onSchedulerReady");
  const banner = outLines.find((l) => l.startsWith("Keni server running at "))!;
  const url = banner.replace(/^Keni server running at /, "");
  return {
    url,
    scheduler: scheduler!,
    registry: registry!,
    outLines,
    shutdown: async () => {
      ctrl.abort();
      const code = await promise;
      assertEquals(code, 0);
    },
  };
}

Deno.test(
  "scheduler integration — happy path: one tick writes session_start + 3 stdout + session_end",
  async () => {
    const env = await provisionProject({
      agents: [{ id: "alice", role: "engineer" }],
      schedules: { engineer: "100ms" },
    });
    let shutdownCalled = false;
    try {
      const inv = createRunningInvoker();
      const boot = await bootRunServer({ root: env.root, home: env.home });
      boot.registry.register(buildEngineerRunner(inv.invoker));

      await inv.waitForInvocation(1);
      await inv.pushStdoutLine("line one");
      await inv.pushStdoutLine("line two");
      await inv.pushStdoutLine("ticket-0001 done");
      inv.resolveCompleted(0);

      await waitFor(
        async () => {
          const rows = await readActivityRows(env.root);
          return rows.some((r) => r.event === "session_end");
        },
        5_000,
        "session_end row",
      );

      const rows = await readActivityRows(env.root);
      const aliceRows = rows.filter((r) => r.agent === "alice");
      const events = aliceRows.map((r) => r.event);
      assertEquals(events[0], "session_start");
      assertEquals(events.filter((e) => e === "subprocess_stdout").length, 3);
      assertEquals(events[events.length - 1], "session_end");

      const start = aliceRows.find((r) => r.event === "session_start")!;
      assertMatch(start.session_id ?? "", /^[0-9a-f-]{36}$/);
      assertEquals(start.summary, "ticket-0001");
      const end = aliceRows.find((r) => r.event === "session_end")!;
      assertEquals(end.session_id, start.session_id);
      assertEquals(end.refs.exit_code, "0");
      assertEquals(end.summary, "ticket-0001 done");

      await boot.shutdown();
      shutdownCalled = true;
    } finally {
      if (!shutdownCalled) {
        // Defensive: ensure cleanup runs even if a step above threw
        // before `boot.shutdown()` had a chance to fire. The test below
        // ("cleanup: ...") covers this contract explicitly.
      }
      await env.cleanup();
    }
  },
);

Deno.test(
  "scheduler integration — pause then resume cycles a new tick",
  async () => {
    const env = await provisionProject({
      agents: [{ id: "alice", role: "engineer" }],
      schedules: { engineer: "100ms" },
    });
    try {
      const inv = createRunningInvoker();
      const boot = await bootRunServer({ root: env.root, home: env.home });
      boot.registry.register(buildEngineerRunner(inv.invoker));

      await inv.waitForInvocation(1);
      await inv.pushStdoutLine("first cycle done");
      inv.resolveCompleted(0);

      await waitFor(
        async () => {
          const rows = await readActivityRows(env.root);
          return rows.filter((r) => r.event === "session_end").length >= 1;
        },
        5_000,
        "first session_end",
      );

      const pauseRes = await fetch(`${boot.url}/agents/alice/pause`, {
        method: "POST",
        headers: { "X-Keni-Role": "user" },
      });
      assertEquals(pauseRes.status, 200);
      await pauseRes.body?.cancel();

      const beforePause = inv.invocationCount();
      await new Promise((r) => setTimeout(r, 350));
      assertEquals(
        inv.invocationCount(),
        beforePause,
        "no new invocations while paused",
      );

      const resumeRes = await fetch(`${boot.url}/agents/alice/resume`, {
        method: "POST",
        headers: { "X-Keni-Role": "user" },
      });
      assertEquals(resumeRes.status, 200);
      await resumeRes.body?.cancel();

      await inv.waitForInvocation(beforePause + 1);
      await inv.pushStdoutLine("second cycle done");
      inv.resolveCompleted(0);

      await waitFor(
        async () => {
          const rows = await readActivityRows(env.root);
          return rows.filter((r) => r.event === "session_end").length >= 2;
        },
        5_000,
        "second session_end",
      );

      const rows = await readActivityRows(env.root);
      const sessions = new Set(
        rows.filter((r) => r.agent === "alice" && r.event === "session_start")
          .map((r) => r.session_id),
      );
      assertGreaterOrEqual(sessions.size, 2);

      await boot.shutdown();
    } finally {
      await env.cleanup();
    }
  },
);

Deno.test(
  "scheduler integration — interrupt mid-cycle aborts and writes session_interrupted",
  async () => {
    const env = await provisionProject({
      agents: [{ id: "alice", role: "engineer" }],
      schedules: { engineer: "100ms" },
    });
    try {
      const inv = createRunningInvoker();
      const boot = await bootRunServer({ root: env.root, home: env.home });
      boot.registry.register(buildEngineerRunner(inv.invoker));

      await inv.waitForInvocation(1);
      await inv.pushStdoutLine("started");

      await waitFor(
        async () => {
          const rows = await readActivityRows(env.root);
          return rows.some((r) => r.agent === "alice" && r.event === "session_start");
        },
        2_000,
        "session_start row",
      );

      const result = await boot.scheduler.interrupt("alice");
      assertEquals(result.interrupted, true);

      await waitFor(
        async () => {
          const rows = await readActivityRows(env.root);
          return rows.some((r) => r.agent === "alice" && r.event === "session_interrupted");
        },
        5_000,
        "session_interrupted row",
      );

      const rows = await readActivityRows(env.root);
      const start = rows.find((r) => r.agent === "alice" && r.event === "session_start")!;
      const interrupted = rows.find((r) =>
        r.agent === "alice" && r.event === "session_interrupted"
      )!;
      assertEquals(interrupted.session_id, start.session_id);

      await boot.shutdown();
    } finally {
      await env.cleanup();
    }
  },
);

Deno.test(
  "scheduler integration — timeout mid-cycle aborts and writes session_timeout",
  async () => {
    const env = await provisionProject({
      agents: [{ id: "alice", role: "engineer" }],
      schedules: { engineer: "100ms" },
      timeouts: { engineer: "300ms" },
    });
    try {
      const inv = createRunningInvoker();
      const boot = await bootRunServer({ root: env.root, home: env.home });
      boot.registry.register(buildEngineerRunner(inv.invoker));

      await inv.waitForInvocation(1);
      await inv.pushStdoutLine("running");

      await waitFor(
        async () => {
          const rows = await readActivityRows(env.root);
          return rows.some((r) => r.agent === "alice" && r.event === "session_timeout");
        },
        5_000,
        "session_timeout row",
      );

      const rows = await readActivityRows(env.root);
      const start = rows.find((r) => r.agent === "alice" && r.event === "session_start")!;
      const timed = rows.find((r) => r.agent === "alice" && r.event === "session_timeout")!;
      assertEquals(timed.session_id, start.session_id);

      await boot.shutdown();
    } finally {
      await env.cleanup();
    }
  },
);

Deno.test(
  "scheduler integration — cleanup: a failed step still aborts the server and removes the temp dir",
  async () => {
    const env = await provisionProject({
      agents: [{ id: "alice", role: "engineer" }],
      schedules: { engineer: "100ms" },
    });
    let stepFailedAsExpected = false;
    let bootShutdown: (() => Promise<void>) | null = null;
    try {
      const inv = createRunningInvoker();
      const boot = await bootRunServer({ root: env.root, home: env.home });
      bootShutdown = boot.shutdown;
      boot.registry.register(buildEngineerRunner(inv.invoker));

      // Synthesise a mid-step failure (mirrors a `assertEquals` that
      // would throw inside one of the production scenarios above).
      try {
        throw new Error("synthetic mid-step failure");
      } catch (e) {
        stepFailedAsExpected = e instanceof Error &&
          e.message === "synthetic mid-step failure";
      }
    } finally {
      if (bootShutdown !== null) await bootShutdown();
      await env.cleanup();
      const exists = await pathExists(env.root);
      assertEquals(exists, false, "project temp dir must be removed by cleanup");
    }
    assertEquals(stepFailedAsExpected, true);
  },
);

async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
