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
 * Argv shape: `claude --print --permission-mode bypassPermissions
 * --mcp-config <path>` with the prompt body fed via stdin. `--print`
 * is Claude Code's documented non-interactive flag; `--mcp-config
 * <file or string>` loads the MCP server JSON. The role-runtime
 * cycle's invoker prepends `[--resume, <session-id>]` when resuming.
 *
 * Permission mode: `bypassPermissions` is required for headless
 * operation — without it, every MCP tool call (and every Bash, Read,
 * Edit, etc.) blocks waiting for an approval prompt that no human can
 * answer, the subprocess emits "I need permission to use the MCP
 * tools" on stdout, and the cycle exits without doing useful work.
 * Per the [Claude Code permission-modes docs](https://docs.anthropic.com/en/docs/claude-code/permission-modes),
 * `bypassPermissions` is the documented mode for "isolated containers
 * and VMs" — which matches the engineer's per-agent workspace (a
 * sparse-checkout clone under `~/.keni/workspaces/<projectId>/<agentId>/`
 * that excludes `.keni/`, has its own git identity, and never touches
 * the host's source tree). The flag is the structural analogue of
 * `cursor-agent`'s `--approve-mcps --trust` and `codex exec`'s
 * implicit non-interactive trust: every CLI in the registry needs an
 * explicit "trust the workspace" switch to function in the engineer
 * loop. `--dangerously-skip-permissions` is documented as equivalent;
 * we use the longer `--permission-mode bypassPermissions` form
 * because it makes the trust scope explicit at the call site.
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
    "--permission-mode",
    "bypassPermissions",
    "--mcp-config",
    mcpConfigPath,
  ],
  promptInjection: "stdin",
  resumeFlag: "--resume",
  envAllowlist: ["HOME", "PATH", "ANTHROPIC_API_KEY"],
  mcpConfigStrategy: { kind: "tempfile-json" },
};
