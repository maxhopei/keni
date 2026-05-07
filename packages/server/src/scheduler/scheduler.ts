/**
 * `Scheduler` — the in-process tick driver for role runtimes.
 *
 * Owns one self-rescheduling `setTimeout` per agent, drives one
 * cycle at a time per agent (cross-agent parallelism allowed),
 * consults the runtime-state store's `paused` flag at the top of every
 * tick (silently skipping when set), enforces precheck-before-spawn,
 * fires per-cycle wall-clock timeouts via `params.signal.abort()`,
 * exposes a synchronous `interrupt(agentId)` that aborts the in-flight
 * cycle and labels the cause in the activity log, and drains every
 * in-flight cycle on `stop()`.
 *
 * Invariants this module guards:
 *
 *  - In-process, single-instance, single-server-per-project. Tick
 *    state is in-memory only; a server restart resumes ticking from
 *    "now" with no replay of missed ticks.
 *  - Pause is a scheduling preference (skipped on the next tick, no
 *    effect on an in-flight cycle).
 *  - Interrupt is the abort verb (fires `params.signal` immediately
 *    and appends `session_interrupted`).
 *  - The scheduler is the canonical caller of `startCycle` and uses
 *    `params.signal` exclusively to fire interrupt and timeout.
 *  - The runtime emits `session_end` (with `terminated_by`); the
 *    scheduler emits `session_interrupted` and `session_timeout` to
 *    label the human-readable cause. Both rows carry the same
 *    `session_id`.
 *  - The scheduler does not auto-revert ticket status on interrupt or
 *    timeout (`spec.md` §7.5).
 *  - Source files under `packages/server/src/scheduler/` (excluding
 *    `*_test.ts` and `fakes/`) contain zero role-keyed conditionals,
 *    zero `.keni/` filesystem reads or writes, and zero direct
 *    `setTimeout` / `clearTimeout` / `Date.now` calls (those go
 *    through the injected {@link SchedulerClock} in `clock.ts`).
 *
 * See `openspec/changes/cron-scheduler-with-pause/specs/scheduler/spec.md`
 * for the full requirement list while the change is active, or
 * `openspec/specs/scheduler/spec.md` once the change is archived.
 * The why behind each decision lives in
 * `openspec/changes/cron-scheduler-with-pause/design.md`.
 *
 * @module
 */

import type { AgentConfig, AgentId, Role } from "@keni/shared";
import type { RoleCycleParams, RoleCycleResult } from "@keni/runtime-common";
import { startCycle as defaultStartCycle } from "@keni/runtime-common";
import type { AgentRuntimeStateStore } from "../agentState.ts";
import { appendSessionInterrupted, appendSessionTimeout } from "./activityClient.ts";
import type { SchedulerClock } from "./clock.ts";
import type { SchedulerLogger } from "./log.ts";
import type { AgentRunner, AgentRunnerRegistry } from "./registry.ts";
import { resolveCadenceMs, resolveTimeoutMs } from "./schedule.ts";

/** Default per-cycle idle threshold (ms). Mirrors `startCycle`'s. */
const DEFAULT_IDLE_THRESHOLD_MS = 250;

/** Hard upper bound for `stop()`'s drain phase (ms). `design.md` Decision 9. */
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** Outcome returned by `Scheduler.interrupt`. */
export type InterruptResult =
  | { readonly interrupted: true; readonly sessionId: string }
  | {
    readonly interrupted: false;
    readonly reason: "no_active_cycle" | "unknown_agent";
  };

/** Public surface of the scheduler. */
export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  interrupt(agentId: string): Promise<InterruptResult>;
  registerRunner(runner: AgentRunner): void;
}

/** Storage and observability dependencies. */
export interface SchedulerDeps {
  readonly runtimeStore: AgentRuntimeStateStore;
  readonly logger: SchedulerLogger;
  readonly registry: AgentRunnerRegistry;
  readonly clock: SchedulerClock;
  /**
   * Optional hook for unit tests to substitute the `startCycle`
   * implementation. Production wires the real
   * `@keni/runtime-common/startCycle`.
   */
  readonly startCycle?: typeof defaultStartCycle;
}

