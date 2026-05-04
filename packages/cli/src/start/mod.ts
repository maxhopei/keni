/**
 * `keni start` — composition root for the orchestration boot subcommand.
 *
 * Composes the seven `start/` modules into a single entry point that
 * the dispatcher in `main.ts` dispatches to:
 *
 *  1. {@link loadKeniConfig} — global + project YAML (project wins).
 *  2. {@link applyFlagOverrides} — overlay parsed CLI flags.
 *  3. {@link loadEnvFile} + {@link applyEnvOverlay} — project `.env` overlay.
 *  4. {@link resolveSpaBundle} — resolve the SPA descriptor.
 *  5. {@link readPausedAgents} — seed paused-agent ids from `state.json`.
 *  6. Build {@link RunServerDeps} and call {@link runServer} via a
 *     {@link bindPortInRange}-wrapped `startServerOverride` so port
 *     selection happens inside `runStart` (not inside `runServer`).
 *  7. {@link installSignalHandlers} — wire SIGINT / SIGTERM to the
 *     graceful-shutdown sequence.
 *  8. On resolve, run the cleanup callback (remove signal handlers).
 *
 * Returns the process exit code. Maps the documented exit-code table:
 *
 * | Code | Cause |
 * | ---- | ----- |
 * | 0    | Clean shutdown |
 * | 1    | Filesystem / project-state failure |
 * | 2    | Argv usage error |
 * | 130  | Forced shutdown (second SIGINT / SIGTERM) |
 *
 * @module
 */

import type { AgentConfig, ProjectConfig } from "@keni/shared";
import {
  type AgentRuntimeStateStore,
  runServer,
  type RunServerDeps,
  type Scheduler,
  type ServerDeps,
  type StartedServer,
  startServer as defaultStartServer,
  type StartServerOptions,
} from "@keni/server";
import type { WorkspaceProvisioner } from "@keni/role-runtimes";
import type { DispatcherIO } from "../main.ts";
import { ProjectStateError, UsageError } from "../init/errors.ts";
import { type ParsedStartArgs, parseStartArgs as parseStartArgsImpl } from "./args.ts";
import {
  applyFlagOverrides as applyFlagOverridesImpl,
  type KeniStartConfig,
  type LoadedKeniConfig,
  loadKeniConfig as loadKeniConfigImpl,
} from "./loadConfig.ts";
import {
  applyEnvOverlay as applyEnvOverlayImpl,
  defaultEnv,
  type EnvLike,
  loadEnvFile as loadEnvFileImpl,
} from "./loadEnv.ts";
import { bindPortInRange as bindPortInRangeImpl, PortRangeExhaustedError } from "./port.ts";
import {
  type ResolvedSpaBundle,
  resolveSpaBundle as resolveSpaBundleImpl,
  SpaBundleMissingError,
} from "./spaBundle.ts";
import {
  persistPausedAgents as persistPausedAgentsImpl,
  readPausedAgents as readPausedAgentsImpl,
} from "./pausedAgents.ts";
import {
  clampShutdownGrace,
  installSignalHandlers as installSignalHandlersImpl,
  runShutdownSequence as runShutdownSequenceImpl,
  type ShutdownLogSink,
} from "./shutdown.ts";

/** Re-export of the argv parser for the dispatcher. */
export const parseStartArgs = parseStartArgsImpl;

/**
 * Optional dependency overrides for {@link runStart}. The end-to-end
 * smoke test injects every field; production calls leave this
 * undefined.
 */
export interface RunStartDeps {
  readonly homeDir?: string;
  readonly env?: EnvLike;
  /**
   * Override for `startServer` (used by the smoke test to drive a
   * recording server handle). Production wires the real
   * `@keni/server`'s `startServer`.
   */
  readonly startServer?: (
    deps: ServerDeps,
    opts: StartServerOptions,
  ) => Promise<StartedServer>;
  /**
   * Override for `runServer`. The default is the real
   * `@keni/server`'s `runServer`. The smoke test replaces this when
   * it wants to drive a stubbed engineer runner without actually
   * provisioning workspaces.
   */
  readonly runServer?: typeof runServer;
  /** Override for the engineer-runner factory passed through `runServer`. */
  readonly makeEngineerRunner?: RunServerDeps["makeEngineerRunner"];
  /**
   * External shutdown signal — when aborted, runStart treats it
   * exactly like a first SIGINT. The smoke test uses this to drive
   * the shutdown without touching real signals.
   */
  readonly shutdownSignal?: AbortSignal;
  /**
   * External "force-shutdown" signal — when aborted, the shutdown
   * sequence short-circuits to exit 130. The smoke test uses this to
   * cover the forced-shutdown case.
   */
  readonly forceShutdownSignal?: AbortSignal;
  /**
   * Override the workspace provisioner used to ensure engineer
   * workspaces. Production wires a `GitWorkspaceProvisioner`; the
   * end-to-end smoke test injects a `FakeWorkspaceProvisioner` so the
   * boot path runs without touching git or the filesystem.
   */
  readonly workspaceProvisioner?: WorkspaceProvisioner;
}

