/**
 * `GET /events` — WebSocket endpoint that broadcasts every emitted
 * `EventFrame` as a JSON text message to every connected client.
 *
 * Composition (per the capability spec's `Requirement: GET /events
 * upgrades the connection to a WebSocket and broadcasts every emitted
 * EventFrame` and `Requirement: The WS endpoint's trust model extends
 * the role-header trust model with a ?role= query-parameter fallback`):
 *
 * - **Role identity** — read by the standard `roleIdentity` middleware
 *   *before* this handler runs. The `/events` mount in `createServer`
 *   wires a `roleIdentity({ fallback: ?role= })` so browsers (which
 *   cannot set arbitrary headers on `new WebSocket(...)`) can pass
 *   `ws://…/events?role=user`. A missing or unknown role surfaces as
 *   the documented `400 missing_role` envelope *before* the upgrade
 *   handshake is attempted.
 * - **Heartbeat** — delegated to Deno's WS runtime via the
 *   `idleTimeout` upgrade option. Deno auto-sends a protocol-level ping
 *   after `heartbeatSeconds` of idle and closes the connection with
 *   code 1011 if no pong arrives during the next idle window. With the
 *   default 25 s value that is the design's "ping every 25 s, close
 *   after a missed-pong window" semantics — modelled at the protocol
 *   level so the application-event channel stays push-only and the
 *   ping / pong frames never leak into the typed `EventFrame` stream.
 * - **Reconnect** — "client refetches via REST" (`design.md` Decision
 *   6). Every frame carries an `id` (uuidv7) so a future
 *   `?since=<event-id>` replay is purely additive on the wire shape.
 * - **Push-only** — inbound message frames are ignored
 *   (`design.md` Decision 5). The connection has no client-driven
 *   subscription protocol in the prototype.
 *
 * Lifecycle of a single connection:
 *
 *   onOpen   → bus.subscribe((frame) => ws.send(JSON.stringify(frame)))
 *   onMessage→ ignored (push-only)
 *   onClose  → unsubscribe (idempotent — `subscribed` flag guards)
 *   onError  → unsubscribe (idempotent — same flag)
 *
 * @module
 */

import { Hono } from "@hono/hono";
import { upgradeWebSocket } from "@hono/hono/deno";
import type { EventBus } from "../eventBus.ts";
import type { ServerVariables } from "../middleware/types.ts";

/**
 * Default heartbeat (idle ping) interval in seconds. Matches the value
 * named in the capability spec (`design.md` Decision 6) so a contributor
 * does not desync the client and server. Tests may pass a smaller value
 * to a hand-built `eventsRoute(bus, smallSeconds)` to exercise the
 * close-on-missed-pong branch within a tight wall-time budget.
 */
export const DEFAULT_HEARTBEAT_SECONDS = 25;

/** Build the `/events` sub-app. */
export function eventsRoute(
  bus: EventBus,
  heartbeatSeconds: number = DEFAULT_HEARTBEAT_SECONDS,
): Hono<{ Variables: ServerVariables }> {
  const app = new Hono<{ Variables: ServerVariables }>();

  app.get(
    "/",
    upgradeWebSocket(
      () => {
        let unsubscribe: (() => void) | undefined;
        let subscribed = false;

        const tearDown = (): void => {
          if (subscribed && unsubscribe !== undefined) {
            unsubscribe();
            subscribed = false;
          }
        };

        return {
          onOpen: (_evt, ws) => {
            unsubscribe = bus.subscribe((frame) => {
              if (ws.readyState !== 1) return;
              ws.send(JSON.stringify(frame));
            });
            subscribed = true;
          },
          onMessage: () => {
            // push-only channel — `design.md` Decision 5
          },
          onClose: tearDown,
          onError: tearDown,
        };
      },
      { idleTimeout: heartbeatSeconds },
    ),
  );

  return app;
}
