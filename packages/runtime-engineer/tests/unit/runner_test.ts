/**
 * Unit tests for {@link createEngineerRunner} — factory purity, the
 * precheck's pull-main-first / in-flight / pickup / skip ladder, and
 * the prompt resolver's bundled-prompt return shape.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import type {
  CodingAgentInvocation,
  CodingAgentInvoker,
  CodingAgentLifecycle,
  CodingAgentOutcome,
  CyclePrepCtx,
  PrecheckResult,
} from "@keni/runtime-common";
import type { AgentId, TicketFilter, TicketSummary } from "@keni/shared";

const ALICE = "alice" as AgentId;
import { ENGINEER_PROMPT_BODY, ENGINEER_PROMPT_NAME } from "../../src/prompts/engineer.ts";
import {
  buildEngineerMcpServerConfig,
  createEngineerRunner,
  type EngineerActivityHttpClient,
  orderEngineerTickets,
} from "../../src/runner.ts";
import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace/test-fakes";
import { type WorkspaceLogger, WorkspaceProvisioningError } from "@keni/runtime-workspace";

interface CapturedLine {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function captureLogger(): { logger: WorkspaceLogger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  return {
    logger: {
      log: (level, event, fields) => {
        lines.push({ level, event, fields: fields ?? {} });
      },
    },
    lines,
  };
}

function summary(
  id: string,
  status: TicketSummary["status"],
  priority: number,
  assignee: string | null = null,
): TicketSummary {
  return {
    id,
    title: `t ${id}`,
    status,
    assignee,
    priority,
    change_request: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
  };
}

interface FakeHttpClient extends EngineerActivityHttpClient {
  readonly calls: { filter: TicketFilter }[];
}

interface FakeHttpOpts {
  readonly inFlight?: readonly TicketSummary[];
  readonly pickup?: readonly TicketSummary[];
}

function fakeHttp(opts: FakeHttpOpts = {}): FakeHttpClient {
  const calls: { filter: TicketFilter }[] = [];
  const inFlight = opts.inFlight ?? [];
  const pickup = opts.pickup ?? [];
  return {
    calls,
    listTickets: (filter) => {
      calls.push({ filter });
      if (filter.assignee === null) return Promise.resolve(pickup);
      return Promise.resolve(inFlight);
    },
  };
}

const noopInvoker: CodingAgentInvoker = {
  invoke: (_invocation: CodingAgentInvocation, _lifecycle: CodingAgentLifecycle) => {
    throw new Error("noop invoker should not be invoked in factory tests");
  },
};

const ctx: CyclePrepCtx = {
  role: "engineer",
  agentId: ALICE,
  projectName: "demo",
  workspacePath: "/tmp/keni-fake-home/.keni/workspaces/p1/alice",
  serverUrl: "http://127.0.0.1:5174",
};

function defaultOpts() {
  const provisioner = new FakeWorkspaceProvisioner();
  return {
    provisioner,
    opts: {
      projectId: "p1",
      projectName: "demo",
      agentId: ALICE,
      projectRepoPath: "/tmp/repo",
      serverUrl: "http://127.0.0.1:5174",
      workspacePath: provisioner.workspacePathFor("p1", "alice"),
      mcpServerConfig: buildEngineerMcpServerConfig({
        agentId: ALICE,
        serverUrl: "http://127.0.0.1:5174",
        workspacePath: provisioner.workspacePathFor("p1", "alice"),
        mcpEntryPath: "/no/such/main.ts",
      }),
    },
  };
}

Deno.test("orderEngineerTickets sorts by priority desc, id asc", () => {
  const out = orderEngineerTickets([
    summary("ticket-0003", "open", 50),
    summary("ticket-0001", "open", 100),
    summary("ticket-0002", "open", 100),
  ]);
  assertEquals(out.map((t) => t.id), ["ticket-0001", "ticket-0002", "ticket-0003"]);
});

Deno.test("createEngineerRunner returns role 'engineer' and expectedPromptName 'engineer'", () => {
  const { provisioner, opts } = defaultOpts();
  const { logger } = captureLogger();
  const runner = createEngineerRunner(
    {
      provisioner,
      codingAgentInvoker: noopInvoker,
      activityHttpClient: fakeHttp(),
      logger,
    },
    opts,
  );
  assertEquals(runner.role, "engineer");
  assertEquals(runner.expectedPromptName, "engineer");
  assertEquals(typeof runner.precheck, "function");
  assertEquals(typeof runner.promptResolver, "function");
  assertEquals(runner.codingAgentInvoker, noopInvoker);
});

Deno.test("createEngineerRunner is pure — no I/O at construction", () => {
  const { provisioner, opts } = defaultOpts();
  const { logger } = captureLogger();
  const http = fakeHttp({
    inFlight: [summary("ticket-0001", "in_progress", 100, "alice")],
  });
  // The mcpServerConfig built by defaultOpts() calls workspacePathFor() once
  // outside the factory; reset the calls to assert the factory itself does no I/O.
  provisioner.calls.length = 0;
  createEngineerRunner(
    { provisioner, codingAgentInvoker: noopInvoker, activityHttpClient: http, logger },
    opts,
  );
  assertEquals(provisioner.calls.length, 0);
  assertEquals(http.calls.length, 0);
});

Deno.test("promptResolver returns the bundled engineer prompt", () => {
  const { provisioner, opts } = defaultOpts();
  const { logger } = captureLogger();
  const runner = createEngineerRunner(
    {
      provisioner,
      codingAgentInvoker: noopInvoker,
      activityHttpClient: fakeHttp(),
      logger,
    },
    opts,
  );
  const prompt = runner.promptResolver(ctx);
  assertEquals(prompt.name, ENGINEER_PROMPT_NAME);
  assertEquals(prompt.body, ENGINEER_PROMPT_BODY);
});

Deno.test("precheck calls pullMain first, before any HTTP query", async () => {
  const { provisioner, opts } = defaultOpts();
  const { logger } = captureLogger();
  const http = fakeHttp({ inFlight: [summary("ticket-0001", "in_progress", 100, "alice")] });
  const runner = createEngineerRunner(
    { provisioner, codingAgentInvoker: noopInvoker, activityHttpClient: http, logger },
    opts,
  );
  provisioner.calls.length = 0;

  const result = await runner.precheck(ctx);

  const firstCall = provisioner.calls[0];
  assertEquals(firstCall?.method, "pullMain");
  if (firstCall && firstCall.method === "pullMain") {
    assertEquals(firstCall.args, ["p1", "alice"]);
  }
  assertEquals(http.calls.length, 1);
  assertEquals(result.kind, "proceed");
});

Deno.test("precheck: pullMain failure short-circuits to skip with no HTTP traffic", async () => {
  const provisioner = new FakeWorkspaceProvisioner({
    pullMainRejection: new WorkspaceProvisioningError(
      "pull_main_failed",
      "non-fast-forward",
    ),
  });
  const opts = {
    projectId: "p1",
    projectName: "demo",
    agentId: ALICE,
    projectRepoPath: "/tmp/repo",
    serverUrl: "http://127.0.0.1:5174",
    workspacePath: provisioner.workspacePathFor("p1", "alice"),
    mcpServerConfig: buildEngineerMcpServerConfig({
      agentId: ALICE,
      serverUrl: "http://127.0.0.1:5174",
      workspacePath: provisioner.workspacePathFor("p1", "alice"),
      mcpEntryPath: "/no/such/main.ts",
    }),
  };
  const { logger, lines } = captureLogger();
  const http = fakeHttp({ inFlight: [summary("ticket-0001", "in_progress", 100, "alice")] });
  const runner = createEngineerRunner(
    { provisioner, codingAgentInvoker: noopInvoker, activityHttpClient: http, logger },
    opts,
  );

  const result = await runner.precheck(ctx);

  assertEquals(result, { kind: "skip", reason: "pull_main_failed" });
  assertEquals(http.calls.length, 0);
  const warns = lines.filter((l) => l.event === "engineer.pull_main_failed");
  assertEquals(warns.length, 1);
  assertEquals(warns[0]?.fields.agent, "alice");
  assertEquals(warns[0]?.fields.error, "non-fast-forward");
});

Deno.test("precheck: in-flight ticket preferred over unassigned open", async () => {
  const { provisioner, opts } = defaultOpts();
  const { logger } = captureLogger();
  const http = fakeHttp({
    inFlight: [summary("ticket-0007", "in_progress", 50, "alice")],
    pickup: [summary("ticket-0003", "open", 100)],
  });
  const runner = createEngineerRunner(
    { provisioner, codingAgentInvoker: noopInvoker, activityHttpClient: http, logger },
    opts,
  );

  const result = await runner.precheck(ctx);

  assertEquals(
    result,
    {
      kind: "proceed",
      roleContext: { summary: "ticket-0007 (in-flight)" },
    } satisfies PrecheckResult,
  );
  assertEquals(http.calls.length, 1);
  assertEquals(http.calls[0]?.filter.assignee, "alice");
});

Deno.test("precheck: pickup uses priority desc, id asc", async () => {
  const { provisioner, opts } = defaultOpts();
  const { logger } = captureLogger();
  const http = fakeHttp({
    pickup: [
      summary("ticket-0003", "open", 50),
      summary("ticket-0001", "open", 100),
      summary("ticket-0002", "open", 100),
    ],
  });
  const runner = createEngineerRunner(
    { provisioner, codingAgentInvoker: noopInvoker, activityHttpClient: http, logger },
    opts,
  );

  const result = await runner.precheck(ctx);

  assertEquals(
    result,
    {
      kind: "proceed",
      roleContext: { summary: "ticket-0001 (picking up)" },
    } satisfies PrecheckResult,
  );
  assertEquals(http.calls.length, 2);
});

Deno.test("precheck: empty board returns skip with no_ticket_to_pick_up", async () => {
  const { provisioner, opts } = defaultOpts();
  const { logger } = captureLogger();
  const http = fakeHttp();
  const runner = createEngineerRunner(
    { provisioner, codingAgentInvoker: noopInvoker, activityHttpClient: http, logger },
    opts,
  );

  const result = await runner.precheck(ctx);

  assertEquals(result, { kind: "skip", reason: "no_ticket_to_pick_up" });
  assertEquals(http.calls.length, 2);
});

Deno.test("buildEngineerMcpServerConfig encodes agent / server / workspace flags", () => {
  const config = buildEngineerMcpServerConfig({
    agentId: ALICE,
    serverUrl: "http://127.0.0.1:5174",
    workspacePath: "/tmp/h/.keni/workspaces/p1/alice",
    mcpEntryPath: "/abs/main.ts",
  });
  assertEquals(config.command, "deno");
  assert(config.args.includes("--agent"));
  assert(config.args.includes("alice"));
  assert(config.args.includes("--server-url"));
  assert(config.args.includes("http://127.0.0.1:5174"));
  assert(config.args.includes("--workspace"));
  assert(config.args.includes("/tmp/h/.keni/workspaces/p1/alice"));
  assert(config.args.includes("/abs/main.ts"));
});

Deno.test("optional opts are propagated through the runner bag", () => {
  const { provisioner, opts } = defaultOpts();
  const { logger } = captureLogger();
  const runner = createEngineerRunner(
    {
      provisioner,
      codingAgentInvoker: noopInvoker,
      activityHttpClient: fakeHttp(),
      logger,
    },
    {
      ...opts,
      idleThresholdMs: 333,
      terminationGraceMs: 7000,
      envAllowlist: ["HOME", "PATH"],
    },
  );
  assertEquals(runner.idleThresholdMs, 333);
  assertEquals(runner.terminationGraceMs, 7000);
  assertEquals(runner.envAllowlist, ["HOME", "PATH"]);
});

Deno.test(
  "createEngineerRunner propagates workspacePath onto the returned runner bag — the scheduler reads it back to build RoleCycleParams.workspacePath, which is in turn what the workspace-rooted MCP-config strategies require",
  () => {
    const { provisioner, opts } = defaultOpts();
    const { logger } = captureLogger();
    const runner = createEngineerRunner(
      {
        provisioner,
        codingAgentInvoker: noopInvoker,
        activityHttpClient: fakeHttp(),
        logger,
      },
      opts,
    );
    assertEquals(runner.workspacePath, provisioner.workspacePathFor("p1", "alice"));
  },
);

Deno.test("noopOutcome type-only ensures CodingAgentOutcome is importable", () => {
  // Compile-time only — exercises the `CodingAgentOutcome` import to keep
  // the module's contract surface pinned.
  const _outcome: CodingAgentOutcome = { kind: "completed", exitCode: 0 };
  assertEquals(_outcome.kind, "completed");
});
