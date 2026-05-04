/**
 * Closed registry mapping a known coding-agent CLI name to the spawn
 * shape `createSubprocessCodingAgentInvoker(...)` expects.
 *
 * The registry is a constant value (not a function, not a class) so:
 *
 *   - The set of supported CLIs is auditable in one place.
 *   - Adding a CLI is an explicit code change with tests.
 *   - The `KnownCli` literal union catches typos in `~/.keni/config.yaml`
 *     at the boundary (`keni start`'s production helper rejects any
 *     name not in `Object.keys(codingAgentCliRegistry)` and emits a
 *     single `engineer.runner_skipped` warn line per agent at boot,
 *     per the `cli-start` capability spec).
 *
 * Each entry's shape is a strict subset of {@link import("./codingAgentInvoker.ts").SubprocessCodingAgentInvokerOpts}
 * — a caller may spread an entry into `createSubprocessCodingAgentInvoker(opts)`
 * directly without translation.
 *
 * The `envAllowlist` carries the per-CLI minimum set of host env
 * variables the CLI needs to authenticate and run. The role-runtime
 * cycle's mandated `KENI_MCP_AGENT` / `KENI_MCP_SERVER_URL` /
 * `KENI_MCP_WORKSPACE` entries are added on top by `buildChildEnv`
 * (see `subprocess.ts`); they SHALL NOT be duplicated here.
 *
 * Coverage tags:
 *
 *   - `"tested"`   — the entry's `buildArgs` is exercised by a unit
 *                    test in `codingAgentCliRegistry_test.ts`.
 *   - `"best-effort"` — the entry's argv shape is modelled against the
 *                    CLI's documented contract but is not yet covered
 *                    by an integration test that spawns the real
 *                    binary. The follow-up tasks 6.1 / 6.2 in the
 *                    `engineer-runner-production-wiring` change track
 *                    closing this gap.
 *
 * @module
 */

import type { CodingAgentInvocation } from "./types.ts";

/** The closed set of coding-agent CLIs the production wiring supports. */
export type KnownCli = "claude" | "cursor-agent" | "codex";

/** A registry entry — a strict subset of `SubprocessCodingAgentInvokerOpts`. */
export interface CodingAgentCliEntry {
  /** The CLI binary name resolved against the child's `PATH`. */
  readonly cliBinary: string;
  /**
   * Builds the CLI argv for one invocation. The `mcpConfigPath` is the
   * path to the JSON file the role-runtime cycle's invoker writes
   * containing `{ mcpServers: { keni: invocation.mcpServerConfig } }`.
   * The role-runtime cycle's invoker prepends `[resumeFlag,
   * invocation.resumeSessionId]` to this argv when
   * `invocation.resumeSessionId !== null`; entries SHOULD NOT include
   * the resume flag in the returned argv.
   */
  readonly buildArgs: (
    invocation: CodingAgentInvocation,
    mcpConfigPath: string,
  ) => readonly string[];
  /** How the engineer's prompt body is fed to the CLI. */
  readonly promptInjection: "stdin" | "arg";
  /** The flag the CLI uses to resume a prior session. */
  readonly resumeFlag: string;
  /**
   * Per-CLI minimum env allowlist. The `KENI_MCP_*` mandates are added
   * on top of this list by `buildChildEnv`.
   */
  readonly envAllowlist: readonly string[];
}

/**
 * Type guard for a `KnownCli` name. Used by the production `keni start`
 * wiring to narrow a `string` from `~/.keni/config.yaml` at the boundary
 * without duplicating the union.
 */
export function isKnownCli(value: string): value is KnownCli {
  return value === "claude" || value === "cursor-agent" || value === "codex";
}

/**
 * `claude` — Anthropic's Claude Code CLI.
 *
 * Reference: <https://docs.anthropic.com/en/docs/claude-code/cli-usage>
 *
 * Coverage: `tested` (unit tests in `codingAgentCliRegistry_test.ts`
 * pin the argv shape; the e2e test in
 * `packages/cli/src/start/engineerRunner_e2e_test.ts` swaps in a fake
 * fixture binary via the `RunStartDeps.codingAgentCliRegistryOverride`
 * seam — it does not spawn the real `claude` binary).
 *
 * Argv shape: `claude --print --mcp-config <path>` with the prompt body
 * fed via stdin. `--print` is Claude Code's documented non-interactive
 * flag; `--mcp-config <path>` loads the MCP server JSON. The role-
 * runtime cycle's invoker prepends `[--resume, <session-id>]` when
 * resuming.
 */
const claudeEntry: CodingAgentCliEntry = {
  cliBinary: "claude",
  buildArgs: (_invocation, mcpConfigPath) => [
    "--print",
    "--mcp-config",
    mcpConfigPath,
  ],
  promptInjection: "stdin",
  resumeFlag: "--resume",
  envAllowlist: ["HOME", "PATH", "ANTHROPIC_API_KEY"],
};

/**
 * `cursor-agent` — Cursor's headless agent CLI.
 *
 * Reference: <https://docs.cursor.com/en/cli/overview>
 *
 * Coverage: `best-effort`. The argv shape is modelled against the CLI's
 * documented `--print` (non-interactive) and `--mcp-config <path>`
 * flags as of the v0 prototype. The follow-up task
 * `engineer-runner-production-wiring/tasks.md#6.1` tracks adding an
 * integration test that spawns the real binary; until that lands,
 * mismatches surface as `roleRuntime.spawn_failed` activity entries
 * per cycle (the user's first-run feedback).
 */
const cursorAgentEntry: CodingAgentCliEntry = {
  cliBinary: "cursor-agent",
  buildArgs: (_invocation, mcpConfigPath) => [
    "--print",
    "--mcp-config",
    mcpConfigPath,
  ],
  promptInjection: "stdin",
  resumeFlag: "--resume",
  envAllowlist: ["HOME", "PATH", "CURSOR_API_KEY"],
};

/**
 * `codex` — OpenAI's Codex CLI.
 *
 * Reference: <https://github.com/openai/codex>
 *
 * Coverage: `best-effort`. The argv shape is modelled against the
 * CLI's documented `exec` non-interactive subcommand and its
 * `--mcp-config <path>` flag. The follow-up task
 * `engineer-runner-production-wiring/tasks.md#6.2` tracks adding an
 * integration test that spawns the real binary.
 */
const codexEntry: CodingAgentCliEntry = {
  cliBinary: "codex",
  buildArgs: (_invocation, mcpConfigPath) => [
    "exec",
    "--mcp-config",
    mcpConfigPath,
  ],
  promptInjection: "stdin",
  resumeFlag: "--resume",
  envAllowlist: ["HOME", "PATH", "OPENAI_API_KEY"],
};

/**
 * The closed registry. Referentially stable — importers MAY use entry
 * identity for caching / equality.
 */
export const codingAgentCliRegistry: Readonly<
  Record<KnownCli, CodingAgentCliEntry>
> = {
  "claude": claudeEntry,
  "cursor-agent": cursorAgentEntry,
  "codex": codexEntry,
};
