/**
 * Wire shapes for the orchestration server's ticket endpoints.
 *
 * These are the HTTP-facing types — distinct from the storage records in
 * `@keni/shared/storage/tickets/interface.ts` so a future on-disk schema
 * change does not force every API response to change too (design.md
 * Decision 6). The mapping (storage → wire) is one trivial helper per shape
 * in `packages/server/src/routes/tickets.ts`.
 *
 * Every list/individual response carries `project_id` so a future
 * multi-project server is purely additive (`spec.md` §7.1).
 *
 * @module
 */

import type { TicketId, TicketStatus } from "../storage/tickets/interface.ts";

/**
 * Body for `POST /tickets`. The server assigns the id, sets `status` to
 * `"open"`, and stamps `created_at`/`updated_at`; callers MUST NOT supply
 * any of those.
 */
export interface TicketCreateRequest {
  readonly title: string;
  readonly body?: string;
  readonly assignee?: string | null;
  readonly priority: number;
  readonly change_request?: string | null;
}

/**
 * Body for `PATCH /tickets/:id`. Header fields plus optional `body`. A
 * `status` field, if present, is rejected with `400 status_in_patch`
 * (per the storage contract — `TicketStore.updateHeader` raises
 * `InvalidArtifactError("status_in_patch")` and the server maps it).
 */
export interface TicketHeaderPatchRequest {
  readonly title?: string;
  readonly assignee?: string | null;
  readonly priority?: number;
  readonly change_request?: string | null;
  readonly body?: string;
}

/**
 * Body for `POST /tickets/:id/transition`. The server enforces the §4.1
 * status graph (`isTransitionReachable`) and the §4.2 owning-role rule
 * (`isRoleOwner`) before delegating to `TicketStore.transitionStatus`.
 */
export interface TicketTransitionRequest {
  readonly from: TicketStatus;
  readonly to: TicketStatus;
}

/** Header fields exposed on every ticket response. Identity-shaped to {@link TicketHeader}. */
export interface TicketSummaryResponse {
  readonly id: TicketId;
  readonly title: string;
  readonly status: TicketStatus;
  readonly assignee: string | null;
  readonly priority: number;
  readonly change_request: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Full response for `GET /tickets/:id`, `POST /tickets`, `PATCH /tickets/:id`, `POST /tickets/:id/transition`. */
export interface TicketResponse extends TicketSummaryResponse {
  readonly body: string;
}

/** Envelope for `GET /tickets/:id`, `POST /tickets`, `PATCH /tickets/:id`, `POST /tickets/:id/transition`. */
export interface TicketEnvelope {
  readonly data: TicketResponse;
  readonly project_id: string;
}

/** Envelope for `GET /tickets`. */
export interface TicketListResponse {
  readonly data: readonly TicketSummaryResponse[];
  readonly project_id: string;
}
