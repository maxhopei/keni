/**
 * Default {@link CodingAgentInvoker} — drives `Deno.Command` with the
 * documented opts.
 *
 * The factory's contract (`design.md` Decision 4 / `spec.md`
 * "CodingAgentInvoker decouples spawn-mechanics from the cycle"):
 *
 * 1. Resolve the `mcpServers` JSON config path. When `mcpConfigPathBuilder`
 *    is supplied, call it; otherwise write a tempfile under
 *    `Deno.makeTempFile({ prefix: "keni-mcp-", suffix: ".json" })` whose
 *    body is `{ mcpServers: { keni: invocation.mcpServerConfig } }`.
 * 2. Build the args via `opts.buildArgs(invocation, mcpConfigPath)`.
 *    When `invocation.resumeSessionId` is non-null, prepend
 *    `[opts.resumeFlag ?? "--resume", invocation.resumeSessionId]`.
 * 3. Spawn `Deno.Command(opts.cliBinary, { args, env, stdin: ..., stdout:
 *    "piped", stderr: "piped" })`. The env is built via `buildChildEnv`
 *    against `opts.envAllowlist` (or the invocation's allowlist) plus the
 *    runtime-mandated `KENI_MCP_AGENT` / `KENI_MCP_SERVER_URL` /
 *    `KENI_MCP_WORKSPACE` entries.
 * 4. When `opts.promptInjection === "stdin"`, write `invocation.promptBody`
 *    to `child.stdin` and close stdin once written.
 * 5. Concurrently `readLines(child.stdout, lifecycle.onStdoutLine)` and
 *    `readLines(child.stderr, lifecycle.onStderrLine)`.
 * 6. When `lifecycle.abortSignal` fires, call the subprocess utility's
 *    `terminate(child, { graceMs: opts.graceMs ?? 5000 })` and capture
 *    the result for the returned outcome.
 * 7. Await `child.status`. Resolve with `{ kind: "completed", exitCode }`
 *    when the abort path didn't fire, otherwise `{ kind: "terminated",
 *    exitCode, terminatedBy }`.
 * 8. `try`/`finally` removes the mcp-config tempfile (when this factory
 *    wrote it).
 *
 * Synchronous spawn failures (binary not found, permission denied,
 * tempfile creation failure) propagate as a thrown `Error` — the cycle
 * catches and surfaces as `{ outcome: "spawn_failed", … }`.
 *
 * @module
 */

import { buildChildEnv, readLines, terminate } from "./subprocess.ts";
import type {
  CodingAgentInvocation,
  CodingAgentInvoker,
  CodingAgentLifecycle,
  CodingAgentOutcome,
} from "./types.ts";

/** Construction options for the default subprocess invoker. */
export interface SubprocessCodingAgentInvokerOpts {
  readonly cliBinary: string;
  readonly buildArgs: (
    invocation: CodingAgentInvocation,
    mcpConfigPath: string,
  ) => readonly string[];
  readonly promptInjection?: "stdin" | "arg";
  readonly mcpConfigPathBuilder?: (invocation: CodingAgentInvocation) => Promise<string>;
  readonly graceMs?: number;
  readonly resumeFlag?: string;
  readonly envAllowlist?: readonly string[];
  readonly killTimeoutMs?: number;
}

/** Re-exported here so step 09 can `import { CodingAgentInvoker } from ".../codingAgentInvoker.ts"`. */
export type { CodingAgentInvoker } from "./types.ts";

/**
 * Build the default subprocess invoker. The result is a stateless object
 * — invoking `invoke()` twice runs two subprocesses in parallel, each
 * with its own temp file.
 */
export function createSubprocessCodingAgentInvoker(
  opts: SubprocessCodingAgentInvokerOpts,
): CodingAgentInvoker {
  const promptInjection = opts.promptInjection ?? "stdin";
  const graceMs = opts.graceMs ?? 5000;
  const resumeFlag = opts.resumeFlag ?? "--resume";

  return {
    invoke: (invocation, lifecycle) =>
      runOnce({
        cliBinary: opts.cliBinary,
        buildArgs: opts.buildArgs,
        mcpConfigPathBuilder: opts.mcpConfigPathBuilder,
        envAllowlist: opts.envAllowlist,
        killTimeoutMs: opts.killTimeoutMs,
        promptInjection,
        graceMs,
        resumeFlag,
        invocation,
        lifecycle,
      }),
  };
}

