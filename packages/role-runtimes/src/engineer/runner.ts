/**
 * `createEngineerRunner` — engineer specialisation of the role-runtime
 * cycle, packaged as the `AgentRunner` value bag the scheduler hands to
 * `startCycle` on every tick.
 *
 * Engineer-runtime spec §"`@keni/role-runtimes` exposes a
 * `createEngineerRunner(deps, opts)` factory…": the factory is pure
 * (no I/O at construction); the precheck pulls `main` first, then
 * queries the orchestration server for in-flight tickets, then
 * unassigned pickups; the prompt resolver returns the bundled
 * engineer prompt; the `mcpServerConfig` is built once at runner
 * creation from `serverUrl`, `agentId`, and `provisioner.workspacePathFor(...)`.
 *
 * The returned value's structural shape is identical to
 * `AgentRunner` from `@keni/server`'s scheduler registry, so a caller
 * registers it via `scheduler.registerRunner(runner)` directly.
 *
 * @module
 */

import type { AgentId, Role, TicketFilter, TicketStatus, TicketSummary } from "@keni/shared";
import type {
  BundledPrompt,
  CodingAgentInvoker,
  CyclePrepCtx,
  McpServerConfig,
  PrecheckResult,
} from "../common/types.ts";
import { ENGINEER_PROMPT_BODY, ENGINEER_PROMPT_NAME } from "./prompts/engineer.ts";
import type { WorkspaceLogger, WorkspaceProvisioner } from "./workspace/interface.ts";

/**
 * Minimal HTTP-client surface the engineer precheck depends on.
 * Mirrors a subset of the orchestration server's `GET /tickets`
 * endpoint as a typed promise; the full HTTP client (multi-method,
 * identity-stamping) lives in `packages/server/src/mcp/httpClient.ts`
 * but the precheck only needs `listTickets`. The narrow surface keeps
 * the engineer runtime testable with a tiny stub.
 */
export interface EngineerActivityHttpClient {
  listTickets(filter: TicketFilter): Promise<readonly TicketSummary[]>;
}

/**
 * Runtime dependencies for the engineer runner. Every member is
 * effectful (provisioner, invoker, HTTP client, logger) — the factory
 * never spawns subprocesses, fetches, or touches the filesystem
 * itself; it threads these dependencies into the returned value bag.
 */
export interface EngineerRunnerDeps {
  readonly provisioner: WorkspaceProvisioner;
  readonly codingAgentInvoker: CodingAgentInvoker;
  readonly activityHttpClient: EngineerActivityHttpClient;
  readonly logger: WorkspaceLogger;
}

/**
 * Construction options for the engineer runner. Mirrors the
 * `AgentRunner` value bag's per-agent fields plus the engineer-specific
 * `projectRepoPath` (used for cycle-side workspace operations) and
 * `serverUrl` (stamped into `mcpServerConfig`).
 */
export interface EngineerRunnerOpts {
  readonly projectId: string;
  readonly projectName: string;
  readonly agentId: AgentId;
  readonly projectRepoPath: string;
  readonly serverUrl: string;
  readonly mcpServerConfig: McpServerConfig;
  readonly envAllowlist?: readonly string[];
  readonly idleThresholdMs?: number;
  readonly terminationGraceMs?: number;
}

/**
 * The structural shape of the value the engineer runner returns —
 * identical (field-by-field) to `AgentRunner` in `@keni/server`'s
 * scheduler registry. Declared here so role-runtimes does not depend
 * on `@keni/server`; the server's `AgentRunner` interface is
 * structurally satisfied at registration time.
 */
export interface EngineerAgentRunner {
  readonly role: Role;
  readonly precheck: (ctx: CyclePrepCtx) => Promise<PrecheckResult> | PrecheckResult;
  readonly promptResolver: (ctx: CyclePrepCtx) => BundledPrompt;
  readonly expectedPromptName: string;
  readonly codingAgentInvoker: CodingAgentInvoker;
  readonly mcpServerConfig: McpServerConfig;
  readonly envAllowlist?: readonly string[];
  readonly idleThresholdMs?: number;
  readonly terminationGraceMs?: number;
}

/** Status set the in-flight precheck query searches for. */
const IN_FLIGHT_STATUSES: readonly TicketStatus[] = [
  "in_progress",
  "ready_for_review",
  "in_review",
  "has_comments",
  "approved",
  "merged",
];

