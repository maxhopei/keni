/**
 * `runServer` — argv-level entry point for the orchestration server.
 *
 * Parses `--project <path>`, `--port <n>`, `--host <h>` (hand-rolled, no
 * `parseArgs` dep yet), resolves project paths, builds the four file-backed
 * stores, reads `project.yaml` once, calls `startServer`, prints the bound
 * URL, and awaits a SIGINT for shutdown. Returns a process exit code:
 *
 * | Exit | Cause |
 * | ---- | ----- |
 * | 0    | Server started, ran, and shut down cleanly on SIGINT |
 * | 1    | Project not initialised (missing `.keni/project.yaml`) |
 * | 2    | Usage error (missing `--project`, unknown flag, bad value) |
 *
 * Tests drive `runServer` in-process by injecting `RunServerDeps`:
 * `signal` to skip waiting for a real SIGINT, `out`/`err` to capture I/O,
 * `makeStores` to substitute in-memory adapters.
 *
 * @module
 */

import {
  FileActivityLogStore,
  FileConfigStore,
  FilePRStore,
  FileTicketStore,
  resolveGlobalPaths,
  resolveProjectPaths,
  StoreNotFoundError,
} from "@keni/shared";
import type {
  ActivityLogStore,
  AgentConfig,
  ConfigStore,
  ProjectPaths,
  PRStore,
  ResolvedConfig,
  TicketStore,
} from "@keni/shared";
import { resolve } from "@std/path";
import type {
  ActivityHttpClient,
  AgentRunner,
  CodingAgentCliEntry,
  WireFn,
  WireInput,
} from "@keni/runtime-common";
import { codingAgentCliRegistry as defaultCodingAgentCliRegistry } from "@keni/runtime-common";
import { createInMemoryAgentRuntimeStateStore } from "./agentState.ts";
import type { ServerDeps } from "./createServer.ts";
import { createInMemoryEventBus } from "./eventBus.ts";
import { createMutex, type Mutex } from "./concurrency/mutex.ts";
import { createMcpHttpClient } from "./mcp/main.ts";
import { MCP_ENTRY_PATH } from "./mcpEntryPath.ts";
import { stdoutLogSink } from "./middleware/requestLog.ts";
import type { LogSink } from "./middleware/types.ts";
import { defaultClock } from "./scheduler/clock.ts";
import { consoleSchedulerLogger, type SchedulerLogger } from "./scheduler/log.ts";
import { type AgentRunnerRegistry, createAgentRunnerRegistry } from "./scheduler/registry.ts";
import {
  createScheduler,
  type Scheduler,
  type SchedulerDeps,
  type SchedulerOpts,
} from "./scheduler/scheduler.ts";
import { type StartedServer, startServer, type StartServerOptions } from "./startServer.ts";
import {
  GitWorkspaceProvisioner,
  type WorkspaceLogger,
  type WorkspaceProvisioner,
} from "@keni/runtime-workspace";

/** Parsed CLI flags for `runServer`. */
export interface RunServerArgs {
  readonly projectDir: string;
  readonly port: number;
  readonly host: string;
}

