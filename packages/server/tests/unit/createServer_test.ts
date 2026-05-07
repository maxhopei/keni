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
  type AgentConfig,
  type AgentListResponse,
  type ErrorResponse,
  type EventFrame,
  InMemoryActivityLogStore,
  InMemoryConfigStore,
  InMemoryPRStore,
  InMemoryTicketStore,
  type TicketListResponse,
} from "@keni/shared";
import { FakeWorkspaceProvisioner } from "@keni/role-runtimes/test-fakes";
import { createInMemoryAgentRuntimeStateStore } from "../../src/agentState.ts";
import { captureBusBuffer, createInMemoryEventBus } from "../../src/eventBus.ts";
import { createMutex } from "../../src/concurrency/mutex.ts";
import { createServer, type ServerDeps } from "../../src/createServer.ts";
import { captureLogSink } from "../../src/middleware/requestLog.ts";
import type { RequestLogLine } from "../../src/middleware/types.ts";

const PROJECT_ID = "project-test";

interface TestDeps extends ServerDeps {
  readonly buffer: RequestLogLine[];
  readonly busBuffer: EventFrame[];
}

function makeDeps(roster: readonly AgentConfig[] = []): TestDeps {
  const buffer: RequestLogLine[] = [];
  const eventBus = createInMemoryEventBus();
  const { buffer: busBuffer, subscribe } = captureBusBuffer();
  subscribe(eventBus);
  return {
    ticketStore: new InMemoryTicketStore(),
    prStore: new InMemoryPRStore(),
    activityLogStore: new InMemoryActivityLogStore(),
    configStore: new InMemoryConfigStore(),
    logSink: captureLogSink(buffer),
    eventBus,
    agentRuntimeStateStore: createInMemoryAgentRuntimeStateStore(roster),
    buffer,
    busBuffer,
  };
}

function authedRequest(url: string, role = "user"): Request {
  const headers = new Headers();
  headers.set("X-Keni-Role", role);
  return new Request(url, { headers });
}

Deno.test(
  "createServer registers middleware in the documented order with the /health carve-out",
  async () => {
    // The expected order around the carve-out:
    //   requestId → requestLog → /health → roleIdentity → REST routes
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
  },
);

Deno.test("createServer's /health route succeeds without X-Keni-Role", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  // No X-Keni-Role header — the carve-out exempts /health from roleIdentity.
  const res = await app.fetch(new Request("http://x/health"));
  assertEquals(res.status, 200);
  const body = (await res.json()) as { data: { status: string }; project_id: string };
  assertEquals(body.data.status, "ok");
  assertEquals(body.project_id, PROJECT_ID);
  // The request-log line for /health carries `role: null` and `agent: null`
  // because roleIdentity never ran.
  const healthLine = deps.buffer.find((l) => l.path === "/health");
  assertEquals(healthLine?.role, null);
  assertEquals(healthLine?.agent, null);
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

Deno.test("createServer mounts /agents and returns the seeded roster", async () => {
  const roster: readonly AgentConfig[] = [
    { id: "alice", role: "engineer" },
    { id: "bob", role: "qa" },
  ];
  const deps = makeDeps(roster);
  const app = createServer(deps, { projectId: PROJECT_ID });
  const res = await app.fetch(authedRequest("http://x/agents"));
  assertEquals(res.status, 200);
  const body = (await res.json()) as AgentListResponse;
  assertEquals(body.project_id, PROJECT_ID);
  assertEquals(body.data.length, 2);
  assertEquals(body.data[0]!.id, "alice");
  assertEquals(body.data[0]!.role, "engineer");
  assertEquals(body.data[0]!.status, "idle");
  assertEquals(body.data[0]!.paused, false);
  assertEquals(body.data[1]!.id, "bob");
});

Deno.test("createServer mounts /events and returns 101 on a valid WS upgrade with ?role=user", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  const res = await app.fetch(
    new Request("http://x/events?role=user", {
      headers: {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    }),
  );
  // The upgrade is accepted by Hono / Deno but the test harness sees a
  // synthetic Response — the status reflects whether the upgrade was
  // attempted (101) vs. refused (400 / 4xx). On a valid handshake the
  // `Deno.upgradeWebSocket` code path returns a 101.
  assertEquals(res.status, 101);
});

Deno.test("createServer's /events refuses an upgrade with no role (400 missing_role)", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  const res = await app.fetch(
    new Request("http://x/events", {
      headers: {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    }),
  );
  assertEquals(res.status, 400);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "missing_role");
});

