/**
 * Tests for `agents.ts` zod schemas. Mirrors `tickets_test.ts`'s pattern
 * (`Expect<Equal<…>>` lower-bound assertion plus a small per-shape good /
 * bad matrix).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { AGENT_STATUSES, type AgentResponse } from "@keni/shared";
import { AgentResponseSchema, AgentStatusSchema } from "./agents.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true
  : false;
type Expect<T extends true> = T;

type _CheckAgentResponse = Expect<
  Equal<z.infer<typeof AgentResponseSchema>, AgentResponse>
>;

Deno.test("AgentStatusSchema accepts the documented values", () => {
  assertEquals(AgentStatusSchema.parse("idle"), "idle");
  assertEquals(AgentStatusSchema.parse("running"), "running");
});

Deno.test("AgentStatusSchema rejects an unknown literal", () => {
  assertThrows(() => AgentStatusSchema.parse("blocked"), z.ZodError);
});

Deno.test("AgentResponseSchema accepts the documented good example", () => {
  const parsed = AgentResponseSchema.parse({
    id: "alice",
    role: "engineer",
    status: "running",
    last_activity: "session_start",
    last_active_at: "2026-05-01T10:00:00.000Z",
    paused: false,
  });
  assertEquals(parsed.id, "alice");
  assertEquals(parsed.status, "running");
  assertEquals(parsed.paused, false);
});

Deno.test("AgentResponseSchema accepts a freshly-seeded row (null last_*)", () => {
  const parsed = AgentResponseSchema.parse({
    id: "alice",
    role: "engineer",
    status: "idle",
    last_activity: null,
    last_active_at: null,
    paused: false,
  });
  assertEquals(parsed.last_activity, null);
  assertEquals(parsed.last_active_at, null);
});

Deno.test("AgentResponseSchema rejects a missing paused flag", () => {
  assertThrows(
    () =>
      AgentResponseSchema.parse({
        id: "alice",
        role: "engineer",
        status: "idle",
        last_activity: null,
        last_active_at: null,
      }),
    z.ZodError,
  );
});

Deno.test("AgentResponseSchema rejects an unknown status literal", () => {
  assertThrows(
    () =>
      AgentResponseSchema.parse({
        id: "alice",
        role: "engineer",
        status: "blocked",
        last_activity: null,
        last_active_at: null,
        paused: false,
      }),
    z.ZodError,
  );
});

Deno.test("AgentResponseSchema rejects unknown extra fields (.strict())", () => {
  assertThrows(
    () =>
      AgentResponseSchema.parse({
        id: "alice",
        role: "engineer",
        status: "idle",
        last_activity: null,
        last_active_at: null,
        paused: false,
        surprise: "rejected",
      }),
    z.ZodError,
  );
});

Deno.test("AGENT_STATUSES enumerates the closed status set in order", () => {
  assertEquals(AGENT_STATUSES, ["idle", "running"]);
});
