/**
 * Tests for `events.ts` zod schemas. Each per-payload schema gets a
 * happy-path parse and a negative case; the discriminated union gets a
 * round-trip per variant, an unknown-event-name case, and the
 * type-equivalence assertion.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import type { EventFrame } from "@keni/shared";
import {
  ActivityAppendedPayloadSchema,
  AgentStateChangedPayloadSchema,
  EventEnvelopeSchema,
  PRCreatedPayloadSchema,
  PRUpdatedPayloadSchema,
  TicketCreatedPayloadSchema,
  TicketUpdatedPayloadSchema,
} from "./events.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true
  : false;
type Expect<T extends true> = T;

type _CheckEventFrame = Expect<
  Equal<z.infer<typeof EventEnvelopeSchema>, EventFrame>
>;

const ID = "01900000-0000-7000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const TIMESTAMP = "2026-05-01T10:00:00.000Z";

function frame<E extends string, P>(event: E, payload: P): {
  id: string;
  event: E;
  project_id: string;
  timestamp: string;
  payload: P;
} {
  return { id: ID, event, project_id: PROJECT_ID, timestamp: TIMESTAMP, payload };
}

Deno.test("TicketCreatedPayloadSchema accepts a documented payload", () => {
  const parsed = TicketCreatedPayloadSchema.parse({
    ticket_id: "ticket-0001",
    status: "open",
  });
  assertEquals(parsed.ticket_id, "ticket-0001");
});

Deno.test("TicketCreatedPayloadSchema rejects a missing field", () => {
  assertThrows(() => TicketCreatedPayloadSchema.parse({ ticket_id: "ticket-0001" }), z.ZodError);
});

Deno.test("TicketUpdatedPayloadSchema accepts both kinds", () => {
  TicketUpdatedPayloadSchema.parse({
    ticket_id: "ticket-0001",
    status: "in_progress",
    kind: "patch",
  });
  TicketUpdatedPayloadSchema.parse({
    ticket_id: "ticket-0001",
    status: "in_progress",
    kind: "transition",
  });
});

Deno.test("TicketUpdatedPayloadSchema rejects an unknown kind", () => {
  assertThrows(
    () =>
      TicketUpdatedPayloadSchema.parse({
        ticket_id: "ticket-0001",
        status: "in_progress",
        kind: "delete",
      }),
    z.ZodError,
  );
});

Deno.test("PRCreatedPayloadSchema accepts a documented payload", () => {
  PRCreatedPayloadSchema.parse({
    pr_id: "pr-0001",
    status: "open",
    ticket: "ticket-0001",
  });
});

Deno.test("PRCreatedPayloadSchema rejects a missing ticket reference", () => {
  assertThrows(
    () =>
      PRCreatedPayloadSchema.parse({
        pr_id: "pr-0001",
        status: "open",
      }),
    z.ZodError,
  );
});

Deno.test("PRUpdatedPayloadSchema accepts both kinds", () => {
  PRUpdatedPayloadSchema.parse({
    pr_id: "pr-0001",
    status: "in_review",
    kind: "intent",
  });
  PRUpdatedPayloadSchema.parse({
    pr_id: "pr-0001",
    status: "in_review",
    kind: "transition",
  });
});

Deno.test("ActivityAppendedPayloadSchema accepts a documented payload", () => {
  ActivityAppendedPayloadSchema.parse({
    entry_id: "01900000-0000-7000-8000-000000000002",
    agent: "alice",
    role: "engineer",
    event: "session_start",
  });
});

Deno.test("ActivityAppendedPayloadSchema rejects empty agent id", () => {
  assertThrows(
    () =>
      ActivityAppendedPayloadSchema.parse({
        entry_id: "01900000-0000-7000-8000-000000000002",
        agent: "",
        role: "engineer",
        event: "session_start",
      }),
    z.ZodError,
  );
});

Deno.test("AgentStateChangedPayloadSchema accepts a documented payload", () => {
  AgentStateChangedPayloadSchema.parse({
    agent_id: "alice",
    paused: true,
    status: "idle",
  });
});

Deno.test("AgentStateChangedPayloadSchema rejects unknown status", () => {
  assertThrows(
    () =>
      AgentStateChangedPayloadSchema.parse({
        agent_id: "alice",
        paused: true,
        status: "blocked",
      }),
    z.ZodError,
  );
});

Deno.test("EventEnvelopeSchema round-trips a ticket.created frame", () => {
  const parsed = EventEnvelopeSchema.parse(
    frame("ticket.created", { ticket_id: "ticket-0001", status: "open" }),
  );
  assertEquals(parsed.event, "ticket.created");
});

Deno.test("EventEnvelopeSchema round-trips every event variant", () => {
  EventEnvelopeSchema.parse(
    frame("ticket.created", { ticket_id: "ticket-0001", status: "open" }),
  );
  EventEnvelopeSchema.parse(
    frame("ticket.updated", {
      ticket_id: "ticket-0001",
      status: "in_progress",
      kind: "transition",
    }),
  );
  EventEnvelopeSchema.parse(
    frame("pr.created", {
      pr_id: "pr-0001",
      status: "open",
      ticket: "ticket-0001",
    }),
  );
  EventEnvelopeSchema.parse(
    frame("pr.updated", {
      pr_id: "pr-0001",
      status: "in_review",
      kind: "intent",
    }),
  );
  EventEnvelopeSchema.parse(
    frame("activity.appended", {
      entry_id: "01900000-0000-7000-8000-000000000002",
      agent: "alice",
      role: "engineer",
      event: "session_start",
    }),
  );
  EventEnvelopeSchema.parse(
    frame("agent.state_changed", {
      agent_id: "alice",
      paused: true,
      status: "idle",
    }),
  );
});

Deno.test("EventEnvelopeSchema rejects an unknown event name", () => {
  assertThrows(
    () =>
      EventEnvelopeSchema.parse({
        id: ID,
        event: "ticket.deleted",
        project_id: PROJECT_ID,
        timestamp: TIMESTAMP,
        payload: { ticket_id: "ticket-0001" },
      }),
    z.ZodError,
  );
});

Deno.test("EventEnvelopeSchema rejects a missing envelope field", () => {
  assertThrows(
    () =>
      EventEnvelopeSchema.parse({
        id: ID,
        event: "ticket.created",
        timestamp: TIMESTAMP,
        payload: { ticket_id: "ticket-0001", status: "open" },
      }),
    z.ZodError,
  );
});

Deno.test("EventEnvelopeSchema rejects a payload mismatched with the event", () => {
  assertThrows(
    () =>
      EventEnvelopeSchema.parse({
        id: ID,
        event: "agent.state_changed",
        project_id: PROJECT_ID,
        timestamp: TIMESTAMP,
        payload: { ticket_id: "ticket-0001", status: "open" },
      }),
    z.ZodError,
  );
});
