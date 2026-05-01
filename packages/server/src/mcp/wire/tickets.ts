/**
 * MCP-internal zod schemas for the four ticket tools.
 *
 * Each schema is annotated `z.ZodType<X>` so a drift between the schema and
 * its companion TypeScript interface is caught at `deno task check` time
 * (design.md Decision 5). The schemas reuse `TICKET_STATUSES` from
 * `../../wire/tickets.ts` so a future status-graph extension lands in one
 * place; the MCP layer never re-enumerates the §4.1 lifecycle.
 *
 * Every object schema is `.strict()` — extra keys are rejected at the
 * schema layer, before any HTTP request is made. This is what enforces the
 * "no sneaked-in `status` on update" and "no sneaked-in `agent`/`role` on
 * activity append" rules from `mcp-engineer-surface/spec.md`.
 *
 * Types declared here are server-internal — the SPA does not depend on
 * them, so they live alongside their schemas instead of in `@keni/shared`
 * (design.md Decision 13).
 *
 * @module
 */

import { z } from "zod";
import type { TicketStatus } from "@keni/shared";
import { TICKET_STATUSES, TicketStatusSchema } from "../../wire/tickets.ts";

/** Input shape for the `list_tickets` MCP tool. */
export interface ListTicketsInput {
  readonly status?: TicketStatus | readonly TicketStatus[];
  readonly assignee?: string | null;
  readonly priorityMin?: number;
  readonly priorityMax?: number;
  readonly change_request?: string | null;
}

/** Input shape for the `read_ticket` MCP tool. */
export interface ReadTicketInput {
  readonly id: string;
}

/** Input shape for the `update_ticket_body` MCP tool. */
export interface UpdateTicketBodyInput {
  readonly id: string;
  readonly body: string;
}

/** Input shape for the `transition_ticket_status` MCP tool. */
export interface TransitionTicketInput {
  readonly id: string;
  readonly from: TicketStatus;
  readonly to: TicketStatus;
}

/**
 * Canonical ticket id literal — matches `generateTicketId` in
 * `@keni/shared/storage/ids.ts` (`ticket-` plus four-or-more digits). The
 * tool layer rejects malformed ids before issuing a 404 round-trip.
 */
const TicketIdSchema = z.string().regex(/^ticket-\d{4,}$/);

/*
 * Schemas use `satisfies z.ZodType<X>` rather than an explicit
 * `: z.ZodType<X>` annotation. The annotation form would widen the
 * schema's static type and erase the underlying `ZodObject<...>` shape,
 * which the MCP SDK's `registerTool` generics need to infer the
 * handler's parsed-input type. `satisfies` keeps both: the underlying
 * narrow type for SDK inference, plus the upper-bound check that the
 * schema does not drift from {@link ListTicketsInput} et al.
 */

export const ListTicketsInputSchema = z.object({
  status: z.union([TicketStatusSchema, z.array(TicketStatusSchema)]).optional(),
  assignee: z.string().nullable().optional(),
  priorityMin: z.number().int().optional(),
  priorityMax: z.number().int().optional(),
  change_request: z.string().nullable().optional(),
}).strict() satisfies z.ZodType<ListTicketsInput>;

export const ReadTicketInputSchema = z.object({
  id: TicketIdSchema,
}).strict() satisfies z.ZodType<ReadTicketInput>;

export const UpdateTicketBodyInputSchema = z.object({
  id: TicketIdSchema,
  body: z.string(),
}).strict() satisfies z.ZodType<UpdateTicketBodyInput>;

export const TransitionTicketInputSchema = z.object({
  id: TicketIdSchema,
  from: TicketStatusSchema,
  to: TicketStatusSchema,
}).strict() satisfies z.ZodType<TransitionTicketInput>;

/** Re-export so the `tools/` layer does not double-import from `../../wire/`. */
export { TICKET_STATUSES };