/** Optional dependency overrides for tests. */
export interface RunServerDeps {
  /** Stdout writer. Defaults to `console.log`. */
  readonly out?: (line: string) => void;
  /** Stderr writer. Defaults to `console.error`. */
  readonly err?: (line: string) => void;
  /** Home directory for `~/.keni/` resolution. Defaults to `Deno.env.get("HOME")`. */
  readonly homeDir?: string;
  /** Override the log sink (defaults to {@link stdoutLogSink}). */
  readonly logSink?: LogSink;
  /**
   * Override the store factory. Defaults to `File*` adapters rooted at the
   * resolved project paths. Tests pass in-memory adapters here.
   */
  readonly makeStores?: (paths: ProjectPaths) => {
    readonly ticketStore: TicketStore;
    readonly prStore: PRStore;
    readonly activityLogStore: ActivityLogStore;
    readonly configStore: ConfigStore;
  };
  /**
   * Pre-aborted signal that resolves immediately, used by tests to make the
   * server return without waiting for a real SIGINT. When omitted, the
   * default behaviour installs a SIGINT listener.
   */
  readonly shutdownSignal?: AbortSignal;
  /**
   * Override the scheduler logger (defaults to {@link consoleSchedulerLogger}).
   * Tests pass a `captureSchedulerLogger(buffer)` to assert on emitted lines.
   */
  readonly schedulerLogger?: SchedulerLogger;
  /**
   * Override the scheduler factory and the registry construction. The
   * default wires `createScheduler` against `defaultClock()` and a fresh
   * `createAgentRunnerRegistry`. Tests inject a stub factory to assert
   * the bootstrap call shape and lifecycle invariants per the
   * scheduler capability spec.
   */
  readonly makeScheduler?: (
    deps: SchedulerDeps,
    opts: SchedulerOpts,
  ) => Scheduler;
  /**
   * Override how the runner registry is built. Tests usually leave this
   * default and instead `register(...)` directly against the returned
   * registry via {@link RunServerHandle.registry} once step 12 wires
   * the interrupt endpoint.
   */
  readonly makeRegistry?: (logger: SchedulerLogger) => AgentRunnerRegistry;
  /**
   * Test-only seam to observe the scheduler handle and the registry
   * after bootstrap completes. The callback is invoked once after
   * `scheduler.start()` returns; it does not gate the function's
   * resolution.
   */
  readonly onSchedulerReady?: (handle: {
    readonly scheduler: Scheduler;
    readonly registry: AgentRunnerRegistry;
  }) => void;
  /**
   * Override the {@link WorkspaceProvisioner}. Defaults to
   * `new GitWorkspaceProvisioner({ homeDir, logger: workspaceLoggerOf(schedulerLogger) })`.
   * Tests pass a `FakeWorkspaceProvisioner` (imported from
   * `@keni/runtime-workspace/test-fakes`) to assert on `ensureProvisioned` /
   * `pullMain` / `discardProvisioned` calls without touching git or the
   * filesystem.
   */
  readonly workspaceProvisioner?: WorkspaceProvisioner;
  /**
   * Optional shared {@link Mutex} guarding `git merge --ff-only` against
   * the project repo from `POST /prs/:id/merge`. Defaults to a fresh
   * in-process mutex created at boot. Tests pass a stub to assert the
   * merge endpoint serialises through it.
   */
  readonly mergeMutex?: Mutex;
  /**
   * Polymorphic per-role plug-in registry. The CLI's composition root
   * assembles `{ engineer: engineerWire, po: poWire, ... }` from each
   * role package's `wire` export and hands it through here. `runServer`
   * iterates the project's roster and dispatches
   * `await roleWires[agent.role]?.(input)` per agent (insertion order).
   * A non-`null` `AgentRunner` return is registered with the scheduler;
   * a `null` return is logged and skipped; a thrown error fails boot
   * with exit code 1. When `roleWires` is undefined or empty, the
   * scheduler runs with zero registered runners and the per-tick
   * `runner.missing` line fires for every roster entry.
   *
   * Replaces the legacy `makeEngineerRunner` seam: the orchestration
   * server holds zero role-specific compile-time knowledge.
   */
  readonly roleWires?: Readonly<Record<string, WireFn>>;
  /**
   * Filesystem path the role wires hand to `mcpServerConfig` builders
   * as the first positional arg of `deno run -A <path> ...`. Defaults
   * to {@link MCP_ENTRY_PATH}. E2E tests override this to point at a
   * fake stub.
   */
  readonly mcpEntryPath?: string;
  /**
   * Factory used by role wires to construct an `ActivityHttpClient`
   * instance per agent (the engineer's runner consumes this for
   * pull/in-flight ticket queries). Defaults to a closure over
   * {@link createMcpHttpClient}; tests pass a stub to avoid real HTTP.
   */
  readonly makeActivityHttpClient?: (
    serverUrl: string,
    agentId: string,
  ) => ActivityHttpClient;
  /**
   * Coding-agent CLI registry handed to role wires via
   * `WireInput.codingAgentCliRegistry`. Defaults to the canonical
   * `codingAgentCliRegistry` from `@keni/runtime-common`. The CLI's
   * e2e tests merge in a fixture entry for the fake-coding-agent
   * subprocess.
   */
  readonly codingAgentCliRegistry?: Readonly<Record<string, CodingAgentCliEntry>>;
  /**
   * Optional absolute path to the SPA's production bundle. When supplied,
   * `runServer` forwards it through `ServerDeps.staticAssetsRoot` so the
   * orchestration server mounts the static SPA route group. The
   * `cli-start-and-end-to-end-wiring` change wires this from
   * `resolveSpaBundle` in `runStart`.
   */
  readonly staticAssetsRoot?: string;
  /**
   * Optional roster ids whose `paused` flag is `true` at boot. Forwarded
   * verbatim to {@link createInMemoryAgentRuntimeStateStore}. Wired by
   * `runStart` from `<projectDir>/.keni/state.json#paused_agents`.
   */
  readonly initiallyPausedAgents?: readonly string[];
  /**
   * Optional persister called by the `/agents/:id/pause` and
   * `/agents/:id/resume` route handlers AFTER the `agent.state_changed`
   * frame is emitted. Wired by `runStart` to `persistPausedAgents`.
   */
  readonly pausedAgentsPersister?: (paused: readonly string[]) => Promise<void>;
  /**
   * Optional override for `startServer`. The
   * `cli-start-and-end-to-end-wiring` change uses this to wrap
   * `startServer` with `bindPortInRange` so port selection happens inside
   * `runStart` rather than `runServer`. When omitted, the default
   * `startServer` (single-attempt bind on the resolved port) is used.
   */
  readonly startServerOverride?: (
    deps: ServerDeps,
    opts: StartServerOptions,
  ) => Promise<StartedServer>;
}

