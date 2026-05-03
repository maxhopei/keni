/**
 * Tests for the scheduler's activity-log adapter.
 *
 * Three scenarios:
 *
 *  1. Success path — headers stamped correctly, body shape matches the
 *     scheduler spec, return value is `{ posted: true, status: 201 }`.
 *  2. Server returns `5xx` — adapter swallows, logs `warn`, returns
 *     `{ posted: false, status: 500 }`.
 *  3. `fetch` rejects — adapter logs `warn`, returns
 *     `{ posted: false, status: 0 }`.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { appendSessionInterrupted, appendSessionTimeout } from "./activityClient.ts";
import { captureSchedulerLogger, type SchedulerLogEntry } from "./log.ts";

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function startStubServer(
  responder: (request: Request) => Promise<Response> | Response,
): { readonly url: string; readonly captured: CapturedRequest[]; stop: () => Promise<void> } {
  const captured: CapturedRequest[] = [];
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, async (req) => {
    let body: unknown = null;
    try {
      body = await req.clone().json();
    } catch { /* not JSON */ }
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => (headers[key] = value));
    captured.push({ method: req.method, url: req.url, headers, body });
    return await responder(req);
  });
  return {
    url: `http://${server.addr.hostname}:${server.addr.port}`,
    captured,
    stop: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

Deno.test("activityClient — appendSessionInterrupted success path stamps headers", async () => {
  const stub = startStubServer(() => new Response("{}", { status: 201 }));
  try {
    const buffer: SchedulerLogEntry[] = [];
    const result = await appendSessionInterrupted(
      {
        serverUrl: stub.url,
        sessionId: "s-1",
        agentId: "alice",
        role: "engineer",
      },
      captureSchedulerLogger(buffer),
    );
    assertEquals(result, { posted: true, status: 201 });
    assertEquals(stub.captured.length, 1);
    const req = stub.captured[0]!;
    assertEquals(req.method, "POST");
    assertEquals(req.headers["content-type"], "application/json");
    assertEquals(req.headers["x-keni-role"], "engineer");
    assertEquals(req.headers["x-keni-agent"], "alice");
    assertEquals(req.body, {
      session_id: "s-1",
      agent: "alice",
      role: "engineer",
      event: "session_interrupted",
      summary: null,
      refs: { reason: "interrupt" },
    });
    assertEquals(buffer.length, 0);
  } finally {
    await stub.stop();
  }
});

Deno.test("activityClient — appendSessionTimeout success path uses session_timeout event + reason", async () => {
  const stub = startStubServer(() => new Response("{}", { status: 201 }));
  try {
    const buffer: SchedulerLogEntry[] = [];
    const result = await appendSessionTimeout(
      {
        serverUrl: stub.url,
        sessionId: "s-2",
        agentId: "po",
        role: "po",
      },
      captureSchedulerLogger(buffer),
    );
    assertEquals(result, { posted: true, status: 201 });
    assertEquals(stub.captured.length, 1);
    assertEquals(stub.captured[0]!.body, {
      session_id: "s-2",
      agent: "po",
      role: "po",
      event: "session_timeout",
      summary: null,
      refs: { reason: "timeout" },
    });
    assertEquals(buffer.length, 0);
  } finally {
    await stub.stop();
  }
});

Deno.test("activityClient — 5xx response is swallowed with warn log", async () => {
  const stub = startStubServer(() =>
    new Response(JSON.stringify({ error: { code: "internal_error" } }), { status: 500 })
  );
  try {
    const buffer: SchedulerLogEntry[] = [];
    const result = await appendSessionInterrupted(
      {
        serverUrl: stub.url,
        sessionId: "s-3",
        agentId: "alice",
        role: "engineer",
      },
      captureSchedulerLogger(buffer),
    );
    assertEquals(result, { posted: false, status: 500 });
    assertEquals(buffer.length, 1);
    const line = buffer[0]!;
    assertEquals(line.level, "warn");
    assertEquals(line.event, "scheduler.activity_post_failed");
    assertEquals(line.fields.agent, "alice");
    assertEquals(line.fields.status, 500);
    assertEquals(line.fields.event, "session_interrupted");
  } finally {
    await stub.stop();
  }
});

Deno.test("activityClient — network failure logs warn and returns posted:false status:0", async () => {
  const buffer: SchedulerLogEntry[] = [];
  // Use a clearly unreachable URL — port 1 is privileged + nothing listens
  const result = await appendSessionTimeout(
    {
      serverUrl: "http://127.0.0.1:1",
      sessionId: "s-4",
      agentId: "alice",
      role: "engineer",
    },
    captureSchedulerLogger(buffer),
  );
  assertEquals(result.posted, false);
  assertEquals(result.status, 0);
  assertEquals(buffer.length, 1);
  assertEquals(buffer[0]!.level, "warn");
  assertEquals(buffer[0]!.event, "scheduler.activity_post_failed");
  assertNotEquals(buffer[0]!.fields.error, undefined);
});