/** Per-server / per-project configuration (resolved by `runServer`). */
export interface SchedulerOpts {
  readonly agents: readonly AgentConfig[];
  readonly schedules?: Readonly<Record<string, string>>;
  readonly timeouts?: Readonly<Record<string, string | number>>;
  readonly serverUrl: string;
  readonly projectName: string;
  readonly workspacePath?: string | null;
  /** Hard timeout for `stop()` to drain in-flight cycles (ms). */
  readonly drainTimeoutMs?: number;
}

interface ActiveCycle {
  sessionId: string | null;
  readonly startedAt: number;
  readonly abortController: AbortController;
  timeoutHandle: unknown;
  /** Resolves when the underlying `startCycle` promise settles. */
  readonly cyclePromise: Promise<RoleCycleResult>;
  /** `true` when a `session_timeout` POST has already been issued for this cycle. */
  timeoutFired: boolean;
}

interface AgentEntry {
  readonly agentId: string;
  readonly role: Role;
  readonly cadenceMs: number;
  readonly timeoutMs: number;
  tickHandle: unknown;
  active: ActiveCycle | null;
  lastTickStartedAt: number;
}

/**
 * Build the scheduler. The returned handle is the only object that
 * mutates per-agent state; `runServer` calls `start()` once and
 * `stop()` once on shutdown.
 */
