/**
 * Shared helpers for activity adapters.
 *
 * @module
 */

import type { ActivityEntry, ActivityFilter } from "./interface.ts";

/** Maximum serialised size of an activity entry (POSIX `O_APPEND` atomicity bound). */
export const MAX_ENTRY_BYTES = 4096;

/** True iff `entry` matches every supplied field of `filter`. */
export function matchActivity(
  entry: ActivityEntry,
  filter?: ActivityFilter,
): boolean {
  if (!filter) return true;
  if (filter.agent !== undefined && entry.agent !== filter.agent) return false;
  if (filter.role !== undefined && entry.role !== filter.role) return false;
  if (filter.from !== undefined && entry.timestamp < filter.from) return false;
  if (filter.to !== undefined && entry.timestamp > filter.to) return false;
  return true;
}

/** Serialise an entry to a single JSONL line (trailing newline included). */
export function serialiseEntry(entry: ActivityEntry): string {
  return JSON.stringify(entry) + "\n";
}
