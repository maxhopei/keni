/**
 * Test-only fake {@link SchedulerClock}.
 *
 * Lets a test deterministically advance virtual time and observe which
 * scheduler timers fired. Avoids the dependency cost of pulling in
 * `@std/testing/time` (`design.md` Decision 12 calls for either FakeTime
 * or "equivalent"; this is the equivalent).
 *
 * Semantics:
 *
 *  - `setTimeout(cb, ms)` queues `cb` for `now + ms`. A `delayMs <= 0`
 *    is queued at `now` (it fires on the *next* `tick(...)` call,
 *    not the current one — see "deferred timers" below).
 *  - `tick(ms)` advances `now` by `ms`, firing every queued timer
 *    whose deadline is `<= newNow` AND whose insertion predates this
 *    `tick(...)` call. Timers added during a callback (e.g. a
 *    self-rescheduling re-arm) are deferred to the *next* `tick(...)`.
 *    This prevents tight loops where a 0-delay re-arm fires in the
 *    same virtual-time instant it was scheduled.
 *  - `now()` returns the current virtual time.
 *  - `clearTimeout(handle)` removes the entry; calling on an unknown
 *    handle is a no-op (mirrors the global API).
 *  - Each `tick(...)` yields to a real-clock macrotask between fires
 *    so any pending real `fetch` against a localhost stub can settle.
 *    The fake clock does NOT virtualise the global `setTimeout` /
 *    `Promise` infrastructure — it intercepts only the
 *    `SchedulerClock` interface that the scheduler depends on.
 *
 * @module
 */

import type { SchedulerClock } from "../clock.ts";

interface QueuedTimer {
  readonly handle: number;
  readonly fireAt: number;
  readonly callback: () => void;
  readonly addedInGeneration: number;
}

/** Public surface of the fake clock test helper. */
export interface FakeClockHandle {
  readonly clock: SchedulerClock;
  /**
   * Advance virtual time by `ms`, firing every queued timer whose
   * deadline is `<=` the new `now` AND that was added BEFORE this
   * `tick(...)` call. Yields to the real macrotask queue between
   * fires so pending real-clock I/O (e.g. a `fetch` against a
   * localhost `Deno.serve` stub) can settle deterministically.
   */
  tick(ms: number): Promise<void>;
  /** Number of timers currently queued (test observation). */
  pendingCount(): number;
  /** Current virtual time (ms since epoch — defaults to `0`). */
  now(): number;
}

/** Build a fake clock initialised at `startNow` (defaults to `0`). */
export function createFakeClock(startNow = 0): FakeClockHandle {
  let virtualNow = startNow;
  let nextHandle = 1;
  let currentGeneration = 0;
  const queue: QueuedTimer[] = [];

  // Drain microtasks and yield several real-clock macrotasks so any
  // pending real I/O (e.g. localhost `fetch` round-trips during a
  // cycle's `appendSessionStart`) can settle deterministically. The
  // fake clock does NOT virtualise the global event loop — tests that
  // exercise the real `startCycle` need real time to pass for fetches.
  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
      await new Promise<void>((r) => globalThis.setTimeout(r, 1));
    }
  }

  const clock: SchedulerClock = {
    setTimeout(callback, delayMs) {
      const handle = nextHandle++;
      const fireAt = virtualNow + Math.max(0, delayMs);
      queue.push({
        handle,
        fireAt,
        callback,
        addedInGeneration: currentGeneration,
      });
      return handle;
    },
    clearTimeout(handle) {
      if (handle === null || handle === undefined) return;
      const idx = queue.findIndex((t) => t.handle === handle);
      if (idx !== -1) queue.splice(idx, 1);
    },
    now() {
      return virtualNow;
    },
  };

  return {
    clock,
    async tick(ms) {
      const target = virtualNow + Math.max(0, ms);
      currentGeneration++;
      const tickGen = currentGeneration;
      while (true) {
        let bestIdx = -1;
        let bestFireAt = Number.POSITIVE_INFINITY;
        for (let i = 0; i < queue.length; i++) {
          const t = queue[i]!;
          if (t.fireAt > target) continue;
          if (t.addedInGeneration >= tickGen) continue; // deferred to next tick()
          if (t.fireAt < bestFireAt) {
            bestFireAt = t.fireAt;
            bestIdx = i;
          }
        }
        if (bestIdx === -1) break;
        const timer = queue[bestIdx]!;
        queue.splice(bestIdx, 1);
        virtualNow = Math.max(virtualNow, timer.fireAt);
        timer.callback();
        await flush();
      }
      virtualNow = target;
      await flush();
    },
    pendingCount() {
      return queue.length;
    },
    now() {
      return virtualNow;
    },
  };
}
