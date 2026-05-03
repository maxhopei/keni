/**
 * Wire shapes for the orchestration server's activity-log endpoints.
 *
 * `POST /activity` mirrors `ActivityLogStore.append` and `GET /activity`
 * mirrors `ActivityLogStore.query`, materialised into a single page (no
 * pagination in the prototype; the envelope leaves room for a future
 * `next_cursor` per design.md Decision 11).
 *
 * @module
 */

import type { ActivityEntryId } from "../storage/activity/interface.ts";

/**
 * Canonical activity-log `event` literal for a successful PR fast-forward
 * merge. Emitted by the orchestration server's `POST /prs/:id/merge`
 * handler with `agent: <calling agent>`, `role: "engineer"`, and `refs`
 * carrying `pr_id`, `branch`, and `merge_commit_sha` (orchestration-server
 * spec §"`POST /prs/:id/merge` …"). Exported as a constant so consumers
 * (the merge handler, the engineer integration test, the activity-log
 * filter UI) reference one source of truth instead of repeating the
 * literal string.
 *
 * The `event` field of `ActivityAppendRequest` / `ActivityEntryResponse`
 * remains an open-ended `string` (control-plane events such as
 * `session_start`, `session_end`, `subprocess_stdout`, `pr_merged`,
 * `manual_override`, etc. are not enumerated as a closed union). This
 * constant documents the exact spelling the merge endpoint emits and
 * lets tests pin it.
 */
export const PR_MERGED_ACTIVITY_EVENT = "pr_merged" as const;

/**
 * Body for `POST /activity`. Identical in shape to {@link ActivityEntryInput}
 * from `@keni/shared/storage/activity/interface.ts`. The store assigns the
 * `id`; `timestamp` defaults to `now` when omitted.
 */
export interface ActivityAppendRequest {
  readonly timestamp?: string;
  readonly session_id: string;
  readonly agent: string;
  readonly role: string;
  readonly event: string;
  readonly summary?: string | null;
  readonly refs?: Readonly<Record<string, string>>;
}

/** Stored activity entry — wire-shape mirror of `ActivityEntry`. */
export interface ActivityEntryResponse {
  readonly id: ActivityEntryId;
  readonly timestamp: string;
  readonly session_id: string;
  readonly agent: string;
  readonly role: string;
  readonly event: string;
  readonly summary: string | null;
  readonly refs: Readonly<Record<string, string>>;
}

/** Envelope for `POST /activity`. */
export interface ActivityEnvelope {
  readonly data: ActivityEntryResponse;
  readonly project_id: string;
}

/**
 * Envelope for `GET /activity`. The `data` array is the materialised
 * `AsyncIterable` from `ActivityLogStore.query` in increasing-id (thus
 * chronological) order; pagination is additive in a later step.
 */
export interface ActivityQueryResponse {
  readonly data: readonly ActivityEntryResponse[];
  readonly project_id: string;
}
