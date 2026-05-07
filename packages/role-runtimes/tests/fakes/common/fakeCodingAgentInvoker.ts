/**
 * Test-only fake {@link CodingAgentInvoker} — used by `startCycle_test.ts`
 * (and potentially future role-specific runtime tests) to drive the
 * cycle without spawning a real subprocess.
 *
 * The fake records the invocation it receives, exposes line-pushing
 * helpers (which call into the lifecycle's `onStdoutLine` /
 * `onStderrLine` callbacks the cycle handed in), and lets the test
 * resolve the eventual outcome explicitly. A "throw on invoke" mode
 * covers the `spawn_failed` scenario.
 *
 * Pure stand-in: no `Deno.Command`, no fetch, no temp files. Every
 * test interaction is synchronous from the test's perspective; the
 * fake handles the cycle's lifecycle protocol via deferred promises.
 *
 * @module
 */

import type {
  CodingAgentInvocation,
  CodingAgentInvoker,
  CodingAgentLifecycle,
  CodingAgentOutcome,
} from "../../../src/common/types.ts";

/** Construction options for the fake. All fields are optional. */
export interface FakeCodingAgentInvokerOpts {
  /** Synchronously throw on `invoke()` instead of resolving — models a `spawn_failed` outcome. */
  readonly throwOnInvoke?: Error;
  /** When provided, the fake calls `onSpawn({ pid })` with this PID. */
  readonly fakePid?: number;
}

/** Public surface of the fake — methods drive the cycle's lifecycle. */
export interface FakeCodingAgentInvokerHandle {
  readonly invoker: CodingAgentInvoker;
  readonly capturedInvocation: () => CodingAgentInvocation | null;
  readonly capturedLifecycle: () => CodingAgentLifecycle | null;
  readonly invocationCount: () => number;
  readonly pushStdoutLine: (line: string) => Promise<void>;
  readonly pushStderrLine: (line: string) => Promise<void>;
  readonly resolveCompleted: (exitCode: number) => void;
  readonly resolveTerminated: (exitCode: number, terminatedBy: "sigterm" | "sigkill") => void;
  readonly throwOnInvoke: (err: Error) => void;
}

/**
 * Build a fake invoker plus the test-side handle.
 *
 * Usage in a test:
 *
 * ```ts
 * const fake = createFakeCodingAgentInvoker({});
 * const cyclePromise = startCycle({ ..., codingAgentInvoker: fake.invoker });
 * await fake.pushStdoutLine("line 1");
 * fake.resolveCompleted(0);
 * const result = await cyclePromise;
 * ```
 */
export function createFakeCodingAgentInvoker(
  opts: FakeCodingAgentInvokerOpts = {},
): FakeCodingAgentInvokerHandle {
  let throwSpec: Error | undefined = opts.throwOnInvoke;
  let captured: CodingAgentInvocation | null = null;
  let lifecycle: CodingAgentLifecycle | null = null;
  let invocationCount = 0;
  let resolveOutcome: ((outcome: CodingAgentOutcome) => void) | null = null;

  const invoker: CodingAgentInvoker = {
    invoke: (invocation, lc) => {
      invocationCount++;
      if (throwSpec !== undefined) {
        throw throwSpec;
      }
      captured = invocation;
      lifecycle = lc;
      if (opts.fakePid !== undefined) lc.onSpawn?.({ pid: opts.fakePid });
      return new Promise<CodingAgentOutcome>((resolveFn) => {
        resolveOutcome = resolveFn;
      });
    },
  };

  return {
    invoker,
    capturedInvocation: () => captured,
    capturedLifecycle: () => lifecycle,
    invocationCount: () => invocationCount,
    pushStdoutLine: async (line) => {
      if (lifecycle === null) throw new Error("invoke() has not been called yet");
      await lifecycle.onStdoutLine(line);
    },
    pushStderrLine: async (line) => {
      if (lifecycle === null) throw new Error("invoke() has not been called yet");
      await lifecycle.onStderrLine(line);
    },
    resolveCompleted: (exitCode) => {
      if (resolveOutcome === null) throw new Error("invoke() has not been called yet");
      resolveOutcome({ kind: "completed", exitCode });
      resolveOutcome = null;
    },
    resolveTerminated: (exitCode, terminatedBy) => {
      if (resolveOutcome === null) throw new Error("invoke() has not been called yet");
      resolveOutcome({ kind: "terminated", exitCode, terminatedBy });
      resolveOutcome = null;
    },
    throwOnInvoke: (err) => {
      throwSpec = err;
    },
  };
}
