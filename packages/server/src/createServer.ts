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
import type { Scheduler } from "./scheduler/scheduler.ts";
import type { Mutex } from "./concurrency/mutex.ts";
import { createMutex } from "./concurrency/mutex.ts";
import { errorBoundary } from "./middleware/errorBoundary.ts";
import { requestId } from "./middleware/requestId.ts";
import { requestLog } from "./middleware/requestLog.ts";
import { roleIdentity } from "./middleware/roleIdentity.ts";
import type { LogSink, ServerVariables } from "./middleware/types.ts";
import { isRestPrefixed } from "./restPrefixes.ts";
import { activityRoutes } from "./routes/activity.ts";
import { agentsRoutes } from "./routes/agents.ts";
import { eventsRoute } from "./routes/events.ts";
import { healthRoute } from "./routes/health.ts";
import { prsRoutes } from "./routes/prs.ts";
import { mountStaticSpa, validateStaticAssetsRoot } from "./routes/static.ts";
import { ticketsRoutes } from "./routes/tickets.ts";
import type { WorkspaceProvisioner } from "@keni/role-runtimes";

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
  /**
   * Optional handle to the in-process role-runtime scheduler. `runServer`
   * instantiates the scheduler AFTER `startServer` (the scheduler needs
   * the bound server URL), so this field is always supplied as a
   * thunk: the route handlers dereference it lazily at request time.
   * The thunk returns `null` until the scheduler has been wired; the
   * `POST /agents/:id/interrupt` route surfaces a 500 in that window.
   *
   * Tests that exercise the interrupt route pass a thunk that returns
   * a fake scheduler. Tests that don't exercise it omit this field
   * (the route is mounted but never called).
   */
  readonly getScheduler?: () => Scheduler | null;
  /**
   * Optional engineer-workspace provisioner. When supplied together with
   * `projectRepoPath`, `createServer` mounts `POST /prs/:id/merge` and
   * uses `mergeMutex` to serialise `git merge --ff-only` against the
   * project repo (engineer-runtime spec § "Engineer prompt sequencing
   * for merge"; orchestration-server spec § "`POST /prs/:id/merge`…").
   *
   * Tests that don't exercise the merge endpoint omit these fields and
   * the route is not registered.
   */
  readonly workspaceProvisioner?: WorkspaceProvisioner;
  /** Absolute path to the on-disk project git repo used by `merge_pr`. */
  readonly projectRepoPath?: string;
  /**
   * Optional shared mutex for `git merge --ff-only`. When omitted but
   * `workspaceProvisioner`+`projectRepoPath` are present, `createServer`
   * builds a fresh in-process mutex. Production wires the same mutex
   * across `runServer` so engineer parallelism never crosses paths.
   */
  readonly mergeMutex?: Mutex;
  /** Override `git` binary path for merge tests. */
  readonly gitBinary?: string;
  /**
   * Wall-clock moment the orchestration server became reachable. Captured
   * by `runServer` immediately after `Deno.serve.onListen` fires (the
   * `cli-start-and-end-to-end-wiring` change extends `runServer` to forward
   * the value through `StartServerOptions`). The `/health` route reads it
   * via a thunk so the value is observable to tests that opt in.
   *
   * Optional — when omitted (existing test call sites that did not opt in),
   * the `/health` route's `uptime_ms` field is `0`.
   */
  readonly serverStartedAt?: Date;
  /**
   * Optional persister called from the `/agents/:id/pause` and
   * `/agents/:id/resume` route handlers AFTER the `agent.state_changed`
   * frame is emitted, only when the call actually flipped (`changed: true`).
   * Receives the post-call snapshot of agent ids whose `paused` flag is
   * `true`, in roster order.
   *
   * The orchestration server warn-logs and proceeds on rejection (the user
   * is not blocked by a transient `state.json` write failure); when the
   * field is absent, the call is skipped silently. The `cli-start`
   * capability wires this to `persistPausedAgents` against
   * `<projectDir>/.keni/state.json`; tests pass an in-memory recorder.
   */
  readonly pausedAgentsPersister?: (paused: readonly string[]) => Promise<void>;
  /**
   * Absolute path to the SPA's production bundle (`packages/spa/dist/`).
   * When supplied, `createServer` mounts the static SPA route group AFTER
   * the REST routes (so REST endpoints win route ordering) and validates
   * the path synchronously (`StaticAssetsRootInvalid` becomes the
   * `createServer` throw on missing `index.html`).
   *
   * Optional — when omitted (existing test call sites that did not opt in),
   * the static SPA route group is not mounted and `GET /` returns the
   * canonical 404 envelope.
   */
  readonly staticAssetsRoot?: string;
}

