/**
 * Integration tests for the WebSocket `/events` route.
 *
 * Two test patterns are used (per `design.md` Decision 10):
 *
 * - **`app.fetch` simulation** for the role-refusal path. The upgrade is
 *   refused *before* the handshake completes, so the response is the
 *   documented JSON error envelope and never produces a real socket. We
 *   can drive that with the same `app.fetch(new Request(...))` harness
 *   the REST tests use, which keeps the assertion surface small and
 *   fast.
 * - **Real `Deno.serve` + Deno's built-in `WebSocket` client** for every
 *   path that exercises the actual socket: handshake, frame delivery,
 *   multi-client fan-out, disconnect-unsubscribes, and the heartbeat
 *   close-on-missed-pong contract. These tests bind to port 0 (OS-
 *   assigned) so the suite stays parallel-safe.
 *
 * Each port-binding test wraps the listener in a `try / finally` block
 * that calls `handle.abort()` so a thrown assertion does not leak the
 * `Deno.HttpServer` across tests.
 */

import { Hono } from "@hono/hono";
import { assert, assertEquals } from "@std/assert";
import type { EventFrame, TicketCreatedPayload, TicketResponse } from "@keni/shared";
import {
  type ErrorResponse,
  InMemoryActivityLogStore,
  InMemoryConfigStore,
  InMemoryPRStore,
  InMemoryTicketStore,
} from "@keni/shared";
import { createInMemoryEventBus, emitFrame, type EventBus } from "../eventBus.ts";
import { errorBoundary } from "../middleware/errorBoundary.ts";
import { captureLogSink, requestLog } from "../middleware/requestLog.ts";
import { requestId } from "../middleware/requestId.ts";
import { roleIdentity } from "../middleware/roleIdentity.ts";
import type { LogSink, RequestLogLine, ServerVariables } from "../middleware/types.ts";
import { ticketsRoutes } from "./tickets.ts";
import { eventsRoute } from "./events.ts";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

interface TestApp {
  readonly app: Hono<{ Variables: ServerVariables }>;
  readonly bus: EventBus;
  readonly logBuffer: RequestLogLine[];
  readonly logSink: LogSink;
}

/**
 * Build a minimal `createServer`-compatible app with just the `/events`
 * mount and an optional `/tickets` mount. The full composition root is
 * exercised by `createServer_test.ts`; this harness intentionally
 * omits the routes the WS tests do not need so a regression in (say)
 * `/prs` cannot break a `/events` test.
 */
function makeTestApp(opts: {
  readonly heartbeatSeconds?: number;
  readonly mountTickets?: boolean;
} = {}): TestApp {
  const bus = createInMemoryEventBus();
  const logBuffer: RequestLogLine[] = [];
  const logSink = captureLogSink(logBuffer);

  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(requestId());
  app.use(requestLog(logSink, PROJECT_ID));
  app.use(
    roleIdentity({
      fallback: (c) => c.req.path === "/events" ? c.req.query("role") : undefined,
    }),
  );
  app.onError(errorBoundary(PROJECT_ID));

  app.route("/events", eventsRoute(bus, opts.heartbeatSeconds));
  if (opts.mountTickets) {
    app.route("/tickets", ticketsRoutes(new InMemoryTicketStore(), bus, PROJECT_ID));
  }

  // Silence the unused-store warning for the in-memory adapters that
  // round-trip a config but are not used by this harness.
  void new InMemoryPRStore();
  void new InMemoryActivityLogStore();
  void new InMemoryConfigStore();

  return { app, bus, logBuffer, logSink };
}

interface BoundServer {
  readonly url: string;
  readonly port: number;
  abort(): Promise<void>;
}

function bindTestServer(
  app: Hono<{ Variables: ServerVariables }>,
): Promise<BoundServer> {
  const ctrl = new AbortController();
  return new Promise((resolveFn, rejectFn) => {
    let resolved = false;
    try {
      const server = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        signal: ctrl.signal,
        onListen: ({ port }) => {
          resolved = true;
          resolveFn({
            port,
            url: `http://127.0.0.1:${port}`,
            abort: async () => {
              ctrl.abort();
              await server.finished.catch(() => {});
            },
          });
        },
      }, app.fetch);
      void server.finished.catch(() => {});
    } catch (err) {
      if (!resolved) rejectFn(err);
    }
  });
}

/**
 * Open a WebSocket and resolve once the connection is `open`. Rejects
 * if the connection errors out before opening (e.g., role-refusal at
 * the upgrade step).
 */
