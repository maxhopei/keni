/**
 * `@keni/runtime-workspace` package entry point.
 *
 * Role-agnostic workspace-provisioner interface (`WorkspaceProvisioner`)
 * and the production `GitWorkspaceProvisioner` default. Each role's
 * `wire(input)` supplies its own sparse-checkout pattern at
 * `ensureProvisioned` time; the engineer pattern lives in
 * `@keni/runtime-engineer` as `ENGINEER_SPARSE_CHECKOUT_PATTERN`.
 *
 * @module
 */

export const packageName = "@keni/runtime-workspace";

export type {
  EnsureProvisionedOpts,
  WorkspaceLogger,
  WorkspaceLogLevel,
  WorkspaceProvisioner,
  WorkspaceProvisioningErrorCode,
  WorkspaceProvisioningErrorDetails,
} from "./interface.ts";
export { WorkspaceProvisioningError } from "./interface.ts";

export type { GitWorkspaceProvisionerOpts } from "./git.ts";
export { GitWorkspaceProvisioner } from "./git.ts";
