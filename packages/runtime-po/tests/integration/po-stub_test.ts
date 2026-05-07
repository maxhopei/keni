/**
 * End-to-end integration test for the PO role's stub package.
 *
 * Mirrors the engineer integration test's shape but with a roster of two
 * agents — one engineer (covered by an inline fake wire so the test does
 * NOT depend on a `claude`-shaped CLI binary), one PO (covered by the
 * real `wire` export from `@keni/runtime-po`). Boots `runServer` against
 * a temp project and asserts the polymorphic `roleWires` dispatch
 * registers and ticks both runners exactly as the
 * `runtime-po-stub` capability spec requires:
 *
 *  - the registry's `roles()` snapshots `["engineer", "po"]` in
 *    insertion order;
 *  - the engineer's fake invoker is called at least once (the engineer
 *    cycle progresses past precheck and into the invoker);
 *  - the PO's precheck always resolves
 *    `{ kind: "skip", reason: "po_not_implemented" }`, surfacing through
 *    the scheduler's structured logger as a `tick.precheck_skipped`
 *    event with the same reason;
 *  - zero activity-log entries land for `agent: "petra"` (the
 *    precheck-skip short-circuit precedes any `appendSessionStart`).
 *
 * The host's real `~/.keni/` is never read or written: the test routes
 * `homeDir` through a temp directory and supplies a
 * `FakeWorkspaceProvisioner` so the production `GitWorkspaceProvisioner`
 * (used by `routes/prs.ts`) is never instantiated.
 *
 * @module
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import {
  type ActivityEntry,
  FileActivityLogStore,
  FileConfigStore,
  resolveGlobalPaths,
  resolveProjectPaths,
} from "@keni/shared";
import type {
  AgentRunner,
  CodingAgentInvocation,
  CodingAgentInvoker,
  WireFn,
} from "@keni/runtime-common";
import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace/test-fakes";
import { runServer } from "../../../server/src/runServer.ts";
import {
  captureSchedulerLogger,
  type SchedulerLogEntry,
} from "../../../server/src/scheduler/log.ts";
import type { AgentRunnerRegistry } from "../../../server/src/scheduler/registry.ts";
import { wire as poWire } from "../../src/wire.ts";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000d1";

interface IntegrationContext {
  readonly serverUrl: string;
  readonly projectRoot: string;
  readonly tempHome: string;
  readonly fakeEngineerInvoker: TrackedInvokerHandle;
  readonly schedulerLog: readonly SchedulerLogEntry[];
  readonly registry: AgentRunnerRegistry;
  readonly stop: () => Promise<void>;
}

interface TrackedInvokerHandle {
  readonly invoker: CodingAgentInvoker;
  readonly invocationCount: () => number;
  readonly invocations: () => readonly CodingAgentInvocation[];
}

function createTrackedInvoker(): TrackedInvokerHandle {
  const captured: CodingAgentInvocation[] = [];
  const invoker: CodingAgentInvoker = {
    invoke: (invocation) => {
      captured.push(invocation);
      return Promise.resolve({ kind: "completed", exitCode: 0 });
    },
  };
  return {
    invoker,
    invocationCount: () => captured.length,
    invocations: () => captured.slice(),
  };
}

/**
 * Build a fake engineer wire that returns a no-op runner: precheck
 * proceeds, the prompt resolver returns a placeholder bundled prompt,
 * and the coding-agent invoker is the supplied tracked stub. The
 * runner deliberately omits `workspacePath` so the cycle never tries
 * to touch a real workspace path and the activity log's session_start
 * record is enough to prove the cycle reached the invoker step.
 */
function buildFakeEngineerWire(invoker: CodingAgentInvoker): WireFn {
  return (input) => {
    if (input.agentConfig.role !== "engineer") {
      return Promise.resolve(null);
    }
    const runner: AgentRunner = {
      role: "engineer",
      precheck: () => ({
        kind: "proceed",
        roleContext: { summary: "fake-engineer-tick" },
      }),
      promptResolver: () => ({
        name: "fake-engineer",
        body: "FAKE ENGINEER PROMPT BODY",
      }),
      expectedPromptName: "fake-engineer",
      codingAgentInvoker: invoker,
      mcpServerConfig: { command: "echo", args: [] },
    };
    return Promise.resolve(runner);
  };
}

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

