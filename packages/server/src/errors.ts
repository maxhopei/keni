/**
 * Server-side typed errors and the central `mapErrorToResponse` mapper.
 *
 * Three classes of errors flow through `mapErrorToResponse`:
 *
 * 1. **Storage errors** raised by `@keni/shared/storage/*` — `StoreNotFoundError`,
 *    `StaleStateError`, `DuplicateIdError`, `InvalidArtifactError`. Mapped
 *    1:1 to documented HTTP statuses, with `InvalidArtifactError` whose
 *    `reason === "status_in_patch"` re-mapped to `400 status_in_patch`.
 * 2. **Server-domain errors** (the three classes below) raised by the
 *    role-guard middleware and the status-graph check.
 * 3. **Validation errors** (`ZodError`) raised by the request-shape parser.
 *
 * Anything else falls through to `500 internal_error` with a redacted
 * message; the original is shipped to the request-log line via the
 * `errorBoundary` middleware.
 *
 * See design.md Decision 8 for the full rationale and table.
 *
 * @module
 */

import {
  DuplicateIdError,
  type ErrorCode,
  type ErrorResponse,
  InvalidArtifactError,
  StaleStateError,
  StoreNotFoundError,
} from "@keni/shared";
import { z } from "zod";
import type { Role } from "@keni/shared";

/**
 * Raised when `to ∉ TICKET_STATUS_TRANSITIONS[from]` (or the analogous PR
 * graph). The role-guard handler wraps this; mapped to `403
 * status_graph_violation` with `error.details: { from, to }`.
 */
export class StatusGraphViolationError extends Error {
  override readonly name = "StatusGraphViolationError";
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(`Transition '${from}' → '${to}' is not in the status graph`);
    this.from = from;
    this.to = to;
  }
}

/**
 * Raised when the calling role is neither in `*_OWNING_ROLES[target]` nor
 * in `USER_OVERRIDE_ALLOWED`. Mapped to `403 role_not_owner` with
 * `error.details: { role, target }`.
 */
export class RoleNotOwnerError extends Error {
  override readonly name = "RoleNotOwnerError";
  readonly role: Role;
  readonly target: string;

  constructor(role: Role, target: string) {
    super(`Role '${role}' is not authorised to set status '${target}'`);
    this.role = role;
    this.target = target;
  }
}

/**
 * Raised by the `POST /prs/:id/merge` handler when `git merge --ff-only`
 * exits non-zero because the PR's source branch is not a fast-forward of
 * `main`. Mapped to `409 merge_conflict` with `error.details: { branch,
 * base, git_stderr }`.
 */
export class MergeConflictError extends Error {
  override readonly name = "MergeConflictError";
  readonly branch: string;
  readonly base: string;
  readonly gitStderr: string;

  constructor(branch: string, base: string, gitStderr: string) {
    super(`Branch '${branch}' is not a fast-forward of '${base}'`);
    this.branch = branch;
    this.base = base;
    this.gitStderr = gitStderr;
  }
}

/**
 * Raised by the `roleIdentity` middleware when `X-Keni-Role` is missing or
 * carries a value outside the `Role` union. Mapped to `400 missing_role`
 * with `error.details: { received }` (received may be `undefined` when the
 * header was absent).
 */
export class MissingRoleError extends Error {
  override readonly name = "MissingRoleError";
  readonly received: string | undefined;

  constructor(received: string | undefined) {
    super(
      received === undefined
        ? "Missing required header 'X-Keni-Role'"
        : `Unknown role '${received}' in 'X-Keni-Role' header`,
    );
    this.received = received;
  }
}

/** What `mapErrorToResponse` returns. The route handler hands this to Hono. */
export interface MappedResponse {
  readonly status: number;
  readonly body: ErrorResponse;
}

/**
 * Map any thrown value to an `(httpStatus, ErrorResponse)` pair. The
 * single source of truth for the {@link ErrorCode} → HTTP status mapping
 * (design.md Decision 8). The `errorBoundary` middleware delegates to this
 * function for every uncaught error.
 *
 * Unrecognised errors map to `500 internal_error` with `error.message =
 * "An unexpected error occurred"` so we never leak stack traces, internal
 * paths, or implementation detail to HTTP clients. The original error is
 * still emitted to the request-log line by `errorBoundary` for debugging.
 */
export function mapErrorToResponse(err: unknown, projectId: string): MappedResponse {
  if (err instanceof StoreNotFoundError) {
    return envelope(404, "store_not_found", err.message, projectId, { id: err.id });
  }

  if (err instanceof StaleStateError) {
    return envelope(409, "stale_state", err.message, projectId, {
      id: err.id,
      expected: err.expected,
      actual: err.actual,
    });
  }

  if (err instanceof DuplicateIdError) {
    return envelope(409, "duplicate_id", err.message, projectId, { id: err.id });
  }

  if (err instanceof InvalidArtifactError) {
    if (err.reason === "status_in_patch") {
      return envelope(400, "status_in_patch", err.message, projectId, {
        reason: err.reason,
      });
    }
    return envelope(422, "invalid_artifact", err.message, projectId, {
      reason: err.reason,
    });
  }

  if (err instanceof StatusGraphViolationError) {
    return envelope(403, "status_graph_violation", err.message, projectId, {
      from: err.from,
      to: err.to,
    });
  }

  if (err instanceof RoleNotOwnerError) {
    return envelope(403, "role_not_owner", err.message, projectId, {
      role: err.role,
      target: err.target,
    });
  }

  if (err instanceof MergeConflictError) {
    return envelope(409, "merge_conflict", err.message, projectId, {
      branch: err.branch,
      base: err.base,
      git_stderr: err.gitStderr,
    });
  }

  if (err instanceof MissingRoleError) {
    return envelope(400, "missing_role", err.message, projectId, {
      received: err.received ?? null,
    });
  }

  if (err instanceof z.ZodError) {
    return envelope(400, "validation_failed", "Request body did not match schema", projectId, {
      issues: err.issues,
    });
  }

  return envelope(500, "internal_error", "An unexpected error occurred", projectId);
}

function envelope(
  status: number,
  code: ErrorCode,
  message: string,
  projectId: string,
  details?: Readonly<Record<string, unknown>>,
): MappedResponse {
  const body: ErrorResponse = details === undefined
    ? { error: { code, message }, project_id: projectId }
    : { error: { code, message, details }, project_id: projectId };
  return { status, body };
}