/**
 * Parse argv. Accepts `--key value` and `--key=value`. Throws `UsageError`
 * (caught by `runServer` → exit 2) on shape problems.
 */
export function parseRunServerArgs(args: readonly string[]): RunServerArgs {
  let projectDir: string | undefined;
  let port = 0;
  let host = "127.0.0.1";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [key, inlineValue] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];

    const consume = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`Flag ${key} requires a value`);
      }
      i++;
      return next;
    };

    switch (key) {
      case "--project":
        projectDir = consume();
        break;
      case "--port": {
        const raw = consume();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
          throw new UsageError(`--port must be a non-negative integer ≤ 65535 (got '${raw}')`);
        }
        port = parsed;
        break;
      }
      case "--host":
        host = consume();
        break;
      default:
        throw new UsageError(`Unknown flag: ${key}`);
    }
  }

  if (projectDir === undefined) {
    throw new UsageError("Missing required flag: --project <path>");
  }

  return { projectDir: resolve(projectDir), port, host };
}

/** Internal — surfaces as exit 2 in `runServer`. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Print the documented usage text. */
function formatUsage(): string {
  return [
    "Usage: deno run -A packages/server/src/main.ts --project <path> [--port <n>] [--host <h>]",
    "",
    "Flags:",
    "  --project <path>   Required. Path to the directory holding `.keni/project.yaml`.",
    "  --port    <n>      Optional. TCP port. 0 (the default) requests an OS-assigned port.",
    "  --host    <h>      Optional. Hostname to bind. Defaults to 127.0.0.1 (loopback only).",
  ].join("\n");
}

/**
 * Argv-level entry point. Returns the exit code; never calls `Deno.exit`.
 */
