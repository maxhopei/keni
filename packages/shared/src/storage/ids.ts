/**
 * Id generation and parsing for Keni artifacts.
 *
 * Tickets and PRs use a human-readable, zero-padded sequence id
 * (`ticket-0001`, `pr-0042`) — minimum four digits, growing to five and
 * beyond once the sequence exceeds 9999. This is the format the user will
 * see in the URL bar, in `git log`, and in git branch names
 * (`ticket-{id}` per `spec.md` §5.2).
 *
 * Activity log entry ids are uuidv7, matching the chat `messages.jsonl`
 * convention (§5.1): ordering-stable, collision-resistant, suitable for
 * unbounded append streams.
 *
 * Every store adapter (file-backed and in-memory) delegates to this module —
 * adapters MUST NOT embed their own id-generation logic — so the two
 * adapters cannot disagree on format.
 *
 * @module
 */

import { generate as generateUuidV7 } from "@std/uuid/v7";

/** Minimum width of the zero-padded numeric component. Five-digit ids appear naturally once the sequence crosses 9999. */
const MIN_PAD_WIDTH = 4;

const TICKET_PREFIX = "ticket-";
const PR_PREFIX = "pr-";

const TICKET_ID_REGEX = /^ticket-\d{4,}$/;
const PR_ID_REGEX = /^pr-\d{4,}$/;

/**
 * True iff `s` is a valid ticket id (`ticket-NNNN` with at least four digits,
 * no leading + / -, no decimal).
 */
export function isTicketId(s: string): boolean {
  return TICKET_ID_REGEX.test(s);
}

/**
 * True iff `s` is a valid PR id (`pr-NNNN` with at least four digits).
 */
export function isPrId(s: string): boolean {
  return PR_ID_REGEX.test(s);
}

/**
 * Parse the numeric component of a ticket id. Throws `Error` if `id` is not a
 * valid ticket id.
 */
export function parseTicketSequence(id: string): number {
  if (!isTicketId(id)) {
    throw new Error(`Not a ticket id: '${id}'`);
  }
  return Number.parseInt(id.slice(TICKET_PREFIX.length), 10);
}

/**
 * Parse the numeric component of a PR id. Throws `Error` if `id` is not a
 * valid PR id.
 */
export function parsePrSequence(id: string): number {
  if (!isPrId(id)) {
    throw new Error(`Not a PR id: '${id}'`);
  }
  return Number.parseInt(id.slice(PR_PREFIX.length), 10);
}

/**
 * Return the next ticket id given the full list of existing ticket ids.
 * Invalid entries in `existing` are ignored. The result is always padded to
 * at least {@link MIN_PAD_WIDTH} digits.
 *
 * Callers must invoke this from within their single-writer critical section
 * (e.g., inside `FileTicketStore.create` after listing the directory) so the
 * returned id is fresh by construction.
 */
export function generateTicketId(existing: readonly string[]): string {
  const next = nextSequence(existing, isTicketId, parseTicketSequence);
  return TICKET_PREFIX + padSequence(next);
}

/**
 * Return the next PR id given the full list of existing PR ids. See
 * {@link generateTicketId} for semantics.
 */
export function generatePrId(existing: readonly string[]): string {
  const next = nextSequence(existing, isPrId, parsePrSequence);
  return PR_PREFIX + padSequence(next);
}

/**
 * Last id produced by {@link generateActivityId}, used to enforce
 * strict-monotonic output even when two calls land in the same millisecond.
 */
let lastActivityId: string | null = null;

/**
 * Return a fresh uuidv7 string, guaranteed to sort lexicographically strictly
 * greater than the previous id returned by this function (process-local
 * monotonicity).
 *
 * When the underlying `@std/uuid/v7` generator returns an id that is
 * lexicographically ≤ the previous one — which happens when two calls land
 * in the same millisecond — we bump the last 48 bits (pure `rand_b` per
 * RFC 9562 v7 layout) by 1 to force ordering. 48 bits of collision headroom
 * is far beyond any realistic intra-millisecond append rate.
 */
export function generateActivityId(): string {
  let id = generateUuidV7();
  if (lastActivityId !== null && id <= lastActivityId) {
    id = bumpUuidV7Tail(lastActivityId);
  }
  lastActivityId = id;
  return id;
}

/**
 * Increment the last hex group (12 hex chars = 48 bits of `rand_b`) of a
 * canonical uuidv7 string. Safe because `rand_b`'s lower 48 bits are purely
 * random and do not overlap the version or variant bits.
 */
function bumpUuidV7Tail(id: string): string {
  const parts = id.split("-");
  if (parts.length !== 5 || parts[4] === undefined) {
    throw new Error(`Not a canonical uuid: '${id}'`);
  }
  const incremented = (BigInt("0x" + parts[4]) + 1n) & 0xff_ff_ff_ff_ff_ffn;
  parts[4] = incremented.toString(16).padStart(12, "0");
  return parts.join("-");
}

/**
 * Reset the internal monotonic state used by {@link generateActivityId}. For
 * tests only; production callers MUST NOT use this.
 *
 * @internal
 */
export function __resetActivityIdState(): void {
  lastActivityId = null;
}

function nextSequence(
  existing: readonly string[],
  isValid: (s: string) => boolean,
  parse: (s: string) => number,
): number {
  let max = 0;
  for (const entry of existing) {
    if (!isValid(entry)) continue;
    const n = parse(entry);
    if (n > max) max = n;
  }
  return max + 1;
}

function padSequence(n: number): string {
  const raw = String(n);
  return raw.length >= MIN_PAD_WIDTH ? raw : raw.padStart(MIN_PAD_WIDTH, "0");
}
