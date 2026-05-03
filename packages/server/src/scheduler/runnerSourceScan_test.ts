/**
 * Structural assertions for `packages/server/src/scheduler/`
 * production source files (excludes `*_test.ts` and `fakes/`).
 *
 * Three structural rules per `openspec/specs/scheduler/spec.md`:
 *
 *  1. No role-keyed conditionals (`=== "engineer"` etc.).
 *  2. No `.keni/` filesystem reads or writes.
 *  3. No direct `setTimeout(` / `clearTimeout(` / `Date.now(` outside
 *     `clock.ts` (the seam that wraps the globals).
 *
 * Mirrors the role-runtime's `integration_test.ts` source-scan
 * pattern — comments are stripped before scanning so doc-comments
 * referencing the forbidden tokens don't trip the test.
 */

import { fromFileUrl, join } from "@std/path";

const SCHEDULER_DIR = fromFileUrl(new URL(".", import.meta.url));

async function listProductionSourceFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(SCHEDULER_DIR)) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith("_test.ts")) continue;
    out.push(join(SCHEDULER_DIR, entry.name));
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

Deno.test("structural — scheduler source has no role-keyed conditionals", async () => {
  const files = await listProductionSourceFiles();
  const forbidden = [
    '=== "engineer"',
    '=== "qa"',
    '=== "po"',
    '=== "writer"',
    '=== "user"',
    "=== 'engineer'",
    "=== 'qa'",
    "=== 'po'",
    "=== 'writer'",
    "=== 'user'",
  ];
  for (const file of files) {
    const stripped = stripComments(await Deno.readTextFile(file));
    for (const literal of forbidden) {
      if (stripped.includes(literal)) {
        throw new Error(
          `${file}: contains forbidden role-keyed conditional \`${literal}\``,
        );
      }
    }
  }
});

Deno.test("structural — scheduler source contains no `.keni/` reads or writes", async () => {
  const files = await listProductionSourceFiles();
  for (const file of files) {
    const stripped = stripComments(await Deno.readTextFile(file));
    for (
      const forbidden of [
        "Deno.readTextFile",
        "Deno.readFile",
        "Deno.writeTextFile",
        "Deno.writeFile",
      ]
    ) {
      if (stripped.includes(forbidden)) {
        throw new Error(`${file}: contains forbidden FS primitive \`${forbidden}\``);
      }
    }
    for (const pathToken of ['".keni/', "'.keni/", '"~/.keni/', "'~/.keni/"]) {
      if (stripped.includes(pathToken)) {
        throw new Error(`${file}: contains forbidden path literal \`${pathToken}\``);
      }
    }
  }
});

Deno.test("structural — scheduler source uses the injected clock (no direct setTimeout/clearTimeout/Date.now outside clock.ts)", async () => {
  const files = await listProductionSourceFiles();
  // `clock.ts` is the sanctioned seam; every other production file
  // SHALL reach time via `SchedulerClock`.
  const directCallPatterns: Array<[string, RegExp]> = [
    ["setTimeout(", /(?<![.\w])setTimeout\s*\(/],
    ["clearTimeout(", /(?<![.\w])clearTimeout\s*\(/],
    ["Date.now(", /(?<![.\w])Date\.now\s*\(/],
  ];
  for (const file of files) {
    if (file.endsWith("/clock.ts")) continue;
    const stripped = stripComments(await Deno.readTextFile(file));
    for (const [label, pattern] of directCallPatterns) {
      if (pattern.test(stripped)) {
        throw new Error(
          `${file}: contains forbidden direct call to \`${label}\`; use the injected SchedulerClock from \`clock.ts\``,
        );
      }
    }
  }
});

Deno.test("structural — scheduler source does not import a TicketStore", async () => {
  const files = await listProductionSourceFiles();
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    if (/\bTicketStore\b/.test(text) || /\bTicketRepository\b/.test(text)) {
      throw new Error(
        `${file}: imports a ticket-store identifier; the scheduler MUST NOT auto-revert ticket status (spec.md §7.5).`,
      );
    }
  }
});
