/**
 * Default {@link CodingAgentInvoker} — drives `Deno.Command` with the
 * documented opts.
 *
 * The factory's contract (`design.md` Decision 4 / `spec.md`
 * "CodingAgentInvoker decouples spawn-mechanics from the cycle"):
 *
 * 1. Materialise the `mcpServers` config per `opts.mcpConfigStrategy`.
 *    The strategy executor returns `{ path, cleanup }`. The factory
 *    invokes the executor exactly once per cycle and `await cleanup()`s
 *    in a `try`/`finally` (success or failure).
 * 2. Build the args via `opts.buildArgs(invocation, path)`. When
 *    `invocation.resumeSessionId` is non-null, prepend
 *    `[opts.resumeFlag ?? "--resume", invocation.resumeSessionId]`.
 * 3. Spawn `Deno.Command(opts.cliBinary, { args, env, cwd, stdin: ...,
 *    stdout: "piped", stderr: "piped" })`. The env is built via
 *    `buildChildEnv` against `opts.envAllowlist` (or the invocation's
 *    allowlist) plus the runtime-mandated `KENI_MCP_AGENT` /
 *    `KENI_MCP_SERVER_URL` / `KENI_MCP_WORKSPACE` entries. The `cwd`
 *    is `invocation.workspacePath` when set; absent otherwise (the
 *    child inherits the parent's cwd).
 * 4. When `opts.promptInjection === "stdin"`, write
 *    `invocation.promptBody` to `child.stdin` and close stdin once
 *    written.
 * 5. Concurrently `readLines(child.stdout, lifecycle.onStdoutLine)` and
 *    `readLines(child.stderr, lifecycle.onStderrLine)`.
 * 6. When `lifecycle.abortSignal` fires, call the subprocess utility's
 *    `terminate(child, { graceMs: opts.graceMs ?? 5000 })` and capture
 *    the result for the returned outcome.
 * 7. Await `child.status`. Resolve with `{ kind: "completed", exitCode }`
 *    when the abort path didn't fire, otherwise `{ kind: "terminated",
 *    exitCode, terminatedBy }`.
 *
 * Synchronous spawn failures (binary not found, permission denied,
 * strategy executor errors) propagate as a thrown `Error` — the cycle
 * catches and surfaces as `{ outcome: "spawn_failed", … }`.
 *
 * Strategy semantics (per `role-runtime` spec delta):
 *
 *   - `tempfile-json`: write `{ mcpServers: { keni: <config> } }` to
 *     `Deno.makeTempFile(...)` and remove on cleanup.
 *   - `workspace-json`: merge `<config>` into
 *     `<workspacePath>/<relativePath>` under `<mergeKey>.<entryName>`.
 *     Cleanup is a no-op (the per-agent workspace is keni-managed and
 *     the merge is idempotent).
 *   - `workspace-toml`: TOML equivalent under `<tableHeader>.<entryName>`.
 *
 * @module
 */

import { dirname, join } from "@std/path";
import { parse as parseToml, stringify as stringifyToml } from "@std/toml";
import { buildChildEnv, readLines, terminate } from "./subprocess.ts";
import type { McpConfigStrategy } from "./codingAgentCliRegistry.ts";
import {
  type CodingAgentInvocation,
  type CodingAgentInvoker,
  type CodingAgentLifecycle,
  type CodingAgentOutcome,
  RoleRuntimeError,
} from "./types.ts";

/** Construction options for the default subprocess invoker. */
export interface SubprocessCodingAgentInvokerOpts {
  readonly cliBinary: string;
  readonly buildArgs: (
    invocation: CodingAgentInvocation,
    mcpConfigPath: string,
  ) => readonly string[];
  readonly promptInjection?: "stdin" | "arg";
  readonly mcpConfigStrategy: McpConfigStrategy;
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
 * with its own materialised MCP-config.
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
        mcpConfigStrategy: opts.mcpConfigStrategy,
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
  readonly mcpConfigStrategy: McpConfigStrategy;
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

  const { path: mcpConfigPath, cleanup } = await materializeMcpConfig(
    invocation,
    args.mcpConfigStrategy,
  );

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
      // Per `role-runtime` spec: spawn the CLI in the per-agent
      // workspace when set, so file-discovery-based CLIs (cursor-agent,
      // codex) find their workspace-rooted MCP-config files.
      cwd: invocation.workspacePath ?? undefined,
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
    try {
      await cleanup();
    } catch { /* best-effort cleanup */ }
  }
}

/**
 * Result of materialising the MCP-config for one cycle. `path` is what
 * the entry's `buildArgs` receives as its `mcpConfigPath` argument
 * (some entries ignore it — workspace-discovery CLIs don't need a
 * path on argv). `cleanup` is awaited in `runOnce`'s `finally` block.
 */
