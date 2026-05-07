/**
 * Pin the production `buildProductionEngineerRunnerFactory` resolution
 * rules (per-agent → global → null) and the documented
 * `engineer.runner_skipped` log contract.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CodingAgentCliEntry,
  codingAgentCliRegistry,
  type EngineerActivityHttpClient,
  type WorkspaceLogger,
  type WorkspaceLogLevel,
} from "@keni/role-runtimes";
import { FakeWorkspaceProvisioner } from "@keni/role-runtimes/test-fakes";
import type { MakeEngineerRunnerInput } from "@keni/server";
import type { AgentConfig, ResolvedConfig, TicketFilter, TicketSummary } from "@keni/shared";
import { buildProductionEngineerRunnerFactory } from "../../../src/start/engineerRunner.ts";

interface CapturedLogEntry {
  readonly level: WorkspaceLogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function captureLogger(buffer: CapturedLogEntry[]): WorkspaceLogger {
  return {
    log(level, event, fields) {
      buffer.push({ level, event, fields: fields ?? {} });
    },
  };
}

const stubActivityHttpClient: EngineerActivityHttpClient = {
  listTickets: (_filter: TicketFilter): Promise<readonly TicketSummary[]> => {
    return Promise.resolve([]);
  },
};

function makeInput(agent: AgentConfig): MakeEngineerRunnerInput {
  return {
    projectId: "p1",
    projectName: "demo",
    agentConfig: agent,
    serverUrl: "http://127.0.0.1:9999",
    projectRepoPath: "/tmp/demo-repo",
    provisioner: new FakeWorkspaceProvisioner(),
    // The engineer-runner factory does not actually use this logger
    // (the helper passes its own dep-supplied logger to
    // `createEngineerRunner`); the field is required by the input
    // shape, so we satisfy it with a no-op sink.
    logger: { log: () => {} },
  };
}

const FAKE_REGISTRY: Readonly<Record<string, CodingAgentCliEntry>> = {
  ...codingAgentCliRegistry,
};

const HELPER_DEPS_BASE = {
  registry: FAKE_REGISTRY,
  mcpEntryPath: "/abs/mcp/main.ts",
  makeActivityHttpClient: (
    _serverUrl: string,
    _agentId: string,
  ): EngineerActivityHttpClient => stubActivityHttpClient,
};

Deno.test(
  "configured global coding_agent_cli registers a runner with the matching registry entry",
  () => {
    const log: CapturedLogEntry[] = [];
    const resolvedConfig: ResolvedConfig = { coding_agent_cli: "claude" };
    const factory = buildProductionEngineerRunnerFactory({
      ...HELPER_DEPS_BASE,
      resolvedConfig,
      logger: captureLogger(log),
    });

    const input = makeInput({ id: "alice", role: "engineer" });
    const runner = factory(input);
    assert(runner !== null, "expected a registered engineer runner");
    assertEquals(runner.role, "engineer");
    // The production helper MUST forward the per-agent workspace path
    // onto the runner bag — the scheduler reads this off the runner to
    // build `RoleCycleParams.workspacePath`, which the workspace-rooted
    // MCP-config strategies (`workspace-json` / `workspace-toml`) require
    // to materialise their config files.
    assertEquals(
      runner.workspacePath,
      input.provisioner.workspacePathFor(input.projectId, input.agentConfig.id),
    );
    assertEquals(
      log.length,
      0,
      `unexpected log lines: ${JSON.stringify(log)}`,
    );
  },
);

Deno.test("per-agent cli wins over the global coding_agent_cli", () => {
  const log: CapturedLogEntry[] = [];
  const resolvedConfig: ResolvedConfig = { coding_agent_cli: "claude" };
  const factory = buildProductionEngineerRunnerFactory({
    ...HELPER_DEPS_BASE,
    resolvedConfig,
    logger: captureLogger(log),
  });

  // No public way to introspect the constructed invoker's bound
  // cliBinary from outside the helper, so we exercise the resolution
  // path via the unknown-cli branch: setting a per-agent override to a
  // value not in the registry forces the unknown-cli warn.
  const runner = factory(
    makeInput({ id: "bob", role: "engineer", cli: "homebrew-toy" }),
  );
  assertEquals(runner, null, "unknown per-agent cli must skip");
  assertEquals(log.length, 1);
  assertEquals(log[0]?.level, "warn");
  assertEquals(log[0]?.event, "engineer.runner_skipped");
  assertEquals(log[0]?.fields.agent, "bob");
  assertEquals(log[0]?.fields.reason, "unknown_cli");
  assertEquals(log[0]?.fields.configured_cli, "homebrew-toy");
});

Deno.test(
  "no CLI configured anywhere logs engineer.runner_skipped with reason no_cli_configured and returns null",
  () => {
    const log: CapturedLogEntry[] = [];
    const resolvedConfig: ResolvedConfig = {};
    const factory = buildProductionEngineerRunnerFactory({
      ...HELPER_DEPS_BASE,
      resolvedConfig,
      logger: captureLogger(log),
    });

    const runner = factory(makeInput({ id: "alice", role: "engineer" }));
    assertEquals(runner, null);
    assertEquals(log.length, 1);
    const entry = log[0]!;
    assertEquals(entry.level, "warn");
    assertEquals(entry.event, "engineer.runner_skipped");
    assertEquals(entry.fields.agent, "alice");
    assertEquals(entry.fields.reason, "no_cli_configured");
    assertEquals(entry.fields.configured_cli, null);
    assertEquals(
      entry.fields.supported,
      ["claude", "codex", "cursor-agent"],
      "supported list should be the sorted closed set",
    );
  },
);

Deno.test(
  "an unknown global coding_agent_cli logs engineer.runner_skipped with reason unknown_cli",
  () => {
    const log: CapturedLogEntry[] = [];
    const resolvedConfig: ResolvedConfig = { coding_agent_cli: "claud" };
    const factory = buildProductionEngineerRunnerFactory({
      ...HELPER_DEPS_BASE,
      resolvedConfig,
      logger: captureLogger(log),
    });

    const runner = factory(makeInput({ id: "alice", role: "engineer" }));
    assertEquals(runner, null);
    assertEquals(log.length, 1);
    const entry = log[0]!;
    assertEquals(entry.event, "engineer.runner_skipped");
    assertEquals(entry.fields.reason, "unknown_cli");
    assertEquals(entry.fields.configured_cli, "claud");
    assertEquals(entry.fields.supported, ["claude", "codex", "cursor-agent"]);
  },
);

Deno.test(
  "two engineers with mixed configs: one registers, one skips, both outcomes happen in the same boot",
  () => {
    const log: CapturedLogEntry[] = [];
    const resolvedConfig: ResolvedConfig = { coding_agent_cli: "claude" };
    const factory = buildProductionEngineerRunnerFactory({
      ...HELPER_DEPS_BASE,
      resolvedConfig,
      logger: captureLogger(log),
    });

    const aliceRunner = factory(makeInput({ id: "alice", role: "engineer" }));
    const bobRunner = factory(
      makeInput({ id: "bob", role: "engineer", cli: "homebrew-toy" }),
    );

    assert(aliceRunner !== null, "alice should register against the global claude");
    assertEquals(bobRunner, null, "bob should skip with unknown_cli");

    assertEquals(log.length, 1, "exactly one warn for bob");
    assertEquals(log[0]?.fields.agent, "bob");
    assertEquals(log[0]?.fields.reason, "unknown_cli");
  },
);

Deno.test("the helper's closure does not throw on any documented input shape", () => {
  const log: CapturedLogEntry[] = [];
  const factory = buildProductionEngineerRunnerFactory({
    ...HELPER_DEPS_BASE,
    resolvedConfig: { coding_agent_cli: "claude" },
    logger: captureLogger(log),
  });

  // Empty per-agent cli string is treated as absent (falls through to
  // global).
  const r1 = factory(makeInput({ id: "a", role: "engineer", cli: "" }));
  assert(r1 !== null);

  // Non-engineer role still goes through the resolution path; the
  // helper does not gate on `role` (the scheduler only consumes
  // engineer registrations, but the helper itself is role-agnostic at
  // this layer).
  const r2 = factory(makeInput({ id: "b", role: "engineer", cli: "claude" }));
  assert(r2 !== null);

  // No throws expected.
});

Deno.test(
  "an extended registry (test override) is honoured by the helper",
  () => {
    const log: CapturedLogEntry[] = [];
    const fixtureEntry: CodingAgentCliEntry = {
      cliBinary: "fake",
      buildArgs: () => [],
      promptInjection: "stdin",
      resumeFlag: "--resume",
      envAllowlist: ["HOME", "PATH"],
      mcpConfigStrategy: { kind: "tempfile-json" },
    };
    const extended: Readonly<Record<string, CodingAgentCliEntry>> = {
      ...codingAgentCliRegistry,
      "fake-coding-agent": fixtureEntry,
    };
    const factory = buildProductionEngineerRunnerFactory({
      registry: extended,
      mcpEntryPath: "/abs/mcp/main.ts",
      makeActivityHttpClient: () => stubActivityHttpClient,
      resolvedConfig: { coding_agent_cli: "fake-coding-agent" },
      logger: captureLogger(log),
    });

    const runner = factory(makeInput({ id: "alice", role: "engineer" }));
    assert(runner !== null, "the fixture entry should resolve");
    assertEquals(log.length, 0);
  },
);