export async function runServer(
  args: readonly string[],
  deps: RunServerDeps = {},
): Promise<number> {
  const out = deps.out ?? ((m) => console.log(m));
  const err = deps.err ?? ((m) => console.error(m));

  let parsed: RunServerArgs;
  try {
    parsed = parseRunServerArgs(args);
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      err(formatUsage());
      return 2;
    }
    throw e;
  }

  const projectPaths = resolveProjectPaths(parsed.projectDir);
  const homeDir = deps.homeDir ?? Deno.env.get("HOME") ?? "";
  const globalPaths = resolveGlobalPaths(homeDir);

  const stores = deps.makeStores?.(projectPaths) ?? {
    ticketStore: new FileTicketStore(projectPaths),
    prStore: new FilePRStore(projectPaths),
    activityLogStore: new FileActivityLogStore(projectPaths),
    configStore: new FileConfigStore(projectPaths, globalPaths),
  };

  let projectId: string;
  let projectName: string;
  let roster: readonly AgentConfig[];
  let schedules: Readonly<Record<string, string>> | undefined;
  let timeouts: Readonly<Record<string, string | number>> | undefined;
  let resolvedConfig: ResolvedConfig;
  try {
    const config = await stores.configStore.readProjectConfig();
    projectId = config.project_id;
    projectName = config.name;
    roster = config.agents ?? [];
    schedules = config.schedules;
    timeouts = config.timeouts;
    resolvedConfig = await stores.configStore.resolve();
  } catch (e) {
    if (e instanceof StoreNotFoundError) {
      err(
        `No .keni/project.yaml found at ${projectPaths.projectConfig}; run \`keni init\` first.`,
      );
      return 1;
    }
    throw e;
  }

  const logSink = deps.logSink ?? stdoutLogSink();
  const eventBus = createInMemoryEventBus({ logSink });
  const agentRuntimeStateStore = createInMemoryAgentRuntimeStateStore(roster, {
    ...(deps.initiallyPausedAgents !== undefined
      ? { initiallyPaused: deps.initiallyPausedAgents }
      : {}),
  });
  const schedulerLogger = deps.schedulerLogger ?? consoleSchedulerLogger();
  const registry = (deps.makeRegistry ?? createAgentRunnerRegistry)(schedulerLogger);
  const provisioner = deps.workspaceProvisioner ??
    new GitWorkspaceProvisioner({
      homeDir,
      logger: workspaceLoggerOf(schedulerLogger),
    });
  const mergeMutex = deps.mergeMutex ?? createMutex();

  // Cell that the agents-route closure dereferences when the
  // `POST /agents/:id/interrupt` handler fires. The scheduler is
  // constructed AFTER `startServer` (it needs the bound server URL),
  // so this thunk returns `null` during the brief startup window —
  // see `interrupt-and-timeout-ux` capability.
  let schedulerForRoutes: Scheduler | null = null;
  const getScheduler = () => schedulerForRoutes;

  // The deps bag is built up-front so its identity is stable across
  // (1) the createServer call inside startServer, and (2) the post-bind
  // `serverStartedAt` mutation below. The `/health` route reads
  // `serverStartedAt` lazily through a closure that closes over this
  // very object, so mutating the field after `startServer` resolves
  // becomes visible to the next request without re-building the app.
  const serverDeps: ServerDeps = {
    ticketStore: stores.ticketStore,
    prStore: stores.prStore,
    activityLogStore: stores.activityLogStore,
    configStore: stores.configStore,
    logSink,
    eventBus,
    agentRuntimeStateStore,
    workspaceProvisioner: provisioner,
    projectRepoPath: parsed.projectDir,
    mergeMutex,
    getScheduler,
    ...(deps.staticAssetsRoot !== undefined ? { staticAssetsRoot: deps.staticAssetsRoot } : {}),
    ...(deps.pausedAgentsPersister !== undefined
      ? { pausedAgentsPersister: deps.pausedAgentsPersister }
      : {}),
  };

  const startServerImpl = deps.startServerOverride ?? startServer;
  const serverHandle = await startServerImpl(
    serverDeps,
    { projectId, port: parsed.port, host: parsed.host },
  );

  // Mutating `readonly` is intentional and safe: the field is only ever
  // written here (immediately after `onListen`), every subsequent reader
  // is a `/health` request observed via the route's closure, and Hono
  // dispatches requests serially per connection so there is no race.
  (serverDeps as { serverStartedAt?: Date }).serverStartedAt = new Date();

  const roleWires = deps.roleWires ?? {};
  const wireInputDefaults: WireInputDefaults = {
    mcpEntryPath: deps.mcpEntryPath ?? MCP_ENTRY_PATH,
    makeActivityHttpClient: deps.makeActivityHttpClient ?? defaultMakeActivityHttpClient,
    codingAgentCliRegistry: deps.codingAgentCliRegistry ?? defaultCodingAgentCliRegistry,
  };
  try {
    await wireRoles({
      roster,
      roleWires,
      projectId,
      projectName,
      projectRepoPath: parsed.projectDir,
      serverUrl: serverHandle.url,
      resolvedConfig,
      provisioner,
      logger: workspaceLoggerOf(schedulerLogger),
      registry,
      schedulerLogger,
      defaults: wireInputDefaults,
    });
  } catch (e) {
    const failure = e as RoleWiringFailure;
    err(`Failed to wire role runner for ${failure.agentId}: ${failure.cause}`);
    await serverHandle.abort();
    return 1;
  }

  const scheduler = (deps.makeScheduler ?? createScheduler)(
    {
      runtimeStore: agentRuntimeStateStore,
      logger: schedulerLogger,
      registry,
      clock: defaultClock(),
    },
    {
      agents: roster,
      ...(schedules !== undefined ? { schedules } : {}),
      ...(timeouts !== undefined ? { timeouts } : {}),
      serverUrl: serverHandle.url,
      projectName,
    },
  );
  // Wire the scheduler into the agents-route closure now so the
  // `POST /agents/:id/interrupt` handler can reach it.
  schedulerForRoutes = scheduler;
  scheduler.start();
  deps.onSchedulerReady?.({ scheduler, registry });

  out(`Keni server running at ${serverHandle.url}`);

  await waitForShutdown(deps.shutdownSignal);
  await scheduler.stop();
  await serverHandle.abort();
  return 0;
}

