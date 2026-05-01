/**
 * Shared PR-filter logic used by both adapters.
 *
 * @module
 */

import type { PRFilter, PRHeader } from "./interface.ts";

/** True iff `header` matches every supplied field of `filter`. */
export function matchPR(header: PRHeader, filter?: PRFilter): boolean {
  if (!filter) return true;
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(header.status)) return false;
  }
  if (filter.ticket !== undefined && header.ticket !== filter.ticket) {
    return false;
  }
  if (filter.author !== undefined && header.author !== filter.author) {
    return false;
  }
  return true;
}