function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolveFn, rejectFn) => {
    const ws = new WebSocket(url);
    const onOpen = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      resolveFn(ws);
    };
    const onError = (evt: Event) => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      rejectFn(new Error(`WebSocket error before open: ${String(evt.type)}`));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

/** Resolve with the next `message` frame received on `ws`. */
function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolveFn, rejectFn) => {
    const onMessage = (evt: MessageEvent) => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      resolveFn(typeof evt.data === "string" ? evt.data : String(evt.data));
    };
    const onError = (evt: Event) => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      rejectFn(new Error(`WebSocket error: ${String(evt.type)}`));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
  });
}

/** Resolve once `ws` enters CLOSED state. */
function awaitClose(ws: WebSocket): Promise<CloseEvent> {
  return new Promise((resolveFn) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolveFn(new CloseEvent("close"));
      return;
    }
    ws.addEventListener("close", (evt) => resolveFn(evt as CloseEvent), { once: true });
  });
}

Deno.test("GET /events without role returns 400 missing_role on the upgrade response", async () => {
  const { app, logBuffer } = makeTestApp();
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
  assertEquals(body.project_id, PROJECT_ID);
  assertEquals(logBuffer.length, 1);
  assertEquals(logBuffer[0]!.error_code, "missing_role");
});

Deno.test("GET /events with ?role=ghost returns 400 missing_role", async () => {
  const { app } = makeTestApp();
  const res = await app.fetch(
    new Request("http://x/events?role=ghost", {
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

Deno.test("GET /events upgrades successfully with ?role=user (real port)", async () => {
  const { app } = makeTestApp();
  const handle = await bindTestServer(app);
  try {
    const ws = await openWebSocket(`ws://127.0.0.1:${handle.port}/events?role=user`);
    assertEquals(ws.readyState, WebSocket.OPEN);
    ws.close();
    await awaitClose(ws);
  } finally {
    await handle.abort();
  }
});

Deno.test("GET /events upgrades successfully with X-Keni-Role header (raw socket)", async () => {
  // Deno's built-in `WebSocket` client cannot set custom headers on the
  // upgrade — that's exactly the browser-side limitation that motivates
  // the `?role=` fallback. To verify the header path we open a raw TCP
  // socket and complete the handshake by hand with `X-Keni-Role: user`
  // and *no* `?role=` query parameter; the 101 status confirms the
  // header-only path works.
  const { app } = makeTestApp();
  const handle = await bindTestServer(app);
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: handle.port });
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    const wsKey = btoa(String.fromCharCode(...keyBytes));
    const handshake = [
      `GET /events HTTP/1.1`,
      `Host: 127.0.0.1:${handle.port}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Version: 13`,
      `Sec-WebSocket-Key: ${wsKey}`,
      `X-Keni-Role: user`,
      "",
      "",
    ].join("\r\n");
    await conn.write(new TextEncoder().encode(handshake));
    const buf = new Uint8Array(8192);
    const n = await conn.read(buf);
    assert(n !== null, "server closed before responding");
    const text = new TextDecoder().decode(buf.subarray(0, n));
    assert(
      text.startsWith("HTTP/1.1 101"),
      `expected 101 upgrade, got: ${text.slice(0, 120)}`,
    );
    try {
      conn.close();
    } catch {
      // already closed by the runtime when we initiate teardown
    }
  } finally {
    await handle.abort();
  }
});

Deno.test("GET /events upgrade with both header and ?role= prefers the header", async () => {
  // The middleware reads `X-Keni-Role` first; the `?role=` fallback only
  // fires when the header is absent. We sanity-check this by sending
  // both a valid header (`engineer`) and a conflicting query parameter
  // (`?role=ghost` — invalid). If the header wins, the upgrade succeeds.
  const { app } = makeTestApp();
  const handle = await bindTestServer(app);
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: handle.port });
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    const wsKey = btoa(String.fromCharCode(...keyBytes));
    const handshake = [
      `GET /events?role=ghost HTTP/1.1`,
      `Host: 127.0.0.1:${handle.port}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Version: 13`,
      `Sec-WebSocket-Key: ${wsKey}`,
      `X-Keni-Role: engineer`,
      "",
      "",
    ].join("\r\n");
    await conn.write(new TextEncoder().encode(handshake));
    const buf = new Uint8Array(8192);
    const n = await conn.read(buf);
    assert(n !== null);
    const text = new TextDecoder().decode(buf.subarray(0, n));
    assert(
      text.startsWith("HTTP/1.1 101"),
      `expected 101 (header wins, ?role=ghost ignored), got: ${text.slice(0, 120)}`,
    );
    try {
      conn.close();
    } catch {
      // already closed
    }
  } finally {
    await handle.abort();
  }
});

