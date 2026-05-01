/**
 * `ActivityLogStore` — interface and types for the append-only activity log
 * (`spec.md` §5.1, §6.3).
 *
 * Every Keni session emits structured entries: session_start, session_end,
 * idle, summary, session_interrupted, session_timeout, manual_override, etc.
 * Entries are date-partitioned JSONL files under
 * `<project-root>/.keni/activity/YYYY-MM-DD.jsonl`.
 *
 * Each entry carries a uuidv7 `id` (ordering-stable per the chat
 * `messages.jsonl` convention in §5.1), an ISO 8601 `timestamp`, and the
 * `session_id` it belongs to. Filters cover agent, role, and a date range.
 *
 * @module
 */

/** Canonical activity entry id, a uuidv7 string. */
export type ActivityEntryId = string;

/**
 * Input to {@link ActivityLogStore.append}. The store assigns the `id`. The
 * caller supplies the `timestamp` (so a long-running session can append
 * post-hoc with the original time) — defaults to `now` if omitted.
 */
export interface ActivityEntryInput {
  /** ISO 8601 UTC timestamp; defaults to `new Date().toISOString()`. */
  readonly timestamp?: string;
  /** Session id this entry belongs to. */
  readonly session_id: string;
  /** Agent id, e.g. `"alice"`. */
  readonly agent: string;
  /** Role of the agent, e.g. `"engineer"`, `"po"`, `"qa"`, `"writer"`. */
  readonly role: string;
  /**
   * Free-form event tag. Common values: `"session_start"`, `"session_end"`,
   * `"idle"`, `"summary"`, `"session_interrupted"`, `"session_timeout"`,
   * `"manual_override"`. The store does not validate this; later steps may
   * narrow the allowed set in their own layer.
   */
  readonly event: string;
  /** Optional human-readable summary line (the agent's last stdout line per §6.3). */
  readonly summary?: string | null;
  /** Optional cross-references — ticket id, PR id, change-request id, etc. */
  readonly refs?: Readonly<Record<string, string>>;
}

/** Stored activity entry — input plus the assigned id and resolved timestamp. */
export interface ActivityEntry {
  readonly id: ActivityEntryId;
  readonly timestamp: string;
  readonly session_id: string;
  readonly agent: string;
  readonly role: string;
  readonly event: string;
  readonly summary: string | null;
  readonly refs: Readonly<Record<string, string>>;
}

/**
 * Filter for {@link ActivityLogStore.query}. All fields optional and ANDed.
 * `from` / `to` are inclusive ISO 8601 timestamps.
 */
export interface ActivityFilter {
  readonly agent?: string;
  readonly role?: string;
  readonly from?: string;
  readonly to?: string;
}

/**
 * Storage interface for the activity log.
 *
 * **Atomicity:** the file-backed adapter performs a single append-mode
 * `write()` per entry. POSIX guarantees that an `O_APPEND` write of less than
 * `PIPE_BUF` (4096 bytes) is atomic with respect to other appenders. To stay
 * within that bound, entries whose serialised JSON exceeds 4096 bytes are
 * rejected with {@link InvalidArtifactError} (`reason: "size_exceeded"`).
 *
 * **Ordering:** entries are returned by {@link query} in increasing-id (thus
 * chronological per uuidv7) order across the date range.
 */
export interface ActivityLogStore {
  /**
   * Append an entry. Assigns a uuidv7 id and an ISO timestamp (defaults to
   * `now` if `entry.timestamp` is omitted). Returns the stored record.
   *
   * @throws {InvalidArtifactError} (`reason: "size_exceeded"`) if the entry's
   *   serialised JSON exceeds 4096 bytes.
   */
  append(entry: ActivityEntryInput): Promise<ActivityEntry>;

  /**
   * Stream entries matching the filter, in increasing-id order. Returns an
   * `AsyncIterable` so callers can paginate without buffering the whole log.
   */
  query(filter?: ActivityFilter): AsyncIterable<ActivityEntry>;
}