/** Per-process server options (resolved by `runServer` from CLI flags). */
export interface ServerOptions {
  /** UUIDv4 carried by `project.yaml`; stamped on every response envelope. */
  readonly projectId: string;
}

/**
 * Build the Hono app. Idempotent and side-effect-free: no port binding,
 * no filesystem access (with one exception — when `staticAssetsRoot` is
 * supplied, `validateStaticAssetsRoot` does a `Deno.statSync` on it; the
 * call is synchronous so the throw becomes the `createServer` exception).
 *
 * Middleware registration order (documented in `spec.md`):
 *
 *  1. `requestId` — assigns/echoes `X-Keni-Request-Id`.
 *  2. `requestLog` — runs *before* role validation so failures still log.
 *  3. `/health` carve-out — registered BEFORE `roleIdentity` so the
 *     supervisor probe is unauthenticated. The carve-out applies ONLY
 *     to `/health`; every other route still requires the role header.
 *  4. `roleIdentity` — populates `c.var.role` / `c.var.agent`. The
 *     fallback consults `?role=<role>` only on the `/events` upgrade
 *     path (browsers cannot set arbitrary headers on
 *     `new WebSocket(...)`); REST routes still require the
 *     `X-Keni-Role` header.
 *  5. REST routes — `/tickets`, `/prs`, `/activity`, `/agents`, `/events`.
 *  6. Static SPA route group — mounted AFTER the REST routes (so REST
 *     endpoints win route ordering) and only when `staticAssetsRoot` is
 *     supplied. The fallthrough handler consults `REST_PREFIXES` to
 *     decide whether an unmatched GET path should serve `index.html`.
 *
 * `errorBoundary` is installed via `app.onError(...)`; it is the
 * "last link" semantically, but Hono v4 forces it onto the `onError`
 * hook.
 *
 * @throws {StaticAssetsRootInvalid} when `staticAssetsRoot` is supplied
 *   but the path does not exist or does not contain `index.html`.
 */
export function createServer(
  deps: ServerDeps,
  opts: ServerOptions,
): Hono<{ Variables: ServerVariables }> {
  if (deps.staticAssetsRoot !== undefined) {
    validateStaticAssetsRoot(deps.staticAssetsRoot);
  }

  const app = new Hono<{ Variables: ServerVariables }>();

  app.use(requestId());
  app.use(requestLog(deps.logSink, opts.projectId));

  app.route(
    "/health",
    healthRoute(opts.projectId, () => deps.serverStartedAt),
  );

  // When a static SPA bundle is mounted, exempt non-REST GET requests
  // from the role guard so browsers can fetch `/`, `/assets/*`, and
  // any deep-link fallthrough without setting `X-Keni-Role`. The
  // exemption applies ONLY to GET requests whose path is not in the
  // closed `REST_PREFIXES` allowlist; every REST endpoint still
  // requires the header verbatim. The `cli-start-and-end-to-end-wiring`
  // change introduces this carve-out (see the static-SPA delta on the
  // `orchestration-server` capability spec).
  const spaMounted = deps.staticAssetsRoot !== undefined;
  app.use(
    roleIdentity({
      fallback: (c) => c.req.path === "/events" ? c.req.query("role") : undefined,
      ...(spaMounted
        ? {
          exempt: (c) => c.req.method === "GET" && !isRestPrefixed(c.req.path),
        }
        : {}),
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
  const mergeDeps = deps.workspaceProvisioner && deps.projectRepoPath
    ? {
      activityLogStore: deps.activityLogStore,
      workspaceProvisioner: deps.workspaceProvisioner,
      projectRepoPath: deps.projectRepoPath,
      mergeMutex: deps.mergeMutex ?? createMutex(),
      projectId: opts.projectId,
      gitBinary: deps.gitBinary,
    }
    : undefined;
  app.route(
    "/prs",
    prsRoutes(deps.prStore, deps.eventBus, opts.projectId, mergeDeps),
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
    agentsRoutes(
      deps.agentRuntimeStateStore,
      deps.eventBus,
      opts.projectId,
      deps.getScheduler,
      deps.pausedAgentsPersister,
      deps.logSink,
    ),
  );
  app.route("/events", eventsRoute(deps.eventBus));

  if (deps.staticAssetsRoot !== undefined) {
    mountStaticSpa(app, { staticAssetsRoot: deps.staticAssetsRoot });
  }

  return app;
}
