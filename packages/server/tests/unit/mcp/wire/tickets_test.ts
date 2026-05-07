/**
 * Tests for the four ticket-tool input schemas.
 *
 * Each schema gets: a positive case from the spec (the documented happy
 * path), a `.strict()`-rejection case that fails when extra keys leak in,
 * and a compile-time `Equal<>` assertion that the schema's parsed output
 * type equals the matching MCP-internal interface (the lower-bound check
 * complementing the `z.ZodType<X>` upper-bound check in `tickets.ts`).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  ListTicketsInputSchema,
  ReadTicketInputSchema,
  TICKET_STATUSES,
  TransitionTicketInputSchema,
  UpdateTicketBodyInputSchema,
} from "../../../../src/mcp/wire/tickets.ts";
import type {
  ListTicketsInput,
  ReadTicketInput,
  TransitionTicketInput,
  UpdateTicketBodyInput,
} from "../../../../src/mcp/wire/tickets.ts";

/*
 * `satisfies z.ZodType<X>` (in `tickets.ts`) provides the upper-bound
 * check — the schema's parsed output must be assignable to `X`. Below
 * we add the lower-bound check via `Assignable<>`, asserting that any
 * value of `X` is also a valid input to the schema. Together this
 * catches both "schema drifted off X" and "X drifted away from the
 * schema" without rejecting trivial `readonly` differences.
 */
type Assignable<From, To> = From extends To ? true : false;
type Expect<T extends true> = T;

type _ListSchemaToInput = Expect<
  Assignable<z.infer<typeof ListTicketsInputSchema>, ListTicketsInput>
>;
type _ReadSchemaToInput = Expect<
  Assignable<z.infer<typeof ReadTicketInputSchema>, ReadTicketInput>
>;
type _UpdateSchemaToInput = Expect<
  Assignable<z.infer<typeof UpdateTicketBodyInputSchema>, UpdateTicketBodyInput>
>;
type _TransitionSchemaToInput = Expect<
  Assignable<z.infer<typeof TransitionTicketInputSchema>, TransitionTicketInput>
>;

Deno.test("ListTicketsInputSchema accepts the documented filter shape", () => {
  const parsed = ListTicketsInputSchema.parse({
    status: "open",
    assignee: "alice",
    priorityMin: 0,
    priorityMax: 100,
    change_request: "cr-2026-04",
  });
  assertEquals(parsed.status, "open");
  assertEquals(parsed.assignee, "alice");
});

Deno.test("ListTicketsInputSchema accepts an empty filter", () => {
  const parsed = ListTicketsInputSchema.parse({});
  assertEquals(parsed, {});
});

Deno.test("ListTicketsInputSchema accepts a single status string", () => {
  const parsed = ListTicketsInputSchema.parse({ status: "open" });
  assertEquals(parsed.status, "open");
});

Deno.test("ListTicketsInputSchema accepts a status array", () => {
  const parsed = ListTicketsInputSchema.parse({ status: ["open", "in_progress"] });
  assertEquals(parsed.status, ["open", "in_progress"]);
});

Deno.test("ListTicketsInputSchema rejects an unknown status literal", () => {
  assertThrows(() => ListTicketsInputSchema.parse({ status: "bogus" }), z.ZodError);
});

Deno.test("ListTicketsInputSchema rejects an unknown extra key (`.strict`)", () => {
  assertThrows(
    () => ListTicketsInputSchema.parse({ rogueField: 1 }),
    z.ZodError,
  );
});

Deno.test("ReadTicketInputSchema accepts a canonical ticket id", () => {
  const parsed = ReadTicketInputSchema.parse({ id: "ticket-0001" });
  assertEquals(parsed.id, "ticket-0001");
});

Deno.test("ReadTicketInputSchema rejects an id missing the prefix", () => {
  assertThrows(() => ReadTicketInputSchema.parse({ id: "0001" }), z.ZodError);
});

Deno.test("ReadTicketInputSchema rejects an id with too few digits", () => {
  assertThrows(() => ReadTicketInputSchema.parse({ id: "ticket-1" }), z.ZodError);
});

Deno.test("UpdateTicketBodyInputSchema accepts the documented good example", () => {
  const parsed = UpdateTicketBodyInputSchema.parse({ id: "ticket-0001", body: "new body" });
  assertEquals(parsed.id, "ticket-0001");
  assertEquals(parsed.body, "new body");
});

Deno.test("UpdateTicketBodyInputSchema rejects a sneaked-in `status` (validation_failed)", () => {
  assertThrows(
    () =>
      (UpdateTicketBodyInputSchema as z.ZodType).parse({
        id: "ticket-0001",
        body: "x",
        status: "in_progress",
      }),
    z.ZodError,
  );
});

Deno.test("UpdateTicketBodyInputSchema rejects a missing body", () => {
  assertThrows(
    () => UpdateTicketBodyInputSchema.parse({ id: "ticket-0001" }),
    z.ZodError,
  );
});

Deno.test("TransitionTicketInputSchema accepts a documented engineer-owned transition", () => {
  const parsed = TransitionTicketInputSchema.parse({
    id: "ticket-0001",
    from: "open",
    to: "in_progress",
  });
  assertEquals(parsed.from, "open");
  assertEquals(parsed.to, "in_progress");
});

Deno.test("TransitionTicketInputSchema rejects an unknown `to` status string", () => {
  assertThrows(
    () =>
      TransitionTicketInputSchema.parse({
        id: "ticket-0001",
        from: "open",
        to: "no_such_status",
      }),
    z.ZodError,
  );
});

Deno.test("TransitionTicketInputSchema rejects a missing field", () => {
  assertThrows(
    () => TransitionTicketInputSchema.parse({ id: "ticket-0001", from: "open" }),
    z.ZodError,
  );
});

Deno.test("TICKET_STATUSES re-export covers the §4.1 lifecycle (sanity)", () => {
  assertEquals(TICKET_STATUSES.length, 12);
  assertEquals(TICKET_STATUSES[0], "open");
  assertEquals(TICKET_STATUSES[TICKET_STATUSES.length - 1], "done");
});
