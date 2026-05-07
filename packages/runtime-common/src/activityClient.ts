/**
 * Activity-log adapter — thin typed `POST /activity` HTTP client used by
 * the cycle.
 *
 * Five typed methods (`appendSessionStart`, `appendSessionEnd`,
 * `appendIdle`, `appendSubprocessOutput`,
 * `appendSubprocessOutputTruncated`) and one escape hatch (`appendRaw`)
 * compose the right `event` value, stamp `X-Keni-Role` and
 * `X-Keni-Agent` from the cycle's params, and surface non-2xx responses
 * as {@link RoleRuntimeHttpError}.
 *
 * Client-side line truncation (`SUMMARY_HARD_CAP_BYTES = 3072`) keeps
 * `subprocess_stdout` / `subprocess_stderr` entries safely below the
 * orchestration server's 4 KB single-syscall-atomic limit. Truncation
 * appends the documented `... [truncated <N> bytes]` marker, rounded to
 * a UTF-8 boundary so the marker is appended cleanly.
 *
 * No imports from `@keni/server` — the cycle reaches the activity log
 * over HTTP, not in-process. This keeps the runtime testable against a
 * `Deno.serve`-backed mock and lets the runtime run in a different
 * process than the server in step 13.
 *
 * @module
 */

import type { ActivityAppendRequest, AgentId, Role } from "@keni/shared";
import { RoleRuntimeHttpError } from "./types.ts";

/** Construction options for the adapter. */
export interface ActivityLogClientOpts {
  readonly serverUrl: string;
  readonly agentId: AgentId;
  readonly role: Role;
}

export const SUMMARY_HARD_CAP_BYTES = 3072;
export const TRUNCATION_MARKER = (n: number): string => `... [truncated ${n} bytes]`;

/** Public surface of the adapter (`design.md` Decision 5). */
export interface ActivityLogClient {
  appendSessionStart(input: {
    readonly sessionId: string;
    readonly summary: string | null;
    readonly refs?: Readonly<Record<string, string>>;
  }): Promise<void>;
  appendSessionEnd(input: {
    readonly sessionId: string;
    readonly exitCode: number;
    readonly summary: string | null;
    readonly terminatedBy?: "sigterm" | "sigkill";
    readonly refs?: Readonly<Record<string, string>>;
  }): Promise<void>;
  appendIdle(input: {
    readonly sessionId: string;
    readonly refs?: Readonly<Record<string, string>>;
  }): Promise<void>;
  appendSubprocessOutput(input: {
    readonly sessionId: string;
    readonly streamKind: "stdout" | "stderr";
    readonly line: string;
  }): Promise<void>;
  appendSubprocessOutputTruncated(input: {
    readonly sessionId: string;
    readonly streamKind: "stdout" | "stderr";
    readonly droppedCount: number;
  }): Promise<void>;
  appendRaw(input: ActivityAppendRequest): Promise<void>;
}

/** Build the activity-log adapter for one cycle's role / agent identity. */
export function createActivityLogClient(opts: ActivityLogClientOpts): ActivityLogClient {
  const url = `${opts.serverUrl}/activity`;

  async function appendRaw(input: ActivityAppendRequest): Promise<void> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Keni-Role": opts.role,
          "X-Keni-Agent": opts.agentId,
        },
        body: JSON.stringify(input),
      });
    } catch (cause) {
      throw new RoleRuntimeHttpError(
        "internal_error",
        `Network error talking to ${url}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        undefined,
        0,
      );
    }
    if (response.ok) {
      try {
        await response.body?.cancel();
      } catch { /* response body already consumed */ }
      return;
    }
    let code = "internal_error";
    let message = `Activity log POST failed with status ${response.status}`;
    let details: Record<string, unknown> | undefined;
    try {
      const body = await response.json() as {
        readonly error?: {
          readonly code?: unknown;
          readonly message?: unknown;
          readonly details?: unknown;
        };
      };
      if (body.error !== undefined) {
        if (typeof body.error.code === "string") code = body.error.code;
        if (typeof body.error.message === "string") message = body.error.message;
        if (
          body.error.details !== undefined && body.error.details !== null &&
          typeof body.error.details === "object"
        ) {
          details = body.error.details as Record<string, unknown>;
        }
      }
    } catch { /* keep the default message — server response was not JSON */ }
    throw new RoleRuntimeHttpError(code, message, details, response.status);
  }

  return {
    appendRaw,

    appendSessionStart: ({ sessionId, summary, refs }) =>
      appendRaw({
        session_id: sessionId,
        agent: opts.agentId,
        role: opts.role,
        event: "session_start",
        summary: summary ?? null,
        ...(refs !== undefined ? { refs } : {}),
      }),

    appendSessionEnd: ({ sessionId, exitCode, summary, terminatedBy, refs }) => {
      const baseRefs: Record<string, string> = { ...(refs ?? {}) };
      baseRefs.exit_code = String(exitCode);
      if (terminatedBy !== undefined) baseRefs.terminated_by = terminatedBy;
      return appendRaw({
        session_id: sessionId,
        agent: opts.agentId,
        role: opts.role,
        event: "session_end",
        summary: summary ?? null,
        refs: baseRefs,
      });
    },

    appendIdle: ({ sessionId, refs }) =>
      appendRaw({
        session_id: sessionId,
        agent: opts.agentId,
        role: opts.role,
        event: "idle",
        summary: null,
        ...(refs !== undefined ? { refs } : {}),
      }),

    appendSubprocessOutput: ({ sessionId, streamKind, line }) => {
      const { value, wasTruncated } = truncateLine(line);
      const refs: Record<string, string> = { stream_kind: streamKind };
      if (wasTruncated) refs.truncated = "true";
      return appendRaw({
        session_id: sessionId,
        agent: opts.agentId,
        role: opts.role,
        event: streamKind === "stdout" ? "subprocess_stdout" : "subprocess_stderr",
        summary: value,
        refs,
      });
    },

    appendSubprocessOutputTruncated: ({ sessionId, streamKind, droppedCount }) =>
      appendRaw({
        session_id: sessionId,
        agent: opts.agentId,
        role: opts.role,
        event: "subprocess_output_truncated",
        summary: `Dropped ${droppedCount} ${streamKind} lines (per-stream cap reached)`,
        refs: {
          stream_kind: streamKind,
          dropped_count: String(droppedCount),
        },
      }),
  };
}

/**
 * Truncate `line` to {@link SUMMARY_HARD_CAP_BYTES} UTF-8 bytes, rounded
 * down to a UTF-8 boundary so a multi-byte character at the boundary is
 * not split, and append a {@link TRUNCATION_MARKER} naming the dropped
 * byte count.
 *
 * Returns the original line when its byte length is within the cap.
 */
export function truncateLine(line: string): { value: string; wasTruncated: boolean } {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const bytes = encoder.encode(line);
  if (bytes.length <= SUMMARY_HARD_CAP_BYTES) return { value: line, wasTruncated: false };

  const dropped = bytes.length - SUMMARY_HARD_CAP_BYTES;
  const marker = TRUNCATION_MARKER(dropped);
  const markerBytes = encoder.encode(marker);
  const targetBytes = Math.max(0, SUMMARY_HARD_CAP_BYTES - markerBytes.length);

  let safeEnd = targetBytes;
  while (safeEnd > 0 && (bytes[safeEnd]! & 0xc0) === 0x80) safeEnd--;
  const head = decoder.decode(bytes.subarray(0, safeEnd));
  return { value: head + marker, wasTruncated: true };
}
