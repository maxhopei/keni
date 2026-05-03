/**
 * In-process `Mutex` — a tiny serialisation primitive over a `Promise`
 * chain. Exposes a single `runExclusive(fn)` method that queues the
 * supplied async function behind the previous one, so concurrent
 * callers execute sequentially in arrival order.
 *
 * Used by the `POST /prs/:id/merge` handler (orchestration-server
 * spec §"`POST /prs/:id/merge` …") to enforce single-writer
 * semantics on the project repo's `git merge --ff-only` invocation:
 * two simultaneous merge requests must serialise so the second
 * cannot race the first's `git fetch` / `git merge` pair.
 *
 * The mutex deliberately does not expose a `try`-non-blocking
 * acquire; the only legal use is `await mutex.runExclusive(() => …)`,
 * which guarantees release on every code path including throws.
 *
 * @module
 */

/** Public surface of the in-process mutex. */
export interface Mutex {
  /**
   * Run `fn` exclusively: subsequent `runExclusive` calls await the
   * current one's resolution before invoking their own `fn`. Throws
   * are propagated; the lock is released on every exit path.
   */
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T>;

  /**
   * `true` while another caller holds the lock. Test-only diagnostic;
   * route handlers SHALL NOT branch on this value.
   */
  isLocked(): boolean;
}

/** Build an in-process mutex. */
export function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  let inflight = 0;

  return {
    runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
      const previous = tail;
      let resolveTail!: () => void;
      tail = new Promise<void>((r) => {
        resolveTail = r;
      });
      inflight++;
      const run = async (): Promise<T> => {
        try {
          await previous;
        } catch {
          // The previous holder threw; we still take our turn.
        }
        try {
          return await fn();
        } finally {
          inflight--;
          resolveTail();
        }
      };
      return run();
    },
    isLocked: () => inflight > 0,
  };
}
