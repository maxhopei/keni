/**
 * Shared types for the orchestration server's middleware stack.
 *
 * Every middleware lives behind a typed `Hono<{ Variables: ServerVariables }>`
 * surface so route handlers can read `c.var.role` / `c.var.request_id` etc.
 * without `as` casts (design.md Decision 3).
 *
 * @module
 */

import type { Role } from "@keni/shared";

/** Per-request variables populated by the middleware stack. */
export interface ServerVariables {
  /** UUID assigned by `requestId` middleware. Always set. */
  request_id: string;
  /** Role from `X-Keni-Role`. Set by `roleIdentity` middleware after validation. */
  role: Role;
  /** Agent id from `X-Keni-Agent`. May be `null` when the header is absent. */
  agent: string | null;
  /**
   * Documented `error.code` of the response, set by `errorBoundary` when an
   * error is mapped. The `requestLog` middleware reads it to populate the
   * `error_code` field of the JSONL log line.
   */
  error_code?: string;
}

/**
 * One JSONL line emitted per HTTP request by `requestLog`. Carries the
 * stable observability fields documented in
 * `openspec/specs/orchestration-server/spec.md` requirement
 * "`requestLog` middleware emits one structured JSONL line per request".
 */
export interface RequestLogLine {
  readonly request_id: string;
  readonly timestamp: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly duration_ms: number;
  readonly role: string | null;
  readonly agent: string | null;
  readonly project_id: string;
  readonly error_code?: string;
}

/**
 * Sink the `requestLog` middleware delegates to. Implementations include
 * `stdoutLogSink`, `captureLogSink`, and `fileLogSink`.
 *
 * `close` is optional — sinks holding OS resources (file handles, sockets)
 * implement it so the composition root and tests can release them on
 * shutdown. `runServer` calls it from its `SIGINT` handler.
 */
export interface LogSink {
  write(line: RequestLogLine): void | Promise<void>;
  close?(): void | Promise<void>;
}
