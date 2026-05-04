/**
 * `AgentRunnerRegistry` — the role plug-in surface for the scheduler.
 *
 * The scheduler imports zero role-specific code (engineer, qa, po,
 * writer). Every role-shaped concern (precheck, prompt resolver,
 * coding-agent invoker, env allowlist, MCP server config) is supplied
 * by the registered runner. Step 09 (engineer specialisation) and
 * step 17 (PO mode selection) `register(...)` their runners against
 * this registry; tests register a fake runner that wraps step 07's
 * `fakeCodingAgentInvoker`.
 *
 * Registration is idempotent for the same `runner.role`: a second
 * `register` for the same role replaces the first and emits an
 * `info`-level `"runner.replaced"` log line so a contributor who wires
 * two engineers gets a clear signal.
 *
 * @module
 */

import type {
  BundledPrompt,
  CodingAgentInvoker,
  CyclePrepCtx,
  McpServerConfig,
  PrecheckResult,
} from "@keni/role-runtimes";
import type { Role } from "@keni/shared";
import type { SchedulerLogger } from "./log.ts";

/**
 * Role-specific bundle the scheduler hands to {@link startCycle} on each
 * proceed-precheck tick. Every field mirrors a `RoleCycleParams` field;
 * the scheduler injects `agentId`, `serverUrl`, `projectName`, and
 * `signal` per cycle.
 */
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

/** Public surface of the registry. */
export interface AgentRunnerRegistry {
  /**
   * Register a runner for `runner.role`. A second call for the same role
   * replaces the previous runner and emits one `info`-level
   * `"runner.replaced"` line via the injected logger.
   */
  register(runner: AgentRunner): void;
  /** Return the runner for `role`, or `null` when none is registered. */
  get(role: string): AgentRunner | null;
  /** Roles that have a registered runner, in insertion order. */
  roles(): readonly Role[];
}

/** Build the in-memory registry. */
export function createAgentRunnerRegistry(
  logger: SchedulerLogger,
): AgentRunnerRegistry {
  const order: Role[] = [];
  const runners = new Map<Role, AgentRunner>();

  return {
    register(runner: AgentRunner): void {
      if (runners.has(runner.role)) {
        logger.log("info", "runner.replaced", { role: runner.role });
      } else {
        order.push(runner.role);
      }
      runners.set(runner.role, runner);
    },

    get(role: string): AgentRunner | null {
      return runners.get(role as Role) ?? null;
    },

    roles(): readonly Role[] {
      return order.slice();
    },
  };
}
