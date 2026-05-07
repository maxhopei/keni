/**
 * `AgentRunner` — the polymorphic plug-in shape every role's `wire`
 * function returns and the orchestration server's scheduler consumes.
 *
 * The interface lives in `@keni/runtime-common` (not in `@keni/server`)
 * so role packages can return `AgentRunner` without forming a
 * `@keni/server` dependency edge. The scheduler's `AgentRunnerRegistry`
 * imports the type from here; no copy or structural duplicate of the
 * interface exists anywhere else in the workspace.
 *
 * Every field mirrors a `RoleCycleParams` field; the scheduler injects
 * `agentId`, `serverUrl`, `projectName`, and `signal` per cycle.
 *
 * @module
 */

import type { Role } from "@keni/shared";
import type {
  BundledPrompt,
  CodingAgentInvoker,
  CyclePrepCtx,
  McpServerConfig,
  PrecheckResult,
} from "./types.ts";

export interface AgentRunner {
  readonly role: Role;
  readonly precheck: (ctx: CyclePrepCtx) => Promise<PrecheckResult> | PrecheckResult;
  readonly promptResolver: (ctx: CyclePrepCtx) => BundledPrompt;
  readonly expectedPromptName?: string;
  readonly codingAgentInvoker: CodingAgentInvoker;
  readonly envAllowlist?: readonly string[];
  readonly mcpServerConfig: McpServerConfig;
  /**
   * Per-agent workspace path the scheduler SHALL forward as
   * `RoleCycleParams.workspacePath`. When set, this wins over the
   * project-level `SchedulerOpts.workspacePath` (a one-value-fits-all
   * leftover that does not model per-agent workspaces correctly). The
   * production engineer wiring populates this from
   * `provisioner.workspacePathFor(projectId, agentId)`.
   */
  readonly workspacePath?: string;
  /** Optional override of the cycle's idle threshold (default 250 ms). */
  readonly idleThresholdMs?: number;
  /** Optional override of the cycle's SIGTERM grace period (default 5 000 ms). */
  readonly terminationGraceMs?: number;
}
