/**
 * In-memory `ActivityLogStore` adapter.
 *
 * @module
 */

import { InvalidArtifactError } from "../errors.ts";
import { generateActivityId } from "../ids.ts";
import type {
  ActivityEntry,
  ActivityEntryInput,
  ActivityFilter,
  ActivityLogStore,
} from "./interface.ts";
import { matchActivity, MAX_ENTRY_BYTES, serialiseEntry } from "./shared.ts";

/**
 * In-memory activity log. Entries are stored in a single array; `append`
 * preserves insertion order, which equals id order because uuidv7 plus our
 * monotonic wrapper guarantees strict ordering.
 *
 * `query` reads the array lazily — entries appended after `query()` is
 * called but before the iterator is fully drained may or may not appear,
 * matching the file adapter's natural behaviour.
 *
 * @see ActivityLogStore for the contract
 */
export class InMemoryActivityLogStore implements ActivityLogStore {
  readonly #entries: ActivityEntry[] = [];

  append(input: ActivityEntryInput): Promise<ActivityEntry> {
    const entry: ActivityEntry = {
      id: generateActivityId(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      session_id: input.session_id,
      agent: input.agent,
      role: input.role,
      event: input.event,
      summary: input.summary ?? null,
      refs: input.refs ?? {},
    };
    const serialised = serialiseEntry(entry);
    if (new TextEncoder().encode(serialised).length > MAX_ENTRY_BYTES) {
      return Promise.reject(
        new InvalidArtifactError(
          "size_exceeded",
          `Activity entry exceeds the ${MAX_ENTRY_BYTES}-byte single-syscall-atomic limit (size=${
            new TextEncoder().encode(serialised).length
          })`,
        ),
      );
    }
    this.#entries.push(entry);
    return Promise.resolve({ ...entry, refs: { ...entry.refs } });
  }

  async *query(
    filter?: ActivityFilter,
  ): AsyncIterable<ActivityEntry> {
    const snapshot = this.#entries.slice().sort(byId);
    for (const entry of snapshot) {
      if (matchActivity(entry, filter)) {
        yield { ...entry, refs: { ...entry.refs } };
      }
    }
  }
}

function byId(a: ActivityEntry, b: ActivityEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
