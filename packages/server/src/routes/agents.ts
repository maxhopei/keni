/**
 * Agents REST routes — read-only roster + pause / resume / interrupt
 * affordances.
 *
 * Four endpoints:
 *
 *  - `GET /` — list every configured agent joined with runtime state. No
 *    role guard beyond the standard `roleIdentity` middleware: every
 *    authenticated role is authorised to read the roster (the dashboard
 *    renders it for the user; the engineer / qa / po runtimes consume
 *    the same shape over the MCP server in step 06).
 *  - `POST /:id/pause` — set the `paused` flag to `true`. User-only
 *    (`design.md` §6.1 — pause is a user-driven affordance the future
 *    scheduler in step 08 honours). Idempotent: calling twice in a row
 *    returns 200 both times and emits `agent.state_changed` only once.
 *  - `POST /:id/resume` — clear the `paused` flag. Same role guard,
 *    same idempotence.
 *  - `POST /:id/interrupt` — abort the agent's in-flight cycle by
 *    delegating to `Scheduler.interrupt(agentId)` (`spec.md` §7.5,
 *    `interrupt-and-timeout-ux` capability). User-only. Both
 *    "interrupted" and "no active cycle" map to `200`; an unknown
 *    agent maps to `404`. The route does NOT auto-revert the ticket's
 *    on-disk status — the scheduler's `session_interrupted` activity
 *    post (issued synchronously inside `scheduler.interrupt`) drives
 *    the runtime-state `last_activity` flip via the existing
 *    `applyActivityEvent` path, so the response body's `last_activity`
 *    is `"session_interrupted"` on the happy path.
 *
 * Errors flow through the existing `errorBoundary`:
 * - `StoreNotFoundError` → 404 `store_not_found` (unknown agent id).
 * - `RoleNotOwnerError(role, "pause_agent" | "resume_agent" |
 *   "interrupt_agent")` → 403 `role_not_owner` (any non-user role).
 *
 * Pause / resume / interrupt do NOT emit a `manual_override` activity
 * entry. The `manual_override` flow in step 25 applies only to status
 * transitions on tickets / PRs (where stale-state semantics matter);
 * pause / resume are flag flips and interrupt is an abort verb whose
 * record on the activity log is `session_interrupted` (already specced
 * by the `scheduler` capability).
 *
 * @module
 */

import { Hono } from "@hono/hono";
import type { AgentEnvelope, AgentListResponse, AgentResponse, Role } from "@keni/shared";
import type { AgentRuntimeState, AgentRuntimeStateStore } from "../agentState.ts";
import { RoleNotOwnerError } from "../errors.ts";
import { emitFrame, type EventBus } from "../eventBus.ts";
import type { LogSink, ServerVariables } from "../middleware/types.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";

/**
 * Persister called from the pause/resume handlers AFTER `agent.state_changed`
 * fires, only when the call actually flipped (`changed: true`). The
 * orchestration server warn-logs and proceeds on rejection so a transient
 * `state.json` write failure never blocks the user.
 */
export type PausedAgentsPersister = (paused: readonly string[]) => Promise<void>;

/** Roles authorised to call `POST /:id/pause` / `resume` / `interrupt`. User-only by spec. */
const AGENT_CONTROL_OWNERS: readonly Role[] = ["user"];

/**
 * Lazy access to the live scheduler handle. The orchestration server's
 * Hono app is built (via `createServer`) before the scheduler is
 * constructed (the scheduler needs the bound server URL); `runServer`
 * passes a closure that returns the live handle once it has been
 * created.
 */
export type SchedulerProvider = () => Scheduler | null;

