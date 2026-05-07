/**
 * Structural tests for the bundled engineer prompt.
 *
 * These tests pin the eight-section structure, the per-section
 * required substrings, the length window, and the no-template-no-IO
 * source-file invariants documented in the `engineer-prompt`
 * capability spec. Editorial wording inside each section is *not*
 * pinned — only the structural contract.
 *
 * @module
 */

import { assert, assertEquals, assertGreaterOrEqual, assertLessOrEqual } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  ENGINEER_PROMPT_BODY,
  ENGINEER_PROMPT_NAME,
} from "../../../../src/engineer/prompts/engineer.ts";

const SOURCE_PATH = fromFileUrl(
  new URL("../../../../src/engineer/prompts/engineer.ts", import.meta.url),
);

const SECTION_HEADINGS = [
  "## 1. Identity",
  "## 2. Workspace",
  "## 3. MCP tools",
  "## 4. The loop",
  "## 5. Self-review",
  "## 6. Integration tests",
  "## 7. Summary line",
  "## 8. Refusals",
] as const;

const ENGINEER_TOOL_NAMES = [
  "list_tickets",
  "read_ticket",
  "update_ticket_body",
  "transition_ticket_status",
  "append_activity_entry",
  "query_activity",
  "get_workspace_path",
  "merge_pr",
] as const;

const PO_TOOL_NAMES = ["propose_change", "chat_send"] as const;

function extractSection(name: typeof SECTION_HEADINGS[number]): string {
  const lines = ENGINEER_PROMPT_BODY.split("\n");
  const start = lines.findIndex((l) => l === name);
  assert(start >= 0, `section heading not found: ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

Deno.test("ENGINEER_PROMPT_NAME is the literal 'engineer'", () => {
  assertEquals(ENGINEER_PROMPT_NAME, "engineer");
});

Deno.test("ENGINEER_PROMPT_BODY length is within [500, 8192]", () => {
  assertGreaterOrEqual(ENGINEER_PROMPT_BODY.length, 500);
  assertLessOrEqual(ENGINEER_PROMPT_BODY.length, 8192);
});

Deno.test("ENGINEER_PROMPT_BODY contains all eight section headings in order", () => {
  const lines = ENGINEER_PROMPT_BODY.split("\n");
  const found: string[] = [];
  for (const line of lines) {
    if (/^## \d+\. /.test(line)) found.push(line);
  }
  assertEquals(found, [...SECTION_HEADINGS]);
});

Deno.test("Section 1 (Identity) names the role and identity env vars", () => {
  const section = extractSection("## 1. Identity");
  assert(section.includes("engineer"), "Section 1 must contain the literal 'engineer'");
  assert(section.includes("KENI_MCP_AGENT"), "Section 1 must name KENI_MCP_AGENT");
  assert(section.includes("KENI_MCP_SERVER_URL"), "Section 1 must name KENI_MCP_SERVER_URL");
});

Deno.test("Section 1 (Identity) refuses git config user.name / user.email overrides", () => {
  const section = extractSection("## 1. Identity").toLowerCase();
  assert(section.includes("git config"), "Section 1 must mention `git config`");
  assert(
    section.includes("user.name") || section.includes("user.email"),
    "Section 1 must mention `user.name` or `user.email`",
  );
  assert(
    section.includes("never") || section.includes("must not") || section.includes("do not"),
    "Section 1 must include a refusal verb (never / must not / do not) for git config overrides",
  );
});

Deno.test("Section 2 (Workspace) names the workspace env var, .keni/ invariant, and get_workspace_path", () => {
  const section = extractSection("## 2. Workspace");
  assert(section.includes("KENI_MCP_WORKSPACE"), "Section 2 must name KENI_MCP_WORKSPACE");
  assert(section.includes(".keni/"), "Section 2 must mention `.keni/`");
  assert(
    section.includes("get_workspace_path"),
    "Section 2 must reference the `get_workspace_path` MCP tool",
  );
});

Deno.test("Section 2 (Workspace) prohibits .keni/ writes with a refusal verb", () => {
  const section = extractSection("## 2. Workspace").toLowerCase();
  const idx = section.indexOf(".keni/");
  assert(idx >= 0, "Section 2 must mention `.keni/`");
  assert(
    section.includes("never") || section.includes("must not") || section.includes("do not") ||
      section.includes("not present") || section.includes("cannot see"),
    "Section 2 must contain a refusal verb in the same section as `.keni/`",
  );
});

Deno.test("Section 3 (MCP tools) lists all eight engineer tool names exactly once", () => {
  const section = extractSection("## 3. MCP tools");
  for (const name of ENGINEER_TOOL_NAMES) {
    assert(section.includes(name), `Section 3 must list MCP tool '${name}'`);
  }
  for (const forbidden of PO_TOOL_NAMES) {
    assert(
      !section.includes(forbidden),
      `Section 3 must NOT list PO-only tool '${forbidden}'`,
    );
  }
});

Deno.test("Section 3 (MCP tools) documents the REST exception for PR creation and transition", () => {
  const section = extractSection("## 3. MCP tools");
  assert(section.includes("POST /prs"), "Section 3 must name `POST /prs`");
  assert(
    section.includes("POST /prs/:id/transition"),
    "Section 3 must name `POST /prs/:id/transition`",
  );
  assert(
    section.includes("KENI_MCP_SERVER_URL"),
    "Section 3 must reference KENI_MCP_SERVER_URL as the REST base URL",
  );
  assert(
    section.includes("X-Keni-Role: engineer"),
    "Section 3 must reference the engineer role header",
  );
  assert(
    section.includes("X-Keni-Agent"),
    "Section 3 must reference the X-Keni-Agent header",
  );
});

Deno.test("Section 4 (The loop) contains at least seven numbered steps", () => {
  const section = extractSection("## 4. The loop");
  const lines = section.split("\n");
  const numbered = lines.filter((l) => /^\d+\. \*\*/.test(l));
  assertGreaterOrEqual(numbered.length, 7);
});

Deno.test("Section 4 (The loop) names list_tickets, the open→in_progress transition, merge_pr, and merged→ready_for_test", () => {
  const section = extractSection("## 4. The loop");
  assert(section.includes("list_tickets"), "Section 4 must include `list_tickets`");
  assert(
    section.includes("transition_ticket_status"),
    "Section 4 must include `transition_ticket_status`",
  );
  assert(
    section.includes("open") && section.includes("in_progress"),
    "Section 4 must mention the open → in_progress transition",
  );
  assert(section.includes("merge_pr"), "Section 4 must include `merge_pr`");
  assert(
    section.includes("merged") && section.includes("ready_for_test"),
    "Section 4 must mention the merged → ready_for_test transition",
  );
});

Deno.test("Section 4 (The loop) names the 'one ticket per session/cycle' invariant", () => {
  const section = extractSection("## 4. The loop").toLowerCase();
  assert(
    section.includes("one ticket per session") || section.includes("one ticket per cycle"),
    "Section 4 must include the `one ticket per session` (or `cycle`) phrase",
  );
});

Deno.test("Section 5 (Self-review) names the fresh-session rule and the cross-cycle status signal", () => {
  const section = extractSection("## 5. Self-review").toLowerCase();
  assert(
    section.includes("fresh session") || section.includes("new subprocess"),
    "Section 5 must contain `fresh session` or `new subprocess`",
  );
  assert(
    section.includes("status"),
    "Section 5 must reference the ticket's status field as the cross-cycle signal",
  );
});

Deno.test("Section 5 (Self-review) names the git diff main...ticket-NNNN review surface", () => {
  const section = extractSection("## 5. Self-review");
  assert(
    section.includes("git diff main...ticket-") || section.includes("git diff main..."),
    "Section 5 must reference `git diff main...ticket-NNNN`",
  );
});

Deno.test("Section 6 (Integration tests) names docker-compose, docker-compose.yml, --rm and tests", () => {
  const section = extractSection("## 6. Integration tests");
  assert(section.includes("docker-compose"), "Section 6 must mention `docker-compose`");
  assert(
    section.includes("docker-compose.yml"),
    "Section 6 must mention `docker-compose.yml`",
  );
  assert(section.includes("--rm"), "Section 6 must mention `--rm`");
  assert(section.includes("tests"), "Section 6 must mention the `tests` service");
});

Deno.test("Section 6 (Integration tests) reminds the agent the activity log captures stdout/stderr", () => {
  const section = extractSection("## 6. Integration tests").toLowerCase();
  assert(
    section.includes("activity log"),
    "Section 6 must remind the agent that the activity log captures the command output",
  );
});

Deno.test("Section 7 (Summary line) names the final-stdout-line / last-non-empty rule", () => {
  const section = extractSection("## 7. Summary line").toLowerCase();
  assert(
    section.includes("final stdout line") || section.includes("last non-empty"),
    "Section 7 must contain `final stdout line` or `last non-empty`",
  );
});

Deno.test("Section 7 (Summary line) gives at least two example summary lines naming a ticket and a status", () => {
  const section = extractSection("## 7. Summary line");
  const exampleMatches = [...section.matchAll(/`ticket-[^`]+`/g)];
  assertGreaterOrEqual(
    exampleMatches.length,
    2,
    "Section 7 must give at least two backticked summary-line examples naming a ticket id",
  );
});

