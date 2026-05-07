/**
 * `AgentRunnerRegistry` — the role plug-in surface for the scheduler.
 *
 * The scheduler imports zero role-specific code (engineer, qa, po,
 * writer). Every role-shaped concern (precheck, prompt resolver,
 * coding-agent invoker, env allowlist, MCP server config) is supplied
 * by the registered runner. Each role package's `wire(input)` (e.g.
 * `@keni/runtime-engineer`, `@keni/runtime-po`) builds an
 * `AgentRunner` and `runServer` registers it via this registry; tests
 * register a fake runner that wraps the `createFakeCodingAgentInvoker`
 * factory from `@keni/runtime-common/test-fakes`.
 *
 * Registration is idempotent for the same `runner.role`: a second
 * `register` for the same role replaces the first and emits an
 * `info`-level `"runner.replaced"` log line so a contributor who wires
 * two engineers gets a clear signal.
 *
 * @module
 */

import type { AgentRunner } from "@keni/runtime-common";
import type { Role } from "@keni/shared";
import type { SchedulerLogger } from "./log.ts";

export type { AgentRunner };

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
