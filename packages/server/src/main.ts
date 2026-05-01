/**
 * `@keni/server` package entry point.
 *
 * Re-exports the orchestration server's public surface (composition root,
 * port binder, argv-level runner, and supporting types) and serves as the
 * direct-invocation script for development:
 *
 * ```bash
 * deno run -A packages/server/src/main.ts --project <path>
 * ```
 *
 * The `import.meta.main` arm dispatches to `runServer(Deno.args)` and exits
 * with the returned code. Tests import the named exports without triggering
 * that side effect.
 *
 * @module
 */

export const packageName = "@keni/server";

export { createServer } from "./createServer.ts";
export type { ServerDeps, ServerOptions } from "./createServer.ts";

export { startServer } from "./startServer.ts";
export type { StartedServer, StartServerOptions } from "./startServer.ts";

export { parseRunServerArgs, runServer, UsageError } from "./runServer.ts";
export type { RunServerArgs, RunServerDeps } from "./runServer.ts";

export {
  captureLogSink,
  errorBoundary,
  fileLogSink,
  requestId,
  requestLog,
  roleIdentity,
  stdoutLogSink,
} from "./middleware/mod.ts";
export type { LogSink, RequestLogLine, ServerVariables } from "./middleware/mod.ts";

export { captureBusBuffer, createInMemoryEventBus, emitFrame } from "./eventBus.ts";
export type { EventBus, EventBusHandler } from "./eventBus.ts";

export { createInMemoryAgentRuntimeStateStore } from "./agentState.ts";
export type { AgentRuntimeState, AgentRuntimeStateStore } from "./agentState.ts";

export { createMcpServer, McpHttpError, runMcpServer } from "./mcp/main.ts";
export type { McpHttpClient, McpServerDeps } from "./mcp/main.ts";

if (import.meta.main) {
  const { runServer } = await import("./runServer.ts");
  Deno.exit(await runServer(Deno.args));
}
