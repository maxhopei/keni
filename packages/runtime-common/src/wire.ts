/**
 * `WireFn` and `WireInput` — the polymorphic per-role plug-in
 * protocol.
 *
 * Each role package (`@keni/runtime-engineer`, `@keni/runtime-po`,
 * etc.) exports a `wire(input: WireInput): Promise<AgentRunner | null>`
 * function. The CLI assembles a `Record<Role, WireFn>` registry and
 * hands it to `runServer` via `RunServerDeps.roleWires`. `runServer`
 * iterates the project's `agents` roster; for each agent it dispatches
 * `await roleWires[agent.role]?.(input)`. A `null` return means
 * "skip this agent — no runner registered" (identical to today's
 * "no CLI configured" path); a missing entry in `roleWires` logs
 * `runner.skipped` and moves on. A throw bubbles up as a `runServer`
 * boot failure.
 *
 * The seam is the load-bearing decoupling that makes the orchestration
 * server role-agnostic: the server holds zero role-specific code; the
 * CLI holds the role-package imports; each role package owns its
 * runner-construction logic behind a `wire` export.
 *
 * @module
 */

import type { AgentConfig, ResolvedConfig } from "@keni/shared";
import type { WorkspaceLogger, WorkspaceProvisioner } from "@keni/runtime-workspace";
import type { ActivityHttpClient } from "./activityHttpClient.ts";
import type { CodingAgentCliEntry } from "./codingAgentCliRegistry.ts";
import type { AgentRunner } from "./runner.ts";

/**
 * Construction context the orchestration server passes to each role's
 * `wire(input)` at agent registration time. Every field is the smallest
 * generalisation of the data the engineer wire historically consumed:
 * project identity, `AgentConfig` from the project's roster, the
 * resolved global / project config bundle, the MCP entry-point path
 * for `buildEngineerMcpServerConfig`-shaped wirings, and the shared
 * `WorkspaceProvisioner` instance so each role's wire can call
 * `ensureProvisioned({ ..., sparseCheckoutPattern: <role-specific> })`.
 */
export interface WireInput {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRepoPath: string;
  readonly serverUrl: string;
  readonly agentConfig: AgentConfig;
  readonly resolvedConfig: ResolvedConfig;
  readonly mcpEntryPath: string;
  readonly logger: WorkspaceLogger;
  readonly makeActivityHttpClient: (
    serverUrl: string,
    agentId: string,
  ) => ActivityHttpClient;
  readonly codingAgentCliRegistry: Readonly<Record<string, CodingAgentCliEntry>>;
  readonly workspaceProvisioner: WorkspaceProvisioner;
}

/**
 * The wire-function shape every role package's `wire` export
 * structurally satisfies. Returning `null` skips the agent without
 * registering a runner; returning a runner registers it on the
 * scheduler. Throwing surfaces as a boot failure (the scheduler does
 * not start).
 */
export type WireFn = (input: WireInput) => Promise<AgentRunner | null>;

/**
 * Convenience alias for the `Record<Role, WireFn>` registry the CLI
 * assembles and hands to `runServer`.
 */
export type RoleWires = Readonly<Record<string, WireFn>>;
