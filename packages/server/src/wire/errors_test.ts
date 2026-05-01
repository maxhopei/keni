/**
 * Tests for `errors.ts` — `ErrorResponseSchema`. Used by integration tests
 * to assert response shape; never by handlers.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import type { ErrorResponse } from "@keni/shared";
import { ErrorResponseSchema } from "./errors.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true
  : false;
type Expect<T extends true> = T;

type _Check = Expect<Equal<z.infer<typeof ErrorResponseSchema>, ErrorResponse>>;

Deno.test("ErrorResponseSchema accepts the minimal envelope", () => {
  const parsed = ErrorResponseSchema.parse({
    error: { code: "store_not_found", message: "Ticket ticket-0001 not found" },
  });
  assertEquals(parsed.error.code, "store_not_found");
});

Deno.test("ErrorResponseSchema accepts the full envelope with details and project_id", () => {
  const parsed = ErrorResponseSchema.parse({
    error: {
      code: "stale_state",
      message: "Status changed under us",
      details: { expected: "open", actual: "in_progress" },
    },
    project_id: "project-xyz",
  });
  assertEquals(parsed.error.code, "stale_state");
  assertEquals(parsed.project_id, "project-xyz");
});

Deno.test("ErrorResponseSchema rejects an unknown error code", () => {
  assertThrows(
    () => ErrorResponseSchema.parse({ error: { code: "bogus", message: "x" } }),
    z.ZodError,
  );
});

Deno.test("ErrorResponseSchema rejects a missing message", () => {
  assertThrows(
    () => ErrorResponseSchema.parse({ error: { code: "internal_error" } }),
    z.ZodError,
  );
});
