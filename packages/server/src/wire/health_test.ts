/**
 * Tests for `health.ts` zod schemas. Mirrors `agents_test.ts`'s pattern
 * (`Expect<Equal<…>>` lower-bound assertion plus a small good / bad matrix).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import type { HealthResponse } from "@keni/shared";
import { HealthResponseSchema } from "./health.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true
  : false;
type Expect<T extends true> = T;

type _CheckHealthResponse = Expect<
  Equal<z.infer<typeof HealthResponseSchema>, HealthResponse>
>;

Deno.test("HealthResponseSchema accepts the documented good example", () => {
  const parsed = HealthResponseSchema.parse({
    status: "ok",
    project_id: "a3f5b1c7-1234-4abc-9def-0123456789ab",
    uptime_ms: 1234,
    version: "0.0.0-prototype",
  });
  assertEquals(parsed.status, "ok");
  assertEquals(parsed.uptime_ms, 1234);
});

Deno.test("HealthResponseSchema accepts uptime_ms === 0 (server-just-bound case)", () => {
  const parsed = HealthResponseSchema.parse({
    status: "ok",
    project_id: "a3f5b1c7-1234-4abc-9def-0123456789ab",
    uptime_ms: 0,
    version: "0.0.0-prototype",
  });
  assertEquals(parsed.uptime_ms, 0);
});

Deno.test("HealthResponseSchema rejects a non-'ok' status", () => {
  assertThrows(
    () =>
      HealthResponseSchema.parse({
        status: "degraded",
        project_id: "a3f5b1c7-1234-4abc-9def-0123456789ab",
        uptime_ms: 0,
        version: "0.0.0-prototype",
      }),
    z.ZodError,
  );
});

Deno.test("HealthResponseSchema rejects a negative uptime_ms", () => {
  assertThrows(
    () =>
      HealthResponseSchema.parse({
        status: "ok",
        project_id: "a3f5b1c7-1234-4abc-9def-0123456789ab",
        uptime_ms: -1,
        version: "0.0.0-prototype",
      }),
    z.ZodError,
  );
});

Deno.test("HealthResponseSchema rejects unknown extra fields (.strict())", () => {
  assertThrows(
    () =>
      HealthResponseSchema.parse({
        status: "ok",
        project_id: "a3f5b1c7-1234-4abc-9def-0123456789ab",
        uptime_ms: 0,
        version: "0.0.0-prototype",
        surprise: "rejected",
      }),
    z.ZodError,
  );
});

Deno.test("HealthResponseSchema rejects an empty project_id", () => {
  assertThrows(
    () =>
      HealthResponseSchema.parse({
        status: "ok",
        project_id: "",
        uptime_ms: 0,
        version: "0.0.0-prototype",
      }),
    z.ZodError,
  );
});
