/**
 * Integration tests for the `/prs` route group, exercised via
 * `app.fetch(new Request(...))` against a real `FilePRStore` rooted at
 * a `Deno.makeTempDir()`. Coverage matrix follows tasks 8.3 in `tasks.md`.
 */

import { Hono } from "@hono/hono";
import { assertEquals, assertMatch } from "@std/assert";
import {
  type ErrorResponse,
  type EventFrame,
  FilePRStore,
  type PREnvelope,
  type PRListResponse,
  resolveProjectPaths,
} from "@keni/shared";
import { captureBusBuffer, createInMemoryEventBus } from "../eventBus.ts";
import { errorBoundary } from "../middleware/errorBoundary.ts";
import { roleIdentity } from "../middleware/roleIdentity.ts";
import type { ServerVariables } from "../middleware/types.ts";
import { prsRoutes } from "./prs.ts";

const PROJECT_ID = "project-test";
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TestContext {
  readonly app: Hono<{ Variables: ServerVariables }>;
  readonly store: FilePRStore;
  readonly buffer: EventFrame[];
  readonly cleanup: () => Promise<void>;
}

async function makeTestApp(): Promise<TestContext> {
  const root = await Deno.makeTempDir({ prefix: "keni-server-prs-" });
  const paths = resolveProjectPaths(root);
  const store = new FilePRStore(paths);
  const bus = createInMemoryEventBus();
  const { buffer, subscribe } = captureBusBuffer();
  subscribe(bus);
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(roleIdentity());
  app.onError(errorBoundary(PROJECT_ID));
  app.route("/prs", prsRoutes(store, bus, PROJECT_ID));
  return {
    app,
    store,
    buffer,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

function authedRequest(
  url: string,
  init: { method?: string; role?: string; body?: unknown } = {},
): Request {
  const headers = new Headers();
  headers.set("X-Keni-Role", init.role ?? "engineer");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const VALID_PR_INPUT = {
  title: "OAuth login",
  ticket: "ticket-0001",
  branch: "engineer/oauth-login",
  author: "alice",
};

Deno.test("GET /prs returns an empty list on a fresh project", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(authedRequest("http://x/prs"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as PRListResponse;
    assertEquals(body.data, []);
    assertEquals(body.project_id, PROJECT_ID);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /prs/<missing> → 404 store_not_found", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(authedRequest("http://x/prs/pr-9999"));
    assertEquals(res.status, 404);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "store_not_found");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs with engineer → 201 and on-disk file", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/prs", {
        method: "POST",
        role: "engineer",
        body: VALID_PR_INPUT,
      }),
    );
    assertEquals(res.status, 201);
    const body = (await res.json()) as PREnvelope;
    assertEquals(body.data.title, "OAuth login");
    assertEquals(body.data.status, "open");
    const onDisk = await ctx.store.read(body.data.id);
    assertEquals(onDisk.header.author, "alice");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs with user → 201 (override path)", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/prs", { method: "POST", role: "user", body: VALID_PR_INPUT }),
    );
    assertEquals(res.status, 201);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs with qa → 403 role_not_owner", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/prs", { method: "POST", role: "qa", body: VALID_PR_INPUT }),
    );
    assertEquals(res.status, 403);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "role_not_owner");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("PATCH /prs/<id>/intent updates the body", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ ...VALID_PR_INPUT, body: "before" });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/prs/${created.header.id}/intent`, {
        method: "PATCH",
        role: "engineer",
        body: { intent: "after" },
      }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as PREnvelope;
    assertEquals(body.data.body, "after");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs/<id>/transition — engineer happy path open → in_review", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create(VALID_PR_INPUT);
    const res = await ctx.app.fetch(
      authedRequest(`http://x/prs/${created.header.id}/transition`, {
        method: "POST",
        role: "engineer",
        body: { from: "open", to: "in_review" },
      }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as PREnvelope;
    assertEquals(body.data.status, "in_review");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs/<id>/transition — qa transition → 403 role_not_owner", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create(VALID_PR_INPUT);
    const res = await ctx.app.fetch(
      authedRequest(`http://x/prs/${created.header.id}/transition`, {
        method: "POST",
        role: "qa",
        body: { from: "open", to: "in_review" },
      }),
    );
    assertEquals(res.status, 403);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "role_not_owner");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs/<id>/transition — user override succeeds for legal transitions", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create(VALID_PR_INPUT);
    const res = await ctx.app.fetch(
      authedRequest(`http://x/prs/${created.header.id}/transition`, {
        method: "POST",
        role: "user",
        body: { from: "open", to: "in_review" },
      }),
    );
    assertEquals(res.status, 200);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs/<id>/transition — graph violation → 403 status_graph_violation", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create(VALID_PR_INPUT);
    const res = await ctx.app.fetch(
      authedRequest(`http://x/prs/${created.header.id}/transition`, {
        method: "POST",
        role: "user",
        body: { from: "open", to: "merged" },
      }),
    );
    assertEquals(res.status, 403);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "status_graph_violation");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs/<id>/transition — stale state → 409 stale_state", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create(VALID_PR_INPUT);
    await ctx.store.updateStatus(created.header.id, "open", "in_review");
    const res = await ctx.app.fetch(
      authedRequest(`http://x/prs/${created.header.id}/transition`, {
        method: "POST",
        role: "engineer",
        body: { from: "open", to: "in_review" },
      }),
    );
    assertEquals(res.status, 409);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "stale_state");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /prs?ticket=ticket-0001&status=open filters", async () => {
  const ctx = await makeTestApp();
  try {
    await ctx.store.create({ ...VALID_PR_INPUT, ticket: "ticket-0001" });
    const second = await ctx.store.create({
      ...VALID_PR_INPUT,
      title: "second",
      ticket: "ticket-0002",
    });
    await ctx.store.updateStatus(second.header.id, "open", "in_review");

    const res = await ctx.app.fetch(
      authedRequest("http://x/prs?ticket=ticket-0001"),
    );
    const body = (await res.json()) as PRListResponse;
    assertEquals(body.data.length, 1);
    assertEquals(body.data[0]!.ticket, "ticket-0001");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs emits one pr.created frame", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/prs", {
        method: "POST",
        role: "engineer",
        body: VALID_PR_INPUT,
      }),
    );
    assertEquals(res.status, 201);
    const body = (await res.json()) as PREnvelope;
    assertEquals(ctx.buffer.length, 1);
    const frame = ctx.buffer[0]!;
    assertEquals(frame.event, "pr.created");
    assertMatch(frame.id, UUIDV7_RE);
    assertEquals(frame.project_id, PROJECT_ID);
    assertEquals(frame.payload, {
      pr_id: body.data.id,
      status: "open",
      ticket: VALID_PR_INPUT.ticket,
    });
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("PATCH /prs/:id/intent emits one pr.updated with kind: intent", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create({ ...VALID_PR_INPUT, body: "before" });
    const res = await ctx.app.fetch(
      authedRequest(`http://x/prs/${created.header.id}/intent`, {
        method: "PATCH",
        role: "engineer",
        body: { intent: "after" },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(ctx.buffer.length, 1);
    const frame = ctx.buffer[0]!;
    assertEquals(frame.event, "pr.updated");
    assertEquals(frame.payload, {
      pr_id: created.header.id,
      status: "open",
      kind: "intent",
    });
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /prs/:id/transition emits one pr.updated with kind: transition", async () => {
  const ctx = await makeTestApp();
  try {
    const created = await ctx.store.create(VALID_PR_INPUT);
    const res = await ctx.app.fetch(
      authedRequest(`http://x/prs/${created.header.id}/transition`, {
        method: "POST",
        role: "engineer",
        body: { from: "open", to: "in_review" },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(ctx.buffer.length, 1);
    const frame = ctx.buffer[0]!;
    assertEquals(frame.event, "pr.updated");
    assertEquals(frame.payload, {
      pr_id: created.header.id,
      status: "in_review",
      kind: "transition",
    });
  } finally {
    await ctx.cleanup();
  }
});
