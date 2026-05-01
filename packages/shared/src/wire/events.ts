/**
 * Wire shapes for the orchestration server's WebSocket event stream.
 *
 * Every frame the `/events` endpoint pushes is an `EventEnvelope<P>` whose
 * `event` field is the discriminator. The closed set of six event names
 * covers ticket / PR / activity / agent state lifecycle moves; the
 * `EventFrame` discriminated union pairs each name with its payload shape
 * so a `switch (frame.event)` on the consumer side type-narrows
 * exhaustively.
 *
 * **Payloads are minimal references** (`design.md` Decision 3): the SPA
 * receives a stable `id` / `status` / `kind` and refetches the canonical
 * record from REST. This keeps the live channel decoupled from the
 * storage record's evolution and avoids race windows where the event's
 * payload disagrees with the next REST refetch.
 *
 * No runtime symbols beyond the runtime-helpers (`EVENT_NAMES`,
 * `isEventName`) live in this module so a `import type { EventFrame } from
 * "@keni/shared"` in the SPA tree-shakes zod out of the bundle (zod
 * schemas live in `@keni/server/src/wire/events.ts`).
 *
 * @module
 */

import type { PRId, PRStatus } from "../storage/prs/interface.ts";
import type { TicketId, TicketStatus } from "../storage/tickets/interface.ts";
import type { ActivityEntryId } from "../storage/activity/interface.ts";
import type { AgentStatus } from "./agents.ts";

/**
 * The closed set of WebSocket event names. New names are additive; an
 * existing name's payload SHALL NOT change semantics in place (a
 * payload-shape change is a new event name).
 */
export type EventName =
  | "ticket.created"
  | "ticket.updated"
  | "pr.created"
  | "pr.updated"
  | "activity.appended"
  | "agent.state_changed";

/** Tuple form of {@link EventName} — used by the zod discriminated union. */
export const EVENT_NAMES: readonly EventName[] = [
  "ticket.created",
  "ticket.updated",
  "pr.created",
  "pr.updated",
  "activity.appended",
  "agent.state_changed",
] as const;

/** Type-guard for {@link EventName}. */
export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * Common envelope around every event payload. `id` is a uuidv7 generated
 * at emit time so frames sort chronologically (and so a future ring
 * buffer can dedupe / replay by id). `timestamp` is the emit-time ISO
 * 8601 UTC — semantically distinct from the storage record's timestamp
 * because the event is *about* the emit, not the write.
 */
export interface EventEnvelope<E extends EventName, P> {
  readonly id: string;
  readonly event: E;
  readonly project_id: string;
  readonly timestamp: string;
  readonly payload: P;
}

/** Payload for `ticket.created`. Minimal reference; the SPA refetches the full record. */
export interface TicketCreatedPayload {
  readonly ticket_id: TicketId;
  readonly status: TicketStatus;
}

/** Payload for `ticket.updated`. `kind` distinguishes header/body patches from status transitions. */
export interface TicketUpdatedPayload {
  readonly ticket_id: TicketId;
  readonly status: TicketStatus;
  readonly kind: "patch" | "transition";
}

/** Payload for `pr.created`. `ticket` is the parent ticket id (one PR per ticket per `spec.md` §4.2). */
export interface PRCreatedPayload {
  readonly pr_id: PRId;
  readonly status: PRStatus;
  readonly ticket: TicketId;
}

/** Payload for `pr.updated`. `kind` distinguishes intent patches from status transitions. */
export interface PRUpdatedPayload {
  readonly pr_id: PRId;
  readonly status: PRStatus;
  readonly kind: "intent" | "transition";
}

/**
 * Payload for `activity.appended`. The SPA's activity feed reads this
 * frame's fields directly (no refetch needed for the common case); the
 * full entry is still queryable via `GET /activity?…` for detail views.
 */
export interface ActivityAppendedPayload {
  readonly entry_id: ActivityEntryId;
  readonly agent: string;
  readonly role: string;
  readonly event: string;
}

/**
 * Payload for `agent.state_changed`. Emitted only when `paused` or
 * `status` actually flip (debounced at the route handler — `design.md`
 * Decision 11). `last_activity` / `last_active_at` are intentionally
 * absent so a per-character session-output stream does not produce a
 * `agent.state_changed` per chunk; consumers that need them refetch via
 * `GET /agents`.
 */
export interface AgentStateChangedPayload {
  readonly agent_id: string;
  readonly paused: boolean;
  readonly status: AgentStatus;
}

/**
 * Discriminated union of every legal `EventFrame` shape on the wire. The
 * `event` field is the discriminator; consumers SHOULD `switch (frame.event)`
 * to type-narrow each variant. Adding a new variant is a closed-set change:
 * extend {@link EventName}, add a new `EventEnvelope<…, …>` arm here, add
 * the matching zod schema in `@keni/server/src/wire/events.ts`.
 */
export type EventFrame =
  | EventEnvelope<"ticket.created", TicketCreatedPayload>
  | EventEnvelope<"ticket.updated", TicketUpdatedPayload>
  | EventEnvelope<"pr.created", PRCreatedPayload>
  | EventEnvelope<"pr.updated", PRUpdatedPayload>
  | EventEnvelope<"activity.appended", ActivityAppendedPayload>
  | EventEnvelope<"agent.state_changed", AgentStateChangedPayload>;
