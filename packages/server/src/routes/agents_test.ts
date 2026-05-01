/**
 * Integration tests for the `/agents` route group — exercised via
 * `app.fetch(new Request(...))` against the real
 * `createInMemoryAgentRuntimeStateStore`. Coverage matrix mirrors
 * `tickets_test.ts` (happy-path, role-refusal, idempotence, not-found).
 */

import { Hono } from "@hono/hono";
import { assertEquals } from "@std/assert";
import type {
  AgentConfig,
  AgentEnvelope,
  AgentListResponse,
  ErrorResponse,
  EventFrame,
} from "@keni/shared";
import {
  type AgentRuntimeStateStore,
  createInMemoryAgentRuntimeStateStore,
} from "../agentState.ts";
import { captureBusBuffer, createInMemoryEventBus } from "../eventBus.ts";
import { errorBoundary } from "../middleware/errorBoundary.ts";
import { roleIdentity } from "../middleware/roleIdentity.ts";
import type { ServerVariables } from "../middleware/types.ts";
import { agentsRoutes } from "./agents.ts";

const PROJECT_ID = "project-test";

interface TestContext {
  readonly app: Hono<{ Variables: ServerVariables }>;
  readonly store: AgentRuntimeStateStore;
  readonly buffer: EventFrame[];
}

function makeTestApp(roster: readonly AgentConfig[] = []): TestContext {
  const store = createInMemoryAgentRuntimeStateStore(roster);
  const bus = createInMemoryEventBus();
  const { buffer, subscribe } = captureBusBuffer();
  subscribe(bus);
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(roleIdentity());
  app.onError(errorBoundary(PROJECT_ID));
  app.route("/agents", agentsRoutes(store, bus, PROJECT_ID));
  return { app, store, buffer };
}

function authedRequest(
  url: string,
  init: { method?: string; role?: string; body?: unknown } = {},
): Request {
  const headers = new Headers();
  headers.set("X-Keni-Role", init.role ?? "user");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const ROSTER: readonly AgentConfig[] = [
  { id: "alice", role: "engineer" },
  { id: "qa-bob", role: "qa" },
];

Deno.test("GET /agents on an empty roster returns { data: [] }", async () => {
  const ctx = makeTestApp([]);
  const res = await ctx.app.fetch(authedRequest("http://x/agents"));
  assertEquals(res.status, 200);
  const body = (await res.json()) as AgentListResponse;
  assertEquals(body.data, []);
  assertEquals(body.project_id, PROJECT_ID);
});

Deno.test("GET /agents returns the seeded roster in order with default fields", async () => {
  const ctx = makeTestApp(ROSTER);
  const res = await ctx.app.fetch(authedRequest("http://x/agents"));
  assertEquals(res.status, 200);
  const body = (await res.json()) as AgentListResponse;
  assertEquals(body.data.length, 2);
  assertEquals(body.data[0]!.id, "alice");
  assertEquals(body.data[0]!.role, "engineer");
  assertEquals(body.data[0]!.status, "idle");
  assertEquals(body.data[0]!.paused, false);
  assertEquals(body.data[0]!.last_activity, null);
  assertEquals(body.data[0]!.last_active_at, null);
  assertEquals(body.data[1]!.id, "qa-bob");
});

Deno.test("GET /agents reflects runtime updates from applyActivityEvent", async () => {
  const ctx = makeTestApp(ROSTER);
  ctx.store.applyActivityEvent({
    id: "01900000-0000-7000-8000-000000000001",
    timestamp: "2026-05-01T10:00:00.000Z",
    session_id: "s1",
    agent: "alice",
    role: "engineer",
    event: "session_start",
    summary: null,
    refs: {},
  });
  const res = await ctx.app.fetch(authedRequest("http://x/agents"));
  const body = (await res.json()) as AgentListResponse;
  const alice = body.data.find((a) => a.id === "alice")!;
  assertEquals(alice.status, "running");
  assertEquals(alice.last_activity, "session_start");
  assertEquals(alice.last_active_at, "2026-05-01T10:00:00.000Z");
});

Deno.test("GET /agents accepts every documented role (engineer, qa, po, writer)", async () => {
  const ctx = makeTestApp(ROSTER);
  for (const role of ["engineer", "qa", "po", "writer"]) {
    const res = await ctx.app.fetch(authedRequest("http://x/agents", { role }));
    assertEquals(res.status, 200, `role=${role} should be authorised to read /agents`);
  }
});

Deno.test("POST /agents/:id/pause as user → 200, paused: true, one agent.state_changed", async () => {
  const ctx = makeTestApp(ROSTER);
  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/pause", { method: "POST", role: "user" }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as AgentEnvelope;
  assertEquals(body.data.id, "alice");
  assertEquals(body.data.paused, true);
  assertEquals(ctx.buffer.length, 1);
  const frame = ctx.buffer[0]!;
  assertEquals(frame.event, "agent.state_changed");
  assertEquals(frame.payload, { agent_id: "alice", paused: true, status: "idle" });
});

Deno.test("POST /agents/:id/pause is idempotent — second call emits no extra frame", async () => {
  const ctx = makeTestApp(ROSTER);
  const a = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/pause", { method: "POST", role: "user" }),
  );
  assertEquals(a.status, 200);
  const b = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/pause", { method: "POST", role: "user" }),
  );
  assertEquals(b.status, 200);
  const bodyB = (await b.json()) as AgentEnvelope;
  assertEquals(bodyB.data.paused, true);
  assertEquals(ctx.buffer.length, 1, "exactly one frame across two pause calls");
});

