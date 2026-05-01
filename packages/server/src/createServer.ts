/**
 * `createServer` — composition root for the orchestration HTTP server.
 *
 * Builds a `Hono` app with the documented middleware order
 * (`requestId → requestLog → roleIdentity → routes`) and mounts the
 * five route groups (`/tickets`, `/prs`, `/activity`, `/agents`,
 * `/events`). The `errorBoundary` is registered via `app.onError(...)`
 * rather than as a regular middleware, because in Hono v4 only the
 * `onError` hook catches errors thrown by downstream handlers
 * (`design.md` Decision 8, `spec.md` §"Composition-root middleware
 * order").
 *
 * Pure factory — no `Deno.serve`, no signal handling, no env reads.
 * Tests drive the returned app via `app.fetch(new Request(...))`; the
 * production `startServer` binds it to a port. The factory accepts an
 * `EventBus` and an `AgentRuntimeStateStore` so the same app can be
 * built with in-memory adapters in tests and the real ones in
 * `runServer`.
 *
 * @module
 */

import { Hono } from "@hono/hono";
import type {
  ActivityLogStore,
  ConfigStore,
  ErrorResponse,
  PRStore,
  TicketStore,
} from "@keni/shared";
import type { AgentRuntimeStateStore } from "./agentState.ts";
import type { EventBus } from "./eventBus.ts";
import { errorBoundary } from "./middleware/errorBoundary.ts";
import { requestId } from "./middleware/requestId.ts";
import { requestLog } from "./middleware/requestLog.ts";
import { roleIdentity } from "./middleware/roleIdentity.ts";
import type { LogSink, ServerVariables } from "./middleware/types.ts";
import { activityRoutes } from "./routes/activity.ts";
import { agentsRoutes } from "./routes/agents.ts";
import { eventsRoute } from "./routes/events.ts";
import { prsRoutes } from "./routes/prs.ts";
import { ticketsRoutes } from "./routes/tickets.ts";

/**
 * Storage and sink dependencies for the orchestration server. The
 * composition root binds concrete file-backed implementations once;
 * integration tests pass in-memory ones.
 */
export interface ServerDeps {
  readonly ticketStore: TicketStore;
  readonly prStore: PRStore;
  readonly activityLogStore: ActivityLogStore;
  readonly configStore: ConfigStore;
  readonly logSink: LogSink;
  /** Process-local pub/sub for `EventFrame` fan-out to the WS endpoint. */
  readonly eventBus: EventBus;
  /** In-memory store for the project's agent roster + transient runtime state. */
  readonly agentRuntimeStateStore: AgentRuntimeStateStore;
}

/** Per-process server options (resolved by `runServer` from CLI flags). */
export interface ServerOptions {
  /** UUIDv4 carried by `project.yaml`; stamped on every response envelope. */
  readonly projectId: string;
}

/**
 * Build the Hono app. Idempotent and side-effect-free: no port binding,
 * no filesystem access. The caller is responsible for
 * `Deno.serve(app.fetch)`.
 *
 * Middleware registration order (documented in `spec.md`):
 *
 *  1. `requestId` — assigns/echoes `X-Keni-Request-Id`.
 *  2. `requestLog` — runs *before* role validation so failures still log.
 *  3. `roleIdentity` — populates `c.var.role` / `c.var.agent`. The
 *     fallback consults `?role=<role>` only on the `/events` upgrade
 *     path (browsers cannot set arbitrary headers on
 *     `new WebSocket(...)`); REST routes still require the
 *     `X-Keni-Role` header.
 *  4. routes — `/tickets`, `/prs`, `/activity`, `/agents`, `/events`.
 *
 * `errorBoundary` is installed via `app.onError(...)`; it is the
 * "fourth link" semantically, but Hono v4 forces it onto the `onError`
 * hook.
 */
export function createServer(
  deps: ServerDeps,
  opts: ServerOptions,
): Hono<{ Variables: ServerVariables }> {
  const app = new Hono<{ Variables: ServerVariables }>();

  app.use(requestId());
  app.use(requestLog(deps.logSink, opts.projectId));
  app.use(
    roleIdentity({
      fallback: (c) => c.req.path === "/events" ? c.req.query("role") : undefined,
    }),
  );

  app.onError(errorBoundary(opts.projectId));
  app.notFound((c) => {
    const body: ErrorResponse = {
      error: {
        code: "store_not_found",
        message: `No route for ${c.req.method} ${c.req.path}`,
        details: { method: c.req.method, path: c.req.path },
      },
      project_id: opts.projectId,
    };
    return c.json(body, 404);
  });

  app.route(
    "/tickets",
    ticketsRoutes(deps.ticketStore, deps.eventBus, opts.projectId),
  );
  app.route(
    "/prs",
    prsRoutes(deps.prStore, deps.eventBus, opts.projectId),
  );
  app.route(
    "/activity",
    activityRoutes(
      deps.activityLogStore,
      deps.agentRuntimeStateStore,
      deps.eventBus,
      opts.projectId,
    ),
  );
  app.route(
    "/agents",
    agentsRoutes(deps.agentRuntimeStateStore, deps.eventBus, opts.projectId),
  );
  app.route("/events", eventsRoute(deps.eventBus));

  return app;
}
