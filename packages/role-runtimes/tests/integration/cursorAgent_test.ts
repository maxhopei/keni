/**
 * Integration sanity-check for the `cursor-agent` registry entry — closes
 * `engineer-runner-production-wiring/tasks.md#6.1`.
 *
 * What this test guards against: a future `cursor-agent` release that
 * removes / renames the flags the registry entry targets (`--print`,
 * `--approve-mcps`, `--workspace`) or re-introduces an `--mcp-config`
 * flag the entry would then be expected to wire through. The argv
 * shape lives in `packages/role-runtimes/src/common/codingAgentClis/cursorAgent.ts`;
 * the `workspace-json` MCP-config strategy semantics (merge-don't-overwrite,
 * cwd plumbing) are exercised by the unit tests in
 * `codingAgentInvoker_test.ts`.
 *
 * The test is gated on `cursor-agent` being on `PATH`. Machines without
 * the binary skip via `Deno.test.ignore` so CI without the binary still
 * passes; the maintainer's local run exercises the flag-presence check
 * against the installed `v2026.04.15-dccdccd`+ binary.
 *
 * The full end-to-end test (real LLM auth, real stdio MCP server,
 * tools/list assertion) is out of scope here — it's a follow-up that
 * needs an authenticated `cursor-agent` setup the maintainer's machine
 * may not have. The unit-test invariants + this argv-flag sanity check
 * cover the bug class this change closes.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { type CodingAgentCliEntry, codingAgentCliRegistry } from "../../src/main.ts";

async function isCursorAgentOnPath(): Promise<boolean> {
  try {
    const proc = new Deno.Command("cursor-agent", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    return (await proc.output()).code === 0;
  } catch {
    return false;
  }
}

const CURSOR_AGENT_AVAILABLE = await isCursorAgentOnPath();

const itCursorAgent = (
  label: string,
  fn: () => void | Promise<void>,
) => {
  if (CURSOR_AGENT_AVAILABLE) {
    Deno.test(label, fn);
    return;
  }
  Deno.test.ignore(`${label} (skipped: cursor-agent not on PATH)`, fn);
};

itCursorAgent(
  "cursor-agent registry entry: argv flags exist in the installed binary's --help output",
  async () => {
    const proc = new Deno.Command("cursor-agent", {
      args: ["--help"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await proc.output();
    assertEquals(code, 0, "cursor-agent --help must exit 0");

    const help = new TextDecoder().decode(stdout);

    // The entry's `buildArgs` references these flags. If a future CLI
    // release removes or renames them, this test fails fast.
    assert(
      help.includes("--print") || help.includes("-p, --print"),
      `cursor-agent --help must document --print (used by the registry entry's buildArgs)`,
    );
    assert(
      help.includes("--approve-mcps"),
      `cursor-agent --help must document --approve-mcps (used by the registry entry's buildArgs)`,
    );
    assert(
      help.includes("--workspace"),
      `cursor-agent --help must document --workspace (used by the registry entry's buildArgs)`,
    );

    // The bug this change fixes is that the prior entry passed
    // `--mcp-config <path>` to a CLI that does not accept it. If a
    // future CLI release re-introduces the flag, this test surfaces
    // the choice — at which point the entry MAY switch to
    // `tempfile-json` strategy and add `--mcp-config` to its
    // `buildArgs`. Until then, the entry's MCP-config is materialised
    // via `workspace-json` against `<workspace>/.cursor/mcp.json`.
    assert(
      !help.includes("--mcp-config"),
      `cursor-agent --help must NOT document --mcp-config; if it does, revisit the entry's mcpConfigStrategy`,
    );
  },
);

itCursorAgent(
  "cursor-agent registry entry: building argv from the entry produces every documented flag",
  () => {
    const entry: CodingAgentCliEntry = codingAgentCliRegistry["cursor-agent"];
    const argv = entry.buildArgs(
      {
        promptBody: "ping",
        role: "engineer",
        agentId: "alice" as never,
        projectName: "demo",
        workspacePath: "/tmp/keni-cursor-it-ws",
        mcpServerConfig: { command: "deno", args: [] },
        resumeSessionId: null,
        envAllowlist: [],
      },
      "<ignored>",
    );

    // Spot-check the argv against the installed binary's flag inventory.
    // The unit test in `codingAgentCliRegistry_test.ts` pins the exact
    // shape; this asserts the shape is consistent with what `--help`
    // documents.
    assert(argv.includes("--print"));
    assert(argv.includes("--approve-mcps"));
    const wsIdx = argv.indexOf("--workspace");
    assert(wsIdx >= 0);
    assertEquals(argv[wsIdx + 1], "/tmp/keni-cursor-it-ws");
  },
);
