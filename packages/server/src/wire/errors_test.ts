/**
 * Tests for `errors.ts` — `ErrorResponseSchema`. Used by integration tests
 * to assert response shape; never by handlers.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { ERROR_CODES, type ErrorResponse, isErrorCode } from "@keni/shared";
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

Deno.test("ERROR_CODES exposes `merge_conflict` and the closed enum stays exhaustive", () => {
  assertEquals(ERROR_CODES.includes("merge_conflict"), true);
  assertEquals(isErrorCode("merge_conflict"), true);
  assertEquals(isErrorCode("not_a_real_code"), false);
});

Deno.test("ErrorResponseSchema accepts the merge_conflict envelope shape", () => {
  const parsed = ErrorResponseSchema.parse({
    error: {
      code: "merge_conflict",
      message: "Branch is not a fast-forward of main",
      details: {
        branch: "ticket-0001",
        base: "main",
        git_stderr: "fatal: Not possible to fast-forward, aborting.",
      },
    },
    project_id: "11111111-1111-1111-1111-111111111111",
  });
  assertEquals(parsed.error.code, "merge_conflict");
  assertEquals(parsed.error.details?.branch, "ticket-0001");
});
