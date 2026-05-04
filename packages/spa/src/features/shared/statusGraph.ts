/**
 * SPA-side mirror of the orchestration server's ticket and PR status graphs.
 *
 * Cross-link: the orchestration-server capability spec ("A status-graph
 * constant encodes the §4.1 ticket lifecycle") is the source of truth. This
 * mirror exists so the SPA's "Advanced: transition" panel can offer only
 * server-legal `to` options without a round-trip to the server. The drift
 * between this mirror and `packages/server/src/statusGraph.ts` is caught at
 * test time by `statusGraph_test.ts` (design.md Decision 10).
 */

import type { PRStatus, TicketStatus } from "@keni/shared";

/**
 * Allowed `from → to` ticket transitions. Must mirror the server's
 * `TICKET_STATUS_TRANSITIONS` edge-for-edge.
 */
export const SPA_TICKET_STATUS_TRANSITIONS: Readonly<
  Record<TicketStatus, readonly TicketStatus[]>
> = Object.freeze({
  open: ["in_progress"],
  in_progress: ["ready_for_review"],
  ready_for_review: ["in_review"],
  in_review: ["has_comments", "approved"],
  has_comments: ["in_progress"],
  approved: ["merged"],
  merged: ["ready_for_test"],
  ready_for_test: ["in_testing"],
  in_testing: ["tested", "test_failed"],
  tested: ["done"],
  test_failed: ["in_progress"],
  done: [],
}) satisfies Readonly<Record<TicketStatus, readonly TicketStatus[]>>;

/**
 * Allowed `from → to` PR transitions. Must mirror the server's
 * `PR_STATUS_TRANSITIONS` edge-for-edge.
 */
export const SPA_PR_STATUS_TRANSITIONS: Readonly<
  Record<PRStatus, readonly PRStatus[]>
> = Object.freeze({
  open: ["in_review"],
  in_review: ["has_comments", "approved"],
  has_comments: ["in_review"],
  approved: ["merged"],
  merged: [],
}) satisfies Readonly<Record<PRStatus, readonly PRStatus[]>>;
