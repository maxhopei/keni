/**
 * Integration tests for the `/activity` route group, against a real
 * `FileActivityLogStore` rooted at a `Deno.makeTempDir()`. Exercises every
 * scenario in `spec.md` §5.4 plus the malformed-timestamp guard from
 * `parseActivityQuery`.
 */

import { Hono } from "@hono/hono";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  type ActivityEnvelope,
  type ActivityQueryResponse,
  type ErrorResponse,
  FileActivityLogStore,
  resolveProjectPaths,
} from "@keni/shared";
import { errorBoundary } from "../middleware/errorBoundary.ts";
import { roleIdentity } from "../middleware/roleIdentity.ts";
import type { ServerVariables } from "../middleware/types.ts";
import { activityRoutes } from "./activity.ts";

const PROJECT_ID = "project-test";
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TestContext {
  readonly app: Hono<{ Variables: ServerVariables }>;
  readonly store: FileActivityLogStore;
  readonly root: string;
  readonly cleanup: () => Promise<void>;
}

async function makeTestApp(): Promise<TestContext> {
  const root = await Deno.makeTempDir({ prefix: "keni-server-activity-" });
  const paths = resolveProjectPaths(root);
  const store = new FileActivityLogStore(paths);
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(roleIdentity());
  app.onError(errorBoundary(PROJECT_ID));
  app.route("/activity", activityRoutes(store, PROJECT_ID));
  return {
    app,
    store,
    root,
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

const VALID_APPEND_BODY = {
  session_id: "s1",
  agent: "alice",
  role: "engineer",
  event: "session_start",
  summary: "Start",
};

Deno.test("GET /activity on a fresh project returns an empty data array", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(authedRequest("http://x/activity"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as ActivityQueryResponse;
    assertEquals(body.data, []);
    assertEquals(body.project_id, PROJECT_ID);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /activity with a valid body returns 201 with uuidv7 id and writes JSONL", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/activity", {
        method: "POST",
        role: "engineer",
        body: VALID_APPEND_BODY,
      }),
    );
    assertEquals(res.status, 201);
    const body = (await res.json()) as ActivityEnvelope;
    assertMatch(body.data.id, UUIDV7_RE);
    assertMatch(body.data.timestamp, /^\d{4}-\d{2}-\d{2}T/);

    const utcDay = new Date(body.data.timestamp).toISOString().slice(0, 10);
    const onDisk = await Deno.readTextFile(
      join(resolveProjectPaths(ctx.root).activity, `${utcDay}.jsonl`),
    );
    const lines = onDisk.split("\n").filter((l) => l.length > 0);
    assertEquals(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { id: string; agent: string; event: string };
    assertEquals(parsed.id, body.data.id);
    assertEquals(parsed.agent, "alice");
    assertEquals(parsed.event, "session_start");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /activity?agent=alice returns only alice's entries in id order", async () => {
  const ctx = await makeTestApp();
  try {
    const a1 = await ctx.store.append({
      session_id: "s1",
      agent: "alice",
      role: "engineer",
      event: "session_start",
    });
    await ctx.store.append({
      session_id: "s1",
      agent: "bob",
      role: "qa",
      event: "session_start",
    });
    const a2 = await ctx.store.append({
      session_id: "s1",
      agent: "alice",
      role: "engineer",
      event: "session_end",
    });

    const res = await ctx.app.fetch(authedRequest("http://x/activity?agent=alice"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as ActivityQueryResponse;
    assertEquals(body.data.length, 2);
    assertEquals(body.data[0]!.id, a1.id);
    assertEquals(body.data[1]!.id, a2.id);
    assert(a1.id < a2.id, "uuidv7 ids must sort chronologically");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /activity?role=qa filters by role", async () => {
  const ctx = await makeTestApp();
  try {
    await ctx.store.append({
      session_id: "s1",
      agent: "alice",
      role: "engineer",
      event: "session_start",
    });
    await ctx.store.append({
      session_id: "s1",
      agent: "bob",
      role: "qa",
      event: "session_start",
    });

    const res = await ctx.app.fetch(authedRequest("http://x/activity?role=qa"));
    const body = (await res.json()) as ActivityQueryResponse;
    assertEquals(body.data.length, 1);
    assertEquals(body.data[0]!.role, "qa");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /activity?from=...&to=... filters by inclusive timestamp range", async () => {
  const ctx = await makeTestApp();
  try {
    await ctx.store.append({
      timestamp: "2026-04-29T10:00:00Z",
      session_id: "s1",
      agent: "alice",
      role: "engineer",
      event: "session_start",
    });
    await ctx.store.append({
      timestamp: "2026-04-30T10:00:00Z",
      session_id: "s1",
      agent: "alice",
      role: "engineer",
      event: "session_end",
    });
    await ctx.store.append({
      timestamp: "2026-05-01T10:00:00Z",
      session_id: "s2",
      agent: "alice",
      role: "engineer",
      event: "session_start",
    });

    const res = await ctx.app.fetch(
      authedRequest(
        "http://x/activity?from=2026-04-30T00:00:00Z&to=2026-04-30T23:59:59Z",
      ),
    );
    const body = (await res.json()) as ActivityQueryResponse;
    assertEquals(body.data.length, 1);
    assertEquals(body.data[0]!.event, "session_end");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /activity with an oversized body → 422 invalid_artifact size_exceeded", async () => {
  const ctx = await makeTestApp();
  try {
    const oversized = {
      ...VALID_APPEND_BODY,
      summary: "X".repeat(5000),
    };
    const res = await ctx.app.fetch(
      authedRequest("http://x/activity", {
        method: "POST",
        role: "engineer",
        body: oversized,
      }),
    );
    assertEquals(res.status, 422);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "invalid_artifact");
    assertEquals(
      (body.error.details as { reason: string } | undefined)?.reason,
      "size_exceeded",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("GET /activity?from=garbage → 400 validation_failed", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(authedRequest("http://x/activity?from=not-a-date"));
    assertEquals(res.status, 400);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "validation_failed");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("POST /activity with an unknown body field → 400 validation_failed (strict schema)", async () => {
  const ctx = await makeTestApp();
  try {
    const res = await ctx.app.fetch(
      authedRequest("http://x/activity", {
        method: "POST",
        role: "engineer",
        body: { ...VALID_APPEND_BODY, surprise: "rejected" },
      }),
    );
    assertEquals(res.status, 400);
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "validation_failed");
  } finally {
    await ctx.cleanup();
  }
});