export function createScheduler(
  deps: SchedulerDeps,
  opts: SchedulerOpts,
): Scheduler {
  const { runtimeStore, logger, registry, clock } = deps;
  const startCycleImpl = deps.startCycle ?? defaultStartCycle;
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  const agents = new Map<string, AgentEntry>();
  let started = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

  for (const cfg of opts.agents) {
    if (agents.has(cfg.id)) continue;
    const cadence = resolveCadenceMs(
      { agentId: cfg.id, role: cfg.role as Role, map: opts.schedules },
      logger,
    );
    const timeout = resolveTimeoutMs(
      { agentId: cfg.id, role: cfg.role as Role, map: opts.timeouts },
      logger,
    );
    agents.set(cfg.id, {
      agentId: cfg.id,
      role: cfg.role as Role,
      cadenceMs: cadence.ms,
      timeoutMs: timeout.ms,
      tickHandle: null,
      active: null,
      lastTickStartedAt: 0,
    });
  }

  function buildCycleParams(
    entry: AgentEntry,
    runner: AgentRunner,
    signal: AbortSignal,
  ): RoleCycleParams {
    // Per-agent `runner.workspacePath` (from the engineer runner's
    // production wiring) wins over the project-level
    // `opts.workspacePath`; the latter is a legacy one-value-fits-all
    // option that does not model per-agent workspaces correctly.
    const resolvedWorkspacePath = runner.workspacePath ?? opts.workspacePath ?? null;
    return {
      role: entry.role,
      agentId: entry.agentId as AgentId,
      serverUrl: opts.serverUrl,
      projectName: opts.projectName,
      ...(resolvedWorkspacePath !== null ? { workspacePath: resolvedWorkspacePath } : {}),
      mcpServerConfig: runner.mcpServerConfig,
      precheck: runner.precheck,
      promptResolver: runner.promptResolver,
      ...(runner.expectedPromptName !== undefined
        ? { expectedPromptName: runner.expectedPromptName }
        : {}),
      codingAgentInvoker: runner.codingAgentInvoker,
      ...(runner.envAllowlist !== undefined ? { envAllowlist: runner.envAllowlist } : {}),
      ...(runner.idleThresholdMs !== undefined ? { idleThresholdMs: runner.idleThresholdMs } : {}),
      ...(runner.terminationGraceMs !== undefined
        ? { terminationGraceMs: runner.terminationGraceMs }
        : {}),
      signal,
    };
  }

  async function runTick(entry: AgentEntry): Promise<void> {
    if (stopped) return;
    if (entry.active !== null) {
      logger.log("warn", "tick.coalesced", { agent: entry.agentId });
      // Arm the next tick a full cadence from `now`, not relative to
      // the stale `lastTickStartedAt`. Coalesce paths SHALL converge —
      // the next attempt evaluates `active` afresh after one cadence.
      armNextTickAtFullCadence(entry);
      return;
    }
    entry.lastTickStartedAt = clock.now();

    let paused = false;
    try {
      paused = runtimeStore.read(entry.agentId).paused;
    } catch {
      // Agent vanished from the runtime-state store (e.g. mid-shutdown).
      // Treat as paused so we no-op cleanly.
      paused = true;
    }
    if (paused) {
      logger.log("debug", "tick.skipped_paused", { agent: entry.agentId });
      armNextTick(entry);
      return;
    }

    const runner = registry.get(entry.role);
    if (runner === null) {
      logger.log("warn", "runner.missing", {
        agent: entry.agentId,
        role: entry.role,
      });
      armNextTick(entry);
      return;
    }

    const abortController = new AbortController();
    const params = buildCycleParams(entry, runner, abortController.signal);

    // Capture the runtime's session id when it is generated. Wired
    // against `StartCycleOptions.onSessionId`, which the runtime
    // invokes synchronously after `generateUuidV7()` and before any
    // `POST /activity`.
    const active: ActiveCycle = {
      sessionId: null,
      startedAt: clock.now(),
      abortController,
      timeoutHandle: null,
      cyclePromise: undefined as unknown as Promise<RoleCycleResult>,
      timeoutFired: false,
    };

    const idleThreshold = runner.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    if (entry.timeoutMs < idleThreshold) {
      logger.log("warn", "timeout.shorter_than_idle", {
        role: entry.role,
        timeout_ms: entry.timeoutMs,
        idle_threshold_ms: idleThreshold,
      });
    }

    active.timeoutHandle = clock.setTimeout(() => {
      void onTimeoutFired(entry, active);
    }, entry.timeoutMs);

    const cyclePromise = (async (): Promise<RoleCycleResult> => {
      try {
        return await startCycleImpl(params, {
          onSessionId: (id) => {
            active.sessionId = id;
          },
        });
      } catch (err) {
        logger.log("warn", "cycle.spawn_failed", {
          agent: entry.agentId,
          role: entry.role,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          outcome: "spawn_failed",
          sessionId: active.sessionId ?? "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    })();
    (active as { cyclePromise: Promise<RoleCycleResult> }).cyclePromise = cyclePromise;
    entry.active = active;

    // Arm the next tick immediately so a long-running cycle does not
    // delay subsequent ticks. Subsequent ticks observe `entry.active`
    // and coalesce while the current cycle is still in flight.
    armNextTick(entry);

    try {
      const result = await cyclePromise;
      if (result.outcome === "precheck_skipped") {
        logger.log("debug", "tick.precheck_skipped", {
          agent: entry.agentId,
          reason: result.reason,
        });
      } else if (result.outcome === "spawn_failed") {
        // The cycle itself caught the error and returned a structured
        // result; the scheduler still logs at warn level so an operator
        // grepping the keni-server log sees the failure cause without
        // having to round-trip through the activity log.
        logger.log("warn", "cycle.spawn_failed", {
          agent: entry.agentId,
          role: entry.role,
          error: result.error.message,
        });
      }
    } finally {
      clock.clearTimeout(active.timeoutHandle);
      if (entry.active === active) entry.active = null;
    }
  }

  async function onTimeoutFired(
    entry: AgentEntry,
    active: ActiveCycle,
  ): Promise<void> {
    if (active.timeoutFired) return;
    if (entry.active !== active) return; // already cleared
    if (stopped) return;
    active.timeoutFired = true;
    active.abortController.abort("timeout");
    if (active.sessionId !== null) {
      await appendSessionTimeout(
        {
          serverUrl: opts.serverUrl,
          sessionId: active.sessionId,
          agentId: entry.agentId,
          role: entry.role,
        },
        logger,
      );
    } else {
      logger.log("warn", "scheduler.activity_post_skipped", {
        event: "session_timeout",
        agent: entry.agentId,
        reason: "session_id_not_yet_assigned",
      });
    }
  }

  function armNextTick(entry: AgentEntry): void {
    if (stopped) return;
    const elapsed = clock.now() - entry.lastTickStartedAt;
    const delay = Math.max(0, entry.cadenceMs - elapsed);
    entry.tickHandle = clock.setTimeout(() => {
      void runTick(entry);
    }, delay);
  }

  function armNextTickAtFullCadence(entry: AgentEntry): void {
    if (stopped) return;
    entry.tickHandle = clock.setTimeout(() => {
      void runTick(entry);
    }, entry.cadenceMs);
  }

  return {
    start(): void {
      if (started) {
        logger.log("warn", "scheduler.already_started", {});
        return;
      }
      started = true;
      logger.log("info", "scheduler.started", {
        agents: agents.size,
      });
      // Walk registered roles up-front and warn on any roster role with
      // no registered runner. The tick will repeat the warn on the
      // first fire but this gives an immediate signal at boot time.
      const seenWarnRoles = new Set<string>();
      for (const entry of agents.values()) {
        if (registry.get(entry.role) === null && !seenWarnRoles.has(entry.role)) {
          seenWarnRoles.add(entry.role);
          logger.log("warn", "runner.missing", {
            agent: entry.agentId,
            role: entry.role,
          });
        }
        // Initial tick: first cadence interval after `start()`.
        entry.lastTickStartedAt = clock.now();
        entry.tickHandle = clock.setTimeout(() => {
          void runTick(entry);
        }, entry.cadenceMs);
      }
    },

    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopped = true;
      // Snapshot in-flight cycles before clearing handles so the
      // drain step has the correct list.
      const draining: Promise<RoleCycleResult>[] = [];
      let exceededTimeout = 0;
      for (const entry of agents.values()) {
        if (entry.tickHandle !== null) {
          clock.clearTimeout(entry.tickHandle);
          entry.tickHandle = null;
        }
      }
      for (const entry of agents.values()) {
        if (entry.active !== null) {
          const active = entry.active;
          clock.clearTimeout(active.timeoutHandle);
          active.abortController.abort("server_shutdown");
          draining.push(active.cyclePromise);
        }
      }

      stopPromise = (async () => {
        if (draining.length === 0) {
          logger.log("info", "scheduler.stopped", {
            drained: 0,
            exceeded_timeout: 0,
          });
          return;
        }
        // Capture the drain-timeout handle so the winning branch of the
        // race can cancel it. Without this, a fast drain (the common
        // path) leaves the 30s setTimeout registered, which both keeps
        // the process event loop alive past `stop()` and trips Deno's
        // test-leak detector when one integration test's `stop()`
        // returns before the timer fires and the next test starts.
        let drainTimeoutHandle: ReturnType<typeof clock.setTimeout> | null = null;
        try {
          const drainOutcomes = await Promise.race([
            Promise.allSettled(draining).then((results) => ({
              kind: "drained" as const,
              results,
            })),
            new Promise<{ kind: "timeout" }>((resolveFn) => {
              drainTimeoutHandle = clock.setTimeout(() => {
                drainTimeoutHandle = null;
                resolveFn({ kind: "timeout" });
              }, drainTimeoutMs);
            }),
          ]);
          if (drainOutcomes.kind === "timeout") {
            exceededTimeout = draining.length;
            logger.log("info", "scheduler.stopped", {
              drained: 0,
              exceeded_timeout: exceededTimeout,
            });
            return;
          }
          const drained = drainOutcomes.results.filter((r) => r.status === "fulfilled").length;
          logger.log("info", "scheduler.stopped", {
            drained,
            exceeded_timeout: drainOutcomes.results.length - drained,
          });
        } finally {
          if (drainTimeoutHandle !== null) {
            clock.clearTimeout(drainTimeoutHandle);
            drainTimeoutHandle = null;
          }
        }
      })();
      return stopPromise;
    },

    async interrupt(agentId: string): Promise<InterruptResult> {
      const entry = agents.get(agentId);
      if (entry === undefined) {
        return { interrupted: false, reason: "unknown_agent" };
      }
      const active = entry.active;
      if (active === null) {
        return { interrupted: false, reason: "no_active_cycle" };
      }
      active.abortController.abort("interrupt");
      const sessionId = active.sessionId ?? "";
      if (active.sessionId !== null) {
        await appendSessionInterrupted(
          {
            serverUrl: opts.serverUrl,
            sessionId: active.sessionId,
            agentId: entry.agentId,
            role: entry.role,
          },
          logger,
        );
      } else {
        logger.log("warn", "scheduler.activity_post_skipped", {
          event: "session_interrupted",
          agent: entry.agentId,
          reason: "session_id_not_yet_assigned",
        });
      }
      return { interrupted: true, sessionId };
    },

    registerRunner(runner: AgentRunner): void {
      registry.register(runner);
    },
  };
}
