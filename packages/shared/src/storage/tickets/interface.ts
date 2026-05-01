/**
 * `TicketStore` — interface and types for ticket storage.
 *
 * Tickets are the unit of work the user (prototype, `spec.md` §8) or the PO
 * (MVP, §9) creates and that engineers, QA, and the PO transition through the
 * status machine in §4.1. Every consumer (REST, MCP, role runtimes, SPA)
 * binds to {@link TicketStore}, never to filesystem paths.
 *
 * The file-backed default writes one `ticket-NNNN.md` per ticket under
 * `<project-root>/.keni/tickets/` with YAML front-matter + markdown body, per
 * §5.1. The in-memory double provides identical behaviour for tests.
 *
 * **Atomicity:** every mutating method on the file-backed adapter is atomic
 * via write-and-rename; readers always observe either the pre-write or the
 * post-write state.
 *
 * **Single-writer:** the file-backed adapter is single-writer-per-artifact;
 * concurrent writers to the same ticket are undefined behaviour. Serialise
 * at the REST/MCP layer.
 *
 * **Status-machine enforcement:** `transitionStatus` does not validate the
 * status graph (which transitions are legal). That validation lives in the
 * caller (REST / MCP), where the role context determines legality per §4.2.
 *
 * @module
 */

/**
 * Canonical ticket id, format `ticket-NNNN` with at least four digits.
 * See {@link generateTicketId} in `../ids.ts`.
 */
export type TicketId = string;

/**
 * Full ticket lifecycle per `spec.md` §4.1. Only the owning role may
 * transition into its own statuses (engineer for `in_progress` →
 * `merged`; QA for `in_testing` → `tested` / `test_failed`; PO for `done`).
 * The store does not enforce role; the caller does.
 */
export type TicketStatus =
  | "open"
  | "in_progress"
  | "ready_for_review"
  | "in_review"
  | "has_comments"
  | "approved"
  | "merged"
  | "ready_for_test"
  | "in_testing"
  | "tested"
  | "test_failed"
  | "done";

/**
 * Structured header for a ticket — the YAML front-matter portion of the
 * markdown file. `change_request` links back to the parent CR (MVP
 * verify-and-fold uses this; populated by the PO's CR-to-tickets cycle).
 */
export interface TicketHeader {
  /** Ticket id (matches the filename and the `id` field). */
  readonly id: TicketId;
  /** Short human-readable title. */
  readonly title: string;
  /** Current lifecycle status (§4.1). */
  readonly status: TicketStatus;
  /** Engineer agent id, or `null` if unassigned (`open` tickets). */
  readonly assignee: string | null;
  /** PO-owned integer; lower is higher priority. */
  readonly priority: number;
  /** Linked change-request id (MVP) or `null` (prototype + unlinked). */
  readonly change_request: string | null;
  /** ISO 8601 UTC timestamp of `create()`. */
  readonly created_at: string;
  /** ISO 8601 UTC timestamp of the most recent mutation. */
  readonly updated_at: string;
}

/**
 * Full ticket record: header (YAML front-matter) plus the markdown body.
 */
export interface Ticket {
  readonly header: TicketHeader;
  /** Markdown body. May be empty. */
  readonly body: string;
}

/**
 * Header-only summary returned by {@link TicketStore.list}. Equivalent to
 * `Pick<Ticket, "header">["header"]` but exposed as its own type so that
 * future fields can be added to summary without changing the full record.
 */
export type TicketSummary = TicketHeader;

/**
 * Filter for {@link TicketStore.list}. Every field is optional and ANDed.
 * `priorityMin` / `priorityMax` are inclusive bounds.
 */
export interface TicketFilter {
  readonly status?: TicketStatus | readonly TicketStatus[];
  readonly assignee?: string | null;
  readonly priorityMin?: number;
  readonly priorityMax?: number;
  readonly changeRequest?: string | null;
}

/**
 * Input for {@link TicketStore.create}. The store assigns the id, timestamps,
 * and the initial `open` status; callers MUST NOT pass any of those.
 */
export interface TicketCreateInput {
  readonly title: string;
  readonly body?: string;
  readonly assignee?: string | null;
  readonly priority: number;
  readonly change_request?: string | null;
}

/**
 * Patch for {@link TicketStore.updateHeader}. Status changes go through
 * {@link TicketStore.transitionStatus}; the store rejects patches that
 * include `status` with an `InvalidArtifactError` (`reason: "status_in_patch"`).
 */
export interface TicketHeaderPatch {
  readonly title?: string;
  readonly assignee?: string | null;
  readonly priority?: number;
  readonly change_request?: string | null;
}

/**
 * Storage interface for tickets. Both `FileTicketStore` (file-backed) and
 * `InMemoryTicketStore` (test double) implement it with behaviourally
 * identical semantics, enforced by the shared contract test in
 * `./contract_test.ts`.
 */
export interface TicketStore {
  /**
   * List ticket headers matching the filter. Returns a fresh array on every
   * call; mutating the returned array does not affect the store.
   * No specific ordering is guaranteed — callers sort as needed.
   */
  list(filter?: TicketFilter): Promise<TicketSummary[]>;

  /**
   * Read the full ticket (header + body) by id.
   *
   * @throws {StoreNotFoundError} if no ticket exists for `id`.
   * @throws {InvalidArtifactError} if the on-disk file is malformed.
   */
  read(id: TicketId): Promise<Ticket>;

  /**
   * Create a new ticket. The store assigns the next sequential id, sets
   * `status` to `"open"`, and stamps `created_at` / `updated_at`. Returns
   * the stored record.
   */
  create(input: TicketCreateInput): Promise<Ticket>;

  /**
   * Replace the body atomically. Updates `updated_at`. Returns the new full
   * ticket.
   *
   * @throws {StoreNotFoundError} if `id` does not exist.
   */
  updateBody(id: TicketId, body: string): Promise<Ticket>;

  /**
   * Partially update header fields atomically. `status` MUST NOT appear in
   * `patch`; use {@link transitionStatus} instead. Updates `updated_at`.
   * Returns the new full ticket.
   *
   * @throws {InvalidArtifactError} (`reason: "status_in_patch"`) if `patch.status` is set.
   * @throws {StoreNotFoundError} if `id` does not exist.
   */
  updateHeader(id: TicketId, patch: TicketHeaderPatch): Promise<Ticket>;

  /**
   * Atomically transition the status from `from` to `to`. The store reads
   * the current status; if it does not equal `from`, throws
   * {@link StaleStateError}. The status graph itself is not validated — that
   * is the caller's responsibility (role determines legality per §4.2).
   *
   * @throws {StaleStateError} if the on-disk status differs from `from`.
   * @throws {StoreNotFoundError} if `id` does not exist.
   */
  transitionStatus(
    id: TicketId,
    from: TicketStatus,
    to: TicketStatus,
  ): Promise<Ticket>;

  /**
   * Set the `change_request` header field. Sugar for
   * `updateHeader({ change_request })`. Callable on any ticket regardless of
   * status. Returns the new full ticket.
   *
   * @throws {StoreNotFoundError} if `id` does not exist.
   */
  linkChangeRequest(
    id: TicketId,
    changeRequestId: string,
  ): Promise<Ticket>;
}
