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
  TicketStore,
} from "@keni/shared";
import { resolve } from "@std/path";
import { createInMemoryAgentRuntimeStateStore } from "./agentState.ts";
import { createInMemoryEventBus } from "./eventBus.ts";
import { createMutex, type Mutex } from "./concurrency/mutex.ts";
import { stdoutLogSink } from "./middleware/requestLog.ts";
import type { LogSink } from "./middleware/types.ts";
import { defaultClock } from "./scheduler/clock.ts";
import { consoleSchedulerLogger, type SchedulerLogger } from "./scheduler/log.ts";
import {
  type AgentRunner,
  type AgentRunnerRegistry,
  createAgentRunnerRegistry,
} from "./scheduler/registry.ts";
import {
  createScheduler,
  type Scheduler,
  type SchedulerDeps,
  type SchedulerOpts,
} from "./scheduler/scheduler.ts";
import { startServer } from "./startServer.ts";
import {
  GitWorkspaceProvisioner,
  type WorkspaceLogger,
  type WorkspaceProvisioner,
  WorkspaceProvisioningError,
} from "@keni/role-runtimes";

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
   * Tests pass a `FakeWorkspaceProvisioner` to assert on
   * `ensureProvisioned` / `pullMain` / `discardProvisioned` calls without
   * touching git or the filesystem.
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
   * Build the engineer's `AgentRunner` for `agentConfig`. The default is
   * to *skip* engineer-runner registration (the merge endpoint, ticket
   * REST, MCP server, and provisioner all still wire up; the scheduler
   * simply logs `runner.missing` on engineer ticks until a follow-up
   * change wires the production coding-agent invoker). Tests pass a
   * stub returning a deterministic runner so the wiring sequence can
   * be observed without launching real subprocesses.
   *
   * @returns an `AgentRunner` to register, or `null` to skip this engineer.
   */
  readonly makeEngineerRunner?: (input: MakeEngineerRunnerInput) => AgentRunner | null;
}

/** Input bag handed to {@link RunServerDeps.makeEngineerRunner}. */
export interface MakeEngineerRunnerInput {
  readonly projectId: string;
  readonly projectName: string;
  readonly agentConfig: AgentConfig;
  readonly serverUrl: string;
  readonly projectRepoPath: string;
  readonly provisioner: WorkspaceProvisioner;
  readonly logger: SchedulerLogger;
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
  try {
    const config = await stores.configStore.readProjectConfig();
    projectId = config.project_id;
    projectName = config.name;
    roster = config.agents ?? [];
    schedules = config.schedules;
    timeouts = config.timeouts;
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
  const agentRuntimeStateStore = createInMemoryAgentRuntimeStateStore(roster);
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

  const serverHandle = await startServer(
    {
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
    },
    { projectId, port: parsed.port, host: parsed.host },
  );

  const engineers = roster.filter((a) => a.role === "engineer");
  if (engineers.length > 0) {
    try {
      await wireEngineers({
        engineers,
        projectId,
        projectName,
        provisioner,
        projectRepoPath: parsed.projectDir,
        serverUrl: serverHandle.url,
        registry,
        schedulerLogger,
        ...(deps.makeEngineerRunner !== undefined
          ? { makeEngineerRunner: deps.makeEngineerRunner }
          : {}),
      });
    } catch (e) {
      const failure = e as EngineerWiringFailure;
      err(
        `Failed to provision workspace for engineer ${failure.agentId}: ` +
          `${failure.code} (${failure.cause})`,
      );
      await serverHandle.abort();
      return 1;
    }
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

interface WireEngineersInput {
  readonly engineers: readonly AgentConfig[];
  readonly projectId: string;
  readonly projectName: string;
  readonly provisioner: WorkspaceProvisioner;
  readonly projectRepoPath: string;
  readonly serverUrl: string;
  readonly registry: AgentRunnerRegistry;
  readonly schedulerLogger: SchedulerLogger;
  readonly makeEngineerRunner?: (input: MakeEngineerRunnerInput) => AgentRunner | null;
}

interface EngineerWiringFailure {
  readonly agentId: string;
  readonly code: string;
  readonly cause: string;
}

async function wireEngineers(input: WireEngineersInput): Promise<void> {
  for (const agentConfig of input.engineers) {
    const startedAt = performance.now();
    try {
      await input.provisioner.ensureProvisioned(
        input.projectId,
        agentConfig.id,
        input.projectRepoPath,
      );
    } catch (cause) {
      const code = cause instanceof WorkspaceProvisioningError
        ? cause.code
        : "ensure_provisioned_failed";
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure: EngineerWiringFailure = {
        agentId: agentConfig.id,
        code,
        cause: message,
      };
      throw failure;
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    const workspacePath = input.provisioner.workspacePathFor(
      input.projectId,
      agentConfig.id,
    );
    input.schedulerLogger.log("info", "engineer.wired", {
      agent: agentConfig.id,
      workspace_path: workspacePath,
      elapsed_ms: elapsedMs,
    });

    if (input.makeEngineerRunner !== undefined) {
      const runner = input.makeEngineerRunner({
        projectId: input.projectId,
        projectName: input.projectName,
        agentConfig,
        serverUrl: input.serverUrl,
        projectRepoPath: input.projectRepoPath,
        provisioner: input.provisioner,
        logger: input.schedulerLogger,
      });
      if (runner !== null) {
        input.registry.register(runner);
      }
    }
  }
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
