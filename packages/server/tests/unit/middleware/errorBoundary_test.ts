/**
 * Tests for the `errorBoundary` Hono `onError` handler. The handler is wired
 * with `app.onError(errorBoundary(projectId))` (this is the only supported
 * way in Hono v4 to translate handler-thrown exceptions into HTTP responses).
 */

import { Hono } from "@hono/hono";
import { assertEquals } from "@std/assert";
import { DuplicateIdError, type ErrorResponse, StoreNotFoundError } from "@keni/shared";
import { z } from "zod";
import { MissingRoleError } from "../../../src/errors.ts";
import { errorBoundary } from "../../../src/middleware/errorBoundary.ts";
import type { ServerVariables } from "../../../src/middleware/types.ts";

const PROJECT_ID = "project-test";

function makeApp(throwFn: () => unknown) {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(async (c, next) => {
    c.set("request_id", "req-1");
    await next();
  });
  app.onError(errorBoundary(PROJECT_ID));
  app.get("/x", () => {
    throw throwFn();
  });
  return app;
}

Deno.test("errorBoundary — StoreNotFoundError → 404 with the documented body", async () => {
  const app = makeApp(() => new StoreNotFoundError("ticket-0001"));
  const res = await app.fetch(new Request("http://x/x"));
  assertEquals(res.status, 404);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "store_not_found");
  assertEquals(body.project_id, PROJECT_ID);
});

Deno.test("errorBoundary — ZodError → 400 validation_failed", async () => {
  const app = makeApp(() => {
    try {
      z.object({ a: z.string() }).parse({ a: 1 });
      return new Error("unreachable");
    } catch (err) {
      return err;
    }
  });
  const res = await app.fetch(new Request("http://x/x"));
  assertEquals(res.status, 400);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "validation_failed");
});

Deno.test("errorBoundary — MissingRoleError → 400 missing_role", async () => {
  const app = makeApp(() => new MissingRoleError(undefined));
  const res = await app.fetch(new Request("http://x/x"));
  assertEquals(res.status, 400);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "missing_role");
});

Deno.test("errorBoundary — DuplicateIdError → 409 duplicate_id", async () => {
  const app = makeApp(() => new DuplicateIdError("ticket-0001"));
  const res = await app.fetch(new Request("http://x/x"));
  assertEquals(res.status, 409);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "duplicate_id");
});

Deno.test("errorBoundary — unknown Error → 500 with redacted message", async () => {
  const app = makeApp(() => new Error("don't leak this"));
  const res = await app.fetch(new Request("http://x/x"));
  assertEquals(res.status, 500);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "internal_error");
  assertEquals(body.error.message, "An unexpected error occurred");
});

Deno.test("errorBoundary — sets c.var.error_code so request-log can pick it up", async () => {
  let captured: string | undefined;
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(async (c, next) => {
    c.set("request_id", "req-1");
    await next();
    captured = c.var.error_code;
  });
  app.onError(errorBoundary(PROJECT_ID));
  app.get("/x", () => {
    throw new StoreNotFoundError("missing");
  });
  await app.fetch(new Request("http://x/x"));
  assertEquals(captured, "store_not_found");
});

Deno.test("errorBoundary — request id is echoed on the error response", async () => {
  const app = makeApp(() => new StoreNotFoundError("ticket-0001"));
  const res = await app.fetch(new Request("http://x/x"));
  assertEquals(res.headers.get("X-Keni-Request-Id"), "req-1");
});
