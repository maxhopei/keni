/**
 * Agents REST routes — read-only roster + pause / resume affordance.
 *
 * Three endpoints:
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
 *
 * Errors flow through the existing `errorBoundary`:
 * - `StoreNotFoundError` → 404 `store_not_found` (unknown agent id).
 * - `RoleNotOwnerError(role, "pause_agent" | "resume_agent")` → 403
 *   `role_not_owner` (any non-user role).
 *
 * Pause / resume do NOT emit a `manual_override` activity entry. The
 * `manual_override` flow in step 25 applies only to status transitions
 * on tickets / PRs (where stale-state semantics matter); pause / resume
 * are flag flips and are recorded by `agent.state_changed` on the bus
 * and the `paused` field on the next `GET /agents` response.
 *
 * @module
 */

import { Hono } from "@hono/hono";
import type { AgentEnvelope, AgentListResponse, AgentResponse, Role } from "@keni/shared";
import type { AgentRuntimeState, AgentRuntimeStateStore } from "../agentState.ts";
import { RoleNotOwnerError } from "../errors.ts";
import { emitFrame, type EventBus } from "../eventBus.ts";
import type { ServerVariables } from "../middleware/types.ts";

/** Roles authorised to call `POST /:id/pause` / `resume`. User-only by spec. */
const AGENT_CONTROL_OWNERS: readonly Role[] = ["user"];

/** Build the `/agents` sub-app. */
export function agentsRoutes(
  store: AgentRuntimeStateStore,
  bus: EventBus,
  projectId: string,
): Hono<{ Variables: ServerVariables }> {
  const app = new Hono<{ Variables: ServerVariables }>();

  app.get("/", (c) => {
    const body: AgentListResponse = {
      data: store.list().map(toAgentResponse),
      project_id: projectId,
    };
    return c.json(body);
  });

  app.post("/:id/pause", (c) => {
    assertRoleCanControlAgent(c.var.role, "pause_agent");
    const id = c.req.param("id");
    const { state, changed } = store.setPaused(id, true);
    if (changed) emitAgentStateChanged(bus, projectId, state);
    return c.json(toAgentEnvelope(state, projectId));
  });

  app.post("/:id/resume", (c) => {
    assertRoleCanControlAgent(c.var.role, "resume_agent");
    const id = c.req.param("id");
    const { state, changed } = store.setPaused(id, false);
    if (changed) emitAgentStateChanged(bus, projectId, state);
    return c.json(toAgentEnvelope(state, projectId));
  });

  return app;
}

/** Allow `user` only (other roles raise `RoleNotOwnerError`). */
export function assertRoleCanControlAgent(
  role: Role,
  target: "pause_agent" | "resume_agent",
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
