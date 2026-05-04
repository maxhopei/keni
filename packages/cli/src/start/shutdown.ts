/**
 * Graceful-shutdown sequence for `keni start`.
 *
 * Triggered by the first SIGINT / SIGTERM. Sequence (per the `cli-start`
 * capability spec):
 *
 *  1. `await scheduler.stop()` — stop accepting new ticks; existing
 *     in-flight cycles continue.
 *  2. For every agent whose runtime status is `"running"`, call
 *     `await scheduler.interrupt(agentId)` IN SERIES. Rejections from
 *     individual interrupts warn-log and are swallowed so a single
 *     wedged cycle does not block the shutdown of the next agent.
 *  3. `await Promise.race([sleep(graceMs), waitForAbort(secondSignal)])`
 *     — the grace window lets in-flight HTTP responses drain.
 *  4. `await serverHandle.abort()` — stops `Deno.serve`'s listener.
 *  5. Return `0`.
 *
 * Forced shutdown: when the user presses Ctrl-C a second time, the
 * `secondSignal` AbortController fires; the sequence short-circuits
 * to return `130` and SKIPS the remaining steps (including
 * `serverHandle.abort()` per the spec).
 *
 * @module
 */

import type { AgentRuntimeStateStore, Scheduler } from "@keni/server";

/** Sink for warn-level lines from the shutdown sequence. */
export interface ShutdownLogSink {
  warn(message: string): void;
}

/** Inputs for {@link runShutdownSequence}. */
export interface RunShutdownSequenceInput {
  readonly scheduler: Pick<Scheduler, "stop" | "interrupt">;
  readonly runtimeStore: Pick<AgentRuntimeStateStore, "list">;
  readonly serverHandle: { readonly abort: () => Promise<void> };
  readonly graceMs: number;
  readonly secondSignal: AbortSignal;
  readonly logSink?: ShutdownLogSink;
}

/**
 * Run the documented sequence. Returns the process exit code (0 on a
 * clean run, 130 on a forced shutdown).
 */
export async function runShutdownSequence(input: RunShutdownSequenceInput): Promise<number> {
  if (input.secondSignal.aborted) return 130;
  await input.scheduler.stop();
  if (input.secondSignal.aborted) return 130;

  for (const agent of input.runtimeStore.list()) {
    if (input.secondSignal.aborted) return 130;
    if (agent.status !== "running") continue;
    try {
      await input.scheduler.interrupt(agent.id);
    } catch (e) {
      input.logSink?.warn(
        `scheduler.interrupt(${agent.id}) rejected during shutdown: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }
  if (input.secondSignal.aborted) return 130;

  await waitForGraceOrAbort(input.graceMs, input.secondSignal);
  if (input.secondSignal.aborted) return 130;

  await input.serverHandle.abort();
  return 0;
}

function waitForGraceOrAbort(graceMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolveFn) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolveFn();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveFn();
    }, graceMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Cleanup callback returned by {@link installSignalHandlers}. */
export type RemoveSignalHandlers = () => void;

/**
 * Register SIGINT and SIGTERM listeners. The first signal calls
 * `onFirstSignal()` exactly once; the second signal aborts
 * `secondSignal`. Returns a cleanup callback that removes both
 * listeners — the caller (`runStart`) invokes it on resolve so the
 * process does not leak global handlers.
 */
export function installSignalHandlers(
  secondSignal: AbortController,
  onFirstSignal: () => void,
): RemoveSignalHandlers {
  let first = true;
  const handler = () => {
    if (first) {
      first = false;
      onFirstSignal();
    } else {
      secondSignal.abort();
    }
  };
  Deno.addSignalListener("SIGINT", handler);
  Deno.addSignalListener("SIGTERM", handler);
  return () => {
    try {
      Deno.removeSignalListener("SIGINT", handler);
    } catch {
      // already removed
    }
    try {
      Deno.removeSignalListener("SIGTERM", handler);
    } catch {
      // already removed
    }
  };
}

/** Hard-cap for the shutdown grace per the `cli-start` capability spec. */
export const SHUTDOWN_GRACE_HARD_CAP_MS = 10_000;

/** Clamp the configured grace at {@link SHUTDOWN_GRACE_HARD_CAP_MS}. */
export function clampShutdownGrace(
  configured: number,
  logSink?: ShutdownLogSink,
): number {
  if (configured <= SHUTDOWN_GRACE_HARD_CAP_MS) return configured;
  logSink?.warn(
    `shutdown_grace_ms (${configured}) exceeds the hard cap of ` +
      `${SHUTDOWN_GRACE_HARD_CAP_MS}ms; clamping to ${SHUTDOWN_GRACE_HARD_CAP_MS}ms.`,
  );
  return SHUTDOWN_GRACE_HARD_CAP_MS;
}
