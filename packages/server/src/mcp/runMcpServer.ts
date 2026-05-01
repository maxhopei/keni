/**
 * `runMcpServer` — argv-level entry point for the engineer MCP server.
 *
 * Mirrors the shape of `runServer` (the orchestration server's CLI) but
 * uses MCP's stdio transport rather than HTTP. Required flags:
 *
 * | Flag             | Required | Validation                                                  |
 * | ---------------- | -------- | ----------------------------------------------------------- |
 * | `--agent <id>`   | yes      | `/^[a-z0-9_-]+$/`                                           |
 * | `--server-url`   | yes      | parses as URL with `http:` or `https:` protocol             |
 * | `--workspace`    | yes      | path exists and `Deno.stat(...).isDirectory` is true        |
 *
 * Exit codes:
 *
 * | Exit | Cause                                                                              |
 * | ---- | ---------------------------------------------------------------------------------- |
 * | 0    | Server started, ran, and shut down cleanly when the stdio transport closed         |
 * | 1    | Workspace path does not exist or is not a directory; uncaught runtime error        |
 * | 2    | Usage error (missing flag, unknown flag, malformed agent id, malformed server URL) |
 *
 * Tests drive `runMcpServer` in-process by injecting `RunMcpServerDeps`:
 * `out`/`err` to capture I/O, `stat` to swap the workspace check, and
 * `transport` to plug an in-memory MCP transport in place of the real
 * stdio one (so the test does not have to spawn a subprocess for the
 * happy-path).
 *
 * @module
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpHttpClient } from "./httpClient.ts";
import { createMcpServer } from "./createMcpServer.ts";

/** Parsed CLI flags for `runMcpServer`. */
export interface RunMcpServerArgs {
  readonly agentId: string;
  readonly serverUrl: string;
  readonly workspacePath: string;
}

/** Internal — surfaces as exit 2 in `runMcpServer`. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Optional dependency overrides for tests. */
export interface RunMcpServerDeps {
  /** Stdout writer. Defaults to `console.log`. */
  readonly out?: (line: string) => void;
  /** Stderr writer. Defaults to `console.error`. */
  readonly err?: (line: string) => void;
  /** Override `Deno.stat` for the workspace existence/isDirectory check. */
  readonly stat?: (path: string) => Promise<Deno.FileInfo>;
  /**
   * Substitute the MCP transport. Tests use this to plug an in-memory
   * transport pair from {@link InMemoryTransport.createLinkedPair} so
   * the happy path can be exercised without spawning a subprocess.
   */
  readonly transport?: Transport;
}

const AGENT_ID_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Parse argv. Accepts `--key value` and `--key=value`. Throws
 * {@link UsageError} (caught by `runMcpServer` → exit 2) on shape problems.
 */
export function parseRunMcpServerArgs(args: readonly string[]): RunMcpServerArgs {
  let agentId: string | undefined;
  let serverUrl: string | undefined;
  let workspacePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [key, inlineValue] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];

    const consume = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`Flag ${key} requires a value`);
      }
      i++;
      return next;
    };

    switch (key) {
      case "--agent":
        agentId = consume();
        break;
      case "--server-url":
        serverUrl = consume();
        break;
      case "--workspace":
        workspacePath = consume();
        break;
      default:
        throw new UsageError(`Unknown flag: ${key}`);
    }
  }

  if (agentId === undefined) {
    throw new UsageError("Missing required flag: --agent <id>");
  }
  if (serverUrl === undefined) {
    throw new UsageError("Missing required flag: --server-url <url>");
  }
  if (workspacePath === undefined) {
    throw new UsageError("Missing required flag: --workspace <path>");
  }

  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new UsageError(
      `--agent must match ${AGENT_ID_PATTERN.source} (got '${agentId}')`,
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(serverUrl);
  } catch {
    throw new UsageError(`--server-url must be a valid URL (got '${serverUrl}')`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new UsageError(
      `--server-url must use http: or https: (got '${parsedUrl.protocol}')`,
    );
  }

  return { agentId, serverUrl, workspacePath };
}

