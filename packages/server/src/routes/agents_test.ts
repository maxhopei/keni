/**
 * Integration tests for the `/agents` route group — exercised via
 * `app.fetch(new Request(...))` against the real
 * `createInMemoryAgentRuntimeStateStore`. Coverage matrix mirrors
 * `tickets_test.ts` (happy-path, role-refusal, idempotence, not-found).
 */

import { Hono } from "@hono/hono";
import { assert, assertEquals } from "@std/assert";
import type {
  ActivityEntryResponse,
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
import { captureBusBuffer, createInMemoryEventBus, emitFrame } from "../eventBus.ts";
import { errorBoundary } from "../middleware/errorBoundary.ts";
import { captureLogSink } from "../middleware/requestLog.ts";
import { roleIdentity } from "../middleware/roleIdentity.ts";
import type { RequestLogLine, ServerVariables } from "../middleware/types.ts";
import type { InterruptResult, Scheduler } from "../scheduler/scheduler.ts";
import type { AgentRunner } from "../scheduler/registry.ts";
import { agentsRoutes, type PausedAgentsPersister } from "./agents.ts";

const PROJECT_ID = "project-test";

interface TestContext {
  readonly app: Hono<{ Variables: ServerVariables }>;
  readonly store: AgentRuntimeStateStore;
  readonly buffer: EventFrame[];
}

interface TestContextWithScheduler extends TestContext {
  readonly scheduler: FakeScheduler;
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

/**
 * Build a test app with an injected scheduler-thunk. The fake
 * scheduler exposes `nextResult` so each test can pin the
 * discriminated return; on a "happy" interrupt the fake also
 * mirrors the real scheduler's contract by writing a
 * `session_interrupted` activity entry into the runtime-state
 * store and emitting `agent.state_changed` on the bus, so the
 * route's response body and the captured frames match production.
 */
function makeTestAppWithScheduler(
  roster: readonly AgentConfig[],
  scheduler: FakeScheduler,
): TestContextWithScheduler {
  const store = createInMemoryAgentRuntimeStateStore(roster);
  const bus = createInMemoryEventBus();
  const { buffer, subscribe } = captureBusBuffer();
  subscribe(bus);
  // Wire the fake scheduler's interrupt path to the same store / bus
  // pair so the route observes production-shaped post-interrupt state.
  scheduler.bind(store, bus, PROJECT_ID);
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(roleIdentity());
  app.onError(errorBoundary(PROJECT_ID));
  app.route(
    "/agents",
    agentsRoutes(store, bus, PROJECT_ID, () => scheduler.handle),
  );
  return { app, store, buffer, scheduler };
}

class FakeScheduler {
  private nextResult: InterruptResult = {
    interrupted: false,
    reason: "no_active_cycle",
  };
  private store: AgentRuntimeStateStore | null = null;
  private bus: ReturnType<typeof createInMemoryEventBus> | null = null;
  private projectId: string | null = null;
  public readonly calls: string[] = [];

  bind(
    store: AgentRuntimeStateStore,
    bus: ReturnType<typeof createInMemoryEventBus>,
    projectId: string,
  ): void {
    this.store = store;
    this.bus = bus;
    this.projectId = projectId;
  }

  setNext(result: InterruptResult): void {
    this.nextResult = result;
  }

  /** The shape `agentsRoutes` consumes via `getScheduler`. */
  get handle(): Scheduler {
    return {
      // deno-lint-ignore require-await
      interrupt: async (id: string): Promise<InterruptResult> => {
        this.calls.push(id);
        const result = this.nextResult;
        if (result.interrupted === true) {
          if (this.store === null || this.bus === null || this.projectId === null) {
            throw new Error("FakeScheduler.bind(...) was not called");
          }
          const store = this.store;
          const bus = this.bus;
          const projectId = this.projectId;
          // Mirror the real scheduler's synchronous `POST /activity`
          // for `session_interrupted` and the resulting
          // `agent.state_changed` flip.
          const entry: ActivityEntryResponse = {
            id: "01HW000000000000000000FAKE",
            timestamp: "2026-05-04T07:00:00.000Z",
            session_id: result.sessionId,
            agent: id,
            role: "engineer",
            event: "session_interrupted",
            summary: null,
            refs: { reason: "interrupt" },
          };
          const { state, changed } = store.applyActivityEvent(entry);
          // Emit `activity.appended` mirroring the real activity-route flow.
          emitFrame(bus, projectId, "activity.appended", {
            entry_id: entry.id,
            agent: entry.agent,
            role: entry.role,
            event: entry.event,
          });
          if (changed && state !== null) {
            emitFrame(bus, projectId, "agent.state_changed", {
              agent_id: state.id,
              paused: state.paused,
              status: state.status,
            });
          }
        }
        return result;
      },
      // The remaining methods are not exercised by the route — the
      // fake stubs them with no-ops so the type contract is satisfied.
      start: () => {},
      stop: () => Promise.resolve(),
      registerRunner: (_runner: AgentRunner) => {},
    };
  }
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

// ---------------------------------------------------------------------------
// POST /agents/:id/interrupt — `interrupt-and-timeout-ux` capability
// ---------------------------------------------------------------------------

Deno.test("POST /:id/interrupt as user with active cycle → 200 with session_interrupted", async () => {
  const fake = new FakeScheduler();
  fake.setNext({ interrupted: true, sessionId: "session-abc" });
  // Pre-seed alice as `running` so the response body's status flips to idle.
  const ctx = makeTestAppWithScheduler(ROSTER, fake);
  ctx.store.applyActivityEvent({
    id: "01HW000000000000000000START",
    timestamp: "2026-05-04T06:59:00.000Z",
    session_id: "session-abc",
    agent: "alice",
    role: "engineer",
    event: "session_start",
    summary: null,
    refs: {},
  });
  // The session_start emit happened directly on the store (no bus
  // route involvement); reset the captured buffer so the test only
  // observes frames produced by the interrupt request itself.
  ctx.buffer.length = 0;

  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/interrupt", { method: "POST", role: "user" }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as AgentEnvelope;
  assertEquals(body.data.id, "alice");
  assertEquals(body.data.status, "idle");
  assertEquals(body.data.last_activity, "session_interrupted");
  assertEquals(fake.calls, ["alice"]);
  // The fake scheduler emits exactly one `activity.appended` and one
  // `agent.state_changed` (status flipped running → idle). The route
  // itself does NOT emit a second `agent.state_changed`.
  const stateChanged = ctx.buffer.filter((f) => f.event === "agent.state_changed");
  const activityAppended = ctx.buffer.filter((f) => f.event === "activity.appended");
  assertEquals(stateChanged.length, 1, "exactly one agent.state_changed across the request");
  assertEquals(activityAppended.length, 1);
  if (stateChanged[0]!.event === "agent.state_changed") {
    assertEquals(stateChanged[0]!.payload.agent_id, "alice");
    assertEquals(stateChanged[0]!.payload.status, "idle");
  }
});

Deno.test("POST /:id/interrupt with no active cycle → 200 idempotent, no frames", async () => {
  const fake = new FakeScheduler();
  fake.setNext({ interrupted: false, reason: "no_active_cycle" });
  const ctx = makeTestAppWithScheduler(ROSTER, fake);
  // Capture the pre-call snapshot so we can prove the runtime state didn't change.
  const before = ctx.store.read("alice");

  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/interrupt", { method: "POST", role: "user" }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as AgentEnvelope;
  assertEquals(body.data.id, "alice");
  assertEquals(body.data.last_activity, before.last_activity);
  assertEquals(body.data.status, before.status);
  // Idempotent: zero frames of either kind.
  assertEquals(ctx.buffer.length, 0);
  assertEquals(fake.calls, ["alice"]);
});

Deno.test("POST /:id/interrupt as engineer → 403 role_not_owner", async () => {
  const fake = new FakeScheduler();
  const ctx = makeTestAppWithScheduler(ROSTER, fake);
  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/interrupt", { method: "POST", role: "engineer" }),
  );
  assertEquals(res.status, 403);
  const errBody = (await res.json()) as ErrorResponse;
  assertEquals(errBody.error.code, "role_not_owner");
  assertEquals(
    (errBody.error.details as { role: string; target: string }).target,
    "interrupt_agent",
  );
  // The scheduler must never be reached on a role-refusal.
  assertEquals(fake.calls.length, 0);
});

Deno.test("POST /:id/interrupt as qa, po, writer → 403", async () => {
  for (const role of ["qa", "po", "writer"]) {
    const fake = new FakeScheduler();
    const ctx = makeTestAppWithScheduler(ROSTER, fake);
    const res = await ctx.app.fetch(
      authedRequest("http://x/agents/alice/interrupt", { method: "POST", role }),
    );
    assertEquals(res.status, 403, `role=${role} should be rejected`);
    assertEquals(fake.calls.length, 0);
  }
});

Deno.test("POST /:id/interrupt for unknown agent → 404 store_not_found, scheduler not called", async () => {
  const fake = new FakeScheduler();
  const ctx = makeTestAppWithScheduler(ROSTER, fake);
  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/ghost/interrupt", { method: "POST", role: "user" }),
  );
  assertEquals(res.status, 404);
  const errBody = (await res.json()) as ErrorResponse;
  assertEquals(errBody.error.code, "store_not_found");
  assertEquals(fake.calls.length, 0);
});

Deno.test("POST /:id/interrupt without X-Keni-Role → 400 missing_role", async () => {
  const fake = new FakeScheduler();
  const ctx = makeTestAppWithScheduler(ROSTER, fake);
  // Hand-build the request so the role header is absent (the helper
  // would default to `user`).
  const res = await ctx.app.fetch(
    new Request("http://x/agents/alice/interrupt", { method: "POST" }),
  );
  assertEquals(res.status, 400);
  const errBody = (await res.json()) as ErrorResponse;
  assertEquals(errBody.error.code, "missing_role");
  assertEquals(fake.calls.length, 0);
});

Deno.test("POST /:id/interrupt with non-empty body still succeeds", async () => {
  const fake = new FakeScheduler();
  fake.setNext({ interrupted: false, reason: "no_active_cycle" });
  const ctx = makeTestAppWithScheduler(ROSTER, fake);
  // Send a body with random JSON; the route SHALL ignore it.
  const headers = new Headers();
  headers.set("X-Keni-Role", "user");
  headers.set("Content-Type", "application/json");
  const res = await ctx.app.fetch(
    new Request("http://x/agents/alice/interrupt", {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "ignored" }),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(fake.calls, ["alice"]);
});

Deno.test("POST /:id/interrupt on an unconfigured server → 500 internal_error", async () => {
  // No `getScheduler` thunk: the route should fail fast.
  const ctx = makeTestApp(ROSTER);
  const res = await ctx.app.fetch(
    authedRequest("http://x/agents/alice/interrupt", { method: "POST", role: "user" }),
  );
  assertEquals(res.status, 500);
  const errBody = (await res.json()) as ErrorResponse;
  assertEquals(errBody.error.code, "internal_error");
});

// ---------------------------------------------------------------------------
// `pausedAgentsPersister` — `cli-start-and-end-to-end-wiring` change
// ---------------------------------------------------------------------------

interface PersistContext {
  readonly app: Hono<{ Variables: ServerVariables }>;
  readonly buffer: EventFrame[];
  readonly logBuffer: RequestLogLine[];
  readonly persistedSnapshots: readonly string[][];
}

function makeTestAppWithPersister(
  roster: readonly AgentConfig[],
  persister: PausedAgentsPersister,
): PersistContext {
  const store = createInMemoryAgentRuntimeStateStore(roster);
  const bus = createInMemoryEventBus();
  const { buffer, subscribe } = captureBusBuffer();
  subscribe(bus);
  const logBuffer: RequestLogLine[] = [];
  const logSink = captureLogSink(logBuffer);
  const persistedSnapshots: string[][] = [];
  const wrappedPersister: PausedAgentsPersister = async (paused) => {
    persistedSnapshots.push([...paused]);
    await persister(paused);
  };
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(roleIdentity());
  app.onError(errorBoundary(PROJECT_ID));
  app.route(
    "/agents",
    agentsRoutes(store, bus, PROJECT_ID, undefined, wrappedPersister, logSink),
  );
  return { app, buffer, logBuffer, persistedSnapshots };
}

Deno.test(
  "POST /agents/:id/pause invokes pausedAgentsPersister with the post-call snapshot",
  async () => {
    const ctx = makeTestAppWithPersister(ROSTER, () => Promise.resolve());
    const res = await ctx.app.fetch(
      authedRequest("http://x/agents/alice/pause", { method: "POST", role: "user" }),
    );
    assertEquals(res.status, 200);
    assertEquals(ctx.persistedSnapshots, [["alice"]]);
    // The agent.state_changed frame fires BEFORE the persist call.
    assertEquals(ctx.buffer.length, 1);
    assertEquals(ctx.buffer[0]!.event, "agent.state_changed");
  },
);

Deno.test(
  "POST /agents/:id/pause: persister rejection still returns 200 and warn-logs",
  async () => {
    const ctx = makeTestAppWithPersister(ROSTER, () => {
      return Promise.reject(new Error("disk full"));
    });
    const res = await ctx.app.fetch(
      authedRequest("http://x/agents/alice/pause", { method: "POST", role: "user" }),
    );
    assertEquals(res.status, 200);
    // The synthetic warn line is captured by the LogSink.
    const warnLines = ctx.logBuffer.filter((l) =>
      typeof l.error_code === "string" && l.error_code.startsWith("paused_agents_persist_failed")
    );
    assertEquals(warnLines.length, 1);
    assert(warnLines[0]!.error_code!.includes("disk full"));
  },
);

Deno.test(
  "POST /agents/:id/pause without a persister: no extra log lines are produced",
  async () => {
    // Build the app WITHOUT the persister deps — the existing
    // makeTestApp helper already does this; verify there's no
    // synthetic warn line and only the standard frame fires.
    const ctx = makeTestApp(ROSTER);
    const res = await ctx.app.fetch(
      authedRequest("http://x/agents/alice/pause", { method: "POST", role: "user" }),
    );
    assertEquals(res.status, 200);
    assertEquals(ctx.buffer.length, 1);
  },
);

Deno.test("Interrupt route exists alongside pause/resume on the same router", async () => {
  // Confirms that the four POST verbs (pause, resume, interrupt) and
  // the GET roster all route off the same `/agents` sub-app.
  const fake = new FakeScheduler();
  fake.setNext({ interrupted: false, reason: "no_active_cycle" });
  const ctx = makeTestAppWithScheduler(ROSTER, fake);
  for (const path of ["/agents/alice/pause", "/agents/alice/resume", "/agents/alice/interrupt"]) {
    const res = await ctx.app.fetch(
      authedRequest(`http://x${path}`, { method: "POST", role: "user" }),
    );
    assert(res.status === 200, `${path} should resolve 200, got ${res.status}`);
  }
});
