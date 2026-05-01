/**
 * Shared logic between `FileTicketStore` and `InMemoryTicketStore` —
 * predicates and validators that are pure functions of the data, with no
 * adapter-specific concerns. Lives here (not in `./interface.ts`) because
 * `interface.ts` is type-only.
 *
 * @module
 */

import { InvalidArtifactError } from "../errors.ts";
import type { TicketFilter, TicketHeader, TicketHeaderPatch } from "./interface.ts";

/**
 * Return `true` iff `header` matches every supplied field of `filter`.
 * `undefined` filter or a filter with no fields matches everything.
 */
export function matchTicket(
  header: TicketHeader,
  filter?: TicketFilter,
): boolean {
  if (!filter) return true;

  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(header.status)) return false;
  }

  if (filter.assignee !== undefined && header.assignee !== filter.assignee) {
    return false;
  }

  if (
    filter.priorityMin !== undefined && header.priority < filter.priorityMin
  ) {
    return false;
  }

  if (
    filter.priorityMax !== undefined && header.priority > filter.priorityMax
  ) {
    return false;
  }

  if (
    filter.changeRequest !== undefined &&
    header.change_request !== filter.changeRequest
  ) {
    return false;
  }

  return true;
}

/**
 * Throw `InvalidArtifactError` (`reason: "status_in_patch"`) if `patch`
 * contains a `status` field — callers must use `transitionStatus` for
 * status changes. Defensive against patches built with `as any` casts in
 * downstream code.
 */
export function validateHeaderPatch(patch: TicketHeaderPatch): void {
  if (
    patch !== null &&
    typeof patch === "object" &&
    Object.prototype.hasOwnProperty.call(patch, "status")
  ) {
    throw new InvalidArtifactError(
      "status_in_patch",
      "updateHeader does not accept `status`; use transitionStatus instead",
    );
  }
}
