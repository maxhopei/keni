/**
 * Production wiring for the engineer's `AgentRunner` factory consumed by
 * `runServer.wireEngineers(...)`. The CLI's composition root wires the
 * default {@link RunStartDeps.makeEngineerRunner} to this helper when
 * the caller does not supply one (the test seam still wins — see
 * `cli-start` capability spec, requirement "A test-supplied
 * makeEngineerRunner wins over the production default").
 *
 * The helper resolves each engineer agent's coding-agent CLI from the
 * effective config (per-agent `cli` → global `coding_agent_cli` →
 * `null`), looks the name up in the supplied registry (the production
 * `codingAgentCliRegistry` from `@keni/role-runtimes`, or an extended
 * registry passed by the e2e test seam), constructs a
 * `CodingAgentInvoker` via `createSubprocessCodingAgentInvoker(...)`,
 * builds the `mcpServerConfig` via `buildEngineerMcpServerConfig(...)`,
 * builds an `EngineerActivityHttpClient` via the supplied factory
 * (the production wiring uses `createMcpHttpClient`), and finally
 * returns the `EngineerAgentRunner` from `createEngineerRunner(...)`.
 *
 * When the resolved CLI is `null` (no per-agent and no global value)
 * or non-`null` but absent from the registry, the helper emits a single
 * `warn`-level `engineer.runner_skipped` log line for that agent and
 * returns `null` so no runner is registered. The scheduler's per-tick
 * `runner.missing` line continues to fire for the affected agent —
 * the two log keys are intentionally distinct (boot vs. tick).
 *
 * Relevant capability specs:
 *   - `openspec/specs/cli-start/spec.md` — production wiring contract.
 *   - `openspec/specs/engineer-runtime/spec.md` — registry shape.
 *   - `README.md` — "Configure the coding-agent CLI" section.
 *
 * @module
 */

import {
  buildEngineerMcpServerConfig,
  type CodingAgentCliEntry,
  createEngineerRunner,
  createSubprocessCodingAgentInvoker,
  type EngineerActivityHttpClient,
  type WorkspaceLogger,
} from "@keni/role-runtimes";
import type { AgentRunner, MakeEngineerRunnerInput } from "@keni/server";
import type { AgentConfig, AgentId, ResolvedConfig } from "@keni/shared";

/**
 * Dependencies for {@link buildProductionEngineerRunnerFactory}.
 *
 * Every member is supplied at composition time by `runStart`:
 *
 *   - `resolvedConfig`: the shallow merge of `~/.keni/config.yaml` and
 *     `<projectDir>/.keni/project.yaml`. Only `coding_agent_cli` is
 *     read.
 *   - `registry`: usually `codingAgentCliRegistry` from
 *     `@keni/role-runtimes`. The e2e test path passes an extended
 *     registry (production registry merged with a fixture entry) via
 *     the {@link RunStartDeps.codingAgentCliRegistryOverride} seam.
 *   - `mcpEntryPath`: usually `MCP_ENTRY_PATH` from `@keni/server`.
 *   - `makeActivityHttpClient`: usually `(serverUrl, agentId) =>
 *     createMcpHttpClient({ serverUrl, agentId })`. Tests pass a stub
 *     to avoid issuing real HTTP.
 *   - `logger`: a `WorkspaceLogger` adapter over the scheduler logger
 *     `runServer` already constructs (`workspaceLoggerOf(schedulerLogger)`).
 */
export interface BuildProductionEngineerRunnerFactoryDeps {
  readonly resolvedConfig: ResolvedConfig;
  readonly registry: Readonly<Record<string, CodingAgentCliEntry>>;
  readonly mcpEntryPath: string;
  readonly makeActivityHttpClient: (
    serverUrl: string,
    agentId: string,
  ) => EngineerActivityHttpClient;
  readonly logger: WorkspaceLogger;
}

/**
 * Build the production `makeEngineerRunner` closure. The closure is
 * stateless across invocations — wiring two engineers produces two
 * independent runners.
 */
export function buildProductionEngineerRunnerFactory(
  deps: BuildProductionEngineerRunnerFactoryDeps,
): (input: MakeEngineerRunnerInput) => AgentRunner | null {
  const supported = Object.keys(deps.registry).sort();

  return (input: MakeEngineerRunnerInput): AgentRunner | null => {
    const resolvedCli = resolveCliName(input.agentConfig, deps.resolvedConfig);
    if (resolvedCli === null) {
      deps.logger.log("warn", "engineer.runner_skipped", {
        agent: input.agentConfig.id,
        reason: "no_cli_configured",
        configured_cli: null,
        supported,
      });
      return null;
    }

    const entry = deps.registry[resolvedCli];
    if (entry === undefined) {
      deps.logger.log("warn", "engineer.runner_skipped", {
        agent: input.agentConfig.id,
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
    });

    const workspacePath = input.provisioner.workspacePathFor(
      input.projectId,
      input.agentConfig.id,
    );
    const mcpServerConfig = buildEngineerMcpServerConfig({
      agentId: input.agentConfig.id as AgentId,
      serverUrl: input.serverUrl,
      workspacePath,
      mcpEntryPath: deps.mcpEntryPath,
    });

    const activityHttpClient = deps.makeActivityHttpClient(
      input.serverUrl,
      input.agentConfig.id,
    );

    return createEngineerRunner(
      {
        provisioner: input.provisioner,
        codingAgentInvoker,
        activityHttpClient,
        logger: deps.logger,
      },
      {
        projectId: input.projectId,
        projectName: input.projectName,
        agentId: input.agentConfig.id as AgentId,
        projectRepoPath: input.projectRepoPath,
        serverUrl: input.serverUrl,
        mcpServerConfig,
        envAllowlist: entry.envAllowlist,
      },
    );
  };
}

/**
 * Resolve the CLI name for an engineer agent. Per-agent `cli` wins over
 * global `coding_agent_cli`; an empty string at either layer is treated
 * as absent (a `~/.keni/config.yaml` with `coding_agent_cli: ""` is a
 * mistake the user should see the same warn line for as no value at
 * all).
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
