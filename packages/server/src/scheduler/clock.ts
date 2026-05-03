/**
 * Injectable clock for the scheduler.
 *
 * The only seam through which the scheduler reads wall-clock time and
 * arms / cancels timers. All other production source files under
 * `packages/server/src/scheduler/` SHALL go through {@link SchedulerClock}
 * (enforced by `runnerSourceScan_test.ts`).
 *
 * `defaultClock()` binds to the global `setTimeout`, `clearTimeout`, and
 * `Date.now`. Tests construct a fake clock that exposes `tick(ms)` (and
 * the like) without using `@std/testing/time` so the suite needs zero new
 * dependencies in `deno.json`.
 *
 * The handle type is `unknown` rather than `number` so test fakes can
 * use whatever opaque token they like without the production type
 * leaking that decision.
 *
 * @module
 */

/**
 * Minimal timer + wall-clock surface the scheduler depends on.
 *
 * `setTimeout` SHALL return an opaque handle that the same clock's
 * `clearTimeout` accepts. The scheduler treats the handle as opaque.
 */
export interface SchedulerClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/**
 * Build the production clock. Wraps the globals so production files
 * never reference `setTimeout` / `clearTimeout` / `Date.now` directly
 * (the source-scan test asserts this).
 */
export function defaultClock(): SchedulerClock {
  return {
    setTimeout(callback, delayMs) {
      return globalThis.setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      if (handle !== null && handle !== undefined) {
        globalThis.clearTimeout(handle as number);
      }
    },
    now() {
      return Date.now();
    },
  };
}
