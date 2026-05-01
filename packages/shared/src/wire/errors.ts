/**
 * Wire shape for the orchestration server's error envelope.
 *
 * Every non-2xx response body matches {@link ErrorResponse}. The
 * `error.code` value is one of {@link ErrorCode}, the stable machine-readable
 * identifier the SPA, role runtimes, and curl callers can switch on.
 *
 * Mapping from typed exceptions to (httpStatus, ErrorCode) is owned by
 * `packages/server/src/errors.ts#mapErrorToResponse` (design.md Decision 8).
 *
 * @module
 */

/**
 * Stable identifier for every documented failure mode. New codes are
 * additive; existing codes never change semantics.
 */
export type ErrorCode =
  | "store_not_found"
  | "stale_state"
  | "duplicate_id"
  | "invalid_artifact"
  | "status_in_patch"
  | "status_graph_violation"
  | "role_not_owner"
  | "missing_role"
  | "validation_failed"
  | "internal_error";

/** Tuple of every documented {@link ErrorCode}. */
export const ERROR_CODES: readonly ErrorCode[] = [
  "store_not_found",
  "stale_state",
  "duplicate_id",
  "invalid_artifact",
  "status_in_patch",
  "status_graph_violation",
  "role_not_owner",
  "missing_role",
  "validation_failed",
  "internal_error",
] as const;

/** Type-guard for {@link ErrorCode}. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The error envelope. `project_id` is present whenever the error response
 * is produced after the composition root has resolved the project id (i.e.,
 * always at runtime; absent only in early-bootstrap errors that never reach
 * an HTTP response).
 */
export interface ErrorResponse {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly project_id?: string;
}