Deno.test("POST /agents/:id/resume on already-running agent is a no-op success", async () => {
  const ctx = makeTestApp(ROSTER);
  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/resume", { method: "POST", role: "user" }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as AgentEnvelope;
  assertEquals(body.data.paused, false);
  assertEquals(ctx.buffer.length, 0, "no agent.state_changed frame for a no-op resume");
});

Deno.test("POST /agents/:id/pause as engineer → 403 role_not_owner", async () => {
  const ctx = makeTestApp(ROSTER);
  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/pause", { method: "POST", role: "engineer" }),
  );
  assertEquals(res.status, 403);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "role_not_owner");
  assertEquals(
    (body.error.details as { role: string; target: string }).target,
    "pause_agent",
  );
  assertEquals(ctx.store.read("alice").paused, false);
});

Deno.test("POST /agents/:id/pause as qa, po, writer all → 403", async () => {
  const ctx = makeTestApp(ROSTER);
  for (const role of ["qa", "po", "writer"]) {
    const res = await ctx.app.fetch(
      authedRequest("http://x/agents/alice/pause", { method: "POST", role }),
    );
    assertEquals(res.status, 403, `role=${role} should be rejected`);
  }
});

Deno.test("POST /agents/:id/pause for unknown id → 404 store_not_found", async () => {
  const ctx = makeTestApp(ROSTER);
  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/ghost/pause", { method: "POST", role: "user" }),
  );
  assertEquals(res.status, 404);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "store_not_found");
});

Deno.test("Pause then resume flips the flag back and emits two frames", async () => {
  const ctx = makeTestApp(ROSTER);
  await ctx.app.fetch(
    authedRequest("http://x/agents/alice/pause", { method: "POST", role: "user" }),
  );
  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/resume", { method: "POST", role: "user" }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as AgentEnvelope;
  assertEquals(body.data.paused, false);
  assertEquals(ctx.buffer.length, 2);
  assertEquals(ctx.buffer[0]!.event, "agent.state_changed");
  assertEquals(ctx.buffer[1]!.event, "agent.state_changed");
  if (ctx.buffer[0]!.event === "agent.state_changed") {
    assertEquals(ctx.buffer[0]!.payload.paused, true);
  }
  if (ctx.buffer[1]!.event === "agent.state_changed") {
    assertEquals(ctx.buffer[1]!.payload.paused, false);
  }
});