interface WireInputDefaults {
  readonly mcpEntryPath: string;
  readonly makeActivityHttpClient: (
    serverUrl: string,
    agentId: string,
  ) => ActivityHttpClient;
  readonly codingAgentCliRegistry: Readonly<Record<string, CodingAgentCliEntry>>;
}

interface WireRolesInput {
  readonly roster: readonly AgentConfig[];
  readonly roleWires: Readonly<Record<string, WireFn>>;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRepoPath: string;
  readonly serverUrl: string;
  readonly resolvedConfig: ResolvedConfig;
  readonly provisioner: WorkspaceProvisioner;
  readonly logger: WorkspaceLogger;
  readonly registry: AgentRunnerRegistry;
  readonly schedulerLogger: SchedulerLogger;
  readonly defaults: WireInputDefaults;
}

interface RoleWiringFailure {
  readonly agentId: string;
  readonly cause: string;
}

/**
 * Iterate the roster in declaration order and dispatch each agent to
 * its role's `WireFn`. Registers every non-`null` runner with the
 * scheduler's registry; logs `runner.skipped` when a wire is missing
 * or returns `null`. A throw inside any wire surfaces as
 * {@link RoleWiringFailure} — `runServer` aborts the server and exits
 * with code 1.
 */
async function wireRoles(input: WireRolesInput): Promise<void> {
  for (const agentConfig of input.roster) {
    const startedAt = performance.now();
    const wireFn = input.roleWires[agentConfig.role];
    if (wireFn === undefined) {
      input.schedulerLogger.log("info", "runner.skipped", {
        agent: agentConfig.id,
        role: agentConfig.role,
        reason: "no_wire_registered",
      });
      continue;
    }

    const wireInput: WireInput = {
      projectId: input.projectId,
      projectName: input.projectName,
      projectRepoPath: input.projectRepoPath,
      serverUrl: input.serverUrl,
      agentConfig,
      resolvedConfig: input.resolvedConfig,
      mcpEntryPath: input.defaults.mcpEntryPath,
      logger: input.logger,
      makeActivityHttpClient: input.defaults.makeActivityHttpClient,
      codingAgentCliRegistry: input.defaults.codingAgentCliRegistry,
      workspaceProvisioner: input.provisioner,
    };

    let runner: AgentRunner | null;
    try {
      runner = await wireFn(wireInput);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure: RoleWiringFailure = {
        agentId: agentConfig.id,
        cause: message,
      };
      throw failure;
    }

    if (runner === null) {
      input.schedulerLogger.log("info", "runner.skipped", {
        agent: agentConfig.id,
        role: agentConfig.role,
        reason: "wire_returned_null",
      });
      continue;
    }

    input.registry.register(runner);
    const elapsedMs = Math.round(performance.now() - startedAt);
    input.schedulerLogger.log("info", "runner.registered", {
      agent: agentConfig.id,
      role: runner.role,
      workspace_path: runner.workspacePath ?? null,
      elapsed_ms: elapsedMs,
    });
  }
}

/**
 * Default `makeActivityHttpClient` — wraps {@link createMcpHttpClient}
 * and exposes only the `listTickets` method required by
 * `ActivityHttpClient`. The full `McpHttpClient` is structurally
 * compatible (it carries `listTickets`); the cast is safe because
 * `ActivityHttpClient` is a strict subset.
 */
function defaultMakeActivityHttpClient(
  serverUrl: string,
  agentId: string,
): ActivityHttpClient {
  return createMcpHttpClient({ serverUrl, agentId }) as ActivityHttpClient;
}

/**
 * Adapt a {@link SchedulerLogger} to the narrower {@link WorkspaceLogger}
 * surface the `GitWorkspaceProvisioner` consumes. Both are
 * (`level`, `event`, `data`)-shaped; the adapter forwards verbatim.
 */
function workspaceLoggerOf(logger: SchedulerLogger): WorkspaceLogger {
  return {
    log(level, event, data) {
      logger.log(level, event, data);
    },
  };
}

/**
 * Wait for either an injected `AbortSignal` (test path) or a real SIGINT
 * (production path). Cleans up the signal listener on resolve so we never
 * leak a global handler.
 */
function waitForShutdown(injected: AbortSignal | undefined): Promise<void> {
  if (injected !== undefined) {
    if (injected.aborted) return Promise.resolve();
    return new Promise((resolveFn) => {
      injected.addEventListener("abort", () => resolveFn(), { once: true });
    });
  }
  return new Promise((resolveFn) => {
    const handler = () => {
      Deno.removeSignalListener("SIGINT", handler);
      resolveFn();
    };
    Deno.addSignalListener("SIGINT", handler);
  });
}
