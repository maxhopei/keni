/**
 * Wire shapes for the orchestration server's `/agents` endpoints.
 *
 * Agent runtime state is the per-agent view rendered on the dashboard's
 * left rail (`spec.md` §7.2): the configured roster (`project.yaml`'s
 * `agents:` array) joined with transient runtime state — `status`,
 * `last_activity`, `last_active_at`, `paused`. The runtime tier is
 * **in-memory only** in the prototype; restart resets every transient
 * field. The `paused` flag is the seam to the future scheduler (step 08).
 *
 * @module
 */

/**
 * Closed status union for an agent's runtime tier. The prototype only
 * needs `idle` (no session active) and `running` (a session is active);
 * additional values (`error`, `blocked`) are post-MVP and additive.
 */
export type AgentStatus = "idle" | "running";

/** Tuple form of {@link AgentStatus} — used by zod enums and other runtime checks. */
export const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "running"] as const;

/** Type-guard for {@link AgentStatus}. */
export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value);
}

/**
 * One agent row exposed on the wire. The shape is identical to
 * `AgentRuntimeState` in `@keni/server/agentState.ts`; the server maps 1:1
 * today and the indirection leaves room for future divergence (e.g.,
 * project-config-only fields the runtime state doesn't track).
 */
export interface AgentResponse {
  readonly id: string;
  readonly role: string;
  readonly status: AgentStatus;
  /** Last activity-log event observed for this agent (e.g., `"session_start"`); `null` until the first entry arrives. */
  readonly last_activity: string | null;
  /** ISO 8601 UTC of the last activity-log event observed; `null` until the first entry arrives. */
  readonly last_active_at: string | null;
  readonly paused: boolean;
}

/** Envelope for `GET /agents`. */
export interface AgentListResponse {
  readonly data: readonly AgentResponse[];
  readonly project_id: string;
}

/** Envelope for `POST /agents/:id/pause` and `POST /agents/:id/resume`. */
export interface AgentEnvelope {
  readonly data: AgentResponse;
  readonly project_id: string;
}