/** Status set the unassigned-pickup precheck query searches for. */
const PICKUP_STATUSES: readonly TicketStatus[] = [
  "open",
  "test_failed",
  "has_comments",
];

/**
 * Order tickets the engineer should pick: priority descending, ties
 * broken by id ascending. Pure helper, exported so a unit test can
 * pin the comparator without round-tripping the precheck.
 */
export function orderEngineerTickets(
  tickets: readonly TicketSummary[],
): readonly TicketSummary[] {
  return [...tickets].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Build the engineer's `AgentRunner` value bag. Pure — no I/O at
 * construction; every effectful primitive flows through `deps`.
 *
 * The returned runner's `precheck` executes the four-step playbook
 * documented in the engineer-runtime capability spec: pull main →
 * in-flight query → pickup query → skip. The `promptResolver` returns
 * the bundled engineer prompt unchanged. The `mcpServerConfig` is the
 * caller-supplied bag (typically constructed via the helper below).
 */
export function createEngineerRunner(
  deps: EngineerRunnerDeps,
  opts: EngineerRunnerOpts,
): EngineerAgentRunner {
  const precheck = async (ctx: CyclePrepCtx): Promise<PrecheckResult> => {
    try {
      await deps.provisioner.pullMain(opts.projectId, opts.agentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.log("warn", "engineer.pull_main_failed", {
        agent: opts.agentId,
        error: message,
        code: err instanceof Error && "code" in err ? (err as { code: unknown }).code : undefined,
      });
      return { kind: "skip", reason: "pull_main_failed" };
    }

    const inFlight = await deps.activityHttpClient.listTickets({
      status: IN_FLIGHT_STATUSES,
      assignee: opts.agentId,
    });
    if (inFlight.length > 0) {
      const top = orderEngineerTickets(inFlight)[0]!;
      return {
        kind: "proceed",
        roleContext: { summary: `${top.id} (in-flight)` },
      };
    }

    const pickup = await deps.activityHttpClient.listTickets({
      status: PICKUP_STATUSES,
      assignee: null,
    });
    if (pickup.length > 0) {
      const top = orderEngineerTickets(pickup)[0]!;
      return {
        kind: "proceed",
        roleContext: { summary: `${top.id} (picking up)` },
      };
    }

    // Unused — documents the precheck context for future use.
    void ctx;

    return { kind: "skip", reason: "no_ticket_to_pick_up" };
  };

  const promptResolver = (_ctx: CyclePrepCtx): BundledPrompt => ({
    name: ENGINEER_PROMPT_NAME,
    body: ENGINEER_PROMPT_BODY,
  });

  const runner: EngineerAgentRunner = {
    role: "engineer",
    precheck,
    promptResolver,
    expectedPromptName: ENGINEER_PROMPT_NAME,
    codingAgentInvoker: deps.codingAgentInvoker,
    mcpServerConfig: opts.mcpServerConfig,
    ...(opts.envAllowlist !== undefined ? { envAllowlist: opts.envAllowlist } : {}),
    ...(opts.idleThresholdMs !== undefined ? { idleThresholdMs: opts.idleThresholdMs } : {}),
    ...(opts.terminationGraceMs !== undefined
      ? { terminationGraceMs: opts.terminationGraceMs }
      : {}),
  };
  return runner;
}

/**
 * Build the canonical `mcpServerConfig` for the engineer subprocess.
 * The MCP server binary is invoked via `deno run -A` against
 * `packages/server/src/mcp/main.ts` (the existing MCP entry point) with
 * `--agent`, `--server-url`, and `--workspace` flags carrying the
 * engineer's identity and workspace path. The optional
 * `denoBinary` and `mcpEntryPath` overrides exist so tests can point
 * at fixture binaries.
 */
export interface BuildEngineerMcpServerConfigOpts {
  readonly agentId: AgentId;
  readonly serverUrl: string;
  readonly workspacePath: string;
  readonly denoBinary?: string;
  readonly mcpEntryPath: string;
  readonly env?: Readonly<Record<string, string>>;
}

export function buildEngineerMcpServerConfig(
  opts: BuildEngineerMcpServerConfigOpts,
): McpServerConfig {
  return {
    command: opts.denoBinary ?? "deno",
    args: [
      "run",
      "-A",
      opts.mcpEntryPath,
      "--agent",
      opts.agentId,
      "--server-url",
      opts.serverUrl,
      "--workspace",
      opts.workspacePath,
    ],
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };
}