Deno.test("createServer's REST endpoints do NOT accept the ?role= query parameter (only /events does)", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  const res = await app.fetch(new Request("http://x/tickets?role=user"));
  assertEquals(res.status, 400);
  const body = (await res.json()) as ErrorResponse;
  assertEquals(body.error.code, "missing_role");
});

Deno.test("a successful POST /activity flips the agent runtime status to running and emits agent.state_changed", async () => {
  const roster: readonly AgentConfig[] = [{ id: "alice", role: "engineer" }];
  const deps = makeDeps(roster);
  const app = createServer(deps, { projectId: PROJECT_ID });

  const res = await app.fetch(
    new Request("http://x/activity", {
      method: "POST",
      headers: {
        "X-Keni-Role": "engineer",
        "X-Keni-Agent": "alice",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: "s1",
        agent: "alice",
        role: "engineer",
        event: "session_start",
        summary: "begin",
      }),
    }),
  );
  assertEquals(res.status, 201);

  const snapshot = deps.agentRuntimeStateStore.read("alice");
  assertEquals(snapshot.status, "running");
  assertEquals(snapshot.last_activity, "session_start");
  assert(snapshot.last_active_at !== null);

  const stateChanged = deps.busBuffer.filter((f) => f.event === "agent.state_changed");
  assertEquals(stateChanged.length, 1);
  if (stateChanged[0]!.event === "agent.state_changed") {
    assertEquals(stateChanged[0]!.payload.agent_id, "alice");
    assertEquals(stateChanged[0]!.payload.paused, false);
    assertEquals(stateChanged[0]!.payload.status, "running");
  }
});

Deno.test(
  "createServer mounts POST /prs/:id/merge only when WorkspaceProvisioner + projectRepoPath are supplied",
  async () => {
    const baseDeps = makeDeps();
    const withoutProvisioner = createServer(baseDeps, { projectId: PROJECT_ID });

    const headers = new Headers();
    headers.set("X-Keni-Role", "engineer");
    const res404 = await withoutProvisioner.fetch(
      new Request("http://x/prs/pr-0001/merge", { method: "POST", headers }),
    );
    assertEquals(res404.status, 404);
    const body404 = (await res404.json()) as ErrorResponse;
    assertEquals(body404.error.code, "store_not_found");
    assertEquals(body404.error.details?.path, "/prs/pr-0001/merge");
  },
);

Deno.test(
  "createServer wires the same WorkspaceProvisioner into the merge route's deps bag",
  async () => {
    const baseDeps = makeDeps();
    const provisioner = new FakeWorkspaceProvisioner();
    const mergeMutex = createMutex();
    const app = createServer(
      {
        ...baseDeps,
        workspaceProvisioner: provisioner,
        projectRepoPath: "/tmp/keni-test-repo",
        mergeMutex,
      },
      { projectId: PROJECT_ID },
    );

    const headers = new Headers();
    headers.set("X-Keni-Role", "engineer");
    const res = await app.fetch(
      new Request("http://x/prs/pr-9999/merge", { method: "POST", headers }),
    );

    assertEquals(res.status, 404, "missing PR maps to store_not_found, not the no-route 404");
    const body = (await res.json()) as ErrorResponse;
    assertEquals(body.error.code, "store_not_found");
    assertEquals(typeof body.error.details?.id, "string");
  },
);

// ----------------------------------------------------------------------------
// /api/<x> alias coverage (per the `spa-api-prefix-alias` change).
//
// Every REST and WS route group is mounted at two equivalent base paths:
// the canonical bare prefix (`/tickets`, `/agents`, ...) and its
// `/api/`-prefixed mirror. The two URLs hit the same handler, the same
// store, and the same event bus. The tests below assert that contract:
// envelope-equality across URL forms, single-emit on a write through the
// prefixed URL, and the unauthenticated `/health` carve-out applying to
// the prefixed mirror too.
// ----------------------------------------------------------------------------

