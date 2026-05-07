/**
 * `@keni/runtime-engineer` package entry point.
 *
 * Engineer specialisation of the role-runtime cycle. Public surface:
 *
 * - `ENGINEER_PROMPT_NAME` / `ENGINEER_PROMPT_BODY` — the bundled
 *   engineer prompt (TS string constants).
 * - `createEngineerRunner(deps, opts)` — engineer's `AgentRunner`
 *   factory. Returns `AgentRunner` from `@keni/runtime-common` directly.
 * - `buildEngineerMcpServerConfig(opts)` — canonical
 *   `McpServerConfig` builder for the engineer subprocess.
 * - `orderEngineerTickets(tickets)` — pure ticket-ordering helper.
 * - `ENGINEER_SPARSE_CHECKOUT_PATTERN` — the array passed to
 *   `WorkspaceProvisioner.ensureProvisioned`.
 * - `wire(input)` — polymorphic `WireFn` the CLI registers under the
 *   `engineer` role key in `runServer`'s `roleWires` registry.
 *
 * The package depends only on `@keni/runtime-common`,
 * `@keni/runtime-workspace`, and `@keni/shared`.
 *
 * @module
 */

export const packageName = "@keni/runtime-engineer";

export { ENGINEER_PROMPT_BODY, ENGINEER_PROMPT_NAME } from "./prompts/engineer.ts";

export type {
  BuildEngineerMcpServerConfigOpts,
  EngineerActivityHttpClient,
  EngineerRunnerDeps,
  EngineerRunnerOpts,
} from "./runner.ts";
export {
  buildEngineerMcpServerConfig,
  createEngineerRunner,
  orderEngineerTickets,
} from "./runner.ts";

export { ENGINEER_SPARSE_CHECKOUT_PATTERN } from "./sparseCheckout.ts";

export { wire } from "./wire.ts";
