/**
 * Tests for `tickets.ts` zod schemas.
 *
 * Each schema is exercised on (a) the documented good example (must
 * accept), (b) every documented bad example (must reject with `ZodError`),
 * and (c) a compile-time type-equality assertion that the schema's
 * inferred output equals the shared `@keni/shared` wire type. The
 * `z.ZodType<SharedType>` annotation in `tickets.ts` is the upper-bound
 * check; the `Expect<Equal<...>>` assertion below is the lower-bound check
 * that catches "schema is a strict subtype" drift.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import type {
  TicketCreateRequest,
  TicketHeaderPatchRequest,
  TicketTransitionRequest,
} from "@keni/shared";
import {
  TICKET_STATUSES,
  TicketCreateRequestSchema,
  TicketHeaderPatchRequestSchema,
  TicketTransitionRequestSchema,
} from "./tickets.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true
  : false;
type Expect<T extends true> = T;

type _CheckCreate = Expect<
  Equal<z.infer<typeof TicketCreateRequestSchema>, TicketCreateRequest>
>;
type _CheckPatch = Expect<
  Equal<z.infer<typeof TicketHeaderPatchRequestSchema>, TicketHeaderPatchRequest>
>;
type _CheckTransition = Expect<
  Equal<z.infer<typeof TicketTransitionRequestSchema>, TicketTransitionRequest>
>;

Deno.test("TicketCreateRequestSchema accepts the documented good example", () => {
  const parsed = TicketCreateRequestSchema.parse({
    title: "Add OAuth login",
    body: "Long description",
    assignee: "alice",
    priority: 100,
    change_request: "cr-2026-04",
  });
  assertEquals(parsed.title, "Add OAuth login");
  assertEquals(parsed.priority, 100);
});

Deno.test("TicketCreateRequestSchema accepts the minimal good example (only required fields)", () => {
  const parsed = TicketCreateRequestSchema.parse({ title: "Tiny", priority: 0 });
  assertEquals(parsed.title, "Tiny");
});

Deno.test("TicketCreateRequestSchema rejects an empty title", () => {
  assertThrows(
    () => TicketCreateRequestSchema.parse({ title: "", priority: 100 }),
    z.ZodError,
  );
});

Deno.test("TicketCreateRequestSchema rejects a title over 200 characters", () => {
  assertThrows(
    () => TicketCreateRequestSchema.parse({ title: "x".repeat(201), priority: 100 }),
    z.ZodError,
  );
});

Deno.test("TicketCreateRequestSchema rejects a non-integer priority", () => {
  assertThrows(
    () => TicketCreateRequestSchema.parse({ title: "Tiny", priority: 1.5 }),
    z.ZodError,
  );
});

Deno.test("TicketCreateRequestSchema rejects a missing priority", () => {
  assertThrows(
    () => TicketCreateRequestSchema.parse({ title: "Tiny" }),
    z.ZodError,
  );
});

Deno.test("TicketHeaderPatchRequestSchema accepts a partial header patch", () => {
  const parsed = TicketHeaderPatchRequestSchema.parse({ assignee: "bob" });
  assertEquals(parsed.assignee, "bob");
});

Deno.test("TicketHeaderPatchRequestSchema accepts an empty patch", () => {
  const parsed = TicketHeaderPatchRequestSchema.parse({});
  assertEquals(parsed, {});
});

Deno.test("TicketHeaderPatchRequestSchema rejects a non-string title", () => {
  assertThrows(
    () => TicketHeaderPatchRequestSchema.parse({ title: 42 }),
    z.ZodError,
  );
});

Deno.test("TicketTransitionRequestSchema accepts a documented good transition", () => {
  const parsed = TicketTransitionRequestSchema.parse({ from: "open", to: "in_progress" });
  assertEquals(parsed.from, "open");
  assertEquals(parsed.to, "in_progress");
});

Deno.test("TicketTransitionRequestSchema rejects an unknown status literal", () => {
  assertThrows(
    () => TicketTransitionRequestSchema.parse({ from: "bogus", to: "in_progress" }),
    z.ZodError,
  );
});

Deno.test("TicketTransitionRequestSchema rejects a missing field", () => {
  assertThrows(
    () => TicketTransitionRequestSchema.parse({ from: "open" }),
    z.ZodError,
  );
});

Deno.test("TICKET_STATUSES enumerates the §4.1 ticket lifecycle in order", () => {
  assertEquals(TICKET_STATUSES.length, 12);
  assertEquals(TICKET_STATUSES[0], "open");
  assertEquals(TICKET_STATUSES[TICKET_STATUSES.length - 1], "done");
});