interface RunOnceArgs {
  readonly cliBinary: string;
  readonly buildArgs: (
    invocation: CodingAgentInvocation,
    mcpConfigPath: string,
  ) => readonly string[];
  readonly mcpConfigPathBuilder?: (invocation: CodingAgentInvocation) => Promise<string>;
  readonly envAllowlist?: readonly string[];
  readonly killTimeoutMs?: number;
  readonly promptInjection: "stdin" | "arg";
  readonly graceMs: number;
  readonly resumeFlag: string;
  readonly invocation: CodingAgentInvocation;
  readonly lifecycle: CodingAgentLifecycle;
}

async function runOnce(args: RunOnceArgs): Promise<CodingAgentOutcome> {
  const { invocation, lifecycle } = args;

  let mcpConfigPath: string;
  let weWroteTempFile = false;
  if (args.mcpConfigPathBuilder !== undefined) {
    mcpConfigPath = await args.mcpConfigPathBuilder(invocation);
  } else {
    mcpConfigPath = await Deno.makeTempFile({ prefix: "keni-mcp-", suffix: ".json" });
    weWroteTempFile = true;
    const body = JSON.stringify({ mcpServers: { keni: invocation.mcpServerConfig } });
    await Deno.writeTextFile(mcpConfigPath, body);
  }

  try {
    const cliArgs = [...args.buildArgs(invocation, mcpConfigPath)];
    if (invocation.resumeSessionId !== null) {
      cliArgs.unshift(args.resumeFlag, invocation.resumeSessionId);
    }

    const allowlist = args.envAllowlist ?? invocation.envAllowlist;
    const runtimeMandated: Record<string, string> = {
      KENI_MCP_AGENT: invocation.agentId,
    };
    const explicitServerUrl = invocation.mcpServerConfig.env?.KENI_MCP_SERVER_URL;
    if (explicitServerUrl !== undefined) {
      runtimeMandated.KENI_MCP_SERVER_URL = explicitServerUrl;
    }
    if (invocation.workspacePath !== null) {
      runtimeMandated.KENI_MCP_WORKSPACE = invocation.workspacePath;
    }
    const env = buildChildEnv(allowlist, runtimeMandated);

    const command = new Deno.Command(args.cliBinary, {
      args: cliArgs,
      env,
      stdin: args.promptInjection === "stdin" ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    });

    const child = command.spawn();
    lifecycle.onSpawn?.({ pid: child.pid });

    type TerminateOutcome = {
      exitCode: number;
      terminatedBy: "exit" | "sigterm" | "sigkill";
    };
    let terminatePromise: Promise<TerminateOutcome> | null = null;
    const abortHandler = () => {
      if (terminatePromise !== null) return;
      terminatePromise = terminate(child, {
        graceMs: args.graceMs,
        killTimeoutMs: args.killTimeoutMs,
      }).catch((): TerminateOutcome => ({ exitCode: -1, terminatedBy: "exit" }));
    };
    if (lifecycle.abortSignal !== undefined) {
      if (lifecycle.abortSignal.aborted) abortHandler();
      else lifecycle.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    const stdoutPromise = readLines(child.stdout, lifecycle.onStdoutLine);
    const stderrPromise = readLines(child.stderr, lifecycle.onStderrLine);

    if (args.promptInjection === "stdin") {
      const writer = child.stdin.getWriter();
      try {
        if (invocation.promptBody.length > 0) {
          await writer.write(new TextEncoder().encode(invocation.promptBody));
        }
        await writer.close();
      } catch {
        // Best-effort: subprocess may have closed stdin already (e.g., aborted).
      } finally {
        try {
          writer.releaseLock();
        } catch { /* ignore */ }
      }
    }

    const status = await child.status;
    await Promise.all([stdoutPromise, stderrPromise]);

    if (lifecycle.abortSignal !== undefined) {
      lifecycle.abortSignal.removeEventListener("abort", abortHandler);
    }

    const finalTerminate = terminatePromise as Promise<TerminateOutcome> | null;
    if (finalTerminate !== null) {
      const terminated = await finalTerminate;
      if (terminated.terminatedBy !== "exit") {
        return {
          kind: "terminated",
          exitCode: terminated.exitCode,
          terminatedBy: terminated.terminatedBy,
        };
      }
    }
    return { kind: "completed", exitCode: status.code };
  } finally {
    if (weWroteTempFile) {
      try {
        await Deno.remove(mcpConfigPath);
      } catch { /* file already removed or never existed */ }
    }
  }
}
