/**
 * `startCycle` — the deterministic seven-step role cycle.
 *
 * Runs *one* cycle per invocation and resolves with a {@link RoleCycleResult}.
 * Implements `spec.md` §6.2 and the `role-runtime` capability spec
 * step-for-step:
 *
 *  1. Precheck. `{ kind: "skip" }` short-circuits to `precheck_skipped`
 *     with no `POST /activity` and no subprocess.
 *  2. Generate session id (uuidv7) and log `session_start`. The cycle's
 *     `sessionId` is distinct from the resumed CLI session id.
 *  3. Resolve the bundled prompt via {@link resolveBundledPrompt}. A
 *     throw is caught and surfaced as `spawn_failed` with a final
 *     `session_end` carrying `refs.spawn_failed: "true"`.
 *  4. Build the {@link CodingAgentInvocation} bag. `resumeSessionId` is
 *     plumbed through verbatim; an empty string is rejected at the cycle
 *     boundary as `RoleRuntimeError("invalid_resume_session_id")`.
 *  5. Spawn and stream. `onStdoutLine` / `onStderrLine` push into a
 *     summary buffer (unbounded) and emit `subprocess_stdout` /
 *     `subprocess_stderr` (capped at `maxLinesPerStream`). On the cap's
 *     last line, one `subprocess_output_truncated` entry is emitted; the
 *     summary buffer keeps capturing for the genuine last-line rule.
 *  6. Idle detection. `kind: "completed", exitCode: 0`, wall time below
 *     `idleThresholdMs` (default 250 ms), and no non-empty stdout lines
 *     emit `idle` and return `{ outcome: "idle", sessionId }`.
 *  7. Capture summary + emit session_end. The summary is the last
 *     non-empty trimmed stdout line ({@link extractSummaryLine}); refs
 *     stamp `exit_code` and (for terminated) `terminated_by`.
 *
 * Activity-log adapter throws bubble up through the cycle's `try`/`catch`
 * and surface as `spawn_failed` with a best-effort final `session_end`.
 *
 * @module
 */

import { generate as generateUuidV7 } from "@std/uuid/v7";
import {
  type ActivityLogClient,
  type ActivityLogClientOpts,
  createActivityLogClient,
} from "./activityClient.ts";
import { resolveBundledPrompt } from "./promptResolver.ts";
import { extractSummaryLine } from "./summaryLine.ts";
import {
  type CodingAgentInvocation,
  type CodingAgentLifecycle,
  type CodingAgentOutcome,
  type CyclePrepCtx,
  type RoleCycleParams,
  type RoleCycleResult,
  RoleRuntimeError,
} from "./types.ts";

const DEFAULT_IDLE_THRESHOLD_MS = 250;
const DEFAULT_MAX_LINES_PER_STREAM = 1000;

/**
 * Public surface of this module. The cycle is a single function; every
 * decision-making field lives on `params`.
 *
 * Optional `opts.createClient` exists for tests that need to inject a
 * fake activity-log client. The default uses the real HTTP adapter.
 *
 * Optional `opts.onSessionId` is invoked synchronously immediately
 * after `sessionId` is generated and before any `POST /activity` is
 * issued. The scheduler (`packages/server/src/scheduler/`) wires this
 * to capture the cycle's runtime session id so a subsequent
 * `interrupt` or wall-clock `timeout` can stamp the same id on its
 * `session_interrupted` / `session_timeout` activity entry. The
 * callback SHALL NOT throw; runtime exceptions are caught and ignored
 * so the cycle remains decoupled from observers.
 */
export interface StartCycleOptions {
  readonly createClient?: (opts: ActivityLogClientOpts) => ActivityLogClient;
  readonly onSessionId?: (sessionId: string) => void;
}

