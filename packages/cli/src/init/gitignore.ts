/**
 * `.gitignore` merge logic for `keni init`.
 *
 * The merge is intentionally additive and conservative:
 *
 * - Existing entries (lines, comments, blank lines) are preserved verbatim
 *   in their original order. Line endings are kept as-is (CRLF inputs stay
 *   CRLF; LF inputs stay LF).
 * - Only the Keni-required entries that are not already present are
 *   appended, preceded by a single marker comment block identifying the
 *   added section as Keni-managed.
 * - Existing `.gitignore` is matched line-by-line on the trimmed,
 *   comment-free body of each line, so a user's existing `.env` (or `.env  `
 *   with trailing whitespace) counts as already-present.
 *
 * The function is pure: it takes the existing file contents (or `null` for
 * "file does not exist") and returns whether the merge changed anything plus
 * the new contents to write. Callers persist the result with a regular
 * `Deno.writeTextFile` — atomicity for `.gitignore` is overkill given how
 * obvious a half-written `.gitignore` would be in `git status`.
 *
 * @module
 */

/**
 * The list of `.gitignore` entries `keni init` enforces. Order is the
 * canonical order they are appended in. Each entry is a literal `.gitignore`
 * pattern; comments are not part of the entry list and are emitted by the
 * merge function alongside the entries.
 */
export const KENI_REQUIRED_GITIGNORE_ENTRIES: readonly string[] = [
  ".env",
  ".env.*",
  "!.env.example",
  ".keni/state.json",
  "node_modules/",
  "dist/",
  "build/",
];

/** Marker comment line that introduces Keni-appended entries. */
export const KENI_GITIGNORE_MARKER =
  "# Added by Keni — do not delete these entries unless you know what you are doing.";

/** Result of {@link mergeGitignore}. */
export interface GitignoreMergeResult {
  /** True if the merge produced new content (i.e. some required entry was missing). */
  readonly changed: boolean;
  /** The new file contents to write. Identical to the input when `changed` is false. */
  readonly contents: string;
}

/**
 * Merge the Keni-required entries into an existing `.gitignore` body.
 *
 * @param existing - The current file contents, or `null` when the file does
 *   not exist on disk. An empty string is treated the same as `null`.
 */
export function mergeGitignore(existing: string | null): GitignoreMergeResult {
  const hasExisting = existing !== null && existing.length > 0;
  const lines = hasExisting ? splitPreservingLineEndings(existing) : [];
  const trimmedExistingEntries = new Set(
    lines
      .map(stripLineEnding)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );

  const missing = KENI_REQUIRED_GITIGNORE_ENTRIES.filter(
    (entry) => !trimmedExistingEntries.has(entry),
  );

  if (missing.length === 0) {
    if (!hasExisting) {
      // No existing file AND nothing to add — the constant list must be
      // non-empty by construction, so this branch is unreachable in practice.
      // We still handle it for defensiveness.
      return { changed: false, contents: "" };
    }
    return { changed: false, contents: existing };
  }

  // Build the appended block. Use \n for new content; rely on a leading
  // newline to separate from existing content (when present).
  const appendedLines = [KENI_GITIGNORE_MARKER, ...missing];
  const appended = appendedLines.join("\n") + "\n";

  if (!hasExisting) {
    return { changed: true, contents: appended };
  }

  // Ensure exactly one blank line between existing content and the appended
  // block. We measure trailing newlines on the existing content.
  const existingEndsWithBlankLine = /(?:\r?\n)\s*(?:\r?\n)$/.test(existing);
  const existingEndsWithNewline = /\r?\n$/.test(existing);

  let separator: string;
  if (existingEndsWithBlankLine) {
    separator = "";
  } else if (existingEndsWithNewline) {
    separator = "\n";
  } else {
    separator = "\n\n";
  }

  return { changed: true, contents: existing + separator + appended };
}

/**
 * Split a string on line endings, keeping the line ending characters attached
 * to the preceding line. The final line lacks an ending if the input did not
 * end with one.
 *
 * Example: `"a\r\nb\n"` → `["a\r\n", "b\n"]`; `"a\nb"` → `["a\n", "b"]`.
 */
function splitPreservingLineEndings(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    out.push(text.slice(start));
  }
  return out;
}

/** Remove trailing `\r\n` or `\n` from a line, returning the bare body. */
function stripLineEnding(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n")) return line.slice(0, -1);
  return line;
}
