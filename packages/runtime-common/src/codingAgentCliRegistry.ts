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
 * The per-CLI entry constants live in single-purpose modules under
 * `./codingAgentClis/` (one file per CLI). This file is the assembly
 * point only — it imports each per-CLI module and binds it to its
 * `KnownCli` key. Adding a fourth CLI is a four-step contract:
 *
 *   1. Create `./codingAgentClis/<newCli>.ts` exporting the entry.
 *   2. Import it in this file and bind it under its name.
 *   3. Extend `KnownCli` and `isKnownCli`.
 *   4. Add a registry-shape test scenario in
 *      `codingAgentCliRegistry_test.ts`.
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
 * Coverage tags (documented per-entry in JSDoc):
 *
 *   - `"tested"`   — the entry's `buildArgs` is exercised by a unit
 *                    test in `codingAgentCliRegistry_test.ts`, an
 *                    integration test against the real binary, or both.
 *   - `"best-effort"` — the entry's argv shape is modelled against the
 *                    CLI's documented contract but is not yet covered
 *                    by an integration test that spawns the real
 *                    binary.
 *
 * @module
 */

import type { CodingAgentInvocation } from "./types.ts";
import { claudeEntry } from "./codingAgentClis/claude.ts";
import { cursorAgentEntry } from "./codingAgentClis/cursorAgent.ts";
import { codexEntry } from "./codingAgentClis/codex.ts";

/** The closed set of coding-agent CLIs the production wiring supports. */
export type KnownCli = "claude" | "cursor-agent" | "codex";

/**
 * How the role-runtime cycle materialises the keni MCP-server config
 * for the CLI. Each `kind` maps to a per-strategy executor branch in
 * `codingAgentInvoker.ts`. The strategy is a value type — every field
 * is a string literal or a discriminator. Adding a fourth strategy is
 * a deliberate type-level change that requires updating the union, the
 * executor, and at least one structural test scenario.
 *
 *   - `tempfile-json` — write `{ mcpServers: { keni: <config> } }` to
 *     `Deno.makeTempFile(...)` and remove on cycle exit. The CLI
 *     accepts the path via argv (e.g. `claude --mcp-config <path>`).
 *   - `workspace-json` — merge the keni entry into
 *     `<workspacePath>/<relativePath>` under `<mergeKey>.<entryName>`.
 *     The CLI reads the file via filesystem discovery; no argv path is
 *     needed (cursor-agent ignores the path argument). No cleanup is
 *     registered — the per-agent workspace is keni-managed and the
 *     merge is idempotent across cycles.
 *   - `workspace-toml` — TOML equivalent for codex's
 *     `[mcp_servers.<name>]` table-header layout.
 */
export type McpConfigStrategy =
  | { readonly kind: "tempfile-json" }
  | {
    readonly kind: "workspace-json";
    readonly relativePath: string;
    readonly mergeKey: string;
    readonly entryName: string;
  }
  | {
    readonly kind: "workspace-toml";
    readonly relativePath: string;
    readonly tableHeader: string;
    readonly entryName: string;
  };

/** A registry entry — a strict subset of `SubprocessCodingAgentInvokerOpts`. */
export interface CodingAgentCliEntry {
  /** The CLI binary name resolved against the child's `PATH`. */
  readonly cliBinary: string;
  /**
   * Builds the CLI argv for one invocation. The `mcpConfigPath` is the
   * path produced by the entry's {@link McpConfigStrategy} executor;
   * some entries (e.g. `cursor-agent`) ignore the argument because the
   * CLI discovers the file from the workspace filesystem. The role-
   * runtime cycle's invoker prepends `[resumeFlag,
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
  /**
   * Where the keni MCP-server config is materialised before spawn.
   * See {@link McpConfigStrategy}.
   */
  readonly mcpConfigStrategy: McpConfigStrategy;
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
 * The closed registry. Referentially stable — importers MAY use entry
 * identity for caching / equality.
 *
 * Per-CLI entry constants are imported from sibling modules under
 * `./codingAgentClis/`. This file SHALL NOT contain inline entry
 * literals (no `cliBinary` strings, no argv shapes, no env-allowlist
 * values for specific CLIs); the structural test in
 * `codingAgentCliRegistry_test.ts` enforces this.
 */
export const codingAgentCliRegistry: Readonly<
  Record<KnownCli, CodingAgentCliEntry>
> = {
  "claude": claudeEntry,
  "cursor-agent": cursorAgentEntry,
  "codex": codexEntry,
};
