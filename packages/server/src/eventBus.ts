/**
 * In-process pub/sub for the orchestration server's WebSocket event stream.
 *
 * Route handlers call `bus.emit(frame)` after a successful storage write;
 * the WebSocket route subscribes one handler per connection and forwards
 * every received frame to its socket. The bus is **not** a durable queue:
 * a subscriber that misses a frame (because it disconnected, because the
 * SPA tab was backgrounded) does not see it again — the documented
 * reconnect tier is "client refetches via REST" (`design.md` Decision 6).
 *
 * Properties:
 *
 * - **Synchronous fan-out.** `emit` iterates the subscriber `Set` in
 *   insertion order and invokes each handler before returning. Handlers
 *   may be async (return a `Promise`); the bus does not await them — it
 *   is fire-and-forget so a slow / hung subscriber cannot block the
 *   request handler that called `emit`.
 * - **Subscriber-error isolation.** A handler that throws (sync) or
 *   rejects (async) has its error caught and logged at warn level via
 *   the optional `LogSink`; the emit caller observes nothing
 *   (`design.md` Decision 8).
 * - **No persistence, no replay buffer.** The wire shape carries `id`
 *   (uuidv7) so a future ring-buffered `?since=<event-id>` replay is
 *   purely additive; today the bus is the live channel only.
 * - **In-process only.** One server, one project per `spec.md` §7.1; a
 *   future cross-process pub/sub adapter would slot in behind the same
 *   `EventBus` interface.
 *
 * @module
 */

import { type EventFrame, type EventName, generateActivityId } from "@keni/shared";
import type { LogSink, RequestLogLine } from "./middleware/types.ts";

/** Handler signature accepted by {@link EventBus.subscribe}. */
export type EventBusHandler = (frame: EventFrame) => void | Promise<void>;

/** In-process pub/sub for `EventFrame` instances. See module docs for semantics. */
export interface EventBus {
  /** Fan out one frame to every subscriber synchronously, fire-and-forget. */
  emit(frame: EventFrame): void;
  /** Register a handler; returns an unsubscribe closure. */
  subscribe(handler: EventBusHandler): () => void;
  /**
   * Number of currently registered subscribers. **Test-only** seam — the
   * WS-route tests use it to assert that disconnect / error tear-downs
   * removed their handler. Production callers SHOULD NOT depend on this
   * count for control flow; it is a pure observation hook.
   */
  subscriberCount(): number;
}

/**
 * Default warn-level logger when `createInMemoryEventBus` is built without
 * an explicit `LogSink`. Writes one structured line per swallowed
 * subscriber error to `console.warn` so a `runServer` started from the
 * CLI surfaces failures even before a `requestLog` sink is wired in.
 */
function consoleWarnLogSink(): LogSink {
  return {
    write(line: RequestLogLine): void {
      console.warn(JSON.stringify(line));
    },
  };
}

/**
 * Build a warn-level structured log line shaped like {@link RequestLogLine}
 * so it round-trips through the existing sink interface. The `path` is set
 * to `"event_bus"` so a contributor grepping the log can find every
 * subscriber failure with one regex.
 */
function buildSubscriberErrorLine(frame: EventFrame, error: unknown): RequestLogLine {
  const message = error instanceof Error ? error.message : String(error);
  return {
    request_id: frame.id,
    timestamp: new Date().toISOString(),
    method: "EVENT",
    path: "event_bus",
    status: 500,
    duration_ms: 0,
    role: null,
    agent: null,
    project_id: frame.project_id,
    error_code: `subscriber_failed:${frame.event}:${message}`,
  };
}

/**
 * Build the in-memory `EventBus`. The `logSink` parameter is optional;
 * tests may pass `captureLogSink(buffer)` to assert on swallowed errors,
 * production hands in the same sink the request log uses so a single
 * stream surfaces every failure.
 */
export function createInMemoryEventBus(
  opts: { readonly logSink?: LogSink } = {},
): EventBus {
  const handlers = new Set<EventBusHandler>();
  const sink = opts.logSink ?? consoleWarnLogSink();

  return {
    emit(frame: EventFrame): void {
      for (const handler of handlers) {
        let result: void | Promise<void>;
        try {
          result = handler(frame);
        } catch (err) {
          void sink.write(buildSubscriberErrorLine(frame, err));
          continue;
        }
        if (result instanceof Promise) {
          result.catch((err) => {
            void sink.write(buildSubscriberErrorLine(frame, err));
          });
        }
      }
    },
    subscribe(handler: EventBusHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    subscriberCount(): number {
      return handlers.size;
    },
  };
}

/**
 * Map from each `EventName` discriminator to its payload type. Used to
 * type the `emitFrame` helper so a wrong (event, payload) pair fails at
 * compile time instead of producing a malformed frame on the wire.
 */
type PayloadFor<E extends EventName> = Extract<EventFrame, { event: E }>["payload"];

/**
 * Build and emit one `EventFrame` on the given bus. Generates a fresh
 * monotonic uuidv7 `id` (via the shared activity-id generator — same
 * monotonic stream so an interleaved `activity.appended` sort-order is
 * stable) and an ISO 8601 UTC `timestamp`. Returns the emitted frame so
 * callers can assert on it in tests.
 */
export function emitFrame<E extends EventName>(
  bus: EventBus,
  projectId: string,
  event: E,
  payload: PayloadFor<E>,
): EventFrame {
  const frame = {
    id: generateActivityId(),
    event,
    project_id: projectId,
    timestamp: new Date().toISOString(),
    payload,
  } as Extract<EventFrame, { event: E }>;
  bus.emit(frame);
  return frame;
}

/**
 * Test helper: capture every emitted frame in an array.
 *
 * Returns `{ buffer, subscribe }` where `subscribe(bus)` registers the
 * handler and returns the unsubscribe closure. Mirrors the existing
 * `captureLogSink(buffer)` pattern from `middleware/requestLog.ts` so the
 * route-test files can wire the bus and the log sink with one statement
 * each.
 *
 * @example
 * const { buffer, subscribe } = captureBusBuffer();
 * const bus = createInMemoryEventBus();
 * subscribe(bus);
 * // ... drive routes ...
 * assertEquals(buffer[0]!.event, "ticket.created");
 */
export function captureBusBuffer(): {
  readonly buffer: EventFrame[];
  subscribe(bus: EventBus): () => void;
} {
  const buffer: EventFrame[] = [];
  return {
    buffer,
    subscribe(bus: EventBus): () => void {
      return bus.subscribe((frame) => {
        buffer.push(frame);
      });
    },
  };
}