export async function startCycle(
  params: RoleCycleParams,
  opts: StartCycleOptions = {},
): Promise<RoleCycleResult> {
  const prepCtx: CyclePrepCtx = {
    role: params.role,
    agentId: params.agentId,
    projectName: params.projectName,
    workspacePath: params.workspacePath ?? null,
    serverUrl: params.serverUrl,
  };

  const precheck = await params.precheck(prepCtx);
  if (precheck.kind === "skip") {
    return { outcome: "precheck_skipped", reason: precheck.reason };
  }

  const sessionId = generateUuidV7();
  if (opts.onSessionId !== undefined) {
    try {
      opts.onSessionId(sessionId);
    } catch {
      // Observer error is non-fatal: the cycle owns the id; observers
      // (e.g., the scheduler) opt in to receive it for labelling and
      // must not be able to crash the cycle.
    }
  }
  const create = opts.createClient ?? createActivityLogClient;
  const activity = create({
    serverUrl: params.serverUrl,
    agentId: params.agentId,
    role: params.role,
  });

  if (params.resumeSessionId !== undefined && params.resumeSessionId.length === 0) {
    return {
      outcome: "spawn_failed",
      sessionId,
      error: new RoleRuntimeError(
        "invalid_resume_session_id",
        "resumeSessionId must be a non-empty string when provided",
      ),
    };
  }

  const sessionStartRefs: Record<string, string> = {};
  if (params.resumeSessionId !== undefined) {
    sessionStartRefs.resume_session_id = params.resumeSessionId;
  }

  try {
    await activity.appendSessionStart({
      sessionId,
      summary: precheck.kind === "proceed" ? precheck.roleContext?.summary ?? null : null,
      ...(Object.keys(sessionStartRefs).length > 0 ? { refs: sessionStartRefs } : {}),
    });
  } catch (err) {
    return {
      outcome: "spawn_failed",
      sessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  let prompt;
  try {
    prompt = resolveBundledPrompt(params.promptResolver(prepCtx), params.expectedPromptName);
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    await tryAppendFinalFailure(activity, sessionId, wrapped);
    return { outcome: "spawn_failed", sessionId, error: wrapped };
  }

  const invocation: CodingAgentInvocation = {
    promptBody: prompt.body,
    role: params.role,
    agentId: params.agentId,
    projectName: params.projectName,
    workspacePath: params.workspacePath ?? null,
    mcpServerConfig: params.mcpServerConfig,
    resumeSessionId: params.resumeSessionId ?? null,
    envAllowlist: params.envAllowlist ?? [],
  };

  const stdoutBuffer: string[] = [];
  const stderrBuffer: string[] = [];
  const maxLinesPerStream = params.maxLinesPerStream ?? DEFAULT_MAX_LINES_PER_STREAM;
  let stdoutEmitted = 0;
  let stderrEmitted = 0;
  let stdoutTruncationLogged = false;
  let stderrTruncationLogged = false;
  let stdoutDropped = 0;
  let stderrDropped = 0;
  const activityErrors: Error[] = [];

  function recordActivityError(err: unknown): void {
    if (err instanceof Error) activityErrors.push(err);
    else activityErrors.push(new Error(String(err)));
  }

  const lifecycle: CodingAgentLifecycle = {
    onStdoutLine: async (line) => {
      stdoutBuffer.push(line);
      if (stdoutEmitted < maxLinesPerStream) {
        try {
          await activity.appendSubprocessOutput({
            sessionId,
            streamKind: "stdout",
            line,
          });
        } catch (err) {
          recordActivityError(err);
        }
        stdoutEmitted++;
      } else {
        stdoutDropped++;
        if (!stdoutTruncationLogged) {
          stdoutTruncationLogged = true;
        }
      }
    },
    onStderrLine: async (line) => {
      stderrBuffer.push(line);
      if (stderrEmitted < maxLinesPerStream) {
        try {
          await activity.appendSubprocessOutput({
            sessionId,
            streamKind: "stderr",
            line,
          });
        } catch (err) {
          recordActivityError(err);
        }
        stderrEmitted++;
      } else {
        stderrDropped++;
        if (!stderrTruncationLogged) {
          stderrTruncationLogged = true;
        }
      }
    },
    abortSignal: params.signal,
  };

  const cycleStartTime = performance.now();
  let outcome: CodingAgentOutcome;
  try {
    outcome = await params.codingAgentInvoker.invoke(invocation, lifecycle);
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    await tryAppendFinalFailure(activity, sessionId, wrapped);
    return { outcome: "spawn_failed", sessionId, error: wrapped };
  }
  const cycleEndTime = performance.now();
  const wallTimeMs = cycleEndTime - cycleStartTime;

  if (stdoutTruncationLogged) {
    try {
      await activity.appendSubprocessOutputTruncated({
        sessionId,
        streamKind: "stdout",
        droppedCount: stdoutDropped,
      });
    } catch (err) {
      recordActivityError(err);
    }
  }
  if (stderrTruncationLogged) {
    try {
      await activity.appendSubprocessOutputTruncated({
        sessionId,
        streamKind: "stderr",
        droppedCount: stderrDropped,
      });
    } catch (err) {
      recordActivityError(err);
    }
  }

  if (activityErrors.length > 0) {
    await tryAppendFinalFailure(activity, sessionId, activityErrors[0]!);
    return {
      outcome: "spawn_failed",
      sessionId,
      error: activityErrors[0]!,
    };
  }

  const idleThreshold = params.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const stdoutHasNonEmpty = stdoutBuffer.some((line) => line.trimEnd() !== "");
  const isIdle = outcome.kind === "completed" &&
    outcome.exitCode === 0 &&
    wallTimeMs < idleThreshold &&
    !stdoutHasNonEmpty;

  if (isIdle) {
    try {
      await activity.appendIdle({ sessionId });
    } catch (err) {
      return {
        outcome: "spawn_failed",
        sessionId,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    return { outcome: "idle", sessionId };
  }

  const summary = extractSummaryLine(stdoutBuffer);
  const sessionEndRefs: Record<string, string> = {};
  try {
    await activity.appendSessionEnd({
      sessionId,
      exitCode: outcome.exitCode,
      summary,
      ...(outcome.kind === "terminated" ? { terminatedBy: outcome.terminatedBy } : {}),
      refs: sessionEndRefs,
    });
  } catch (err) {
    return {
      outcome: "spawn_failed",
      sessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  if (outcome.kind === "terminated") {
    return {
      outcome: "terminated",
      sessionId,
      exitCode: outcome.exitCode,
      terminatedBy: outcome.terminatedBy,
    };
  }
  return {
    outcome: "completed",
    sessionId,
    exitCode: outcome.exitCode,
    summary,
  };
}

async function tryAppendFinalFailure(
  activity: ActivityLogClient,
  sessionId: string,
  error?: Error,
): Promise<void> {
  const refs: Record<string, string> = { spawn_failed: "true" };
  if (error !== undefined) {
    // Surface the failure cause in the activity log itself so an
    // operator can diagnose without grepping the scheduler stderr.
    // Truncate hard at 2 KiB so a chatty `Error.stack` cannot blow up
    // the activity entry's storage row.
    refs.error = truncate(`${error.name}: ${error.message}`, 2048);
  }
  try {
    await activity.appendSessionEnd({
      sessionId,
      exitCode: -1,
      summary: error !== undefined ? truncate(error.message, 240) : null,
      refs,
    });
  } catch {
    // Best-effort: the orchestration server may be unreachable; the
    // caller still gets a coherent RoleCycleResult.
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
