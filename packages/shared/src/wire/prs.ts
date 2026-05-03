/**
 * Wire shapes for the orchestration server's PR endpoints.
 *
 * Mirrors `tickets.ts` in shape and conventions (design.md Decision 6). The
 * engineer owns the entire PR lifecycle (`spec.md` §3 / §4.1); the user can
 * override every transition (the `manual_override` activity emission lands
 * in step 25, see Decision 15 + the deferred-override requirement in
 * `openspec/specs/orchestration-server/spec.md`).
 *
 * @module
 */

import type { PRId, PRStatus } from "../storage/prs/interface.ts";
import type { TicketId } from "../storage/tickets/interface.ts";

/**
 * Body for `POST /prs`. The server assigns the id, sets `status` to
 * `"open"`, and stamps timestamps.
 */
export interface PRCreateRequest {
  readonly title: string;
  readonly body?: string;
  readonly ticket: TicketId;
  readonly branch: string;
  readonly author: string;
}

/** Body for `PATCH /prs/:id/intent`. */
export interface PRIntentPatchRequest {
  readonly intent: string;
}

/**
 * Body for `POST /prs/:id/transition`. Same role-guard semantics as the
 * ticket transition endpoint, but the engineer is the only owning role for
 * every PR status (and the user can override).
 */
export interface PRTransitionRequest {
  readonly from: PRStatus;
  readonly to: PRStatus;
}

/** Header fields exposed on every PR response. Identity-shaped to {@link PRHeader}. */
export interface PRSummaryResponse {
  readonly id: PRId;
  readonly title: string;
  readonly status: PRStatus;
  readonly ticket: TicketId;
  readonly branch: string;
  readonly author: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Full response for `GET /prs/:id`, `POST /prs`, `PATCH /prs/:id/intent`, `POST /prs/:id/transition`. */
export interface PRResponse extends PRSummaryResponse {
  readonly body: string;
}

/** Envelope for `GET /prs/:id`, `POST /prs`, `PATCH /prs/:id/intent`, `POST /prs/:id/transition`. */
export interface PREnvelope {
  readonly data: PRResponse;
  readonly project_id: string;
}

/** Envelope for `GET /prs`. */
export interface PRListResponse {
  readonly data: readonly PRSummaryResponse[];
  readonly project_id: string;
}

/**
 * Response data for `POST /prs/:id/merge` on success. The endpoint
 * fast-forward-merges the PR's source branch onto `main` (orchestration
 * server spec §"`POST /prs/:id/merge` …"); on a non-fast-forward the
 * server responds `409 merge_conflict` instead of this shape.
 *
 * `merge_commit_sha` is the SHA of the `main` branch HEAD after the
 * merge — for a true fast-forward this is identical to the source
 * branch tip; the field exists separately so a future non-FF merge
 * strategy keeps the wire shape stable.
 */
export interface MergePrResponse {
  readonly merge_commit_sha: string;
}

/** Envelope for `POST /prs/:id/merge` on success. */
export interface MergePrEnvelope {
  readonly data: MergePrResponse;
  readonly project_id: string;
}
