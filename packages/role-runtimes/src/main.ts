/**
 * `@keni/role-runtimes` package entry point.
 *
 * Re-exports the public surface of the role-runtime cycle:
 *
 *   - `startCycle(params)` — runs one role cycle end-to-end.
 *   - `createSubprocessCodingAgentInvoker(opts)` — default invoker
 *     factory backed by `Deno.Command`.
 *   - `resolveBundledPrompt(prompt, expectedName?)` — bundled-prompt
 *     resolver (TS string constants only).
 *   - The `RoleCycleParams` / `RoleCycleResult` discriminated-union
 *     types and the supporting `CodingAgent*` types.
 *   - `RoleRuntimeError` / `RoleRuntimeHttpError` typed error classes.
 *
 * The package is engineer/QA/PO-agnostic — every role-shaped concern
 * (precheck, prompt resolver, env allowlist, MCP server config) is a
 * parameter on `RoleCycleParams`. Step 09 (engineer specialisation) is
 * the first concrete consumer; step 17 (PO mode selection) is the
 * second.
 *
 * @module
 */

export const packageName = "@keni/role-runtimes";

export { startCycle } from "./common/startCycle.ts";

export type {
  BundledPrompt,
  CodingAgentInvocation,
  CodingAgentInvoker,
  CodingAgentLifecycle,
  CodingAgentOutcome,
  CyclePrepCtx,
  McpServerConfig,
  PrecheckResult,
  RoleCycleParams,
  RoleCycleResult,
} from "./common/types.ts";

export { createSubprocessCodingAgentInvoker } from "./common/codingAgentInvoker.ts";
export type { SubprocessCodingAgentInvokerOpts } from "./common/codingAgentInvoker.ts";

export { resolveBundledPrompt } from "./common/promptResolver.ts";

export { RoleRuntimeError, RoleRuntimeHttpError } from "./common/types.ts";

/**
 * Re-exports for integration tests outside this package — the
 * cron-scheduler-with-pause and role-runtime-common integration tests
 * register a fake `AgentRunner` whose `promptResolver` returns this
 * placeholder bundle. Steps 09 and 18 introduce role-specific prompts;
 * once those land, callers should switch off these constants.
 */
export { PLACEHOLDER_PROMPT_BODY, PLACEHOLDER_PROMPT_NAME } from "./common/prompts/placeholder.ts";
