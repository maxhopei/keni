/**
 * Integration tests for the `/tickets` route group, exercised via
 * `app.fetch(new Request(...))` against a real `FileTicketStore` rooted at
 * a `Deno.makeTempDir()`. Coverage matrix follows tasks 7.4 in `tasks.md`.
 */

import { Hono } from "@hono/hono";
import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  type EventFrame,
  FileTicketStore,
  resolveProjectPaths,
  type TicketEnvelope,
  type TicketListResponse,
  type TicketResponse,
} from "@keni/shared";
import { captureBusBuffer, createInMemoryEventBus, type EventBus } from "../../../src/eventBus.ts";
import { captureLogSink } from "../../../src/middleware/requestLog.ts";
import { errorBoundary } from "../../../src/middleware/errorBoundary.ts";
import { roleIdentity } from "../../../src/middleware/roleIdentity.ts";
import type { RequestLogLine, ServerVariables } from "../../../src/middleware/types.ts";
import { ticketsRoutes } from "../../../src/routes/tickets.ts";
import type { ErrorResponse } from "@keni/shared";

const PROJECT_ID = "project-test";
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TestContext {
  readonly app: Hono<{ Variables: ServerVariables }>;
  readonly store: FileTicketStore;
  readonly bus: EventBus;
  readonly buffer: EventFrame[];
  readonly logBuffer: RequestLogLine[];
  readonly cleanup: () => Promise<void>;
}

