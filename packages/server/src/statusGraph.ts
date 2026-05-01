/**
 * Status graph for tickets and PRs.
 *
 * Encodes `spec.md` §4.1 (ticket lifecycle) and §4.2 (owning-role rule)
 * line-for-line, plus the analogous engineer-only PR lifecycle. The graph
 * lives in one frozen module so a §4.1/§4.2 change has exactly one source
 * of truth (design.md Decision 7).
 *
 * The constants are consumed by the role-guard middleware in
 * `routes/tickets.ts` and `routes/prs.ts` via {@link isTransitionReachable}
 * and {@link isRoleOwner}.
 *
 * @module
 */

import type { PRStatus, Role, TicketStatus } from "@keni/shared";

/**
 * Allowed `from → to` transitions for a ticket. Mirrors the §4.1 diagram
 * one edge per entry; `done` is terminal (`[]`).
 */
export const TICKET_STATUS_TRANSITIONS: Readonly<
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
 * Owning role(s) per ticket target status (§4.2). The empty array on `open`
 * means "no owning role" — `open` is never the target of a transition (it
 * is the starting status), so `isRoleOwner` will only be consulted for the
 * other 11 targets.
 */
export const TICKET_STATUS_OWNING_ROLES: Readonly<
  Record<TicketStatus, readonly Role[]>
> = Object.freeze({
  open: [],
  in_progress: ["engineer"],
  ready_for_review: ["engineer"],
  in_review: ["engineer"],
  has_comments: ["engineer"],
  approved: ["engineer"],
  merged: ["engineer"],
  ready_for_test: ["engineer"],
  in_testing: ["qa"],
  tested: ["qa"],
  test_failed: ["qa"],
  done: ["po"],
}) satisfies Readonly<Record<TicketStatus, readonly Role[]>>;

/**
 * Allowed PR transitions. The engineer self-reviews after submitting (per
 * `spec.md` §3), so a single agent walks every edge: open → in_review →
 * has_comments / approved → merged, with a back-edge from `has_comments`
 * to `in_review` after the engineer addresses comments. `merged` is
 * terminal.
 */
export const PR_STATUS_TRANSITIONS: Readonly<
  Record<PRStatus, readonly PRStatus[]>
> = Object.freeze({
  open: ["in_review"],
  in_review: ["has_comments", "approved"],
  has_comments: ["in_review"],
  approved: ["merged"],
  merged: [],
}) satisfies Readonly<Record<PRStatus, readonly PRStatus[]>>;

/**
 * Engineer owns every PR target. The user can also override (per
 * {@link USER_OVERRIDE_ALLOWED}); QA / PO / writer never touch PRs.
 */
export const PR_STATUS_OWNING_ROLES: Readonly<
  Record<PRStatus, readonly Role[]>
> = Object.freeze({
  open: [],
  in_review: ["engineer"],
  has_comments: ["engineer"],
  approved: ["engineer"],
  merged: ["engineer"],
}) satisfies Readonly<Record<PRStatus, readonly Role[]>>;

/**
 * The user can override every transition (`spec.md` §4.2 "User overrides are
 * allowed and logged"). The associated `manual_override` activity emission
 * is deferred to step 25 (design.md Decision 15); the role guard already
 * permits the transition through this allowance.
 */
export const USER_OVERRIDE_ALLOWED: readonly Role[] = ["user"] as const;

/** True iff `from → to` is a documented edge in {@link TICKET_STATUS_TRANSITIONS}. */
export function isTicketTransitionReachable(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_STATUS_TRANSITIONS[from].includes(to);
}

/** True iff `from → to` is a documented edge in {@link PR_STATUS_TRANSITIONS}. */
export function isPRTransitionReachable(from: PRStatus, to: PRStatus): boolean {
  return PR_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * True iff `role` is allowed to set `target` on a ticket. Combines the
 * §4.2 owner table and the user-override allowance.
 */
export function isTicketRoleOwner(role: Role, target: TicketStatus): boolean {
  if (USER_OVERRIDE_ALLOWED.includes(role)) return true;
  return TICKET_STATUS_OWNING_ROLES[target].includes(role);
}

/** True iff `role` is allowed to set `target` on a PR. */
export function isPRRoleOwner(role: Role, target: PRStatus): boolean {
  if (USER_OVERRIDE_ALLOWED.includes(role)) return true;
  return PR_STATUS_OWNING_ROLES[target].includes(role);
}