/** Build the `/agents` sub-app. */
export function agentsRoutes(
  store: AgentRuntimeStateStore,
  bus: EventBus,
  projectId: string,
  getScheduler?: SchedulerProvider,
  pausedAgentsPersister?: PausedAgentsPersister,
  logSink?: LogSink,
): Hono<{ Variables: ServerVariables }> {
  const app = new Hono<{ Variables: ServerVariables }>();

  app.get("/", (c) => {
    const body: AgentListResponse = {
      data: store.list().map(toAgentResponse),
      project_id: projectId,
    };
    return c.json(body);
  });

  app.post("/:id/pause", async (c) => {
    assertRoleCanControlAgent(c.var.role, "pause_agent");
    const id = c.req.param("id");
    const { state, changed } = store.setPaused(id, true);
    if (changed) {
      emitAgentStateChanged(bus, projectId, state);
      await persistPausedSnapshot(store, pausedAgentsPersister, logSink, c.var.request_id);
    }
    return c.json(toAgentEnvelope(state, projectId));
  });

  app.post("/:id/resume", async (c) => {
    assertRoleCanControlAgent(c.var.role, "resume_agent");
    const id = c.req.param("id");
    const { state, changed } = store.setPaused(id, false);
    if (changed) {
      emitAgentStateChanged(bus, projectId, state);
      await persistPausedSnapshot(store, pausedAgentsPersister, logSink, c.var.request_id);
    }
    return c.json(toAgentEnvelope(state, projectId));
  });

  app.post("/:id/interrupt", async (c) => {
    assertRoleCanControlAgent(c.var.role, "interrupt_agent");
    const id = c.req.param("id");
    // Pre-check the roster so an unknown agent surfaces as 404 via
    // the canonical `StoreNotFoundError` path (the scheduler also
    // returns `unknown_agent`, but we want the response body to use
    // the same envelope as pause/resume on the same condition).
    store.read(id);
    const scheduler = getScheduler?.() ?? null;
    if (scheduler === null) {
      // The route is mounted but the scheduler was not wired. This
      // is a deployment misconfiguration; surface 500 internal_error.
      throw new Error("interrupt route called but scheduler is not configured");
    }
    const result = await scheduler.interrupt(id);
    if (result.interrupted === false && result.reason === "unknown_agent") {
      // Defensive: the pre-check above should have caught this, but
      // a race (agent removed mid-call) lands here. Emit the canonical
      // 404 by re-reading the store (which throws StoreNotFoundError).
      store.read(id);
    }
    // Both `interrupted: true` and `interrupted: false / no_active_cycle`
    // resolve to 200 with the post-call runtime state. The scheduler's
    // synchronous `POST /activity` for `session_interrupted` runs
    // before this `await` resolves on the happy path, so
    // `store.read(id)` already reflects `last_activity:
    // "session_interrupted"` and `status: "idle"`.
    return c.json(toAgentEnvelope(store.read(id), projectId));
  });

  return app;
}

/** Allow `user` only (other roles raise `RoleNotOwnerError`). */
export function assertRoleCanControlAgent(
  role: Role,
  target: "pause_agent" | "resume_agent" | "interrupt_agent",
): void {
  if (!AGENT_CONTROL_OWNERS.includes(role)) {
    throw new RoleNotOwnerError(role, target);
  }
}

function emitAgentStateChanged(
  bus: EventBus,
  projectId: string,
  state: AgentRuntimeState,
): void {
  emitFrame(bus, projectId, "agent.state_changed", {
    agent_id: state.id,
    paused: state.paused,
    status: state.status,
  });
}

function toAgentResponse(state: AgentRuntimeState): AgentResponse {
  return {
    id: state.id,
    role: state.role,
    status: state.status,
    last_activity: state.last_activity,
    last_active_at: state.last_active_at,
    paused: state.paused,
  };
}

function toAgentEnvelope(state: AgentRuntimeState, projectId: string): AgentEnvelope {
  return { data: toAgentResponse(state), project_id: projectId };
}

/**
 * Snapshot the currently-paused agent ids and forward to the persister.
 * Rejection is logged (best-effort via the request-log sink as a synthetic
 * line) and DOES NOT fail the request — `state.json` is a recovery seam,
 * not a transactional store.
 *
 * The synthetic log line uses the existing `LogSink` shape so operators
 * see the failure on the same JSONL stream as request logs. When
 * `logSink` is omitted (existing test call sites that did not opt in),
 * the rejection is silently swallowed.
 */
async function persistPausedSnapshot(
  store: AgentRuntimeStateStore,
  persister: PausedAgentsPersister | undefined,
  logSink: LogSink | undefined,
  requestId: string | undefined,
): Promise<void> {
  if (persister === undefined) return;
  const paused = store.list().filter((a) => a.paused).map((a) => a.id);
  try {
    await persister(paused);
  } catch (e) {
    if (logSink !== undefined) {
      const reason = e instanceof Error ? e.message : String(e);
      await logSink.write({
        request_id: requestId ?? "",
        timestamp: new Date().toISOString(),
        method: "INTERNAL",
        path: "/agents/pause-persister",
        status: 0,
        duration_ms: 0,
        role: null,
        agent: null,
        project_id: "",
        error_code: `paused_agents_persist_failed: ${reason}`,
      });
    }
  }
}
