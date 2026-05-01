/**
 * Registers the `get_workspace_path` tool — the only tool that does not
 * delegate to the orchestration server.
 *
 * The workspace path is captured as a closure constant from
 * `deps.workspacePath` (validated against `Deno.stat` at boot by
 * `runMcpServer` — see spec "the path is read once at startup and is
 * constant for the life of this MCP-server process"). The handler is
 * synchronous, performs no I/O, and never throws (no `try`/`catch`
 * needed; design.md leading rationale).
 *
 * @module
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerDeps } from "../createMcpServer.ts";
import { wrapToolSuccess } from "../errors.ts";
import { GetWorkspacePathInputSchema } from "../wire/workspace.ts";

/** Description for the `get_workspace_path` tool — pinned by the drift test. */
export const GET_WORKSPACE_PATH_DESCRIPTION =
  "Returns the absolute filesystem path of this engineer's workspace clone. The path is read once at startup and is constant for the life of this MCP-server process.";

/** Register the workspace-path tool onto `server`. */
export function registerWorkspaceTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    "get_workspace_path",
    {
      description: GET_WORKSPACE_PATH_DESCRIPTION,
      inputSchema: GetWorkspacePathInputSchema,
    },
    () => wrapToolSuccess({ path: deps.workspacePath }),
  );
}
