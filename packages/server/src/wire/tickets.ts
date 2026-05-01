/**
 * zod schemas for ticket request bodies.
 *
 * Each `*Schema` is annotated `z.ZodType<SharedType>` so a schema-shape
 * change that drifts from the shared wire type is caught at `deno task
 * check` time (design.md Decision 5). The route handlers validate request
 * bodies through these schemas and pass the parsed payloads on to the
 * storage layer.
 *
 * @module
 */

import { z } from "zod";
import type {
  TicketCreateRequest,
  TicketHeaderPatchRequest,
  TicketTransitionRequest,
} from "@keni/shared";

/**
 * Every legal `TicketStatus` literal — used by the transition schema and
 * the §4.1 status graph in `../statusGraph.ts`. Keep this list in lock-step
 * with `@keni/shared/storage/tickets/interface.ts#TicketStatus`.
 */
export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "ready_for_review",
  "in_review",
  "has_comments",
  "approved",
  "merged",
  "ready_for_test",
  "in_testing",
  "tested",
  "test_failed",
  "done",
] as const;

/** zod enum for ticket statuses, derived from {@link TICKET_STATUSES}. */
export const TicketStatusSchema = z.enum(TICKET_STATUSES);

export const TicketCreateRequestSchema: z.ZodType<TicketCreateRequest> = z.object({
  title: z.string().min(1).max(200),
  body: z.string().optional(),
  assignee: z.string().nullable().optional(),
  priority: z.number().int(),
  change_request: z.string().nullable().optional(),
}).strict();

export const TicketHeaderPatchRequestSchema: z.ZodType<TicketHeaderPatchRequest> = z.object({
  title: z.string().min(1).max(200).optional(),
  assignee: z.string().nullable().optional(),
  priority: z.number().int().optional(),
  change_request: z.string().nullable().optional(),
  body: z.string().optional(),
}).strict();

export const TicketTransitionRequestSchema: z.ZodType<TicketTransitionRequest> = z.object({
  from: TicketStatusSchema,
  to: TicketStatusSchema,
}).strict();
