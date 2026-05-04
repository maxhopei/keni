/**
 * Tests for the `/health` route. Covers the seven scenarios in the
 * `orchestration-server` capability spec's `/health` requirement:
 *
 *  1. No `X-Keni-Role` header → 200 with the documented envelope.
 *  2. With `X-Keni-Role` header → 200 with the documented envelope.
 *  3. `uptime_ms` advances over time.
 *  4. `serverStartedAt` absent → `uptime_ms: 0`.
 *  5. The request does not mutate the runtime-state store and does not
 *     emit on the event bus.
 *  6. `POST /health` returns 4xx (the route only accepts GET).
 *  7. The request-log line for `/health` carries `role: null` and
 *     `agent: null` (the role middleware never ran for this request).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type AgentConfig,
  type EventFrame,
  type HealthEnvelope,
  InMemoryActivityLogStore,
  InMemoryConfigStore,
  InMemoryPRStore,
  InMemoryTicketStore,
  VERSION,
} from "@keni/shared";
import { createInMemoryAgentRuntimeStateStore } from "../agentState.ts";
import { captureBusBuffer, createInMemoryEventBus } from "../eventBus.ts";
import { createServer, type ServerDeps } from "../createServer.ts";
import { captureLogSink } from "../middleware/requestLog.ts";
import type { RequestLogLine } from "../middleware/types.ts";

const PROJECT_ID = "project-health";

interface TestDeps extends ServerDeps {
  readonly buffer: RequestLogLine[];
  readonly busBuffer: EventFrame[];
}

function makeDeps(opts: { startedAt?: Date; roster?: readonly AgentConfig[] } = {}): TestDeps {
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
    agentRuntimeStateStore: createInMemoryAgentRuntimeStateStore(opts.roster ?? []),
    buffer,
    busBuffer,
    ...(opts.startedAt !== undefined ? { serverStartedAt: opts.startedAt } : {}),
  };
}

Deno.test("GET /health succeeds without X-Keni-Role and returns the documented envelope", async () => {
  const deps = makeDeps({ startedAt: new Date(Date.now() - 1500) });
  const app = createServer(deps, { projectId: PROJECT_ID });

  const res = await app.fetch(new Request("http://x/health"));
  assertEquals(res.status, 200);
  const body = (await res.json()) as HealthEnvelope;
  assertEquals(body.data.status, "ok");
  assertEquals(body.data.project_id, PROJECT_ID);
  assertEquals(body.project_id, PROJECT_ID);
  assertEquals(body.data.version, VERSION);
  assert(body.data.uptime_ms >= 1500);
});

Deno.test("GET /health succeeds with an X-Keni-Role header (still no role guard applied)", async () => {
  const deps = makeDeps({ startedAt: new Date() });
  const app = createServer(deps, { projectId: PROJECT_ID });

  const headers = new Headers();
  headers.set("X-Keni-Role", "user");
  const res = await app.fetch(new Request("http://x/health", { headers }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as HealthEnvelope;
  assertEquals(body.data.status, "ok");
});

Deno.test("GET /health: uptime_ms advances over time", async () => {
  const startedAt = new Date(Date.now() - 100);
  const deps = makeDeps({ startedAt });
  const app = createServer(deps, { projectId: PROJECT_ID });

  const res1 = await app.fetch(new Request("http://x/health"));
  const body1 = (await res1.json()) as HealthEnvelope;
  await new Promise((r) => setTimeout(r, 25));
  const res2 = await app.fetch(new Request("http://x/health"));
  const body2 = (await res2.json()) as HealthEnvelope;
  assert(body2.data.uptime_ms >= body1.data.uptime_ms);
});

Deno.test("GET /health: serverStartedAt absent → uptime_ms is 0", async () => {
  const deps = makeDeps();
  const app = createServer(deps, { projectId: PROJECT_ID });

  const res = await app.fetch(new Request("http://x/health"));
  const body = (await res.json()) as HealthEnvelope;
  assertEquals(body.data.uptime_ms, 0);
});

Deno.test("GET /health does not mutate the runtime-state store and does not emit on the bus", async () => {
  const roster: readonly AgentConfig[] = [{ id: "alice", role: "engineer" }];
  const deps = makeDeps({ roster, startedAt: new Date() });
  const app = createServer(deps, { projectId: PROJECT_ID });

  const before = deps.agentRuntimeStateStore.read("alice");
  await app.fetch(new Request("http://x/health"));
  const after = deps.agentRuntimeStateStore.read("alice");
  assertEquals(after, before);
  assertEquals(deps.busBuffer.length, 0);
});

Deno.test("POST /health returns a 4xx (the route only accepts GET)", async () => {
  const deps = makeDeps({ startedAt: new Date() });
  const app = createServer(deps, { projectId: PROJECT_ID });

  // POST without X-Keni-Role: the /health route does not match the verb,
  // so the request walks past the carve-out into the role-guarded
  // pipeline and surfaces 400 missing_role. Either way, the response
  // is in the 4xx range and is NOT 200.
  const res = await app.fetch(new Request("http://x/health", { method: "POST" }));
  assert(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
});

Deno.test("GET /health request-log line carries role: null and agent: null", async () => {
  const deps = makeDeps({ startedAt: new Date() });
  const app = createServer(deps, { projectId: PROJECT_ID });

  await app.fetch(new Request("http://x/health"));
  const line = deps.buffer.find((l) => l.path === "/health");
  assert(line !== undefined, "expected a request-log line for /health");
  assertEquals(line!.role, null);
  assertEquals(line!.agent, null);
  assertEquals(line!.method, "GET");
  assertEquals(line!.status, 200);
});
