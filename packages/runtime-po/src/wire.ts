/**
 * PO role's `wire(input)` function — the polymorphic plug-in entry
 * point the orchestration server's `runServer` calls (via the
 * `roleWires` registry the CLI assembles) to register a PO agent.
 *
 * The runner returned here is intentionally minimal: every effectful
 * field exists only because `AgentRunner` requires it, and the
 * `precheck` always resolves
 * `{ kind: "skip", reason: "po_not_implemented" }` so no MCP server
 * is spawned, no coding-agent CLI runs, and no activity log entries
 * are produced for the PO agent.
 *
 * The wire's only role-specific guard rejects an `agentConfig.role`
 * that is not `"po"` — defensive, since `runServer`'s polymorphic
 * dispatch keys on role and would not call this wire for a
 * non-PO agent, but kept as a documented invariant.
 *
 * @module
 */

import type { AgentRunner, BundledPrompt, CyclePrepCtx, WireFn } from "@keni/runtime-common";
import { createSubprocessCodingAgentInvoker } from "@keni/runtime-common";

import { PO_PROMPT_BODY, PO_PROMPT_NAME } from "./prompts/po.ts";

/**
 * PO's `WireFn`. Always resolves with an `AgentRunner`; never returns
 * `null` (the PO role has no notion of "skip the agent on boot"
 * because no precondition can fail at boot time — every PO precheck
 * returns the same `precheck_skipped` outcome at tick time).
 */
export const wire: WireFn = (input): Promise<AgentRunner | null> => {
  if (input.agentConfig.role !== "po") {
    return Promise.resolve(null);
  }

  const codingAgentInvoker = createSubprocessCodingAgentInvoker({
    cliBinary: "/usr/bin/true",
    buildArgs: () => [],
    promptInjection: "stdin",
    mcpConfigStrategy: { kind: "tempfile-json" },
  });

  const promptResolver = (_ctx: CyclePrepCtx): BundledPrompt => ({
    name: PO_PROMPT_NAME,
    body: PO_PROMPT_BODY,
  });

  const runner: AgentRunner = {
    role: "po",
    precheck: () => ({ kind: "skip", reason: "po_not_implemented" }),
    promptResolver,
    expectedPromptName: PO_PROMPT_NAME,
    codingAgentInvoker,
    mcpServerConfig: {
      command: "deno",
      args: [
        "run",
        "-A",
        input.mcpEntryPath,
        "--agent",
        input.agentConfig.id,
        "--server-url",
        input.serverUrl,
        "--workspace",
        "/dev/null",
      ],
    },
  };

  return Promise.resolve(runner);
};
