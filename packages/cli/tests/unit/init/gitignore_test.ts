import { assert, assertEquals } from "@std/assert";
import {
  KENI_GITIGNORE_MARKER,
  KENI_REQUIRED_GITIGNORE_ENTRIES,
  mergeGitignore,
} from "../../../src/init/gitignore.ts";

Deno.test("mergeGitignore — null input produces fresh contents with all required entries", () => {
  const { changed, contents } = mergeGitignore(null);
  assertEquals(changed, true);
  assert(contents.startsWith(KENI_GITIGNORE_MARKER));
  for (const entry of KENI_REQUIRED_GITIGNORE_ENTRIES) {
    assert(contents.includes(`\n${entry}\n`) || contents.endsWith(`${entry}\n`));
  }
  assert(contents.endsWith("\n"));
});

Deno.test("mergeGitignore — empty-string input is treated like null", () => {
  const fromEmpty = mergeGitignore("");
  const fromNull = mergeGitignore(null);
  assertEquals(fromEmpty.contents, fromNull.contents);
  assertEquals(fromEmpty.changed, true);
});

Deno.test("mergeGitignore — already-complete input returns changed: false", () => {
  const complete = [
    "__pycache__/",
    "",
    KENI_GITIGNORE_MARKER,
    ...KENI_REQUIRED_GITIGNORE_ENTRIES,
    "",
  ].join("\n");
  const { changed, contents } = mergeGitignore(complete);
  assertEquals(changed, false);
  assertEquals(contents, complete);
});

Deno.test("mergeGitignore — partial input appends only the missing entries", () => {
  const partial = ".env\nnode_modules/\n";
  const { changed, contents } = mergeGitignore(partial);
  assertEquals(changed, true);
  assert(contents.startsWith(partial));
  // The missing entries are appended; the present ones are not duplicated.
  const occurrences = (s: string, sub: string): number => s.split(sub).length - 1;
  assertEquals(occurrences(contents, ".env\n"), 1);
  assertEquals(occurrences(contents, "node_modules/\n"), 1);
  assert(contents.includes(".keni/state.json"));
  assert(contents.includes("dist/"));
  assert(contents.includes("build/"));
  assert(contents.includes(".env.*"));
  assert(contents.includes("!.env.example"));
});

Deno.test("mergeGitignore — preserves existing comments and blank lines verbatim", () => {
  const input = "# my custom rules\n\n__pycache__/\n.vscode/\n";
  const { changed, contents } = mergeGitignore(input);
  assertEquals(changed, true);
  assert(contents.startsWith(input));
  assert(contents.includes("# my custom rules"));
  assert(contents.includes("__pycache__/"));
  assert(contents.includes(".vscode/"));
});

Deno.test("mergeGitignore — preserves existing CRLF lines and uses LF for appended block", () => {
  const crlf = "__pycache__/\r\n.vscode/\r\n";
  const { changed, contents } = mergeGitignore(crlf);
  assertEquals(changed, true);
  // Existing CRLF lines unchanged.
  assert(contents.startsWith("__pycache__/\r\n.vscode/\r\n"));
  // Appended block uses LF — that's an acceptable trade-off (git treats both
  // line endings the same for ignore patterns).
  const appendedSection = contents.slice(crlf.length);
  assert(!appendedSection.includes("\r"), "appended block should be LF-only");
});

Deno.test("mergeGitignore — idempotent (running on its own output is a no-op)", () => {
  const first = mergeGitignore(null);
  assertEquals(first.changed, true);
  const second = mergeGitignore(first.contents);
  assertEquals(second.changed, false);
  assertEquals(second.contents, first.contents);
});

Deno.test("mergeGitignore — idempotent on a partially-merged input", () => {
  const first = mergeGitignore(".env\nnode_modules/\n");
  assertEquals(first.changed, true);
  const second = mergeGitignore(first.contents);
  assertEquals(second.changed, false);
  assertEquals(second.contents, first.contents);
});

Deno.test("mergeGitignore — strips trailing-whitespace match (so `.env  ` counts as `.env`)", () => {
  const input = ".env  \nnode_modules/\n.env.*\n!.env.example\n.keni/state.json\ndist/\nbuild/\n";
  const { changed } = mergeGitignore(input);
  assertEquals(changed, false, "all required entries are present after trimming");
});

Deno.test("mergeGitignore — input without trailing newline gets the appended block on a new line", () => {
  const input = "__pycache__/";
  const { contents } = mergeGitignore(input);
  // The result must contain the original then the marker on a new line.
  assert(contents.startsWith("__pycache__/\n\n"));
  assert(contents.includes(KENI_GITIGNORE_MARKER));
});
