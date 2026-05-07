/**
 * Tests for `requestId` middleware.
 */

import { Hono } from "@hono/hono";
import { assert, assertEquals } from "@std/assert";
import { REQUEST_ID_UUIDV4_REGEX, requestId } from "../../../src/middleware/requestId.ts";
import type { ServerVariables } from "../../../src/middleware/types.ts";

function makeApp() {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(requestId());
  app.get("/", (c) => c.json({ id: c.var.request_id }));
  return app;
}

Deno.test("requestId — server-assigned id is a UUIDv4", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://x/"));
  const id = res.headers.get("X-Keni-Request-Id");
  assert(id !== null, "X-Keni-Request-Id header must be present");
  assert(REQUEST_ID_UUIDV4_REGEX.test(id), `id ${id} should match uuidv4`);
});

Deno.test("requestId — caller-supplied id is honoured verbatim", async () => {
  const app = makeApp();
  const res = await app.fetch(
    new Request("http://x/", { headers: { "X-Keni-Request-Id": "abc-123" } }),
  );
  assertEquals(res.headers.get("X-Keni-Request-Id"), "abc-123");
});

Deno.test("requestId — id round-trips on the response body", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://x/"));
  const headerId = res.headers.get("X-Keni-Request-Id");
  const body = (await res.json()) as { id: string };
  assertEquals(body.id, headerId);
});

Deno.test("requestId — c.var.request_id is populated for downstream handlers", async () => {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(requestId());
  let captured: string | undefined;
  app.get("/", (c) => {
    captured = c.var.request_id;
    return c.text("ok");
  });
  await app.fetch(new Request("http://x/"));
  assert(captured !== undefined && captured.length > 0);
});
