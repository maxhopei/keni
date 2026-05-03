/**
 * Tests for `runServer`. Avoids waiting for a real SIGINT by injecting an
 * `AbortSignal` (the production code path is exercised by step 13's
 * end-to-end tests; here we cover argv shape, exit codes, and the happy
 * path without touching `Deno.addSignalListener`).
 *
 * Scheduler-bootstrap cross-walk against
 * `openspec/changes/cron-scheduler-with-pause/specs/scheduler/spec.md`
 * and `…/specs/orchestration-server/spec.md`:
 *
 *  - "runServer constructs the scheduler once, calls start() exactly
 *    once, and stops it before server.abort() on shutdown" covers:
 *      • scheduler/spec.md "runServer instantiates and starts the
 *        scheduler exactly once at bootstrap"
 *      • scheduler/spec.md "runServer's abort handler calls
 *        scheduler.stop() before resolving"
 *      • orchestration-server/spec.md "Shutdown calls
 *        scheduler.stop() before resolving"
 *  - "runServer forwards schedules and timeouts from project.yaml to
 *    the scheduler" covers:
 *      • orchestration-server/spec.md "Boot against a project with a
 *        roster" (config-key forwarding clause)
 *
 * The "Boot against a project with no roster" scenario is exercised by
 * the existing "runServer prints the bound URL and exits 0 …" test,
 * which boots against an empty roster and asserts the server replies.
 */

import { assertEquals, assertMatch } from "@std/assert";
import { FileConfigStore, resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import { FakeWorkspaceProvisioner, WorkspaceProvisioningError } from "@keni/role-runtimes";
import { parseRunServerArgs, runServer, UsageError } from "./runServer.ts";
import type {
  InterruptResult,
  Scheduler,
  SchedulerDeps,
  SchedulerOpts,
} from "./scheduler/scheduler.ts";

async function makeKeniInitialised(
  agents: readonly { readonly id: string; readonly role: string }[] = [],
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "keni-server-runserver-" });
  const home = await Deno.makeTempDir({ prefix: "keni-server-runserver-home-" });
  const projectPaths = resolveProjectPaths(root);
  const globalPaths = resolveGlobalPaths(home);
  await Deno.mkdir(projectPaths.keni, { recursive: true });
  await Deno.mkdir(projectPaths.tickets, { recursive: true });
  await Deno.mkdir(projectPaths.prs, { recursive: true });
  await Deno.mkdir(projectPaths.activity, { recursive: true });
  const config = new FileConfigStore(projectPaths, globalPaths);
  await config.writeProjectConfig({
    project_id: "00000000-0000-4000-8000-000000000001",
    name: "test-project",
    ...(agents.length > 0 ? { agents } : {}),
  });
  return {
    root,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(home, { recursive: true });
    },
  };
}

Deno.test("parseRunServerArgs accepts --project=<path> inline form", () => {
  const parsed = parseRunServerArgs(["--project=/tmp/x", "--port=8080"]);
  assertEquals(parsed.port, 8080);
  assertMatch(parsed.projectDir, /\/tmp\/x$/);
  assertEquals(parsed.host, "127.0.0.1");
});

Deno.test("parseRunServerArgs accepts --project <path> separated form", () => {
  const parsed = parseRunServerArgs(["--project", "/tmp/x", "--host", "0.0.0.0"]);
  assertMatch(parsed.projectDir, /\/tmp\/x$/);
  assertEquals(parsed.host, "0.0.0.0");
});

Deno.test("parseRunServerArgs throws UsageError on missing --project", () => {
  let thrown: unknown;
  try {
    parseRunServerArgs(["--port", "8080"]);
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof UsageError, true);
});

Deno.test("parseRunServerArgs throws UsageError on unknown flag", () => {
  let thrown: unknown;
  try {
    parseRunServerArgs(["--project", "/tmp/x", "--bogus"]);
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof UsageError, true);
});

Deno.test("parseRunServerArgs rejects --port < 0 or > 65535", () => {
  for (const bad of ["-1", "65536", "abc"]) {
    let thrown: unknown;
    try {
      parseRunServerArgs(["--project", "/tmp/x", "--port", bad]);
    } catch (e) {
      thrown = e;
    }
    assertEquals(thrown instanceof UsageError, true, `expected UsageError for --port ${bad}`);
  }
});

Deno.test("runServer with no args returns exit 2 (missing --project)", async () => {
  const errLines: string[] = [];
  const code = await runServer([], { out: () => {}, err: (m) => errLines.push(m) });
  assertEquals(code, 2);
  assertEquals(errLines.some((l) => l.includes("--project")), true);
});

