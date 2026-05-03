/**
 * Tests for `activity.ts` zod schema and query parser.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import type { ActivityAppendRequest, ActivityFilter } from "@keni/shared";
import { PR_MERGED_ACTIVITY_EVENT } from "@keni/shared";
import { ActivityAppendRequestSchema, parseActivityQuery } from "./activity.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true
  : false;
type Expect<T extends true> = T;

type _CheckAppend = Expect<
  Equal<z.infer<typeof ActivityAppendRequestSchema>, ActivityAppendRequest>
>;

Deno.test("ActivityAppendRequestSchema accepts the documented good example", () => {
  const parsed = ActivityAppendRequestSchema.parse({
    timestamp: "2026-05-01T10:00:00Z",
    session_id: "sess-1",
    agent: "alice",
    role: "engineer",
    event: "session_start",
    summary: "Started work on ticket-0001",
    refs: { ticket: "ticket-0001" },
  });
  assertEquals(parsed.session_id, "sess-1");
  assertEquals(parsed.refs?.ticket, "ticket-0001");
});

Deno.test("ActivityAppendRequestSchema accepts the minimal good example", () => {
  const parsed = ActivityAppendRequestSchema.parse({
    session_id: "sess-1",
    agent: "alice",
    role: "engineer",
    event: "idle",
  });
  assertEquals(parsed.session_id, "sess-1");
});

Deno.test("ActivityAppendRequestSchema rejects a malformed timestamp", () => {
  assertThrows(
    () =>
      ActivityAppendRequestSchema.parse({
        timestamp: "yesterday",
        session_id: "s",
        agent: "a",
        role: "r",
        event: "e",
      }),
    z.ZodError,
  );
});

Deno.test("ActivityAppendRequestSchema rejects a missing required field", () => {
  assertThrows(
    () =>
      ActivityAppendRequestSchema.parse({
        session_id: "s",
        agent: "a",
        role: "r",
      }),
    z.ZodError,
  );
});

Deno.test("parseActivityQuery handles the empty query string", () => {
  const filter: ActivityFilter = parseActivityQuery(new URLSearchParams());
  assertEquals(filter, {});
});

Deno.test("parseActivityQuery extracts the documented filters", () => {
  const filter = parseActivityQuery(
    new URLSearchParams({
      agent: "alice",
      role: "engineer",
      from: "2026-05-01T00:00:00Z",
      to: "2026-05-02T00:00:00Z",
    }),
  );
  assertEquals(filter, {
    agent: "alice",
    role: "engineer",
    from: "2026-05-01T00:00:00Z",
    to: "2026-05-02T00:00:00Z",
  });
});

Deno.test("parseActivityQuery ignores unknown keys", () => {
  const filter = parseActivityQuery(new URLSearchParams({ bogus: "value", agent: "alice" }));
  assertEquals(filter, { agent: "alice" });
});

Deno.test("parseActivityQuery throws ZodError on a malformed `from`", () => {
  assertThrows(
    () => parseActivityQuery(new URLSearchParams({ from: "yesterday" })),
    z.ZodError,
  );
});

Deno.test("PR_MERGED_ACTIVITY_EVENT is the literal `pr_merged`", () => {
  assertEquals(PR_MERGED_ACTIVITY_EVENT, "pr_merged");
});

Deno.test("ActivityAppendRequestSchema accepts a pr_merged entry shape", () => {
  const parsed = ActivityAppendRequestSchema.parse({
    session_id: "sess-merge",
    agent: "alice",
    role: "engineer",
    event: PR_MERGED_ACTIVITY_EVENT,
    summary: "Merged PR pr-0001 as 0123…",
    refs: {
      pr_id: "pr-0001",
      branch: "ticket-0001",
      merge_commit_sha: "0123456789abcdef0123456789abcdef01234567",
    },
  });
  assertEquals(parsed.event, "pr_merged");
});