Deno.test("Section 8 (Refusals) names .keni/, git push origin main, transition_ticket_status, and ~/.gitconfig", () => {
  const section = extractSection("## 8. Refusals");
  const lower = section.toLowerCase();
  assert(section.includes(".keni/"), "Section 8 must mention `.keni/`");
  assert(
    section.includes("git push") && section.includes("main"),
    "Section 8 must refuse `git push origin main`",
  );
  assert(
    section.includes("transition_ticket_status"),
    "Section 8 must mention `transition_ticket_status`",
  );
  assert(section.includes("~/.gitconfig"), "Section 8 must mention `~/.gitconfig`");
  assert(
    lower.includes("never") || lower.includes("must not") || lower.includes("do not"),
    "Section 8 must use a refusal verb",
  );
});

Deno.test("Source file does not call Deno.readTextFile / Deno.env.get / import.meta.resolve", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);
  assert(
    !source.includes("Deno.readTextFile("),
    "engineer.ts must not call Deno.readTextFile()",
  );
  assert(!source.includes("Deno.readFile("), "engineer.ts must not call Deno.readFile()");
  assert(!source.includes("Deno.env.get("), "engineer.ts must not call Deno.env.get()");
  assert(
    !source.includes("import.meta.resolve("),
    "engineer.ts must not call import.meta.resolve()",
  );
});

Deno.test("Source file does not contain ${...} template interpolation", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);
  assert(
    !/\$\{[^}]+\}/.test(source),
    "engineer.ts must not contain template interpolation; the body is a literal constant",
  );
});
