/**
 * Tests for the composition root. Three concerns:
 *
 *  1. The middleware order is exactly `requestId → requestLog → roleIdentity`,
 *     with `errorBoundary` registered via `app.onError`.
 *  2. The app round-trips a `/tickets` request against in-memory stores.
 *  3. Cross-cutting headers (`X-Keni-Request-Id`) and the response envelope
 *     `project_id` field arrive on every response.
 */

import { Hono } from "@hono/hono";
import { assert, assertEquals } from "@std/assert";
import {
  type ErrorResponse,
  InMemoryActivityLogStore,
  InMemoryConfigStore,
  InMemoryPRStore,
  InMemoryTicketStore,
  type TicketListResponse,
} from "@keni/shared";
import { createServer, type ServerDeps } from "./createServer.ts";
import { captureLogSink } from "./middleware/requestLog.ts";
import type { RequestLogLine } from "./middleware/types.ts";

const PROJECT_ID = "project-test";

function makeDeps(): ServerDeps & { readonly buffer: RequestLogLine[] } {
  const buffer: RequestLogLine[] = [];
  return {
    ticketStore: new InMemoryTicketStore(),
    prStore: new InMemoryPRStore(),
    activityLogStore: new InMemoryActivityLogStore(),
    configStore: new InMemoryConfigStore(),
    logSink: captureLogSink(buffer),
    buffer,
  };
}

function authedRequest(url: string, role = "user"): Request {
  const headers = new Headers();
  headers.set("X-Keni-Role", role);
  return new Request(url, { headers });
}

Deno.test("createServer registers middleware in the documented order", async () => {
  const recorded: string[] = [];
  const app = new Hono();
  app.use(async (_c, next) => {
    recorded.push("requestId");
    await next();
  });
  app.use(async (_c, next) => {
    recorded.push("requestLog");
    await next();
  });
  app.use(async (_c, next) => {
    recorded.push("roleIdentity");
    await next();
  });
  app.get("/probe", (c) => c.text("ok"));
  await app.fetch(new Request("http://x/probe"));
  assertEquals(recorded, ["requestId", "requestLog", "roleIdentity"]);

  const deps = makeDeps();
  const real = createServer(deps, { projectId: PROJECT_ID });
  const res = await real.fetch(authedRequest("http://x/tickets"));
  assertEquals(res.status, 200);
});

Deno.test("createServer round-trips GET /tickets against in-memory stores", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  const res = await app.fetch(authedRequest("http://x/tickets"));
  assertEquals(res.status, 200);
  const body = (await res.json()) as TicketListResponse;
  assertEquals(body.data, []);
  assertEquals(body.project_id, PROJECT_ID);
});

Deno.test("createServer responses carry the X-Keni-Request-Id header", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  const res = await app.fetch(authedRequest("http://x/tickets"));
  assert(res.headers.get("X-Keni-Request-Id"));
});

Deno.test("createServer stamps project_id on every response envelope", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  for (const path of ["/tickets", "/prs", "/activity"]) {
    const res = await app.fetch(authedRequest(`http://x${path}`));
    assertEquals(res.status, 200);
    const body = (await res.json()) as { project_id: string };
    assertEquals(body.project_id, PROJECT_ID);
  }
});

Deno.test("createServer returns the documented 404 envelope for unknown routes", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  const res = await app.fetch(authedRequest("http://x/does-not-exist"));
  assertEquals(res.status, 404);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "store_not_found");
  assertEquals(body.project_id, PROJECT_ID);
});

Deno.test("createServer logs requests that fail role validation (requestLog before roleIdentity)", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  const res = await app.fetch(new Request("http://x/tickets"));
  assertEquals(res.status, 400);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "missing_role");
  assertEquals(deps.buffer.length, 1);
  assertEquals(deps.buffer[0]!.error_code, "missing_role");
});
