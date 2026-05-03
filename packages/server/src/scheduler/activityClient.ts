/**
 * Scheduler-owned activity-log adapter.
 *
 * The scheduler reaches the activity log only through `POST /activity`
 * (same constraint the role runtime obeys, `design.md` Decision 10).
 * Two append helpers cover the scheduler's two human-readable event
 * causes:
 *
 *  - `session_interrupted` — emitted from `Scheduler.interrupt(agentId)`
 *    after `abort()` fires. The runtime's own `session_end`
 *    (`refs.terminated_by: "sigterm"`) follows on its usual path.
 *  - `session_timeout` — emitted from the per-cycle wall-clock timeout's
 *    expiry handler after `abort()` fires. Same dual-row pattern.
 *
 * Both helpers swallow non-2xx responses and network failures with a
 * single warn-level log line (`scheduler.activity_post_failed`) and
 * return `{ posted: false, status }`. The caller (the scheduler) does
 * not throw out of `interrupt()` or out of the timeout's expiry on a
 * post failure — the user-facing operation succeeded; the missing log
 * row is a reportable warning.
 *
 * Identity headers (`X-Keni-Role`, `X-Keni-Agent`,
 * `Content-Type: application/json`) match the orchestration server's
 * role-identity middleware contract.
 *
 * @module
 */

import type { Role } from "@keni/shared";
import type { SchedulerLogger } from "./log.ts";

/** Outcome of one append call. */
export interface ActivityPostResult {
  readonly posted: boolean;
  /** HTTP status when the POST round-tripped; `0` on a fetch failure. */
  readonly status: number;
}

/** Common inputs for both helpers. */
export interface AppendSessionEventInput {
  readonly serverUrl: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly role: Role;
}

/** Append `session_interrupted` for the supplied cycle. */
export function appendSessionInterrupted(
  input: AppendSessionEventInput,
  logger: SchedulerLogger,
): Promise<ActivityPostResult> {
  return postSessionEvent({
    ...input,
    event: "session_interrupted",
    reason: "interrupt",
    logger,
  });
}

/** Append `session_timeout` for the supplied cycle. */
export function appendSessionTimeout(
  input: AppendSessionEventInput,
  logger: SchedulerLogger,
): Promise<ActivityPostResult> {
  return postSessionEvent({
    ...input,
    event: "session_timeout",
    reason: "timeout",
    logger,
  });
}

interface InternalArgs extends AppendSessionEventInput {
  readonly event: "session_interrupted" | "session_timeout";
  readonly reason: "interrupt" | "timeout";
  readonly logger: SchedulerLogger;
}

async function postSessionEvent(args: InternalArgs): Promise<ActivityPostResult> {
  const url = `${args.serverUrl}/activity`;
  const body = JSON.stringify({
    session_id: args.sessionId,
    agent: args.agentId,
    role: args.role,
    event: args.event,
    summary: null,
    refs: { reason: args.reason },
  });
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keni-Role": args.role,
        "X-Keni-Agent": args.agentId,
      },
      body,
    });
  } catch (cause) {
    args.logger.log("warn", "scheduler.activity_post_failed", {
      event: args.event,
      agent: args.agentId,
      role: args.role,
      session_id: args.sessionId,
      status: 0,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return { posted: false, status: 0 };
  }
  try {
    await response.body?.cancel();
  } catch {
    // best-effort: response body already consumed or cancelled
  }
  if (!response.ok) {
    args.logger.log("warn", "scheduler.activity_post_failed", {
      event: args.event,
      agent: args.agentId,
      role: args.role,
      session_id: args.sessionId,
      status: response.status,
    });
    return { posted: false, status: response.status };
  }
  return { posted: true, status: response.status };
}
