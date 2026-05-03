/**
 * Drives `createEventsClient` against an in-process `MockWebSocket` and a
 * `FakeClock` setTimeout/clearTimeout pair, so reconnect timing is
 * deterministic. No real `Deno.upgradeWebSocket` here — the focus is on the
 * client's lifecycle state machine and frame parsing.
 */

import { assert, assertEquals } from "@std/assert";
import { createEventsClient, type EventsClientLifecycle } from "./eventsClient.ts";
import type { EventFrame } from "@keni/shared";

interface FakeClockHandle {
  readonly id: number;
  readonly fireAtMs: number;
  readonly callback: () => void;
}

class FakeClock {
  private nowMs = 0;
  private nextId = 1;
  private readonly pending: FakeClockHandle[] = [];

  readonly setTimeout: typeof setTimeout = ((
    callback: (...args: unknown[]) => void,
    delayMs?: number,
  ): ReturnType<typeof setTimeout> => {
    const handle: FakeClockHandle = {
      id: this.nextId++,
      fireAtMs: this.nowMs + (delayMs ?? 0),
      callback: () => callback(),
    };
    this.pending.push(handle);
    return handle.id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  readonly clearTimeout: typeof clearTimeout = ((
    id: ReturnType<typeof setTimeout> | undefined,
  ): void => {
    if (id === undefined) return;
    const idx = this.pending.findIndex((h) => h.id === (id as unknown as number));
    if (idx >= 0) this.pending.splice(idx, 1);
  }) as unknown as typeof clearTimeout;

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      this.pending.sort((a, b) => a.fireAtMs - b.fireAtMs);
      const next = this.pending[0];
      if (next === undefined || next.fireAtMs > target) break;
      this.pending.shift();
      this.nowMs = next.fireAtMs;
      next.callback();
    }
    this.nowMs = target;
  }
}

type WebSocketLike = {
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void;
  close(): void;
};

class MockWebSocket implements WebSocketLike {
  static readonly instances: MockWebSocket[] = [];
  readonly url: string;
  private readonly listeners = new Map<string, Set<(event: Event | MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  close(): void {
    this.dispatch("close", new Event("close"));
  }

  fireOpen(): void {
    this.dispatch("open", new Event("open"));
  }

  fireServerClose(): void {
    this.dispatch("close", new Event("close"));
  }

  fireFrame(frame: EventFrame): void {
    const event = new MessageEvent("message", { data: JSON.stringify(frame) });
    this.dispatch("message", event);
  }

  fireBadJson(): void {
    const event = new MessageEvent("message", { data: "not-json{" });
    this.dispatch("message", event);
  }

  fireUnknownFrame(): void {
    const event = new MessageEvent("message", {
      data: JSON.stringify({ event: "nope", payload: {} }),
    });
    this.dispatch("message", event);
  }

  private dispatch(type: string, event: Event | MessageEvent): void {
    const set = this.listeners.get(type);
    if (set === undefined) return;
    for (const listener of set) listener(event);
  }
}

function makeFrame(): EventFrame {
  return {
    id: "01J0000000000000000000FRAME",
    event: "agent.state_changed",
    project_id: "proj-1",
    timestamp: "2026-05-03T18:00:00Z",
    payload: {
      agent_id: "alice",
      paused: true,
      status: "idle",
    },
  };
}

function setupClient() {
  MockWebSocket.instances.length = 0;
  const clock = new FakeClock();
  const lifecycle: EventsClientLifecycle[] = [];
  const frames: EventFrame[] = [];
  const client = createEventsClient({
    url: "ws://127.0.0.1:0/events",
    webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  });
  client.onLifecycle((s) => lifecycle.push(s));
  client.onEvent((f) => frames.push(f));
  return { client, clock, lifecycle, frames };
}

function lastSocket(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1);
  assert(ws !== undefined, "expected at least one constructed mock socket");
  return ws;
}

Deno.test("start() opens the socket and surfaces connecting → connected lifecycle", () => {
  const { client, lifecycle } = setupClient();
  client.start();
  assertEquals(lifecycle, ["connecting"]);
  lastSocket().fireOpen();
  assertEquals(lifecycle, ["connecting", "connected"]);
  client.close();
});

Deno.test("incoming frames are parsed and dispatched to event listeners", () => {
  const { client, frames } = setupClient();
  client.start();
  lastSocket().fireOpen();
  lastSocket().fireFrame(makeFrame());
  assertEquals(frames.length, 1);
  assertEquals(frames[0]?.event, "agent.state_changed");
  client.close();
});

Deno.test("malformed JSON and unknown event names are silently dropped", () => {
  const { client, frames } = setupClient();
  client.start();
  lastSocket().fireOpen();
  lastSocket().fireBadJson();
  lastSocket().fireUnknownFrame();
  assertEquals(frames.length, 0);
  client.close();
});

Deno.test("a server-side close triggers exponential-backoff reconnect (1s, 2s, 4s)", () => {
  const { client, clock, lifecycle } = setupClient();
  client.start();
  lastSocket().fireOpen();
  // First disconnect — backoff 1s.
  lastSocket().fireServerClose();
  assertEquals(lifecycle.at(-1), "disconnected");
  clock.advance(1000);
  // Reconnect attempt scheduled after 1s; new socket constructed and in `connecting`.
  assertEquals(MockWebSocket.instances.length, 2);
  assertEquals(lifecycle.at(-1), "connecting");

  // Second close before connecting — backoff doubles to 2s.
  lastSocket().fireServerClose();
  clock.advance(1999);
  assertEquals(MockWebSocket.instances.length, 2, "must wait full 2s before reconnecting");
  clock.advance(1);
  assertEquals(MockWebSocket.instances.length, 3);

  // Third close — backoff doubles to 4s.
  lastSocket().fireServerClose();
  clock.advance(3999);
  assertEquals(MockWebSocket.instances.length, 3);
  clock.advance(1);
  assertEquals(MockWebSocket.instances.length, 4);

  client.close();
});

Deno.test("a clean reconnect resets the backoff to the initial delay", () => {
  const { client, clock } = setupClient();
  client.start();
  lastSocket().fireOpen();
  lastSocket().fireServerClose();
  clock.advance(1000);
  // Successful reconnect.
  lastSocket().fireOpen();
  // Drop again — backoff should be 1s, not 2s.
  lastSocket().fireServerClose();
  clock.advance(999);
  assertEquals(MockWebSocket.instances.length, 2);
  clock.advance(1);
  assertEquals(MockWebSocket.instances.length, 3);
  client.close();
});

Deno.test("close() cancels pending reconnect timers and stops the loop", () => {
  const { client, clock, lifecycle } = setupClient();
  client.start();
  lastSocket().fireOpen();
  lastSocket().fireServerClose();
  // Pending reconnect timer is queued; close() cancels it.
  client.close();
  clock.advance(60000);
  assertEquals(MockWebSocket.instances.length, 1);
  assertEquals(lifecycle.at(-1), "disconnected");
});

Deno.test("event and lifecycle unsubscribers stop further callbacks", () => {
  const { client, frames, lifecycle } = setupClient();
  const offFrame = client.onEvent(() => {
    throw new Error("must not fire after unsubscribe");
  });
  const offLifecycle = client.onLifecycle(() => {
    throw new Error("must not fire after unsubscribe");
  });
  offFrame();
  offLifecycle();
  client.start();
  lastSocket().fireOpen();
  lastSocket().fireFrame(makeFrame());
  // The two listeners registered inside setupClient are still alive and
  // should have recorded the frame and the lifecycle transitions.
  assertEquals(frames.length, 1);
  assert(lifecycle.length >= 2);
  client.close();
});