Deno.test("runServer with --unknown returns exit 2", async () => {
  const errLines: string[] = [];
  const code = await runServer(["--unknown"], { out: () => {}, err: (m) => errLines.push(m) });
  assertEquals(code, 2);
});

Deno.test("runServer against an empty dir returns exit 1 with `keni init` hint", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-server-runserver-empty-" });
  try {
    const errLines: string[] = [];
    const code = await runServer(["--project", root], {
      out: () => {},
      err: (m) => errLines.push(m),
    });
    assertEquals(code, 1);
    assertEquals(errLines.some((l) => l.includes("keni init")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runServer prints the bound URL and exits 0 on injected shutdown", async () => {
  const env = await makeKeniInitialised();
  try {
    const outLines: string[] = [];
    const ctrl = new AbortController();
    const promise = runServer(
      ["--project", env.root, "--port", "0"],
      { out: (m) => outLines.push(m), err: () => {}, shutdownSignal: ctrl.signal },
    );
    await waitFor(() => outLines.some((l) => l.startsWith("Keni server running at ")));
    const banner = outLines.find((l) => l.startsWith("Keni server running at "))!;
    assertMatch(banner, /^Keni server running at http:\/\/127\.0\.0\.1:\d+$/);

    const url = banner.replace(/^Keni server running at /, "");
    const res = await fetch(`${url}/tickets`, { headers: { "X-Keni-Role": "user" } });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.project_id, "00000000-0000-4000-8000-000000000001");

    ctrl.abort();
    const exit = await promise;
    assertEquals(exit, 0);
  } finally {
    await env.cleanup();
  }
});

Deno.test("runServer seeds /agents from the project.yaml roster", async () => {
  const env = await makeKeniInitialised([
    { id: "alice", role: "engineer" },
    { id: "bob", role: "qa" },
  ]);
  try {
    const outLines: string[] = [];
    const ctrl = new AbortController();
    const promise = runServer(
      ["--project", env.root, "--port", "0"],
      {
        out: (m) => outLines.push(m),
        err: () => {},
        shutdownSignal: ctrl.signal,
        workspaceProvisioner: new FakeWorkspaceProvisioner(),
      },
    );
    await waitFor(() => outLines.some((l) => l.startsWith("Keni server running at ")));
    const banner = outLines.find((l) => l.startsWith("Keni server running at "))!;
    const url = banner.replace(/^Keni server running at /, "");

    const res = await fetch(`${url}/agents`, { headers: { "X-Keni-Role": "user" } });
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      readonly project_id: string;
      readonly data: readonly {
        readonly id: string;
        readonly role: string;
        readonly status: string;
        readonly paused: boolean;
      }[];
    };
    assertEquals(body.project_id, "00000000-0000-4000-8000-000000000001");
    assertEquals(body.data.length, 2);
    assertEquals(body.data[0]!.id, "alice");
    assertEquals(body.data[0]!.role, "engineer");
    assertEquals(body.data[0]!.status, "idle");
    assertEquals(body.data[0]!.paused, false);
    assertEquals(body.data[1]!.id, "bob");
    assertEquals(body.data[1]!.role, "qa");

    ctrl.abort();
    const exit = await promise;
    assertEquals(exit, 0);
  } finally {
    await env.cleanup();
  }
});

