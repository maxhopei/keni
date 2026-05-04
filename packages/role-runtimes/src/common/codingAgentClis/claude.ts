/**
 * `claude` — Anthropic's Claude Code CLI.
 *
 * Reference: <https://docs.anthropic.com/en/docs/claude-code/cli-usage>
 * Modelled against `claude --help` output for `v1.0.2 (Claude Code)`.
 *
 * Coverage: `tested` (unit tests in `codingAgentCliRegistry_test.ts`
 * pin the argv shape; the e2e test in
 * `packages/cli/src/start/engineerRunner_e2e_test.ts` swaps in a fake
 * fixture binary via the `RunStartDeps.codingAgentCliRegistryOverride`
 * seam — it does not spawn the real `claude` binary).
 *
 * Argv shape: `claude --print --mcp-config <path>` with the prompt body
 * fed via stdin. `--print` is Claude Code's documented non-interactive
 * flag; `--mcp-config <file or string>` loads the MCP server JSON.
 * The role-runtime cycle's invoker prepends `[--resume, <session-id>]`
 * when resuming.
 *
 * MCP-config strategy: `tempfile-json` — the role-runtime cycle's
 * invoker writes `{ mcpServers: { keni: <config> } }` to
 * `Deno.makeTempFile(...)` and removes it on cycle exit.
 *
 * Version-skew note: `claude v2.x` changed `--mcp-config` to a variadic
 * option (see <https://github.com/anthropics/claude-code/issues/16122>).
 * The variadic ambiguity only manifests when the prompt is supplied
 * positionally after `-p`; we feed the prompt via stdin, so the
 * `["--print", "--mcp-config", <path>]` order remains unambiguous on
 * `v1.x` and `v2.x`.
 *
 * @module
 */

import type { CodingAgentCliEntry } from "../codingAgentCliRegistry.ts";

export const claudeEntry: CodingAgentCliEntry = {
  cliBinary: "claude",
  buildArgs: (_invocation, mcpConfigPath) => [
    "--print",
    "--mcp-config",
    mcpConfigPath,
  ],
  promptInjection: "stdin",
  resumeFlag: "--resume",
  envAllowlist: ["HOME", "PATH", "ANTHROPIC_API_KEY"],
  mcpConfigStrategy: { kind: "tempfile-json" },
};