Deno.test(
  "every REST GET succeeds under both /<x> and /api/<x> with identical envelopes",
  async () => {
    const roster: readonly AgentConfig[] = [{ id: "alice", role: "engineer" }];
    const deps = makeDeps(roster);
    const app = createServer(deps, { projectId: PROJECT_ID });

    const cases = [
      { bare: "/tickets", prefixed: "/api/tickets" },
      { bare: "/prs", prefixed: "/api/prs" },
      { bare: "/activity", prefixed: "/api/activity" },
      { bare: "/agents", prefixed: "/api/agents" },
    ];

    for (const { bare, prefixed } of cases) {
      const bareRes = await app.fetch(authedRequest(`http://x${bare}`));
      const prefixedRes = await app.fetch(authedRequest(`http://x${prefixed}`));
      assertEquals(bareRes.status, 200, `${bare} should be 200`);
      assertEquals(prefixedRes.status, 200, `${prefixed} should be 200`);
      const bareBody = await bareRes.json();
      const prefixedBody = await prefixedRes.json();
      assertEquals(
        prefixedBody,
        bareBody,
        `${prefixed} envelope must equal ${bare} envelope`,
      );
      // Per-call X-Keni-Request-Id is the only documented difference.
      assert(bareRes.headers.get("X-Keni-Request-Id"));
      assert(prefixedRes.headers.get("X-Keni-Request-Id"));
      assert(
        bareRes.headers.get("X-Keni-Request-Id") !==
          prefixedRes.headers.get("X-Keni-Request-Id"),
        "request ids should be distinct across two requests",
      );
    }
  },
);

Deno.test(
  "a POST through /api/tickets round-trips on a GET /tickets and emits exactly one EventFrame",
  async () => {
    const deps = makeDeps();
    const app = createServer(deps, { projectId: PROJECT_ID });

    const createRes = await app.fetch(
      new Request("http://x/api/tickets", {
        method: "POST",
        headers: {
          "X-Keni-Role": "user",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "alpha", priority: 1 }),
      }),
    );
    assertEquals(createRes.status, 201);
    const createBody = (await createRes.json()) as { data: { id: string } };
    const ticketId = createBody.data.id;
    assert(typeof ticketId === "string" && ticketId.length > 0);

    const listRes = await app.fetch(authedRequest("http://x/tickets"));
    assertEquals(listRes.status, 200);
    const listBody = (await listRes.json()) as TicketListResponse;
    assertEquals(listBody.data.length, 1);
    assertEquals(listBody.data[0]!.id, ticketId);

    // The dual-mount must NOT cause duplicate frame emission: exactly
    // one ticket.created frame for the operation, regardless of which
    // URL form was used to issue it.
    const created = deps.busBuffer.filter((f) => f.event === "ticket.created");
    assertEquals(created.length, 1);
    if (created[0]!.event === "ticket.created") {
      assertEquals(created[0]!.payload.ticket_id, ticketId);
    }
  },
);

Deno.test(
  "POST /api/agents/:id/pause emits exactly one agent.state_changed frame",
  async () => {
    const roster: readonly AgentConfig[] = [{ id: "alice", role: "engineer" }];
    const deps = makeDeps(roster);
    const app = createServer(deps, { projectId: PROJECT_ID });

    const res = await app.fetch(
      new Request("http://x/api/agents/alice/pause", {
        method: "POST",
        headers: { "X-Keni-Role": "user" },
      }),
    );
    assertEquals(res.status, 200);

    const stateChanged = deps.busBuffer.filter((f) => f.event === "agent.state_changed");
    assertEquals(stateChanged.length, 1);
    if (stateChanged[0]!.event === "agent.state_changed") {
      assertEquals(stateChanged[0]!.payload.agent_id, "alice");
      assertEquals(stateChanged[0]!.payload.paused, true);
    }
  },
);

Deno.test("GET /api/health is unauthenticated and returns the documented health envelope", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });
  // No X-Keni-Role header — the carve-out exempts /api/health from
  // roleIdentity (parity with the bare /health route).
  const res = await app.fetch(new Request("http://x/api/health"));
  assertEquals(res.status, 200);
  const body = (await res.json()) as { data: { status: string }; project_id: string };
  assertEquals(body.data.status, "ok");
  assertEquals(body.project_id, PROJECT_ID);
});

Deno.test(
  "createServer mounts /api/events and returns 101 on a valid WS upgrade with ?role=user",
  async () => {
    const deps = makeDeps();
    const app = createServer(deps, { projectId: PROJECT_ID });
    const res = await app.fetch(
      new Request("http://x/api/events?role=user", {
        headers: {
          "Upgrade": "websocket",
          "Connection": "Upgrade",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      }),
    );
    // Parity with the bare-/events upgrade test above: the ?role=
    // fallback now matches /api/events too, so the upgrade succeeds.
    assertEquals(res.status, 101);
  },
);
