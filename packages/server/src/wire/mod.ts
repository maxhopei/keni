/**
 * Barrel for the server-side zod schemas. Routes import from this module;
 * tests import the per-shape modules directly to keep failure messages
 * narrow.
 *
 * @module
 */

export {
  TICKET_STATUSES,
  TicketCreateRequestSchema,
  TicketHeaderPatchRequestSchema,
  TicketStatusSchema,
  TicketTransitionRequestSchema,
} from "./tickets.ts";

export {
  PR_STATUSES,
  PRCreateRequestSchema,
  PRIntentPatchRequestSchema,
  PRStatusSchema,
  PRTransitionRequestSchema,
} from "./prs.ts";

export { ActivityAppendRequestSchema, parseActivityQuery } from "./activity.ts";

export { ErrorResponseSchema } from "./errors.ts";

export { AgentResponseSchema, AgentStatusSchema } from "./agents.ts";

export { HealthResponseSchema } from "./health.ts";

export {
  ActivityAppendedPayloadSchema,
  AgentStateChangedPayloadSchema,
  EventEnvelopeSchema,
  PRCreatedPayloadSchema,
  PRUpdatedPayloadSchema,
  TicketCreatedPayloadSchema,
  TicketUpdatedPayloadSchema,
} from "./events.ts";
