/**
 * File-backed `ActivityLogStore` adapter — appends one JSON-per-line entry
 * to date-partitioned `<root>/.keni/activity/YYYY-MM-DD.jsonl` files, per
 * `spec.md` §5.1.
 *
 * Atomicity strategy: each `append()` performs a single `O_APPEND` write of
 * the serialised line bytes. POSIX guarantees this is atomic with respect to
 * other appenders when the write size is below `PIPE_BUF` (4096 bytes); we
 * reject oversized entries to stay safely below that bound.
 *
 * @module
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { InvalidArtifactError } from "../errors.ts";
import { generateActivityId } from "../ids.ts";
import type { ProjectPaths } from "../paths.ts";
import type {
  ActivityEntry,
  ActivityEntryInput,
  ActivityFilter,
  ActivityLogStore,
} from "./interface.ts";
import { matchActivity, MAX_ENTRY_BYTES, serialiseEntry } from "./shared.ts";

const FILE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * File-backed `ActivityLogStore`. See `./interface.ts` for the contract.
 *
 * Single-writer-per-file: a single process appending to a JSONL day-file is
 * the supported pattern. Concurrent appenders to the same file from
 * different processes are out of scope for prototype/MVP and produce
 * undefined behaviour beyond what `O_APPEND` guarantees.
 */
export class FileActivityLogStore implements ActivityLogStore {
  readonly #activityDir: string;

  constructor(paths: Pick<ProjectPaths, "activity">) {
    this.#activityDir = paths.activity;
  }

  async append(input: ActivityEntryInput): Promise<ActivityEntry> {
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
    const bytes = new TextEncoder().encode(serialised);
    if (bytes.length > MAX_ENTRY_BYTES) {
      throw new InvalidArtifactError(
        "size_exceeded",
        `Activity entry exceeds the ${MAX_ENTRY_BYTES}-byte single-syscall-atomic limit (size=${bytes.length})`,
      );
    }

    await ensureDir(this.#activityDir);
    const path = join(this.#activityDir, dayFileName(entry.timestamp));
    using file = await Deno.open(path, { append: true, create: true });
    let offset = 0;
    while (offset < bytes.length) {
      const written = await file.write(bytes.subarray(offset));
      if (written === 0) break;
      offset += written;
    }

    return entry;
  }

  async *query(
    filter?: ActivityFilter,
  ): AsyncIterable<ActivityEntry> {
    const entries = await this.#readAllEntries(filter);
    entries.sort(byId);
    for (const entry of entries) {
      if (matchActivity(entry, filter)) yield entry;
    }
  }

  async #readAllEntries(
    filter?: ActivityFilter,
  ): Promise<ActivityEntry[]> {
    const fileNames = await this.#listDayFiles();
    const fromDay = filter?.from?.slice(0, 10);
    const toDay = filter?.to?.slice(0, 10);
    const out: ActivityEntry[] = [];
    for (const fileName of fileNames) {
      const day = fileName.slice(0, 10);
      if (fromDay !== undefined && day < fromDay) continue;
      if (toDay !== undefined && day > toDay) continue;
      const path = join(this.#activityDir, fileName);
      const text = await Deno.readTextFile(path);
      for (const line of text.split("\n")) {
        if (line === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          throw new InvalidArtifactError(
            "malformed_jsonl",
            `Failed to parse activity line in ${path}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            path,
          );
        }
        out.push(coerceEntry(parsed, path));
      }
    }
    return out;
  }

  async #listDayFiles(): Promise<string[]> {
    const out: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.#activityDir)) {
        if (entry.isFile && FILE_DATE_REGEX.test(entry.name)) {
          out.push(entry.name);
        }
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
    out.sort();
    return out;
  }
}

function dayFileName(isoTimestamp: string): string {
  return `${isoTimestamp.slice(0, 10)}.jsonl`;
}

function byId(a: ActivityEntry, b: ActivityEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function coerceEntry(raw: unknown, path: string): ActivityEntry {
  if (raw === null || typeof raw !== "object") {
    throw new InvalidArtifactError(
      "invalid_entry_shape",
      `Activity entry in ${path} is not a JSON object`,
      path,
    );
  }
  const r = raw as Record<string, unknown>;
  return {
    id: expectString(r, "id", path),
    timestamp: expectString(r, "timestamp", path),
    session_id: expectString(r, "session_id", path),
    agent: expectString(r, "agent", path),
    role: expectString(r, "role", path),
    event: expectString(r, "event", path),
    summary: expectStringOrNull(r, "summary", path),
    refs: expectRefs(r, "refs", path),
  };
}

function expectString(
  r: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const v = r[key];
  if (typeof v !== "string") {
    throw new InvalidArtifactError(
      "missing_or_invalid_field",
      `Expected string for '${key}' in ${path}, got ${typeof v}`,
      path,
    );
  }
  return v;
}

function expectStringOrNull(
  r: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const v = r[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new InvalidArtifactError(
      "missing_or_invalid_field",
      `Expected string or null for '${key}' in ${path}, got ${typeof v}`,
      path,
    );
  }
  return v;
}

function expectRefs(
  r: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, string> {
  const v = r[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new InvalidArtifactError(
      "missing_or_invalid_field",
      `Expected object for '${key}' in ${path}, got ${Array.isArray(v) ? "array" : typeof v}`,
      path,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new InvalidArtifactError(
        "missing_or_invalid_field",
        `Expected string value at '${key}.${k}' in ${path}, got ${typeof value}`,
        path,
      );
    }
    out[k] = value;
  }
  return out;
}
