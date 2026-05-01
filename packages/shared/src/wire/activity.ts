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
