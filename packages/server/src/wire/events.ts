/**
 * zod schemas for the orchestration server's WebSocket event frames.
 *
 * `EventEnvelopeSchema` is a `z.discriminatedUnion("event", […])` over the
 * six per-payload schemas. The annotation `z.ZodType<EventFrame>` is the
 * upper-bound drift guard from `design.md` Decision 5: a payload-shape
 * change in `@keni/shared/wire/events.ts` that is not mirrored here fails
 * `deno task check`. The matching wire test file adds the inverse lower
 * bound (`expectType<z.infer<typeof EventEnvelopeSchema>>().toEqual<EventFrame>()`).
 *
 * The schemas are not strictly necessary on the emit side (the server
 * builds frames from typed code paths) — they exist so a future MCP /
 * CLI consumer can validate inbound frames, and so the test suite can
 * assert on schema conformance independent of TypeScript.
 *
 * @module
 */

import { z } from "zod";
import type {
  ActivityAppendedPayload,
  AgentStateChangedPayload,
  EventFrame,
  PRCreatedPayload,
  PRUpdatedPayload,
  TicketCreatedPayload,
  TicketUpdatedPayload,
} from "@keni/shared";
import { AgentStatusSchema } from "./agents.ts";
import { PRStatusSchema } from "./prs.ts";
import { TicketStatusSchema } from "./tickets.ts";

export const TicketCreatedPayloadSchema: z.ZodType<TicketCreatedPayload> = z.object({
  ticket_id: z.string().min(1),
  status: TicketStatusSchema,
}).strict();

export const TicketUpdatedPayloadSchema: z.ZodType<TicketUpdatedPayload> = z.object({
  ticket_id: z.string().min(1),
  status: TicketStatusSchema,
  kind: z.enum(["patch", "transition"]),
}).strict();

export const PRCreatedPayloadSchema: z.ZodType<PRCreatedPayload> = z.object({
  pr_id: z.string().min(1),
  status: PRStatusSchema,
  ticket: z.string().min(1),
}).strict();

export const PRUpdatedPayloadSchema: z.ZodType<PRUpdatedPayload> = z.object({
  pr_id: z.string().min(1),
  status: PRStatusSchema,
  kind: z.enum(["intent", "transition"]),
}).strict();

export const ActivityAppendedPayloadSchema: z.ZodType<ActivityAppendedPayload> = z.object({
  entry_id: z.string().min(1),
  agent: z.string().min(1),
  role: z.string().min(1),
  event: z.string().min(1),
}).strict();

export const AgentStateChangedPayloadSchema: z.ZodType<AgentStateChangedPayload> = z.object({
  agent_id: z.string().min(1),
  paused: z.boolean(),
  status: AgentStatusSchema,
}).strict();

/**
 * Build a per-variant envelope schema. `event` is a `z.literal(...)` so
 * the discriminated union can switch on it; `id` / `project_id` /
 * `timestamp` are stable across variants.
 */
function envelopeSchema<E extends string, P>(
  event: E,
  payloadSchema: z.ZodType<P>,
) {
  return z.object({
    id: z.string().min(1),
    event: z.literal(event),
    project_id: z.string().min(1),
    timestamp: z.string().min(1),
    payload: payloadSchema,
  }).strict();
}

/**
 * Discriminated union over every legal `EventFrame`. The
 * `z.ZodType<EventFrame>` annotation guarantees the schema covers every
 * variant in the shared union; the schemas above guarantee each payload
 * is typed correctly.
 */
export const EventEnvelopeSchema: z.ZodType<EventFrame> = z.discriminatedUnion("event", [
  envelopeSchema("ticket.created", TicketCreatedPayloadSchema),
  envelopeSchema("ticket.updated", TicketUpdatedPayloadSchema),
  envelopeSchema("pr.created", PRCreatedPayloadSchema),
  envelopeSchema("pr.updated", PRUpdatedPayloadSchema),
  envelopeSchema("activity.appended", ActivityAppendedPayloadSchema),
  envelopeSchema("agent.state_changed", AgentStateChangedPayloadSchema),
]);