/**
 * Run the `start` subcommand. Returns the exit code; never calls
 * `Deno.exit`.
 *
 * The sequence is documented in the module-level header. Failures
 * before the listener is bound throw typed errors that the dispatcher
 * (`main.ts`) maps to exit codes; failures after the listener is
 * bound are caught here and surface as exit 1 (the user already saw
 * the success line; we should still attempt a clean shutdown).
 */
export async function runStart(
  args: ParsedStartArgs,
  io: DispatcherIO,
  deps: RunStartDeps = {},
): Promise<number> {
  const homeDir = deps.homeDir ?? Deno.env.get("HOME") ?? "";
  const env = deps.env ?? defaultEnv();
  const cliLogSink: ShutdownLogSink = {
    warn: (message: string) => io.err(`warn: ${message}`),
  };

  if (args.positionalAndFlagBoth) {
    cliLogSink.warn(
      "Both a positional [path] and --project were supplied; using the positional value",
    );
  }

  let loaded: LoadedKeniConfig;
  try {
    loaded = await loadKeniConfigImpl({ projectDir: args.projectDir, homeDir });
  } catch (e) {
    return mapBootError(e, io);
  }
  const startConfig = applyFlagOverridesImpl(loaded.startConfig, args);

  const parsedEnv = await loadEnvFileImpl({
    projectDir: args.projectDir,
    logSink: cliLogSink,
  });
  applyEnvOverlayImpl(parsedEnv, env);

  let spa: ResolvedSpaBundle;
  try {
    spa = resolveSpaBundleImpl({
      spa: startConfig.spa,
      projectDir: args.projectDir,
    });
  } catch (e) {
    return mapBootError(e, io);
  }

  const roster: readonly AgentConfig[] = loaded.projectConfig.agents ?? [];
  const initiallyPausedAgents = await readPausedAgentsImpl({
    projectDir: args.projectDir,
    roster,
    logSink: cliLogSink,
  });

  // The persister wired into `pausedAgentsPersister` re-resolves the
  // project paths via the same helper used elsewhere; the orchestration
  // server's pause handler will catch and warn-log on rejection.
  const pausedAgentsPersister = (paused: readonly string[]): Promise<void> => {
    return persistPausedAgentsImpl({
      projectDir: args.projectDir,
      paused,
      logSink: cliLogSink,
    });
  };

  // Wrap the injected (or default) `startServer` with the port-range
  // walker so port selection happens here, not in `runServer`.
  const startServerImpl = deps.startServer ?? defaultStartServer;
  const startServerOverride = (
    serverDeps: ServerDeps,
    serverOpts: StartServerOptions,
  ): Promise<StartedServer> => {
    return bindPortInRangeImpl({
      startServer: ({ host, port }) => startServerImpl(serverDeps, { ...serverOpts, host, port }),
      host: serverOpts.host ?? startConfig.host,
      range: startConfig.port_range,
      logSink: cliLogSink,
    });
  };

  const graceMs = clampShutdownGrace(startConfig.shutdown_grace_ms, cliLogSink);

  // Three signal sources collaborate:
  //
  //  - `firstShutdown`     : aborts on the first OS / test shutdown signal.
  //                          Drives the documented graceful-shutdown sequence.
  //  - `forceShutdown`     : aborts on the second OS / test shutdown signal.
  //                          Short-circuits the sequence to exit 130.
  //  - `runServerShutdown` : aborts AFTER the graceful sequence resolves so
  //                          `runServer`'s blocking `waitForShutdown` loop
  //                          unblocks. `runServer`'s subsequent
  //                          `scheduler.stop()` and `serverHandle.abort()`
  //                          calls are idempotent no-ops (the handles were
  //                          already drained by the documented sequence).
  const firstShutdown = new AbortController();
  const forceShutdown = new AbortController();
  const runServerShutdown = new AbortController();
  let removeHandlers: (() => void) | undefined;
  const onFirstSignal = () => {
    if (!firstShutdown.signal.aborted) firstShutdown.abort();
  };
  const onForce = () => {
    if (!forceShutdown.signal.aborted) forceShutdown.abort();
  };

  if (deps.shutdownSignal !== undefined) {
    if (deps.shutdownSignal.aborted) onFirstSignal();
    else deps.shutdownSignal.addEventListener("abort", onFirstSignal, { once: true });
  }
  if (deps.forceShutdownSignal !== undefined) {
    if (deps.forceShutdownSignal.aborted) onForce();
    else deps.forceShutdownSignal.addEventListener("abort", onForce, { once: true });
  }
  try {
    removeHandlers = installSignalHandlersImpl(forceShutdown, onFirstSignal);
  } catch {
    removeHandlers = () => {};
  }

  // The `runServer` handles exposed to the documented graceful sequence
  // via a "tap" populated by `startServerOverride` and `onSchedulerReady`.
  const tap: {
    scheduler: Scheduler | null;
    runtimeStore: AgentRuntimeStateStore | null;
    serverHandle: StartedServer | null;
  } = {
    scheduler: null,
    runtimeStore: null,
    serverHandle: null,
  };

  // Capture the documented graceful sequence's exit code (0 or 130)
  // so the dispatcher can return it after `runServer` has unblocked.
  let shutdownExitCode = 0;
  let shutdownPromise: Promise<void> | null = null;
  const onFirstShutdown = () => {
    if (shutdownPromise !== null) return;
    if (tap.scheduler === null || tap.runtimeStore === null || tap.serverHandle === null) {
      // The shutdown signal raced ahead of the listener bind. Ask
      // `runServer` to unblock immediately; it will stop the partial
      // bootstrap and return a non-zero code if relevant.
      runServerShutdown.abort();
      return;
    }
    shutdownPromise = runShutdownSequenceImpl({
      scheduler: tap.scheduler,
      runtimeStore: tap.runtimeStore,
      serverHandle: tap.serverHandle,
      graceMs,
      secondSignal: forceShutdown.signal,
      logSink: cliLogSink,
    }).then((code) => {
      shutdownExitCode = code;
      runServerShutdown.abort();
    });
  };
  if (firstShutdown.signal.aborted) onFirstShutdown();
  else firstShutdown.signal.addEventListener("abort", onFirstShutdown, { once: true });

  const runServerImpl = deps.runServer ?? runServer;
  const runServerArgs = synthesiseRunServerArgs(args.projectDir, startConfig);
  const runServerDeps: RunServerDeps = {
    out: (line) => io.out(line),
    err: (line) => io.err(line),
    homeDir,
    initiallyPausedAgents,
    pausedAgentsPersister,
    startServerOverride: async (serverDeps, serverOpts) => {
      const handle = await startServerOverride(serverDeps, serverOpts);
      tap.serverHandle = handle;
      tap.runtimeStore = serverDeps.agentRuntimeStateStore;
      io.out(`Keni server running at ${handle.url}`);
      if (spa.mode === "dev") {
        io.out(`SPA dev mode — proxy your Vite dev server to ${spa.devUrl}`);
      }
      return handle;
    },
    onSchedulerReady: ({ scheduler }) => {
      tap.scheduler = scheduler;
    },
    ...(spa.mode === "bundled" ? { staticAssetsRoot: spa.root } : {}),
    ...(deps.makeEngineerRunner !== undefined
      ? { makeEngineerRunner: deps.makeEngineerRunner }
      : {}),
    ...(deps.workspaceProvisioner !== undefined
      ? { workspaceProvisioner: deps.workspaceProvisioner }
      : {}),
    // `runServer` blocks on this signal, then runs its own (idempotent)
    // scheduler.stop + serverHandle.abort. We abort it ourselves AFTER
    // the documented graceful sequence resolves.
    shutdownSignal: runServerShutdown.signal,
  };

  let runServerExitCode = 0;
  try {
    runServerExitCode = await runServerImpl(runServerArgs, runServerDeps);
  } catch (e) {
    removeHandlers?.();
    return mapBootError(e, io);
  }
  // Wait for the documented sequence to settle if it was kicked off
  // (e.g. when the user pressed Ctrl-C). When no shutdown signal
  // ever fired, `shutdownPromise` is `null` and this is a no-op.
  if (shutdownPromise !== null) {
    try {
      await shutdownPromise;
    } catch {
      // Sequence rejections are already warn-logged by their own
      // try/catch; surfacing them here would mask the exit code.
    }
  }
  removeHandlers?.();
  if (runServerExitCode !== 0) return runServerExitCode;
  return shutdownExitCode;
}

function mapBootError(e: unknown, io: DispatcherIO): number {
  if (e instanceof UsageError) {
    io.err(`Error: ${e.message}`);
    return 2;
  }
  if (
    e instanceof ProjectStateError ||
    e instanceof SpaBundleMissingError ||
    e instanceof PortRangeExhaustedError
  ) {
    io.err(`Error: ${e.message}`);
    return 1;
  }
  io.err(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  return 1;
}

function synthesiseRunServerArgs(
  projectDir: string,
  config: KeniStartConfig,
): readonly string[] {
  return [
    "--project",
    projectDir,
    "--port",
    String(config.port_range.start),
    "--host",
    config.host,
  ];
}

// Re-export for tests / external callers
export type { ParsedStartArgs };

// Side-effect-free re-export to silence "unused" warnings on the imported
// types — they are part of the public surface other modules consume.
export type { LoadedKeniConfig, ProjectConfig };