Deno.test("runServer constructs the scheduler once, calls start() exactly once, and stops it before server.abort() on shutdown", async () => {
  const env = await makeKeniInitialised([
    { id: "alice", role: "engineer" },
  ]);
  try {
    interface SchedulerCall {
      readonly deps: SchedulerDeps;
      readonly opts: SchedulerOpts;
    }
    const calls: SchedulerCall[] = [];
    const events: string[] = [];
    let factoryInvocations = 0;
    let startCount = 0;
    let stopCount = 0;
    let stopResolved = false;

    const stubScheduler: Scheduler = {
      start(): void {
        startCount += 1;
        events.push("scheduler.start");
      },
      async stop(): Promise<void> {
        stopCount += 1;
        events.push("scheduler.stop:enter");
        await Promise.resolve();
        stopResolved = true;
        events.push("scheduler.stop:resolve");
      },
      interrupt(): Promise<InterruptResult> {
        return Promise.resolve({ interrupted: false, reason: "no_active_cycle" });
      },
      registerRunner(): void {},
    };

    const ctrl = new AbortController();
    const outLines: string[] = [];
    const promise = runServer(
      ["--project", env.root, "--port", "0"],
      {
        out: (m) => outLines.push(m),
        err: () => {},
        shutdownSignal: ctrl.signal,
        workspaceProvisioner: new FakeWorkspaceProvisioner(),
        makeScheduler: (deps, opts) => {
          factoryInvocations += 1;
          calls.push({ deps, opts });
          return stubScheduler;
        },
      },
    );

    await waitFor(() => outLines.some((l) => l.startsWith("Keni server running at ")));
    assertEquals(factoryInvocations, 1, "scheduler factory must be called exactly once");
    assertEquals(startCount, 1, "scheduler.start() must be called exactly once");
    assertEquals(calls[0]!.opts.agents.length, 1);
    assertEquals(calls[0]!.opts.agents[0]!.id, "alice");
    assertMatch(calls[0]!.opts.serverUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assertEquals(calls[0]!.opts.projectName, "test-project");

    ctrl.abort();
    const exit = await promise;
    assertEquals(exit, 0);
    assertEquals(stopCount, 1, "scheduler.stop() must be called exactly once");
    assertEquals(
      stopResolved,
      true,
      "runServer must await scheduler.stop() to completion before resolving",
    );
    assertEquals(
      events[0],
      "scheduler.start",
      "scheduler.start must precede scheduler.stop",
    );
    assertEquals(events.includes("scheduler.stop:resolve"), true);
  } finally {
    await env.cleanup();
  }
});

Deno.test("runServer forwards schedules and timeouts from project.yaml to the scheduler", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-server-runserver-cfg-" });
  const home = await Deno.makeTempDir({ prefix: "keni-server-runserver-cfg-home-" });
  try {
    const projectPaths = resolveProjectPaths(root);
    const globalPaths = resolveGlobalPaths(home);
    await Deno.mkdir(projectPaths.keni, { recursive: true });
    await Deno.mkdir(projectPaths.tickets, { recursive: true });
    await Deno.mkdir(projectPaths.prs, { recursive: true });
    await Deno.mkdir(projectPaths.activity, { recursive: true });
    const config = new FileConfigStore(projectPaths, globalPaths);
    await config.writeProjectConfig({
      project_id: "00000000-0000-4000-8000-000000000002",
      name: "cfg-project",
      agents: [{ id: "alice", role: "engineer" }],
      schedules: { engineer: "30s" },
      timeouts: { engineer: "20m" },
    });

    let captured: SchedulerOpts | null = null;
    const stubScheduler: Scheduler = {
      start() {},
      stop: () => Promise.resolve(),
      interrupt: () =>
        Promise.resolve<InterruptResult>({
          interrupted: false,
          reason: "no_active_cycle",
        }),
      registerRunner() {},
    };

    const ctrl = new AbortController();
    const outLines: string[] = [];
    const promise = runServer(
      ["--project", root, "--port", "0"],
      {
        out: (m) => outLines.push(m),
        err: () => {},
        shutdownSignal: ctrl.signal,
        homeDir: home,
        workspaceProvisioner: new FakeWorkspaceProvisioner(),
        makeScheduler: (_deps, opts) => {
          captured = opts;
          return stubScheduler;
        },
      },
    );
    await waitFor(() => outLines.some((l) => l.startsWith("Keni server running at ")));
    ctrl.abort();
    await promise;

    assertEquals(captured !== null, true);
    const opts = captured! as SchedulerOpts;
    assertEquals(opts.schedules?.engineer, "30s");
    assertEquals(opts.timeouts?.engineer, "20m");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --- Engineer-wiring tests (cron-scheduler-with-pause + engineer-runtime
//     orchestration-server delta). Validate that runServer:
//     • calls ensureProvisioned per engineer in roster order before
//       Deno.serve starts accepting any engineer-driven traffic;
//     • registers the engineer runner exactly once per engineer when
//       `makeEngineerRunner` is supplied;
//     • exits 1 with a clear stderr message on a provisioning failure
//       and never starts the scheduler;
//     • is a clean no-op when the roster contains zero engineers.

Deno.test("runServer awaits ensureProvisioned for every engineer before scheduler.start()", async () => {
  const env = await makeKeniInitialised([
    { id: "alice", role: "engineer" },
    { id: "bob", role: "engineer" },
    { id: "qa-1", role: "qa" },
  ]);
  try {
    const provisioner = new FakeWorkspaceProvisioner();
    const events: string[] = [];

    const stubScheduler: Scheduler = {
      start() {
        events.push("scheduler.start");
      },
      stop: () => Promise.resolve(),
      interrupt: () =>
        Promise.resolve<InterruptResult>({
          interrupted: false,
          reason: "no_active_cycle",
        }),
      registerRunner() {},
    };

    const ctrl = new AbortController();
    const outLines: string[] = [];
    const promise = runServer(
      ["--project", env.root, "--port", "0"],
      {
        out: (m) => outLines.push(m),
        err: () => {},
        shutdownSignal: ctrl.signal,
        workspaceProvisioner: provisioner,
        makeScheduler: () => stubScheduler,
      },
    );

    await waitFor(() => events.includes("scheduler.start"));

    const ensureCalls = provisioner.calls.filter((c) => c.method === "ensureProvisioned");
    assertEquals(ensureCalls.length, 2, "ensureProvisioned must be called per engineer");
    assertEquals(ensureCalls[0]!.args[1], "alice");
    assertEquals(ensureCalls[1]!.args[1], "bob");

    ctrl.abort();
    const exit = await promise;
    assertEquals(exit, 0);
  } finally {
    await env.cleanup();
  }
});

Deno.test("runServer registers an engineer runner per engineer when makeEngineerRunner is supplied", async () => {
  const env = await makeKeniInitialised([
    { id: "alice", role: "engineer" },
  ]);
  try {
    const provisioner = new FakeWorkspaceProvisioner();
    const registered: string[] = [];

    const ctrl = new AbortController();
    const outLines: string[] = [];
    const promise = runServer(
      ["--project", env.root, "--port", "0"],
      {
        out: (m) => outLines.push(m),
        err: () => {},
        shutdownSignal: ctrl.signal,
        workspaceProvisioner: provisioner,
        makeEngineerRunner: (input) => {
          registered.push(input.agentConfig.id);
          return {
            role: "engineer",
            precheck: () => ({ kind: "skip", reason: "no_ticket_to_pick_up" }),
            promptResolver: () => ({ name: "engineer", body: "stub" }),
            expectedPromptName: "engineer",
            codingAgentInvoker: {
              invoke: () => Promise.resolve({ kind: "completed" as const, exitCode: 0 }),
            },
            mcpServerConfig: { command: "true", args: [] },
          };
        },
      },
    );

    await waitFor(() => outLines.some((l) => l.startsWith("Keni server running at ")));
    assertEquals(registered, ["alice"]);

    ctrl.abort();
    const exit = await promise;
    assertEquals(exit, 0);
  } finally {
    await env.cleanup();
  }
});

Deno.test("runServer exits 1 with a clear stderr message on ensureProvisioned failure", async () => {
  const env = await makeKeniInitialised([
    { id: "alice", role: "engineer" },
  ]);
  try {
    const provisioner = new FakeWorkspaceProvisioner({
      ensureProvisionedRejection: new WorkspaceProvisioningError(
        "git_clone_failed",
        "boom: clone refused",
      ),
    });
    const errLines: string[] = [];
    let schedulerStarted = false;
    const stubScheduler: Scheduler = {
      start() {
        schedulerStarted = true;
      },
      stop: () => Promise.resolve(),
      interrupt: () =>
        Promise.resolve<InterruptResult>({
          interrupted: false,
          reason: "no_active_cycle",
        }),
      registerRunner() {},
    };

    const code = await runServer(
      ["--project", env.root, "--port", "0"],
      {
        out: () => {},
        err: (m) => errLines.push(m),
        workspaceProvisioner: provisioner,
        makeScheduler: () => stubScheduler,
      },
    );

    assertEquals(code, 1);
    assertEquals(
      schedulerStarted,
      false,
      "scheduler.start must not run after a provisioning failure",
    );
    assertEquals(
      errLines.some((l) => l.includes("alice") && l.includes("boom")),
      true,
      `stderr must name the failed engineer and the error message; got: ${
        JSON.stringify(errLines)
      }`,
    );
  } finally {
    await env.cleanup();
  }
});

Deno.test("runServer skips engineer-wiring entirely on a roster with zero engineers", async () => {
  const env = await makeKeniInitialised([
    { id: "qa-1", role: "qa" },
    { id: "po-1", role: "po" },
  ]);
  try {
    const provisioner = new FakeWorkspaceProvisioner();
    const ctrl = new AbortController();
    const outLines: string[] = [];
    const promise = runServer(
      ["--project", env.root, "--port", "0"],
      {
        out: (m) => outLines.push(m),
        err: () => {},
        shutdownSignal: ctrl.signal,
        workspaceProvisioner: provisioner,
      },
    );
    await waitFor(() => outLines.some((l) => l.startsWith("Keni server running at ")));

    assertEquals(provisioner.calls.length, 0);

    ctrl.abort();
    const exit = await promise;
    assertEquals(exit, 0);
  } finally {
    await env.cleanup();
  }
});