async function setup(): Promise<IntegrationContext> {
  const projectRoot = await Deno.makeTempDir({ prefix: "keni-po-it-project-" });
  const tempHome = await Deno.makeTempDir({ prefix: "keni-po-it-home-" });

  const projectPaths = resolveProjectPaths(projectRoot);
  const globalPaths = resolveGlobalPaths(tempHome);
  await Deno.mkdir(projectPaths.keni, { recursive: true });
  await Deno.mkdir(projectPaths.tickets, { recursive: true });
  await Deno.mkdir(projectPaths.prs, { recursive: true });
  await Deno.mkdir(projectPaths.activity, { recursive: true });

  const config = new FileConfigStore(projectPaths, globalPaths);
  await config.writeProjectConfig({
    project_id: PROJECT_ID,
    name: "po-stub-it-project",
    agents: [
      { id: "alice", role: "engineer", cli: "claude" },
      { id: "petra", role: "po" },
    ],
    schedules: { engineer: "100ms", po: "100ms" },
  });

  const fakeEngineerInvoker = createTrackedInvoker();
  const fakeEngineerWire = buildFakeEngineerWire(fakeEngineerInvoker.invoker);

  const schedulerLog: SchedulerLogEntry[] = [];
  const outLines: string[] = [];
  const ctrl = new AbortController();

  let registryHandle: AgentRunnerRegistry | null = null;
  const promise = runServer(
    ["--project", projectRoot, "--port", "0"],
    {
      out: (m) => outLines.push(m),
      err: () => {},
      homeDir: tempHome,
      shutdownSignal: ctrl.signal,
      schedulerLogger: captureSchedulerLogger(schedulerLog),
      workspaceProvisioner: new FakeWorkspaceProvisioner({ homeDir: tempHome }),
      roleWires: { engineer: fakeEngineerWire, po: poWire },
      onSchedulerReady: (handle) => {
        registryHandle = handle.registry;
      },
    },
  );

  const start = performance.now();
  let banner: string | undefined;
  while (banner === undefined) {
    if (performance.now() - start > 8_000) {
      throw new Error("Orchestration server did not bind within 8s");
    }
    banner = outLines.find((l) => l.startsWith("Keni server running at "));
    if (banner === undefined) await new Promise((r) => setTimeout(r, 25));
  }
  const serverUrl = banner.replace(/^Keni server running at /, "");

  await waitFor(
    () => registryHandle !== null,
    2_000,
    "onSchedulerReady",
  );
  assert(registryHandle !== null, "onSchedulerReady never fired");

  return {
    serverUrl,
    projectRoot,
    tempHome,
    fakeEngineerInvoker,
    schedulerLog,
    registry: registryHandle,
    stop: async () => {
      ctrl.abort();
      await promise;
    },
  };
}

async function teardown(ctx: IntegrationContext): Promise<void> {
  await ctx.stop();
  await Deno.remove(ctx.projectRoot, { recursive: true });
  await Deno.remove(ctx.tempHome, { recursive: true });
}

async function readActivityRows(
  projectRoot: string,
): Promise<readonly ActivityEntry[]> {
  const projectPaths = resolveProjectPaths(projectRoot);
  const store = new FileActivityLogStore(projectPaths);
  const rows: ActivityEntry[] = [];
  for await (const row of store.query({})) rows.push(row);
  return rows;
}

Deno.test(
  "po integration — both engineer and PO runners register and tick; only PO precheck-skips",
  async () => {
    const ctx = await setup();
    try {
      assertEquals(
        ctx.registry.roles(),
        ["engineer", "po"],
        "registry.roles() should be the roster's role insertion order",
      );

      await waitFor(
        () => ctx.fakeEngineerInvoker.invocationCount() >= 1,
        5_000,
        "engineer invoker called once",
      );

      await waitFor(
        () =>
          ctx.schedulerLog.some(
            (e) =>
              e.event === "tick.precheck_skipped" &&
              e.fields.agent === "petra" &&
              e.fields.reason === "po_not_implemented",
          ),
        5_000,
        "PO tick.precheck_skipped",
      );

      assertGreater(
        ctx.fakeEngineerInvoker.invocationCount(),
        0,
        "engineer's fake invoker should have been called",
      );

      const rows = await readActivityRows(ctx.projectRoot);
      const poRows = rows.filter((r) => r.agent === "petra");
      assertEquals(
        poRows,
        [],
        `expected zero activity-log entries for the PO agent, got ${JSON.stringify(poRows)}`,
      );

      const poSkipEntries = ctx.schedulerLog.filter(
        (e) =>
          e.event === "tick.precheck_skipped" &&
          e.fields.agent === "petra",
      );
      assertGreater(
        poSkipEntries.length,
        0,
        "PO tick must produce at least one precheck_skipped log entry",
      );
      for (const entry of poSkipEntries) {
        assertEquals(entry.fields.reason, "po_not_implemented");
      }
    } finally {
      await teardown(ctx);
    }
  },
);