/** Documented usage block. */
function formatUsage(): string {
  return [
    "Usage: deno run -A packages/server/src/mcp/main.ts \\",
    "         --agent <id> --server-url <url> --workspace <abs-path>",
    "",
    "Flags:",
    "  --agent       <id>   Required. Engineer agent id (matches /^[a-z0-9_-]+$/).",
    "  --server-url  <url>  Required. http:// or https:// URL of the orchestration server.",
    "  --workspace   <path> Required. Absolute path to this engineer's workspace clone.",
  ].join("\n");
}

/**
 * Argv-level entry point. Returns the exit code; never calls `Deno.exit`.
 */
export async function runMcpServer(
  args: readonly string[],
  deps: RunMcpServerDeps = {},
): Promise<number> {
  const out = deps.out ?? ((m) => console.log(m));
  const err = deps.err ?? ((m) => console.error(m));
  const stat = deps.stat ?? Deno.stat.bind(Deno);

  let parsed: RunMcpServerArgs;
  try {
    parsed = parseRunMcpServerArgs(args);
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      err(formatUsage());
      return 2;
    }
    throw e;
  }

  let info: Deno.FileInfo;
  try {
    info = await stat(parsed.workspacePath);
  } catch (e) {
    err(
      `--workspace path does not exist: ${parsed.workspacePath} (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
    return 1;
  }
  if (!info.isDirectory) {
    err(`--workspace path is not a directory: ${parsed.workspacePath}`);
    return 1;
  }

  try {
    const httpClient = createMcpHttpClient({
      serverUrl: parsed.serverUrl,
      agentId: parsed.agentId,
    });
    const server = createMcpServer({
      httpClient,
      agentId: parsed.agentId,
      workspacePath: parsed.workspacePath,
    });
    const transport = deps.transport ?? new StdioServerTransport();

    /*
     * Wire the close-promise BEFORE calling `connect`. The SDK's
     * `Protocol.connect` overwrites `transport.onclose` with its own
     * wrapper, but its wrapper bubbles the close event to
     * `server.server.onclose` (the Protocol-level callback), which we
     * hook here. This is the documented "wait until the client closes
     * the connection" pattern from the SDK.
     */
    const closed = new Promise<void>((resolveFn) => {
      server.server.onclose = () => resolveFn();
    });

    /*
     * Install SIGINT / SIGTERM handlers so the process responds to
     * Ctrl-C (and `kill -INT` / `kill -TERM` from a supervisor) without
     * a stuck `await closed` keeping the runtime alive. Each handler
     * closes the server, which fires `server.server.onclose`, which
     * resolves the close-promise — the same path the SDK takes for
     * stdin EOF. Tests pass `transport` (an in-memory pair); they don't
     * spawn a real process, so the listeners are harmless extras.
     */
    const removeSignalHandlers = installShutdownHandlers(() => {
      void server.close().catch(() => {
        // Server-close errors are best-effort during shutdown; the
        // close-promise resolves either way via `onclose`.
      });
    });

    await server.connect(transport);
    out(
      `Engineer MCP server connected (agent=${parsed.agentId}, server-url=${parsed.serverUrl}).`,
    );
    try {
      await closed;
      return 0;
    } finally {
      removeSignalHandlers();
    }
  } catch (e) {
    const name = e instanceof Error ? e.name : "UnknownError";
    const message = e instanceof Error ? e.message : String(e);
    err(`MCP server failed: [${name}] ${message}`);
    return 1;
  }
}

/**
 * Attach SIGINT and SIGTERM listeners that invoke `onSignal` once
 * (subsequent signals are ignored — the first triggers a clean shutdown
 * and a fast second Ctrl-C should fall through to the runtime's hard
 * exit). Returns an idempotent `remove` thunk that the caller invokes
 * after a clean stdin-EOF shutdown to avoid leaking listeners across
 * test runs.
 */
function installShutdownHandlers(onSignal: () => void): () => void {
  let fired = false;
  const handler = () => {
    if (fired) return;
    fired = true;
    onSignal();
  };
  let removed = false;
  const signals: ReadonlyArray<Deno.Signal> = ["SIGINT", "SIGTERM"];
  for (const sig of signals) {
    try {
      Deno.addSignalListener(sig, handler);
    } catch {
      // Signal not supported on this platform (e.g. Windows for SIGTERM).
    }
  }
  return () => {
    if (removed) return;
    removed = true;
    for (const sig of signals) {
      try {
        Deno.removeSignalListener(sig, handler);
      } catch {
        // Symmetrical to install — ignore unsupported signals.
      }
    }
  };
}
