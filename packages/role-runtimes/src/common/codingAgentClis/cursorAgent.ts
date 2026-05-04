/**
 * `cursor-agent` — Cursor's headless agent CLI.
 *
 * Reference: <https://cursor.com/docs/cli/mcp> (the documented CLI MCP
 * surface) and <https://docs.cursor.com/en/cli/overview>. Modelled
 * against `cursor-agent --help` for `v2026.04.15-dccdccd`.
 *
 * Coverage: `tested` once the integration test in
 * `packages/role-runtimes/tests/integration/cursorAgent_test.ts` runs
 * (the test is gated on `cursor-agent` being on `PATH`; on machines
 * without the binary the test is skipped via `Deno.test.ignore`,
 * leaving this entry effectively `best-effort` on those CI runners).
 *
 * Argv shape: `cursor-agent --print --approve-mcps --workspace
 * <workspacePath>` with the prompt body fed via stdin. `--print` is
 * Cursor's documented non-interactive flag; `--approve-mcps`
 * auto-approves MCP servers (skipping the interactive approval prompt
 * that would block in headless mode); `--workspace <path>` overrides
 * the workspace-discovery root the CLI reads `.cursor/mcp.json` from.
 *
 * MCP-config strategy: `workspace-json` against
 * `<workspacePath>/.cursor/mcp.json` under `mcpServers.keni`. The CLI
 * does NOT accept `--mcp-config` (verified on `v2026.04.15-dccdccd`);
 * MCP servers are discovered from the workspace's `.cursor/mcp.json`
 * (project precedence) or `~/.cursor/mcp.json` (global precedence).
 * The role-runtime cycle merges the keni entry into any existing
 * `<workspacePath>/.cursor/mcp.json` so a user who has committed their
 * own MCP servers in their project repo keeps them in their per-agent
 * workspace; the merged file persists across cycles (no cleanup).
 *
 * The per-agent workspace is a sparse-checkout clone managed by
 * `WorkspaceProvisioner.workspacePathFor(projectId, agentId)` and
 * lives at `<homeDir>/.keni/workspaces/<projectId>/<agentId>/`. The
 * sparse-checkout pattern excludes `.keni/`, NOT `.cursor/`, so a
 * user's committed `.cursor/mcp.json` flows through to the engineer's
 * per-agent workspace and is merged into (not stomped) by this entry's
 * strategy.
 *
 * Version-skew note: this entry is modelled against
 * `cursor-agent v2026.04.15-dccdccd`. A future CLI release that
 * removes or renames `--workspace` / `--approve-mcps` would surface as
 * a failing integration test (when the binary is on `PATH`).
 *
 * @module
 */

import type { CodingAgentCliEntry } from "../codingAgentCliRegistry.ts";

export const cursorAgentEntry: CodingAgentCliEntry = {
  cliBinary: "cursor-agent",
  buildArgs: (invocation, _mcpConfigPath) =>
    invocation.workspacePath !== null
      ? ["--print", "--approve-mcps", "--workspace", invocation.workspacePath]
      : ["--print", "--approve-mcps"],
  promptInjection: "stdin",
  resumeFlag: "--resume",
  envAllowlist: ["HOME", "PATH", "CURSOR_API_KEY"],
  mcpConfigStrategy: {
    kind: "workspace-json",
    relativePath: ".cursor/mcp.json",
    mergeKey: "mcpServers",
    entryName: "keni",
  },
};