Deno.test("GET /events forwards an emitted frame to a connected client", async () => {
  const { app, bus } = makeTestApp();
  const handle = await bindTestServer(app);
  try {
    const ws = await openWebSocket(`ws://127.0.0.1:${handle.port}/events?role=user`);
    const messagePromise = nextMessage(ws);

    const payload: TicketCreatedPayload = {
      ticket_id: "ticket-0001",
      status: "open",
    };
    const emitted = emitFrame(bus, PROJECT_ID, "ticket.created", payload);

    const raw = await messagePromise;
    const received = JSON.parse(raw) as EventFrame;
    assertEquals(received.id, emitted.id);
    assertEquals(received.event, "ticket.created");
    assertEquals(received.project_id, PROJECT_ID);
    assertEquals(received.payload, payload);

    ws.close();
    await awaitClose(ws);
  } finally {
    await handle.abort();
  }
});

Deno.test("GET /events fans out one emitted frame to every connected client", async () => {
  const { app, bus } = makeTestApp();
  const handle = await bindTestServer(app);
  try {
    const a = await openWebSocket(`ws://127.0.0.1:${handle.port}/events?role=user`);
    const b = await openWebSocket(`ws://127.0.0.1:${handle.port}/events?role=user`);

    const aMsg = nextMessage(a);
    const bMsg = nextMessage(b);

    emitFrame(bus, PROJECT_ID, "ticket.updated", {
      ticket_id: "ticket-0002",
      status: "in_progress",
      kind: "transition",
    });

    const [rawA, rawB] = await Promise.all([aMsg, bMsg]);
    const fA = JSON.parse(rawA) as EventFrame;
    const fB = JSON.parse(rawB) as EventFrame;
    assertEquals(fA.event, "ticket.updated");
    assertEquals(fB.event, "ticket.updated");
    assertEquals(fA.id, fB.id);

    a.close();
    b.close();
    await awaitClose(a);
    await awaitClose(b);
  } finally {
    await handle.abort();
  }
});

Deno.test("GET /events unsubscribes the bus handler when a client disconnects", async () => {
  const { app, bus } = makeTestApp();
  const handle = await bindTestServer(app);
  try {
    assertEquals(bus.subscriberCount(), 0);

    const ws = await openWebSocket(`ws://127.0.0.1:${handle.port}/events?role=user`);
    // Allow the server-side `onOpen` to register its subscriber. The
    // browser-style `WebSocket` resolves `open` on the *client*; the
    // server `onOpen` runs on the next microtask after the handshake.
    await waitFor(() => bus.subscriberCount() === 1, 1000);
    assertEquals(bus.subscriberCount(), 1);

    ws.close();
    await awaitClose(ws);
    await waitFor(() => bus.subscriberCount() === 0, 1000);
    assertEquals(bus.subscriberCount(), 0);
  } finally {
    await handle.abort();
  }
});

