/**
 * Registers the two activity-log tools (`append_activity_entry`,
 * `query_activity`) onto an `McpServer`.
 *
 * Identity (`agent`, `role`) is stamped by the HTTP client from the
 * boot-time `--agent` flag — the tool input schema deliberately omits
 * both fields so an LLM cannot forge them (spec scenario "rejects an
 * attempt to override `agent`"). The handler simply forwards the
 * validated input.
 *
 * `query_activity` applies the 200-default-limit (handler-side, since
 * the schema's parsed type would otherwise become `{ limit: number }`
 * and lose `?` optionality — see `wire/activity.ts` leading comment).
 * The hard ceiling is enforced by the schema before the handler runs.
 *
 * @module
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerDeps } from "../createMcpServer.ts";
import { mapHttpErrorToToolResult, wrapToolSuccess } from "../errors.ts";
import {
  type AppendActivityInput,
  AppendActivityInputSchema,
  QUERY_ACTIVITY_DEFAULT_LIMIT,
  type QueryActivityInput,
  QueryActivityInputSchema,
} from "../wire/activity.ts";

/** Description for the `append_activity_entry` tool — pinned by the drift test. */
export const APPEND_ACTIVITY_ENTRY_DESCRIPTION =
  "Appends one entry to the project's activity log under the calling agent's identity. The agent and role fields are stamped server-side and cannot be overridden.";

/** Description for the `query_activity` tool — pinned by the drift test. */
export const QUERY_ACTIVITY_DESCRIPTION =
  "Queries the activity log with optional filters and a per-call limit (default 200, hard ceiling 1000). Use a narrow from/to window to keep results focused.";

/** Register the two activity-log tools onto `server`. */
export function registerActivityTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    "append_activity_entry",
    {
      description: APPEND_ACTIVITY_ENTRY_DESCRIPTION,
      inputSchema: AppendActivityInputSchema,
    },
    async (rawInput: unknown) => {
      const input = rawInput as AppendActivityInput;
      try {
        const data = await deps.httpClient.appendActivity({
          session_id: input.session_id,
          event: input.event,
          summary: input.summary,
          refs: input.refs,
          agent: deps.agentId,
          role: "engineer",
        });
        return wrapToolSuccess(data);
      } catch (err) {
        return mapHttpErrorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "query_activity",
    {
      description: QUERY_ACTIVITY_DESCRIPTION,
      inputSchema: QueryActivityInputSchema,
    },
    async (rawInput: unknown) => {
      const input = rawInput as QueryActivityInput;
      try {
        const limit = input.limit ?? QUERY_ACTIVITY_DEFAULT_LIMIT;
        const data = await deps.httpClient.queryActivity(
          {
            agent: input.agent,
            role: input.role,
            from: input.from,
            to: input.to,
          },
          limit,
        );
        return wrapToolSuccess(data);
      } catch (err) {
        return mapHttpErrorToToolResult(err);
      }
    },
  );
}
