/**
 * Reconnecting WebSocket client for the orchestration server's `/events`
 * stream.
 *
 * Wire the lifecycle stream + the frame stream into the SPA's React tree
 * via `<EventsClientProvider>` and `useEventsClient()`. The client owns:
 *
 *   - exponential-backoff reconnect (`design.md` Decision 5: 1s, 2s, 4s,
 *     8s, capped at 30s; reset on a clean `connected`).
 *   - lifecycle event emission (`connecting`, `connected`, `disconnected`)
 *     so consumers (e.g. the agent roster panel) can refetch REST on a
 *     fresh `connected` and surface a "disconnected" UX state otherwise.
 *   - frame parsing via `JSON.parse` and shallow shape validation against
 *     the `EventFrame` discriminated union (`event` is one of the closed
 *     `EventName` set).
 *
 * Server-pushed only — the client never sends frames upstream.
 */

import type { EventFrame, EventName } from "@keni/shared";
import { isEventName } from "@keni/shared";

export type EventsClientLifecycle = "connecting" | "connected" | "disconnected";

export type EventListener = (frame: EventFrame) => void;
export type LifecycleListener = (state: EventsClientLifecycle) => void;

export interface EventsClient {
  readonly state: EventsClientLifecycle;
  /** Register a frame listener. Returns an unsubscriber. */
  onEvent(listener: EventListener): () => void;
  /** Register a lifecycle listener. Returns an unsubscriber. */
  onLifecycle(listener: LifecycleListener): () => void;
  /** Open the socket. Idempotent — calling twice is a no-op while open. */
  start(): void;
  /** Close the socket and stop reconnect attempts. */
  close(): void;
}

export interface CreateEventsClientOpts {
  /**
   * WebSocket URL. Default `"/events"` — relative path; relies on
   * `URL` resolution against `globalThis.location` and the Vite dev
   * proxy's `ws: true` to route to the orchestration server.
   *
   * Tests inject an absolute `ws://127.0.0.1:<port>/events` URL.
   */
  readonly url?: string;
  /** Initial backoff in ms (default 1000 — `design.md` Decision 5). */
  readonly backoffInitialMs?: number;
  /** Backoff cap in ms (default 30000). */
  readonly backoffCapMs?: number;
  /** Test seam: alternative `WebSocket` ctor (e.g., `MockWebSocket`). */
  readonly webSocketImpl?: typeof WebSocket;
  /**
   * Test seam: scheduling primitives. Defaults to the real
   * `setTimeout` / `clearTimeout`. Tests inject a fake clock to drive
   * the reconnect loop deterministically.
   */
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
}

function isEventFrame(value: unknown): value is EventFrame {
  if (typeof value !== "object" || value === null) return false;
  const event = (value as { event?: unknown }).event;
  if (!isEventName(event)) return false;
  const payload = (value as { payload?: unknown }).payload;
  return typeof payload === "object" && payload !== null;
}

function resolveUrl(url: string): string {
  // Relative path (`"/events"`) → resolve against the page origin and
  // upgrade `http://` → `ws://`. Absolute `ws://` / `wss://` URLs are
  // returned untouched (the test seam).
  if (url.startsWith("ws://") || url.startsWith("wss://")) return url;
  const base =
    typeof globalThis !== "undefined" && (globalThis as { location?: { origin?: string } }).location
      ? (globalThis as { location: { origin: string } }).location.origin
      : "http://127.0.0.1";
  const absolute = new URL(url, base);
  absolute.protocol = absolute.protocol === "https:" ? "wss:" : "ws:";
  return absolute.toString();
}

export function createEventsClient(opts: CreateEventsClientOpts = {}): EventsClient {
  const url = resolveUrl(opts.url ?? "/events");
  const backoffInitialMs = opts.backoffInitialMs ?? 1000;
  const backoffCapMs = opts.backoffCapMs ?? 30000;
  const WebSocketCtor = opts.webSocketImpl ?? WebSocket;
  const setTimeoutFn = opts.setTimeoutImpl ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutImpl ?? clearTimeout;

  const eventListeners = new Set<EventListener>();
  const lifecycleListeners = new Set<LifecycleListener>();

  let state: EventsClientLifecycle = "disconnected";
  let socket: WebSocket | null = null;
  let reconnectHandle: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = backoffInitialMs;
  let stopped = false;

  function setLifecycle(next: EventsClientLifecycle) {
    state = next;
    for (const listener of lifecycleListeners) {
      listener(next);
    }
  }

  function emitFrame(frame: EventFrame) {
    for (const listener of eventListeners) {
      listener(frame);
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectHandle !== null) return;
    const delay = Math.min(backoffMs, backoffCapMs);
    reconnectHandle = setTimeoutFn(() => {
      reconnectHandle = null;
      backoffMs = Math.min(backoffMs * 2, backoffCapMs);
      open();
    }, delay);
  }

  function open() {
    if (stopped) return;
    setLifecycle("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocketCtor(url);
    } catch {
      // Synchronous ctor failure (URL malformed in jsdom-ish environments)
      // is treated as an immediate disconnect; the next backoff tick will
      // try again.
      setLifecycle("disconnected");
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.addEventListener("open", () => {
      backoffMs = backoffInitialMs;
      setLifecycle("connected");
    });
    ws.addEventListener("close", () => {
      socket = null;
      if (stopped) return;
      setLifecycle("disconnected");
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // The matching `close` will fire and trigger the reconnect path.
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isEventFrame(parsed)) return;
      emitFrame(parsed);
    });
  }

  return {
    get state() {
      return state;
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },

    start() {
      if (socket !== null) return;
      stopped = false;
      open();
    },

    close() {
      stopped = true;
      if (reconnectHandle !== null) {
        clearTimeoutFn(reconnectHandle);
        reconnectHandle = null;
      }
      if (socket !== null) {
        socket.close();
        socket = null;
      }
      setLifecycle("disconnected");
    },
  };
}

export type { EventName };
