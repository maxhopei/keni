/**
 * Registers the four ticket tools (`list_tickets`, `read_ticket`,
 * `update_ticket_body`, `transition_ticket_status`) onto an `McpServer`.
 *
 * Each handler is a thin transport adapter (see `mcp-engineer-surface`
 * spec, "Every MCP tool handler SHALL be a thin transport adapter") —
 * input validation lands in the schema, identity stamping lands in the
 * HTTP client, and any HTTP-shaped throw is funnelled through
 * {@link mapHttpErrorToToolResult} so the tool result carries the
 * documented `[<code>] ...` prefix.
 *
 * Tool descriptions are single literal strings ≤ 240 chars (design.md
 * Decision 5 / spec scenario "every tool's `description` is a non-empty
 * string ... ≤ 240 characters"). The constants below are exported so the
 * drift-detector test in `createMcpServer_test.ts` can pin them.
 *
 * @module
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerDeps } from "../createMcpServer.ts";
import { mapHttpErrorToToolResult, wrapToolSuccess } from "../errors.ts";
import {
  type ListTicketsInput,
  ListTicketsInputSchema,
  type ReadTicketInput,
  ReadTicketInputSchema,
  type TransitionTicketInput,
  TransitionTicketInputSchema,
  type UpdateTicketBodyInput,
  UpdateTicketBodyInputSchema,
} from "../wire/tickets.ts";

/** Description for the `list_tickets` tool — pinned by the drift test. */
export const LIST_TICKETS_DESCRIPTION =
  "Lists tickets in the project, optionally filtered by status, assignee, priority range, or change-request id. Returns a summary view per ticket; use read_ticket for the full body.";

/** Description for the `read_ticket` tool — pinned by the drift test. */
export const READ_TICKET_DESCRIPTION =
  "Reads a single ticket by id. Returns the full ticket including its markdown body.";

/** Description for the `update_ticket_body` tool — pinned by the drift test. */
export const UPDATE_TICKET_BODY_DESCRIPTION =
  "Updates the markdown body of a ticket. Cannot change status, title, assignee, priority, or change-request link; use transition_ticket_status to move statuses.";

/** Description for the `transition_ticket_status` tool — pinned by the drift test. */
export const TRANSITION_TICKET_STATUS_DESCRIPTION =
  "Transitions a ticket from `from` to `to`, where `to` must be in the engineer-owned subset of the status graph. The orchestration server enforces the §4.1 status graph and §4.2 owning-role rule.";

/** Register the four ticket tools onto `server`. */
export function registerTicketTools(server: McpServer, deps: McpServerDeps): void {
  server.registerTool(
    "list_tickets",
    {
      description: LIST_TICKETS_DESCRIPTION,
      inputSchema: ListTicketsInputSchema,
    },
    async (rawInput: unknown) => {
      const input = rawInput as ListTicketsInput;
      try {
        const data = await deps.httpClient.listTickets(input);
        return wrapToolSuccess(data);
      } catch (err) {
        return mapHttpErrorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "read_ticket",
    {
      description: READ_TICKET_DESCRIPTION,
      inputSchema: ReadTicketInputSchema,
    },
    async (rawInput: unknown) => {
      const input = rawInput as ReadTicketInput;
      try {
        const data = await deps.httpClient.readTicket(input.id);
        return wrapToolSuccess(data);
      } catch (err) {
        return mapHttpErrorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "update_ticket_body",
    {
      description: UPDATE_TICKET_BODY_DESCRIPTION,
      inputSchema: UpdateTicketBodyInputSchema,
    },
    async (rawInput: unknown) => {
      const input = rawInput as UpdateTicketBodyInput;
      try {
        const data = await deps.httpClient.updateTicketBody(input.id, input.body);
        return wrapToolSuccess(data);
      } catch (err) {
        return mapHttpErrorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "transition_ticket_status",
    {
      description: TRANSITION_TICKET_STATUS_DESCRIPTION,
      inputSchema: TransitionTicketInputSchema,
    },
    async (rawInput: unknown) => {
      const input = rawInput as TransitionTicketInput;
      try {
        const data = await deps.httpClient.transitionTicket(input.id, input.from, input.to);
        return wrapToolSuccess(data);
      } catch (err) {
        return mapHttpErrorToToolResult(err);
      }
    },
  );
}
