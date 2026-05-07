/**
 * `@keni/runtime-common` package entry point.
 *
 * The role-agnostic seven-step cycle, cycle types, the coding-agent CLI
 * registry, the prompt resolver, the activity-log adapter, and the
 * polymorphic plug-in contracts (`AgentRunner`, plus `WireFn` /
 * `WireInput` introduced by §6 of the
 * `split-role-runtimes-package` change).
 *
 * The package is engineer/QA/PO/Writer-agnostic — every role-shaped
 * concern (precheck content, prompt resolution, invoker selection,
 * env allowlist, MCP-server config, workspace path) is a parameter on
 * `RoleCycleParams`. Each role's specifics live in the matching
 * `@keni/runtime-<role>` package; the CLI assembles a
 * `Record<Role, WireFn>` registry and hands it to `runServer`.
 *
 * @module
 */

export const packageName = "@keni/runtime-common";

export { startCycle } from "./startCycle.ts";

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
} from "./types.ts";

export { createSubprocessCodingAgentInvoker } from "./codingAgentInvoker.ts";
export type { SubprocessCodingAgentInvokerOpts } from "./codingAgentInvoker.ts";

export { codingAgentCliRegistry, isKnownCli } from "./codingAgentCliRegistry.ts";
export type { CodingAgentCliEntry, KnownCli, McpConfigStrategy } from "./codingAgentCliRegistry.ts";

export { resolveBundledPrompt } from "./promptResolver.ts";

export { RoleRuntimeError, RoleRuntimeHttpError } from "./types.ts";

export type { AgentRunner } from "./runner.ts";

export type { ActivityHttpClient } from "./activityHttpClient.ts";

export type { RoleWires, WireFn, WireInput } from "./wire.ts";