async function makeTestApp(): Promise<TestContext> {
  const root = await Deno.makeTempDir({ prefix: "keni-server-tickets-" });
  const paths = resolveProjectPaths(root);
  const store = new FileTicketStore(paths);
  const logBuffer: RequestLogLine[] = [];
  const bus = createInMemoryEventBus({ logSink: captureLogSink(logBuffer) });
  const { buffer, subscribe } = captureBusBuffer();
  subscribe(bus);
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(roleIdentity());
  app.onError(errorBoundary(PROJECT_ID));
  app.route("/tickets", ticketsRoutes(store, bus, PROJECT_ID));
  return {
    app,
    store,
    bus,
    buffer,
    logBuffer,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

function authedRequest(
  url: string,
  init: { method?: string; role?: string; agent?: string; body?: unknown } = {},
): Request {
  const headers = new Headers();
  headers.set("X-Keni-Role", init.role ?? "user");
  if (init.agent !== undefined) headers.set("X-Keni-Agent", init.agent);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

Deno.test("GET /tickets returns an empty list on a fresh project", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(authedRequest("http://x/tickets"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as TicketListResponse;
    assertEquals(body.data, []);
    assertEquals(body.project_id, PROJECT_ID);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /tickets?status=open,in_progress filters correctly", async () => {
  const ctx = await makeTestApp();
  try {
    const open = await ctx.store.create({ title: "open one", priority: 100 });
    const inProg = await ctx.store.create({ title: "engineer pick", priority: 50 });
    await ctx.store.transitionStatus(inProg.header.id, "open", "in_progress");
    const merged = await ctx.store.create({ title: "merged one", priority: 90 });
    await ctx.store.transitionStatus(merged.header.id, "open", "in_progress");
    await ctx.store.transitionStatus(merged.header.id, "in_progress", "ready_for_review");

    const res = await ctx.app.fetch(
      authedRequest("http://x/tickets?status=open,in_progress"),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as TicketListResponse;
    const ids = body.data.map((t) => t.id).sort();
    assertEquals(ids, [open.header.id, inProg.header.id].sort());
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /tickets/<missing> returns 404 store_not_found", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(authedRequest("http://x/tickets/ticket-9999"));
    assertEquals(res.status, 404);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "store_not_found");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets with X-Keni-Role: user returns 201 and persists to disk", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/tickets", {
        method: "POST",
        role: "user",
        body: { title: "first ticket", priority: 100 },
      }),
    );
    assertEquals(res.status, 201);
    const body = (await res.json()) as TicketEnvelope;
    assertEquals(body.data.title, "first ticket");
    assertEquals(body.data.status, "open");
    const onDisk = await ctx.store.read(body.data.id);
    assertEquals(onDisk.header.title, "first ticket");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets with X-Keni-Role: engineer returns 201", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/tickets", {
        method: "POST",
        role: "engineer",
        body: { title: "engineer-created", priority: 50 },
      }),
    );
    assertEquals(res.status, 201);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets with X-Keni-Role: po → 403 role_not_owner (prototype)", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/tickets", {
        method: "POST",
        role: "po",
        body: { title: "po-attempt", priority: 100 },
      }),
    );
    assertEquals(res.status, 403);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "role_not_owner");
    assertEquals((body.error.details as { role: string }).role, "po");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets with empty title → 400 validation_failed", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/tickets", {
        method: "POST",
        role: "user",
        body: { title: "", priority: 100 },
      }),
    );
    assertEquals(res.status, 400);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "validation_failed");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("PATCH /tickets/<id> applies header + body merge", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({
      title: "before",
      priority: 100,
      body: "old body",
    });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}`, {
        method: "PATCH",
        role: "user",
        body: { title: "after", body: "new body" },
      }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as TicketEnvelope;
    assertEquals(body.data.title, "after");
    assertEquals(body.data.body, "new body");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("PATCH /tickets/<id> with status field → 400 status_in_patch", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "x", priority: 100 });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}`, {
        method: "PATCH",
        role: "user",
        body: { status: "in_progress" },
      }),
    );
    assertEquals(res.status, 400);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "validation_failed");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets/<id>/transition — engineer happy path open → in_progress", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "x", priority: 100 });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}/transition`, {
        method: "POST",
        role: "engineer",
        body: { from: "open", to: "in_progress" },
      }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as TicketEnvelope;
    assertEquals(body.data.status, "in_progress");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets/<id>/transition — graph violation → 403 status_graph_violation", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "x", priority: 100 });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}/transition`, {
        method: "POST",
        role: "user",
        body: { from: "open", to: "merged" },
      }),
    );
    assertEquals(res.status, 403);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "status_graph_violation");
    assertEquals(body.error.details as { from: string; to: string }, {
      from: "open",
      to: "merged",
    });
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets/<id>/transition — engineer cannot set tested → 403 role_not_owner", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "x", priority: 100 });
    await ctx.store.transitionStatus(created.header.id, "open", "in_progress");
    await ctx.store.transitionStatus(created.header.id, "in_progress", "ready_for_review");
    await ctx.store.transitionStatus(created.header.id, "ready_for_review", "in_review");
    await ctx.store.transitionStatus(created.header.id, "in_review", "approved");
    await ctx.store.transitionStatus(created.header.id, "approved", "merged");
    await ctx.store.transitionStatus(created.header.id, "merged", "ready_for_test");
    await ctx.store.transitionStatus(created.header.id, "ready_for_test", "in_testing");
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}/transition`, {
        method: "POST",
        role: "engineer",
        body: { from: "in_testing", to: "tested" },
      }),
    );
    assertEquals(res.status, 403);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "role_not_owner");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets/<id>/transition — stale state → 409 stale_state", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "x", priority: 100 });
    await ctx.store.transitionStatus(created.header.id, "open", "in_progress");
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}/transition`, {
        method: "POST",
        role: "engineer",
        body: { from: "open", to: "in_progress" },
      }),
    );
    assertEquals(res.status, 409);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "stale_state");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets/<id>/transition — user override succeeds for any legal from→to", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "x", priority: 100 });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}/transition`, {
        method: "POST",
        role: "user",
        body: { from: "open", to: "in_progress" },
      }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as TicketEnvelope;
    assertEquals(body.data.status, "in_progress");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets/<id>/transition — user override is rejected for an illegal from→to", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "x", priority: 100 });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}/transition`, {
        method: "POST",
        role: "user",
        body: { from: "open", to: "done" },
      }),
    );
    assertEquals(res.status, 403);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "status_graph_violation");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /tickets returns wire shapes carrying the project_id envelope", async () => {
  const ctx = await makeTestApp();
  try {
    await ctx.store.create({ title: "x", priority: 100 });
    const res = await ctx.app.fetch(authedRequest("http://x/tickets"));
    const body = (await res.json()) as TicketListResponse;
    assertEquals(body.project_id, PROJECT_ID);
    assertEquals(body.data.length, 1);
    const item = body.data[0]! as TicketResponse;
    assert(typeof item.id === "string");
    assert(typeof item.title === "string");
    assert(typeof item.status === "string");
    assertEquals(typeof item.priority, "number");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /tickets?priorityMin=abc → 400 validation_failed", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/tickets?priorityMin=abc"),
    );
    assertEquals(res.status, 400);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "validation_failed");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets emits one ticket.created frame", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/tickets", {
        method: "POST",
        role: "user",
        body: { title: "first ticket", priority: 100 },
      }),
    );
    assertEquals(res.status, 201);
    const body = (await res.json()) as TicketEnvelope;
    assertEquals(ctx.buffer.length, 1);
    const frame = ctx.buffer[0]!;
    assertEquals(frame.event, "ticket.created");
    assertMatch(frame.id, UUIDV7_RE);
    assertEquals(frame.project_id, PROJECT_ID);
    assertMatch(frame.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assertEquals(frame.payload, { ticket_id: body.data.id, status: "open" });
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("PATCH /tickets/:id emits one ticket.updated with kind: patch", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "before", priority: 100 });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}`, {
        method: "PATCH",
        role: "user",
        body: { title: "after" },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(ctx.buffer.length, 1);
    const frame = ctx.buffer[0]!;
    assertEquals(frame.event, "ticket.updated");
    assertEquals(frame.payload, {
      ticket_id: created.header.id,
      status: "open",
      kind: "patch",
    });
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /tickets/:id/transition emits one ticket.updated with kind: transition", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "x", priority: 100 });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}/transition`, {
        method: "POST",
        role: "engineer",
        body: { from: "open", to: "in_progress" },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(ctx.buffer.length, 1);
    const frame = ctx.buffer[0]!;
    assertEquals(frame.event, "ticket.updated");
    assertEquals(frame.payload, {
      ticket_id: created.header.id,
      status: "in_progress",
      kind: "transition",
    });
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("a throwing subscriber does not affect the response (route still 201)", async () => {
  const ctx = await makeTestApp();
  ctx.bus.subscribe(() => {
    throw new Error("subscriber-kapow");
  });
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/tickets", {
        method: "POST",
        role: "user",
        body: { title: "still-ok", priority: 100 },
      }),
    );
    assertEquals(res.status, 201);
    assertEquals(ctx.buffer.length, 1);
    const subscriberFailureLines = ctx.logBuffer.filter((l) => l.path === "event_bus");
    assertEquals(subscriberFailureLines.length, 1);
    assert(
      subscriberFailureLines[0]!.error_code?.startsWith(
        "subscriber_failed:ticket.created:",
      ),
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("a failed transition (stale_state) does not emit any frame", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ title: "x", priority: 100 });
    await ctx.store.transitionStatus(created.header.id, "open", "in_progress");
    const res = await ctx.app.fetch(
      authedRequest(`http://x/tickets/${created.header.id}/transition`, {
        method: "POST",
        role: "engineer",
        body: { from: "open", to: "in_progress" },
      }),
    );
    assertEquals(res.status, 409);
    assertEquals(ctx.buffer.length, 0);
  } finally {
    await ctx.cleanup();
  }
});
