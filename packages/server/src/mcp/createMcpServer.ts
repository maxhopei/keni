/**
 * Composition root for the engineer MCP server.
 *
 * `createMcpServer` is a pure synchronous factory: it takes the three
 * boot-time dependencies (typed HTTP client, agent id, workspace path),
 * builds a fresh `McpServer` instance from `@modelcontextprotocol/sdk`,
 * registers every engineer tool group in a deterministic order
 * (tickets → activity → workspace), and returns the configured server
 * **without attaching a transport** (design.md Decision 6 / spec
 * scenario "`createMcpServer` does not bind a transport").
 *
 * The factory is engineer-only — there is no `role` parameter, by design
 * (spec requirement "The MCP server is engineer-only — the role is
 * hard-coded at the factory boundary"). A future PO MCP server is a
 * sibling factory (`createPoMcpServer`), not a parameterisation of this
 * one (Decision 14).
 *
 * @module
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpHttpClient } from "./httpClient.ts";
import { registerActivityTools } from "./tools/activity.ts";
import { registerTicketTools } from "./tools/tickets.ts";
import { registerWorkspaceTools } from "./tools/workspace.ts";

/**
 * Boot-time dependencies for the engineer MCP server. All three are
 * captured at server creation; tool input has no surface to override
 * any of them.
 */
export interface McpServerDeps {
  /** Typed HTTP client capturing role/agent/server-URL identity. */
  readonly httpClient: McpHttpClient;
  /** Agent id from `--agent`; mirrored into the `agent` field of activity-append bodies. */
  readonly agentId: string;
  /** Absolute path to the engineer's workspace clone, validated by `runMcpServer`. */
  readonly workspacePath: string;
}

/** Optional metadata for the constructed `McpServer`. */
export interface McpServerOptions {
  readonly serverName: string;
  readonly serverVersion: string;
}

/** Defaults applied when {@link createMcpServer} is called without options. */
export const DEFAULT_MCP_SERVER_OPTIONS: McpServerOptions = {
  serverName: "keni-engineer-mcp",
  serverVersion: "0.1.0",
};

/**
 * Build a fresh, configured `McpServer` for the engineer surface. Pure
 * and synchronous — no I/O, no `await`, no side effects beyond
 * `server.registerTool` calls (which are themselves in-memory).
 */
export function createMcpServer(
  deps: McpServerDeps,
  opts: McpServerOptions = DEFAULT_MCP_SERVER_OPTIONS,
): McpServer {
  const server = new McpServer({
    name: opts.serverName,
    version: opts.serverVersion,
  });

  registerTicketTools(server, deps);
  registerActivityTools(server, deps);
  registerWorkspaceTools(server, deps);

  return server;
}