Deno.test("a ticket POST round-trips through the bus to a WS client", async () => {
  const { app, bus } = makeTestApp({ mountTickets: true });
  const handle = await bindTestServer(app);
  try {
    const ws = await openWebSocket(`ws://127.0.0.1:${handle.port}/events?role=user`);
    await waitFor(() => bus.subscriberCount() === 1, 1000);

    const messagePromise = nextMessage(ws);

    const res = await fetch(`${handle.url}/tickets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keni-Role": "user",
      },
      body: JSON.stringify({ title: "round-trip", priority: 1 }),
    });
    assertEquals(res.status, 201);
    const body = (await res.json()) as { data: TicketResponse };

    const raw = await messagePromise;
    const frame = JSON.parse(raw) as EventFrame;
    assertEquals(frame.event, "ticket.created");
    if (frame.event === "ticket.created") {
      assertEquals(frame.payload.ticket_id, body.data.id);
    }

    ws.close();
    await awaitClose(ws);
  } finally {
    await handle.abort();
  }
});

Deno.test("the heartbeat closes a non-ponging connection within the documented window", async () => {
  // `heartbeatSeconds: 1` ⇒ Deno's WS runtime sends a ping after 1 s of
  // idle and closes 1011 if no pong arrives within the next 1 s window.
  // With a raw socket that never replies the close should land within
  // ~2 s; we use a 10 s timeout to absorb CI scheduling jitter and the
  // OS-level TCP buffering that can delay the close-frame visibility.
  const { app } = makeTestApp({ heartbeatSeconds: 1 });
  const handle = await bindTestServer(app);
  try {
    const conn = await openRawWebSocket(handle.port, "/events?role=user");
    const closedAt = await waitForServerClose(conn, 10000);
    try {
      conn.close();
    } catch {
      // already closed by the server
    }
    assert(
      closedAt !== null,
      "server should close the connection when no pong arrives",
    );
    assert(
      closedAt < 10000,
      `expected close within 10 s, got ${closedAt} ms`,
    );
  } finally {
    await handle.abort();
  }
});

/**
 * Open a raw TCP connection and complete the WebSocket upgrade
 * handshake by hand. Returns the connected `Deno.Conn`. The handshake
 * is the minimum required by RFC 6455 — `Upgrade`, `Connection`,
 * `Sec-WebSocket-Version`, and a random `Sec-WebSocket-Key`. The server
 * computes `Sec-WebSocket-Accept` from the key but the test does not
 * verify it (Deno's runtime already enforces the protocol; we only
 * care that the upgrade succeeded enough to reach the heartbeat
 * timer).
 */
async function openRawWebSocket(port: number, path: string): Promise<Deno.Conn> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const keyBytes = crypto.getRandomValues(new Uint8Array(16));
  const wsKey = btoa(String.fromCharCode(...keyBytes));
  const handshake = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    `Upgrade: websocket`,
    `Connection: Upgrade`,
    `Sec-WebSocket-Version: 13`,
    `Sec-WebSocket-Key: ${wsKey}`,
    "",
    "",
  ].join("\r\n");
  await conn.write(new TextEncoder().encode(handshake));

  // Read the server's response. We do not parse it — we just assert
  // that the line begins with `HTTP/1.1 101` and stop reading.
  const buf = new Uint8Array(8192);
  const n = await conn.read(buf);
  if (n === null) {
    conn.close();
    throw new Error("server closed before WS upgrade response");
  }
  const text = new TextDecoder().decode(buf.subarray(0, n));
  if (!text.startsWith("HTTP/1.1 101")) {
    conn.close();
    throw new Error(`unexpected upgrade response: ${text.slice(0, 120)}`);
  }
  return conn;
}

/**
 * Read from `conn` until EOF or `timeoutMs` elapses. Returns the
 * elapsed milliseconds when the server closes the connection, or
 * `null` when the timeout fires first. The test does not interpret the
 * frame bytes — pings, pongs, and the close frame all surface as
 * non-null reads; only EOF (the server ending the stream) returns
 * `null` from `conn.read`, which is what we want to detect.
 */
/**
 * Read frames until the server sends a WS Close frame (opcode 0x8) or
 * the deadline expires. Returns the elapsed milliseconds when the close
 * frame arrives, or `null` on timeout. We detect the close frame instead
 * of waiting for full TCP EOF because the WS spec requires the peer to
 * ACK with its own close frame before the TCP socket is torn down — and
 * our raw socket deliberately does not ACK.
 */
async function waitForServerClose(
  conn: Deno.Conn,
  timeoutMs: number,
): Promise<number | null> {
  const started = performance.now();
  const buf = new Uint8Array(1024);
  while (true) {
    const remaining = Math.max(0, timeoutMs - (performance.now() - started));
    if (remaining === 0) return null;
    let timeoutId: number | undefined;
    const timeoutP = new Promise<"timeout">((resolveFn) => {
      timeoutId = setTimeout(() => resolveFn("timeout"), remaining);
    });
    let result: number | null | "timeout";
    try {
      result = await Promise.race([conn.read(buf), timeoutP]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    if (result === "timeout") return null;
    if (result === null) return performance.now() - started;
    // Frame format: byte 0 low nibble is the opcode. 0x8 = Close,
    // 0x9 = Ping, 0xa = Pong. We treat receipt of a Close frame as the
    // signal the server has decided the connection is dead.
    const opcode = buf[0]! & 0x0f;
    if (opcode === 0x8) return performance.now() - started;
  }
}

/** Poll `predicate()` every 10 ms until it returns true or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
