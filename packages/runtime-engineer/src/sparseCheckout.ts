/**
 * Engineer's sparse-checkout pattern.
 *
 * The engineer's per-agent workspace clone (provisioned by
 * `@keni/runtime-workspace`'s `WorkspaceProvisioner`) excludes the
 * project's `.keni/` directory so the engineer agent never sees
 * project metadata (tickets, PRs, configuration). The MCP-tool
 * surface is the only seam by which an engineer reads or writes
 * project state.
 *
 * The pattern is `["/*", "!.keni/"]` — every project file (`/*`)
 * minus the `.keni/` directory.
 *
 * @module
 */

export const ENGINEER_SPARSE_CHECKOUT_PATTERN: readonly string[] = ["/*", "!.keni/"];
