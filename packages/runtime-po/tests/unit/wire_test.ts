import { assert, assertEquals } from "@std/assert";
import type {
  ActivityHttpClient,
  CodingAgentCliEntry,
  CyclePrepCtx,
  WireInput,
} from "@keni/runtime-common";
import { codingAgentCliRegistry } from "@keni/runtime-common";
import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace/test-fakes";
import type { AgentConfig, AgentId, ResolvedConfig, TicketFilter } from "@keni/shared";

import { PO_PROMPT_BODY, PO_PROMPT_NAME } from "../../src/prompts/po.ts";
import { wire } from "../../src/wire.ts";

const PETRA = "petra" as AgentId;

const stubActivityHttpClient: ActivityHttpClient = {
  listTickets: (_filter: TicketFilter) => Promise.resolve([]),
};

const FAKE_REGISTRY: Readonly<Record<string, CodingAgentCliEntry>> = {
  ...codingAgentCliRegistry,
};

function makeInput(agent: AgentConfig): WireInput {
  return {
    projectId: "p1",
    projectName: "demo",
    projectRepoPath: "/tmp/demo-repo",
    serverUrl: "http://127.0.0.1:9999",
    agentConfig: agent,
    resolvedConfig: {} as ResolvedConfig,
    mcpEntryPath: "/abs/mcp/main.ts",
    logger: { log: () => {} },
    makeActivityHttpClient: () => stubActivityHttpClient,
    codingAgentCliRegistry: FAKE_REGISTRY,
    workspaceProvisioner: new FakeWorkspaceProvisioner(),
  };
}

const ctx: CyclePrepCtx = {
  role: "po",
  agentId: PETRA,
  projectName: "demo",
  workspacePath: null,
  serverUrl: "http://127.0.0.1:9999",
};

Deno.test("wire returns an AgentRunner whose role is 'po'", async () => {
  const runner = await wire(makeInput({ id: "petra", role: "po" }));

  assert(runner !== null, "expected wire to register a PO runner");
  assertEquals(runner.role, "po");
  assertEquals(runner.expectedPromptName, "po");
  assertEquals(runner.workspacePath, undefined);
});

Deno.test(
  "the PO runner's precheck always resolves { kind: 'skip', reason: 'po_not_implemented' }",
  async () => {
    const runner = await wire(makeInput({ id: "petra", role: "po" }));
    assert(runner !== null);

    const result = await runner.precheck(ctx);
    assertEquals(result, { kind: "skip", reason: "po_not_implemented" });
  },
);

Deno.test("the PO runner's promptResolver returns the bundled PO prompt", async () => {
  const runner = await wire(makeInput({ id: "petra", role: "po" }));
  assert(runner !== null);

  const prompt = runner.promptResolver(ctx);
  assertEquals(prompt.name, PO_PROMPT_NAME);
  assertEquals(prompt.body, PO_PROMPT_BODY);
});

Deno.test("the PO mcpServerConfig is the documented placeholder shape", async () => {
  const input = makeInput({ id: "petra", role: "po" });
  const runner = await wire(input);
  assert(runner !== null);

  assertEquals(runner.mcpServerConfig.command, "deno");
  assertEquals(runner.mcpServerConfig.args, [
    "run",
    "-A",
    input.mcpEntryPath,
    "--agent",
    "petra",
    "--server-url",
    input.serverUrl,
    "--workspace",
    "/dev/null",
  ]);
});

Deno.test(
  "wire returns null defensively when called with a non-po agentConfig.role",
  async () => {
    const runner = await wire(makeInput({ id: "alice", role: "engineer" }));
    assertEquals(runner, null);
  },
);

Deno.test(
  "the PO wire never spawns the coding-agent CLI (workspaceProvisioner.calls stays empty)",
  async () => {
    const input = makeInput({ id: "petra", role: "po" });
    const provisioner = input.workspaceProvisioner as FakeWorkspaceProvisioner;
    const runner = await wire(input);
    assert(runner !== null);

    assertEquals(provisioner.calls.length, 0);
  },
);
