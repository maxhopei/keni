/**
 * `runServer` — argv-level entry point for the orchestration server.
 *
 * Parses `--project <path>`, `--port <n>`, `--host <h>` (hand-rolled, no
 * `parseArgs` dep yet), resolves project paths, builds the four file-backed
 * stores, reads `project.yaml` once, calls `startServer`, prints the bound
 * URL, and awaits a SIGINT for shutdown. Returns a process exit code:
 *
 * | Exit | Cause |
 * | ---- | ----- |
 * | 0    | Server started, ran, and shut down cleanly on SIGINT |
 * | 1    | Project not initialised (missing `.keni/project.yaml`) |
 * | 2    | Usage error (missing `--project`, unknown flag, bad value) |
 *
 * Tests drive `runServer` in-process by injecting `RunServerDeps`:
 * `signal` to skip waiting for a real SIGINT, `out`/`err` to capture I/O,
 * `makeStores` to substitute in-memory adapters.
 *
 * @module
 */

import {
  FileActivityLogStore,
  FileConfigStore,
  FilePRStore,
  FileTicketStore,
  resolveGlobalPaths,
  resolveProjectPaths,
  StoreNotFoundError,
} from "@keni/shared";
import type {
  ActivityLogStore,
  ConfigStore,
  ProjectPaths,
  PRStore,
  TicketStore,
} from "@keni/shared";
import { resolve } from "@std/path";
import { createInMemoryAgentRuntimeStateStore } from "./agentState.ts";
import { createInMemoryEventBus } from "./eventBus.ts";
import { stdoutLogSink } from "./middleware/requestLog.ts";
import type { LogSink } from "./middleware/types.ts";
import { startServer } from "./startServer.ts";

/** Parsed CLI flags for `runServer`. */
export interface RunServerArgs {
  readonly projectDir: string;
  readonly port: number;
  readonly host: string;
}

/** Optional dependency overrides for tests. */
export interface RunServerDeps {
  /** Stdout writer. Defaults to `console.log`. */
  readonly out?: (line: string) => void;
  /** Stderr writer. Defaults to `console.error`. */
  readonly err?: (line: string) => void;
  /** Home directory for `~/.keni/` resolution. Defaults to `Deno.env.get("HOME")`. */
  readonly homeDir?: string;
  /** Override the log sink (defaults to {@link stdoutLogSink}). */
  readonly logSink?: LogSink;
  /**
   * Override the store factory. Defaults to `File*` adapters rooted at the
   * resolved project paths. Tests pass in-memory adapters here.
   */
  readonly makeStores?: (paths: ProjectPaths) => {
    readonly ticketStore: TicketStore;
    readonly prStore: PRStore;
    readonly activityLogStore: ActivityLogStore;
    readonly configStore: ConfigStore;
  };
  /**
   * Pre-aborted signal that resolves immediately, used by tests to make the
   * server return without waiting for a real SIGINT. When omitted, the
   * default behaviour installs a SIGINT listener.
   */
  readonly shutdownSignal?: AbortSignal;
}

/**
 * Parse argv. Accepts `--key value` and `--key=value`. Throws `UsageError`
 * (caught by `runServer` → exit 2) on shape problems.
 */
export function parseRunServerArgs(args: readonly string[]): RunServerArgs {
  let projectDir: string | undefined;
  let port = 0;
  let host = "127.0.0.1";

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
      case "--project":
        projectDir = consume();
        break;
      case "--port": {
        const raw = consume();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
          throw new UsageError(`--port must be a non-negative integer ≤ 65535 (got '${raw}')`);
        }
        port = parsed;
        break;
      }
      case "--host":
        host = consume();
        break;
      default:
        throw new UsageError(`Unknown flag: ${key}`);
    }
  }

  if (projectDir === undefined) {
    throw new UsageError("Missing required flag: --project <path>");
  }

  return { projectDir: resolve(projectDir), port, host };
}

/** Internal — surfaces as exit 2 in `runServer`. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Print the documented usage text. */
function formatUsage(): string {
  return [
    "Usage: deno run -A packages/server/src/main.ts --project <path> [--port <n>] [--host <h>]",
    "",
    "Flags:",
    "  --project <path>   Required. Path to the directory holding `.keni/project.yaml`.",
    "  --port    <n>      Optional. TCP port. 0 (the default) requests an OS-assigned port.",
    "  --host    <h>      Optional. Hostname to bind. Defaults to 127.0.0.1 (loopback only).",
  ].join("\n");
}

/**
 * Argv-level entry point. Returns the exit code; never calls `Deno.exit`.
 */
export async function runServer(
  args: readonly string[],
  deps: RunServerDeps = {},
): Promise<number> {
  const out = deps.out ?? ((m) => console.log(m));
  const err = deps.err ?? ((m) => console.error(m));

  let parsed: RunServerArgs;
  try {
    parsed = parseRunServerArgs(args);
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      err(formatUsage());
      return 2;
    }
    throw e;
  }

  const projectPaths = resolveProjectPaths(parsed.projectDir);
  const homeDir = deps.homeDir ?? Deno.env.get("HOME") ?? "";
  const globalPaths = resolveGlobalPaths(homeDir);

  const stores = deps.makeStores?.(projectPaths) ?? {
    ticketStore: new FileTicketStore(projectPaths),
    prStore: new FilePRStore(projectPaths),
    activityLogStore: new FileActivityLogStore(projectPaths),
    configStore: new FileConfigStore(projectPaths, globalPaths),
  };

  let projectId: string;
  let roster: readonly { readonly id: string; readonly role: string }[];
  try {
    const config = await stores.configStore.readProjectConfig();
    projectId = config.project_id;
    roster = config.agents ?? [];
  } catch (e) {
    if (e instanceof StoreNotFoundError) {
      err(
        `No .keni/project.yaml found at ${projectPaths.projectConfig}; run \`keni init\` first.`,
      );
      return 1;
    }
    throw e;
  }

  const logSink = deps.logSink ?? stdoutLogSink();
  const eventBus = createInMemoryEventBus({ logSink });
  const agentRuntimeStateStore = createInMemoryAgentRuntimeStateStore(roster);

  const handle = await startServer(
    {
      ticketStore: stores.ticketStore,
      prStore: stores.prStore,
      activityLogStore: stores.activityLogStore,
      configStore: stores.configStore,
      logSink,
      eventBus,
      agentRuntimeStateStore,
    },
    { projectId, port: parsed.port, host: parsed.host },
  );

  out(`Keni server running at ${handle.url}`);

  await waitForShutdown(deps.shutdownSignal);
  await handle.abort();
  return 0;
}

/**
 * Wait for either an injected `AbortSignal` (test path) or a real SIGINT
 * (production path). Cleans up the signal listener on resolve so we never
 * leak a global handler.
 */
function waitForShutdown(injected: AbortSignal | undefined): Promise<void> {
  if (injected !== undefined) {
    if (injected.aborted) return Promise.resolve();
    return new Promise((resolveFn) => {
      injected.addEventListener("abort", () => resolveFn(), { once: true });
    });
  }
  return new Promise((resolveFn) => {
    const handler = () => {
      Deno.removeSignalListener("SIGINT", handler);
      resolveFn();
    };
    Deno.addSignalListener("SIGINT", handler);
  });
}
