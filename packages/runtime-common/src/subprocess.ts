/**
 * Subprocess utility — wraps `Deno.Command` with the documented graceful-
 * termination contract, exit-code handling, env-allowlist construction,
 * and per-line stream reading.
 *
 * Three concerns, three exports:
 *
 * - {@link terminate} — race a child's `status` against a SIGTERM-then-
 *   SIGKILL ladder. Default grace is 5 000 ms; default kill-timeout is
 *   1 000 ms. Returns `terminatedBy: "exit" | "sigterm" | "sigkill"` so
 *   the cycle can stamp `refs.terminated_by` correctly. Throws
 *   `Error("subprocess refused to die after SIGKILL")` only on a
 *   kernel pathology (the kill-timeout expires after SIGKILL).
 * - {@link buildChildEnv} — construct the child env from an allowlist
 *   plus runtime-mandated entries. Reads each allowlisted name via
 *   `Deno.env.get(name)` and skips any that are unset; never calls
 *   `Deno.env.toObject()`. The runtime-mandated map is merged on top, so
 *   a runtime-mandated `KENI_*` always wins over a same-named host var.
 * - {@link readLines} — pipe a `ReadableStream<Uint8Array>` through
 *   `TextDecoderStream`, split on `"\n"`, hold trailing partial lines,
 *   and emit non-empty trimmed lines via `onLine`. Calls `onClose` once
 *   the stream ends (after any final partial is drained).
 *
 * Windows behaviour (`design.md` Decision 8 / `spec.md` "Windows path"
 * scenario): `Deno.Command.kill()` on Windows is `TerminateProcess`
 * (a hard kill, no signal). The utility detects `Deno.build.os ===
 * "windows"` and skips the SIGTERM phase, going straight to `kill()`.
 * A one-line warning is emitted to `Deno.stderr` the first time the
 * utility runs on Windows (module-level `warned` flag). The prototype's
 * primary platforms are macOS and Linux; CI does not run Windows.
 *
 * @module
 */

/**
 * Options for {@link terminate}. `graceMs` is the SIGTERM-to-SIGKILL
 * window (default 5 000 ms in the cycle, but no default here — every
 * call site supplies it); `killTimeoutMs` defaults to 1 000 ms.
 */
export interface SubprocessTerminateOpts {
  readonly graceMs: number;
  readonly killTimeoutMs?: number;
}

/** Result of {@link terminate}. */
export interface SubprocessTerminateResult {
  readonly exitCode: number;
  readonly terminatedBy: "exit" | "sigterm" | "sigkill";
}

const DEFAULT_KILL_TIMEOUT_MS = 1000;
let warnedAboutWindows = false;

/**
 * Send the configured termination ladder at `child` and resolve with the
 * outcome. The function never sends a signal when `child.status` has
 * already resolved (the "already-exited" path).
 */
export async function terminate(
  child: Deno.ChildProcess,
  opts: SubprocessTerminateOpts,
): Promise<SubprocessTerminateResult> {
  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  let resolvedStatus: Deno.CommandStatus | null = null;
  const statusPromise = child.status.then((s) => {
    resolvedStatus = s;
    return s;
  });
  await Promise.resolve();
  if (resolvedStatus !== null) {
    return { exitCode: (resolvedStatus as Deno.CommandStatus).code, terminatedBy: "exit" };
  }

  if (Deno.build.os === "windows") {
    if (!warnedAboutWindows) {
      warnedAboutWindows = true;
      const warning =
        "[role-runtimes] Windows graceful termination is degraded: SIGTERM is unsupported, falling back to a hard kill.\n";
      try {
        await Deno.stderr.write(new TextEncoder().encode(warning));
      } catch {
        // Best-effort warning; ignore failure (e.g., stderr closed).
      }
    }
    safeKill(child, "SIGKILL");
    const killed = await raceWithTimeout(statusPromise, killTimeoutMs);
    if (killed === null) {
      throw new Error("subprocess refused to die after SIGKILL");
    }
    return { exitCode: killed.code, terminatedBy: "sigkill" };
  }

  safeKill(child, "SIGTERM");
  const beforeGrace = await raceWithTimeout(statusPromise, opts.graceMs);
  if (beforeGrace !== null) {
    return { exitCode: beforeGrace.code, terminatedBy: "sigterm" };
  }
  safeKill(child, "SIGKILL");
  const afterKill = await raceWithTimeout(statusPromise, killTimeoutMs);
  if (afterKill === null) {
    throw new Error("subprocess refused to die after SIGKILL");
  }
  return { exitCode: afterKill.code, terminatedBy: "sigkill" };
}

function safeKill(child: Deno.ChildProcess, signal: Deno.Signal): void {
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the status check and the kill;
    // either way, the racing `child.status` promise already has the answer.
  }
}

function raceWithTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolveFn) => {
    let settled = false;
    const handle = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveFn(null);
    }, timeoutMs);
    p.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(handle);
      resolveFn(value);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(handle);
      resolveFn(null);
    });
  });
}

/**
 * Build the env object for `Deno.Command(..., { env })` from an
 * allowlist plus a map of runtime-mandated variables. Runtime-mandated
 * entries always win over the allowlist (so a host `KENI_MCP_AGENT`
 * cannot shadow the runtime's value).
 */
export function buildChildEnv(
  allowlist: readonly string[],
  runtimeMandated: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of allowlist) {
    const value = Deno.env.get(name);
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(runtimeMandated)) {
    env[name] = value;
  }
  return env;
}

/**
 * Pipe `stream` through `TextDecoderStream`, split on `"\n"`, hold
 * trailing partial lines, and call `onLine` once per non-empty
 * right-trimmed line in arrival order. Calls `onClose` (when supplied)
 * once the stream ends, after any final partial line has been drained.
 *
 * Returns when the stream is fully consumed; never throws (decoder
 * errors are swallowed since a misbehaving subprocess byte stream
 * should not crash the cycle).
 */
export async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void | Promise<void>,
  onClose?: () => void | Promise<void>,
): Promise<void> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trimEnd() !== "") await onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.trimEnd() !== "") await onLine(buffer);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Stream already closed.
    }
    if (onClose !== undefined) await onClose();
  }
}
