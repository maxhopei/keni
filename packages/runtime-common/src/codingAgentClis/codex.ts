/**
 * `codex` — OpenAI's Codex CLI.
 *
 * Reference: <https://developers.openai.com/codex/mcp> (the MCP surface
 * documentation) and <https://github.com/openai/codex>.
 *
 * Coverage: `best-effort`. Modelled against the documented `codex exec`
 * non-interactive subcommand and the `[mcp_servers.<name>]` TOML table
 * layout the CLI consumes from `~/.codex/config.toml` /
 * `<project>/.codex/config.toml`. The CLI does NOT accept
 * `--mcp-config` (see <https://github.com/openai/codex/issues/9550>,
 * closed as `not_planned`); the documented per-session `-c key=value`
 * overrides have known bugs (e.g.
 * <https://github.com/openai/codex/issues/16045> — `-c 'mcp_servers={}'`
 * silently no-ops). The follow-up task
 * `engineer-runner-production-wiring/tasks.md#6.2` tracks adding an
 * integration test that spawns the real binary.
 *
 * Argv shape: `codex exec` with the prompt body fed via stdin. `exec`
 * is the documented non-interactive subcommand. The role-runtime
 * cycle's invoker prepends `[--resume, <session-id>]` when resuming.
 *
 * MCP-config strategy: `workspace-toml` against
 * `<workspacePath>/.codex/config.toml` under `[mcp_servers.keni]`.
 * The role-runtime cycle's invoker reads any existing TOML file at
 * that path (treating `Deno.errors.NotFound` as `""`), parses it,
 * merges the keni entry under `mcp_servers.keni`, and writes the file
 * back. The per-agent workspace is keni-managed, so the merged file
 * persists across cycles (no cleanup).
 *
 * @module
 */

import type { CodingAgentCliEntry } from "../codingAgentCliRegistry.ts";

export const codexEntry: CodingAgentCliEntry = {
  cliBinary: "codex",
  buildArgs: (_invocation, _mcpConfigPath) => ["exec"],
  promptInjection: "stdin",
  resumeFlag: "--resume",
  envAllowlist: ["HOME", "PATH", "OPENAI_API_KEY"],
  mcpConfigStrategy: {
    kind: "workspace-toml",
    relativePath: ".codex/config.toml",
    tableHeader: "mcp_servers",
    entryName: "keni",
  },
};
