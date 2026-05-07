/**
 * Engineer's `wire(input)` function — the polymorphic plug-in entry
 * point the orchestration server's `runServer` calls (via the
 * `roleWires` registry the CLI assembles) to register an engineer
 * agent.
 *
 * Body lifted from the previous `buildProductionEngineerRunnerFactory`
 * (now deleted from `@keni/cli`'s `start/engineerRunner.ts`). Walks the
 * resolved config to pick the engineer's coding-agent CLI, looks the
 * name up in the supplied `codingAgentCliRegistry`, constructs a
 * `CodingAgentInvoker` via `createSubprocessCodingAgentInvoker`, calls
 * `workspaceProvisioner.ensureProvisioned({ ...,
 * sparseCheckoutPattern: ENGINEER_SPARSE_CHECKOUT_PATTERN })` to
 * materialise the per-agent workspace, builds the `mcpServerConfig`
 * via `buildEngineerMcpServerConfig`, and finally returns the
 * `AgentRunner` from `createEngineerRunner`.
 *
 * Returns `null` (with a `engineer.runner_skipped` log line) when the
 * resolved CLI is absent or unknown — the scheduler then logs
 * `runner.skipped` for the agent and the per-tick `runner.missing`
 * line continues to fire on each scheduled tick.
 *
 * @module
 */

import type { AgentConfig, AgentId, ResolvedConfig } from "@keni/shared";
import type { ActivityHttpClient, AgentRunner, WireFn, WireInput } from "@keni/runtime-common";
import { createSubprocessCodingAgentInvoker } from "@keni/runtime-common";

import { buildEngineerMcpServerConfig, createEngineerRunner } from "./runner.ts";
import { ENGINEER_SPARSE_CHECKOUT_PATTERN } from "./sparseCheckout.ts";

const SKIPPED_EVENT = "engineer.runner_skipped";

/**
 * Engineer's `WireFn`. Called once per engineer agent at server boot;
 * resolves with an `AgentRunner` to register, `null` to skip the
 * agent without registering, or rejects on unrecoverable errors
 * (e.g., workspace provisioning failure).
 */
export const wire: WireFn = async (input: WireInput): Promise<AgentRunner | null> => {
  const { agentConfig, resolvedConfig } = input;
  const supported = Object.keys(input.codingAgentCliRegistry).sort();

  const resolvedCli = resolveCliName(agentConfig, resolvedConfig);
  if (resolvedCli === null) {
    input.logger.log("warn", SKIPPED_EVENT, {
      agent: agentConfig.id,
      reason: "no_cli_configured",
      configured_cli: null,
      supported,
    });
    return null;
  }

  const entry = input.codingAgentCliRegistry[resolvedCli];
  if (entry === undefined) {
    input.logger.log("warn", SKIPPED_EVENT, {
      agent: agentConfig.id,
      reason: "unknown_cli",
      configured_cli: resolvedCli,
      supported,
    });
    return null;
  }

  const codingAgentInvoker = createSubprocessCodingAgentInvoker({
    cliBinary: entry.cliBinary,
    buildArgs: entry.buildArgs,
    promptInjection: entry.promptInjection,
    resumeFlag: entry.resumeFlag,
    envAllowlist: entry.envAllowlist,
    mcpConfigStrategy: entry.mcpConfigStrategy,
  });

  const workspacePath = await input.workspaceProvisioner.ensureProvisioned({
    projectId: input.projectId,
    agentId: agentConfig.id,
    projectRepoPath: input.projectRepoPath,
    sparseCheckoutPattern: ENGINEER_SPARSE_CHECKOUT_PATTERN,
  });

  const mcpServerConfig = buildEngineerMcpServerConfig({
    agentId: agentConfig.id as AgentId,
    serverUrl: input.serverUrl,
    workspacePath,
    mcpEntryPath: input.mcpEntryPath,
  });

  const activityHttpClient: ActivityHttpClient = input.makeActivityHttpClient(
    input.serverUrl,
    agentConfig.id,
  );

  return createEngineerRunner(
    {
      provisioner: input.workspaceProvisioner,
      codingAgentInvoker,
      activityHttpClient,
      logger: input.logger,
    },
    {
      projectId: input.projectId,
      projectName: input.projectName,
      agentId: agentConfig.id as AgentId,
      projectRepoPath: input.projectRepoPath,
      serverUrl: input.serverUrl,
      workspacePath,
      mcpServerConfig,
      envAllowlist: entry.envAllowlist,
    },
  );
};

/**
 * Resolve the engineer agent's CLI name. Per-agent `cli` wins over
 * global `coding_agent_cli`; an empty string at either layer is treated
 * as absent.
 */
function resolveCliName(
  agent: AgentConfig,
  resolved: ResolvedConfig,
): string | null {
  if (typeof agent.cli === "string" && agent.cli.length > 0) return agent.cli;
  if (
    typeof resolved.coding_agent_cli === "string" &&
    resolved.coding_agent_cli.length > 0
  ) {
    return resolved.coding_agent_cli;
  }
  return null;
}