interface MaterializedMcpConfig {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Test seam — when set, the `tempfile-json` branch routes the temp
 * path through this builder instead of `Deno.makeTempFile`. Test-only;
 * the production path SHALL leave this `null`.
 */
let tempfileJsonOverride:
  | ((invocation: CodingAgentInvocation) => Promise<string>)
  | null = null;

/**
 * Test-only override for the `tempfile-json` strategy's path builder.
 * Pass `null` to restore the production behaviour. Exported for use
 * exclusively from `codingAgentInvoker_test.ts`.
 */
export function setTempfileJsonOverrideForTesting(
  builder: ((invocation: CodingAgentInvocation) => Promise<string>) | null,
): void {
  tempfileJsonOverride = builder;
}

/**
 * Execute the given strategy: write the keni MCP-config to disk and
 * return the path the entry's `buildArgs` receives. Throws
 * `RoleRuntimeError` for the documented invariant violations
 * (`workspace_required_for_strategy`, `mcp_config_corrupt`).
 */
async function materializeMcpConfig(
  invocation: CodingAgentInvocation,
  strategy: McpConfigStrategy,
): Promise<MaterializedMcpConfig> {
  switch (strategy.kind) {
    case "tempfile-json":
      return await materializeTempfileJson(invocation);
    case "workspace-json":
      return await materializeWorkspaceJson(invocation, strategy);
    case "workspace-toml":
      return await materializeWorkspaceToml(invocation, strategy);
    default: {
      // Exhaustiveness check — any future strategy must extend the union
      // and add a branch here. The compiler enforces this.
      const _never: never = strategy;
      throw new Error(
        `unknown McpConfigStrategy.kind: ${JSON.stringify(_never)}`,
      );
    }
  }
}

async function materializeTempfileJson(
  invocation: CodingAgentInvocation,
): Promise<MaterializedMcpConfig> {
  const path = tempfileJsonOverride !== null
    ? await tempfileJsonOverride(invocation)
    : await Deno.makeTempFile({ prefix: "keni-mcp-", suffix: ".json" });
  const body = JSON.stringify({
    mcpServers: { keni: invocation.mcpServerConfig },
  });
  await Deno.writeTextFile(path, body);
  return {
    path,
    cleanup: async () => {
      try {
        await Deno.remove(path);
      } catch { /* file already removed or never existed */ }
    },
  };
}

async function materializeWorkspaceJson(
  invocation: CodingAgentInvocation,
  strategy: Extract<McpConfigStrategy, { kind: "workspace-json" }>,
): Promise<MaterializedMcpConfig> {
  if (invocation.workspacePath === null) {
    throw new RoleRuntimeError(
      "workspace_required_for_strategy",
      `MCP-config strategy "workspace-json" requires invocation.workspacePath; got null.`,
    );
  }
  const path = join(invocation.workspacePath, strategy.relativePath);

  let parsed: Record<string, unknown>;
  let existing: string | null = null;
  try {
    existing = await Deno.readTextFile(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  if (existing === null || existing.trim().length === 0) {
    parsed = {};
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(existing);
    } catch {
      throw new RoleRuntimeError(
        "mcp_config_corrupt",
        `MCP-config at ${path} is not valid JSON (strategy=workspace-json).`,
      );
    }
    if (!isPlainObject(raw)) {
      throw new RoleRuntimeError(
        "mcp_config_corrupt",
        `MCP-config at ${path} is not a plain object (strategy=workspace-json).`,
      );
    }
    parsed = raw;
  }

  const merge = parsed[strategy.mergeKey];
  let mergeBucket: Record<string, unknown>;
  if (merge === undefined) {
    mergeBucket = {};
  } else if (isPlainObject(merge)) {
    mergeBucket = merge;
  } else {
    throw new RoleRuntimeError(
      "mcp_config_corrupt",
      `MCP-config at ${path} has non-object "${strategy.mergeKey}" (strategy=workspace-json).`,
    );
  }
  mergeBucket[strategy.entryName] = invocation.mcpServerConfig;
  parsed[strategy.mergeKey] = mergeBucket;

  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(parsed, null, 2)}\n`);

  return { path, cleanup: () => Promise.resolve() };
}

async function materializeWorkspaceToml(
  invocation: CodingAgentInvocation,
  strategy: Extract<McpConfigStrategy, { kind: "workspace-toml" }>,
): Promise<MaterializedMcpConfig> {
  if (invocation.workspacePath === null) {
    throw new RoleRuntimeError(
      "workspace_required_for_strategy",
      `MCP-config strategy "workspace-toml" requires invocation.workspacePath; got null.`,
    );
  }
  const path = join(invocation.workspacePath, strategy.relativePath);

  let parsed: Record<string, unknown>;
  let existing: string | null = null;
  try {
    existing = await Deno.readTextFile(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  if (existing === null || existing.trim().length === 0) {
    parsed = {};
  } else {
    let raw: unknown;
    try {
      raw = parseToml(existing);
    } catch {
      throw new RoleRuntimeError(
        "mcp_config_corrupt",
        `MCP-config at ${path} is not valid TOML (strategy=workspace-toml).`,
      );
    }
    if (!isPlainObject(raw)) {
      throw new RoleRuntimeError(
        "mcp_config_corrupt",
        `MCP-config at ${path} is not a plain object (strategy=workspace-toml).`,
      );
    }
    parsed = raw;
  }

  const merge = parsed[strategy.tableHeader];
  let tableBucket: Record<string, unknown>;
  if (merge === undefined) {
    tableBucket = {};
  } else if (isPlainObject(merge)) {
    tableBucket = merge;
  } else {
    throw new RoleRuntimeError(
      "mcp_config_corrupt",
      `MCP-config at ${path} has non-object "${strategy.tableHeader}" (strategy=workspace-toml).`,
    );
  }
  tableBucket[strategy.entryName] = mcpServerConfigToTomlValue(
    invocation.mcpServerConfig,
  );
  parsed[strategy.tableHeader] = tableBucket;

  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, stringifyToml(parsed));

  return { path, cleanup: () => Promise.resolve() };
}

/**
 * Convert {@link McpServerConfig} to a plain object that `@std/toml`'s
 * stringify accepts. The `args` and `env` fields stay as-is (TOML
 * arrays / nested tables); we just drop `readonly` modifiers by
 * structural copy.
 */
function mcpServerConfigToTomlValue(
  config: CodingAgentInvocation["mcpServerConfig"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    command: config.command,
    args: [...config.args],
  };
  if (config.env !== undefined) {
    out.env = { ...config.env };
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
