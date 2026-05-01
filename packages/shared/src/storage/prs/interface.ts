/**
 * `PRStore` — interface and types for pull-request record storage.
 *
 * PRs are markdown files under `<project-root>/.keni/prs/pr-NNNN.md` with
 * YAML front-matter + intent body, per `spec.md` §5.1. Each PR links to its
 * source ticket and tracks the engineer-side flow: open → in_review →
 * has_comments / approved → merged.
 *
 * Same atomicity / single-writer / no-status-graph-validation contract as
 * {@link TicketStore}.
 *
 * @module
 */

import type { TicketId } from "../tickets/interface.ts";

/** Canonical PR id, format `pr-NNNN` with at least four digits. */
export type PRId = string;

/**
 * PR lifecycle. The engineer self-reviews after submission per `spec.md` §3,
 * so a single agent transitions through every status. The QA / PO never
 * touch PRs — those flows operate on tickets.
 */
export type PRStatus =
  | "open"
  | "in_review"
  | "has_comments"
  | "approved"
  | "merged";

/** YAML front-matter fields for a PR. */
export interface PRHeader {
  readonly id: PRId;
  readonly title: string;
  readonly status: PRStatus;
  /** Linked ticket id (the PR's source). */
  readonly ticket: TicketId;
  /** Source branch in the engineer's workspace clone. */
  readonly branch: string;
  /** Engineer agent id who authored the PR. */
  readonly author: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Full PR record: header + intent body. */
export interface PR {
  readonly header: PRHeader;
  /** Intent / description body (markdown). May be empty. */
  readonly body: string;
}

/** Header-only summary returned by {@link PRStore.list}. */
export type PRSummary = PRHeader;

/** Filter for {@link PRStore.list}. All fields optional and ANDed. */
export interface PRFilter {
  readonly status?: PRStatus | readonly PRStatus[];
  readonly ticket?: TicketId;
  readonly author?: string;
}

/**
 * Input for {@link PRStore.create}. The store assigns the id, timestamps,
 * and the initial `open` status; callers MUST NOT pass any of those.
 */
export interface PRCreateInput {
  readonly title: string;
  readonly body?: string;
  readonly ticket: TicketId;
  readonly branch: string;
  readonly author: string;
}

/**
 * Storage interface for PRs. See `./interface.ts` JSDoc for atomicity and
 * single-writer semantics; behavioural equivalence between adapters is
 * enforced by `./contract_test.ts`.
 */
export interface PRStore {
  list(filter?: PRFilter): Promise<PRSummary[]>;
  read(id: PRId): Promise<PR>;
  create(input: PRCreateInput): Promise<PR>;

  /**
   * Replace the PR's intent body atomically. Updates `updated_at`.
   *
   * @throws {StoreNotFoundError} if `id` does not exist.
   */
  updateIntent(id: PRId, intent: string): Promise<PR>;

  /**
   * Atomically transition the status from `from` to `to`. Optimistic check;
   * the store does not validate the status graph (caller does).
   *
   * @throws {StaleStateError} if the on-disk status differs from `from`.
   * @throws {StoreNotFoundError} if `id` does not exist.
   */
  updateStatus(id: PRId, from: PRStatus, to: PRStatus): Promise<PR>;
}
