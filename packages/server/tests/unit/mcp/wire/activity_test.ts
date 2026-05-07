/**
 * Tests for the two activity-tool input schemas. The trust-seam tests (no
 * `agent`, no `role` in input) are the load-bearing assertions for the
 * spec's "rejects identity overrides" scenarios.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  AppendActivityInputSchema,
  QUERY_ACTIVITY_DEFAULT_LIMIT,
  QUERY_ACTIVITY_MAX_LIMIT,
  QueryActivityInputSchema,
} from "../../../../src/mcp/wire/activity.ts";
import type { AppendActivityInput, QueryActivityInput } from "../../../../src/mcp/wire/activity.ts";

/*
 * Same `Assignable<>` lower-bound check pattern as in `tickets_test.ts`
 * — `satisfies` in the schema gives us the upper bound; this asserts
 * the lower bound without rejecting trivial `readonly` differences.
 */
type Assignable<From, To> = From extends To ? true : false;
type Expect<T extends true> = T;

type _AppendSchemaToInput = Expect<
  Assignable<z.infer<typeof AppendActivityInputSchema>, AppendActivityInput>
>;
type _QuerySchemaToInput = Expect<
  Assignable<z.infer<typeof QueryActivityInputSchema>, QueryActivityInput>
>;

Deno.test("AppendActivityInputSchema accepts the documented happy path", () => {
  const parsed = AppendActivityInputSchema.parse({
    session_id: "s1",
    event: "session_start",
    summary: "starting",
    refs: { ticket: "ticket-0001" },
  });
  assertEquals(parsed.session_id, "s1");
  assertEquals(parsed.event, "session_start");
});

Deno.test("AppendActivityInputSchema accepts the minimal happy path (no summary, no refs)", () => {
  const parsed = AppendActivityInputSchema.parse({ session_id: "s1", event: "summary" });
  assertEquals(parsed.session_id, "s1");
});

Deno.test("AppendActivityInputSchema rejects an attempt to override `agent`", () => {
  assertThrows(
    () =>
      (AppendActivityInputSchema as z.ZodType).parse({
        session_id: "s1",
        event: "summary",
        agent: "bob",
      }),
    z.ZodError,
  );
});

Deno.test("AppendActivityInputSchema rejects an attempt to override `role`", () => {
  assertThrows(
    () =>
      (AppendActivityInputSchema as z.ZodType).parse({
        session_id: "s1",
        event: "summary",
        role: "po",
      }),
    z.ZodError,
  );
});

Deno.test("AppendActivityInputSchema rejects an empty session_id", () => {
  assertThrows(
    () => AppendActivityInputSchema.parse({ session_id: "", event: "summary" }),
    z.ZodError,
  );
});

Deno.test("AppendActivityInputSchema rejects an empty event", () => {
  assertThrows(
    () => AppendActivityInputSchema.parse({ session_id: "s1", event: "" }),
    z.ZodError,
  );
});

Deno.test("AppendActivityInputSchema rejects a summary over 500 chars", () => {
  assertThrows(
    () =>
      AppendActivityInputSchema.parse({
        session_id: "s1",
        event: "summary",
        summary: "x".repeat(501),
      }),
    z.ZodError,
  );
});

Deno.test("QueryActivityInputSchema accepts an empty filter", () => {
  const parsed = QueryActivityInputSchema.parse({});
  assertEquals(parsed.limit, undefined);
});

Deno.test("QueryActivityInputSchema honours an explicit limit of 5", () => {
  const parsed = QueryActivityInputSchema.parse({ limit: 5 });
  assertEquals(parsed.limit, 5);
});

Deno.test("QueryActivityInputSchema rejects a limit above the hard ceiling (1001)", () => {
  assertThrows(() => QueryActivityInputSchema.parse({ limit: 1001 }), z.ZodError);
});

Deno.test("QueryActivityInputSchema rejects limit = 0", () => {
  assertThrows(() => QueryActivityInputSchema.parse({ limit: 0 }), z.ZodError);
});

Deno.test("QueryActivityInputSchema rejects a negative limit", () => {
  assertThrows(() => QueryActivityInputSchema.parse({ limit: -1 }), z.ZodError);
});

Deno.test("QueryActivityInputSchema rejects a non-integer limit", () => {
  assertThrows(() => QueryActivityInputSchema.parse({ limit: 1.5 }), z.ZodError);
});

Deno.test("QueryActivityInputSchema accepts the full filter set", () => {
  const parsed = QueryActivityInputSchema.parse({
    agent: "alice",
    role: "engineer",
    from: "2026-04-30T00:00:00Z",
    to: "2026-04-30T23:59:59Z",
    limit: 50,
  });
  assertEquals(parsed.agent, "alice");
  assertEquals(parsed.role, "engineer");
  assertEquals(parsed.limit, 50);
});

Deno.test("QueryActivityInputSchema rejects a malformed timestamp", () => {
  assertThrows(
    () => QueryActivityInputSchema.parse({ from: "yesterday" }),
    z.ZodError,
  );
});

Deno.test("QueryActivityInputSchema rejects unknown extra keys (`.strict`)", () => {
  assertThrows(
    () => QueryActivityInputSchema.parse({ rogueField: 1 }),
    z.ZodError,
  );
});

Deno.test("QUERY_ACTIVITY_DEFAULT_LIMIT and QUERY_ACTIVITY_MAX_LIMIT match the spec", () => {
  assertEquals(QUERY_ACTIVITY_DEFAULT_LIMIT, 200);
  assertEquals(QUERY_ACTIVITY_MAX_LIMIT, 1000);
});
