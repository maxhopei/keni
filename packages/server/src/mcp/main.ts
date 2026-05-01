/**
 * `@keni/server/mcp` entry point — the engineer MCP server's public
 * surface.
 *
 * Re-exports the composition root (`createMcpServer`), the argv runner
 * (`runMcpServer`), the typed HTTP client (`createMcpHttpClient`,
 * `McpHttpClient`), and the error class (`McpHttpError`). Imported by:
 *
 * - `packages/server/src/main.ts` — re-exports the same names so a
 *   downstream consumer needs only one import path
 *   (`@keni/server`) for both the orchestration server and the MCP
 *   server. The `mcpServers` config block of the engineer subprocess
 *   (step 07's role runtime) points its `command` at *this* file's
 *   direct-invocation arm:
 *
 * ```bash
 * deno run -A packages/server/src/mcp/main.ts \
 *   --agent <id> --server-url <url> --workspace <abs-path>
 * ```
 *
 * The `import.meta.main` arm dispatches to `runMcpServer(Deno.args)` and
 * exits with the returned code. Tests import the named exports without
 * triggering that side effect.
 *
 * @module
 */

export { createMcpServer, DEFAULT_MCP_SERVER_OPTIONS } from "./createMcpServer.ts";
export type { McpServerDeps, McpServerOptions } from "./createMcpServer.ts";

export { parseRunMcpServerArgs, runMcpServer, UsageError } from "./runMcpServer.ts";
export type { RunMcpServerArgs, RunMcpServerDeps } from "./runMcpServer.ts";

export { createMcpHttpClient } from "./httpClient.ts";
export type { McpHttpClient } from "./httpClient.ts";

export { McpHttpError } from "./errors.ts";

if (import.meta.main) {
  const { runMcpServer } = await import("./runMcpServer.ts");
  Deno.exit(await runMcpServer(Deno.args));
}
