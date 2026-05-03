/**
 * Summary-line extractor — pure helper used at session-end time to pick
 * the cycle's `session_end.summary` from the captured stdout buffer.
 *
 * Rule (`design.md` Decision 7 / `spec.md` §6.3): the last entry of the
 * buffer whose `String.prototype.trimEnd()`-ed value is non-empty wins;
 * the returned value is the raw entry (no trim applied to the returned
 * value — preserving any leading indentation the agent might have used).
 *
 * Pure function: no I/O, no side effects, no argument mutation. Tests
 * cover the empty / whitespace-only / single-line / leading-indent
 * edge cases.
 *
 * @module
 */

/**
 * Return the last entry of `buffer` whose right-trimmed value is
 * non-empty. Returns `null` when the buffer is empty or every entry
 * trims to empty.
 */
export function extractSummaryLine(buffer: readonly string[]): string | null {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const entry = buffer[i]!;
    if (entry.trimEnd() !== "") return entry;
  }
  return null;
}
