/**
 * Pin the engineer `wire(input)` resolution rules (per-agent → global
 * → null) and the documented `engineer.runner_skipped` log contract.
 *
 * Migrated to exercise the role-package's `wire` export directly per
 * `split-role-runtimes-package` §9.3 — the previous
 * `buildProductionEngineerRunnerFactory` helper from `cli/src/start/`
 * is gone; the same scenarios now run against the polymorphic
 * `WireFn` shape.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ActivityHttpClient,
  type CodingAgentCliEntry,
  codingAgentCliRegistry,
  type WireInput,
} from "@keni/runtime-common";
import { wire as engineerWire } from "@keni/runtime-engineer";
import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace/test-fakes";
import type { WorkspaceLogger, WorkspaceLogLevel } from "@keni/runtime-workspace";
import type { AgentConfig, ResolvedConfig, TicketFilter, TicketSummary } from "@keni/shared";

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

const stubActivityHttpClient: ActivityHttpClient = {
  listTickets: (_filter: TicketFilter): Promise<readonly TicketSummary[]> => {
    return Promise.resolve([]);
  },
};

interface MakeInputOpts {
  readonly agent: AgentConfig;
  readonly resolvedConfig: ResolvedConfig;
  readonly registry: Readonly<Record<string, CodingAgentCliEntry>>;
  readonly logger: WorkspaceLogger;
  readonly provisioner?: FakeWorkspaceProvisioner;
}

function makeInput(opts: MakeInputOpts): WireInput {
  return {
    projectId: "p1",
    projectName: "demo",
    projectRepoPath: "/tmp/demo-repo",
    serverUrl: "http://127.0.0.1:9999",
    agentConfig: opts.agent,
    resolvedConfig: opts.resolvedConfig,
    mcpEntryPath: "/abs/mcp/main.ts",
    logger: opts.logger,
    makeActivityHttpClient: (
      _serverUrl: string,
      _agentId: string,
    ): ActivityHttpClient => stubActivityHttpClient,
    codingAgentCliRegistry: opts.registry,
    workspaceProvisioner: opts.provisioner ?? new FakeWorkspaceProvisioner(),
  };
}

const FAKE_REGISTRY: Readonly<Record<string, CodingAgentCliEntry>> = {
  ...codingAgentCliRegistry,
};

Deno.test(
  "configured global coding_agent_cli registers a runner with the matching registry entry",
  async () => {
    const log: CapturedLogEntry[] = [];
    const provisioner = new FakeWorkspaceProvisioner();
    const input = makeInput({
      agent: { id: "alice", role: "engineer" },
      resolvedConfig: { coding_agent_cli: "claude" },
      registry: FAKE_REGISTRY,
      logger: captureLogger(log),
      provisioner,
    });

    const runner = await engineerWire(input);
    assert(runner !== null, "expected a registered engineer runner");
    assertEquals(runner.role, "engineer");
    assertEquals(
      runner.workspacePath,
      provisioner.workspacePathFor(input.projectId, input.agentConfig.id),
    );
    assertEquals(
      log.length,
      0,
      `unexpected log lines: ${JSON.stringify(log)}`,
    );
  },
);

Deno.test("per-agent cli wins over the global coding_agent_cli", async () => {
  const log: CapturedLogEntry[] = [];
  const runner = await engineerWire(
    makeInput({
      agent: { id: "bob", role: "engineer", cli: "homebrew-toy" },
      resolvedConfig: { coding_agent_cli: "claude" },
      registry: FAKE_REGISTRY,
      logger: captureLogger(log),
    }),
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
  async () => {
    const log: CapturedLogEntry[] = [];
    const runner = await engineerWire(
      makeInput({
        agent: { id: "alice", role: "engineer" },
        resolvedConfig: {},
        registry: FAKE_REGISTRY,
        logger: captureLogger(log),
      }),
    );
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
  async () => {
    const log: CapturedLogEntry[] = [];
    const runner = await engineerWire(
      makeInput({
        agent: { id: "alice", role: "engineer" },
        resolvedConfig: { coding_agent_cli: "claud" },
        registry: FAKE_REGISTRY,
        logger: captureLogger(log),
      }),
    );
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
  async () => {
    const log: CapturedLogEntry[] = [];
    const resolvedConfig: ResolvedConfig = { coding_agent_cli: "claude" };
    const baseLogger = captureLogger(log);

    const aliceRunner = await engineerWire(
      makeInput({
        agent: { id: "alice", role: "engineer" },
        resolvedConfig,
        registry: FAKE_REGISTRY,
        logger: baseLogger,
      }),
    );
    const bobRunner = await engineerWire(
      makeInput({
        agent: { id: "bob", role: "engineer", cli: "homebrew-toy" },
        resolvedConfig,
        registry: FAKE_REGISTRY,
        logger: baseLogger,
      }),
    );

    assert(aliceRunner !== null, "alice should register against the global claude");
    assertEquals(bobRunner, null, "bob should skip with unknown_cli");

    assertEquals(log.length, 1, "exactly one warn for bob");
    assertEquals(log[0]?.fields.agent, "bob");
    assertEquals(log[0]?.fields.reason, "unknown_cli");
  },
);

Deno.test("the wire does not throw on any documented input shape", async () => {
  const log: CapturedLogEntry[] = [];
  const baseLogger = captureLogger(log);

  // Empty per-agent cli string is treated as absent (falls through to
  // global).
  const r1 = await engineerWire(
    makeInput({
      agent: { id: "a", role: "engineer", cli: "" },
      resolvedConfig: { coding_agent_cli: "claude" },
      registry: FAKE_REGISTRY,
      logger: baseLogger,
    }),
  );
  assert(r1 !== null);

  // Per-agent cli wins.
  const r2 = await engineerWire(
    makeInput({
      agent: { id: "b", role: "engineer", cli: "claude" },
      resolvedConfig: { coding_agent_cli: "claude" },
      registry: FAKE_REGISTRY,
      logger: baseLogger,
    }),
  );
  assert(r2 !== null);
});

Deno.test(
  "an extended registry (test override) is honoured by the wire",
  async () => {
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
    const runner = await engineerWire(
      makeInput({
        agent: { id: "alice", role: "engineer" },
        resolvedConfig: { coding_agent_cli: "fake-coding-agent" },
        registry: extended,
        logger: captureLogger(log),
      }),
    );
    assert(runner !== null, "the fixture entry should resolve");
    assertEquals(log.length, 0);
  },
);
