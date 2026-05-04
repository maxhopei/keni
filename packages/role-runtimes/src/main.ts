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

export { codingAgentCliRegistry, isKnownCli } from "./common/codingAgentCliRegistry.ts";
export type {
  CodingAgentCliEntry,
  KnownCli,
  McpConfigStrategy,
} from "./common/codingAgentCliRegistry.ts";

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

/**
 * Engineer-runtime public surface (introduced by the
 * `engineer-runtime-and-workspace` change). The {@link WorkspaceProvisioner}
 * interface is the seam between the engineer runtime and the per-agent
 * sparse-checkout clone; {@link GitWorkspaceProvisioner} is the
 * production default; {@link FakeWorkspaceProvisioner} is the test
 * fake. {@link WorkspaceProvisioningError} is the typed error every
 * workspace operation rejects with.
 */
export type {
  WorkspaceLogger,
  WorkspaceLogLevel,
  WorkspaceProvisioner,
  WorkspaceProvisioningErrorCode,
  WorkspaceProvisioningErrorDetails,
} from "./engineer/workspace/interface.ts";
export { WorkspaceProvisioningError } from "./engineer/workspace/interface.ts";

export type {
  FakeWorkspaceProvisionerCall,
  FakeWorkspaceProvisionerOpts,
} from "./engineer/workspace/fakes/fakeWorkspaceProvisioner.ts";
export { FakeWorkspaceProvisioner } from "./engineer/workspace/fakes/fakeWorkspaceProvisioner.ts";

export type { GitWorkspaceProvisionerOpts } from "./engineer/workspace/git.ts";
export { GitWorkspaceProvisioner, SPARSE_CHECKOUT_PATTERN } from "./engineer/workspace/git.ts";

export { ENGINEER_PROMPT_BODY, ENGINEER_PROMPT_NAME } from "./engineer/prompts/engineer.ts";

export type {
  BuildEngineerMcpServerConfigOpts,
  EngineerActivityHttpClient,
  EngineerAgentRunner,
  EngineerRunnerDeps,
  EngineerRunnerOpts,
} from "./engineer/runner.ts";
export {
  buildEngineerMcpServerConfig,
  createEngineerRunner,
  orderEngineerTickets,
} from "./engineer/runner.ts";
