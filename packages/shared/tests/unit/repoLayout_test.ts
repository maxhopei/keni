/**
 * Repo-layout invariants — enforces the contract from the
 * `developer-setup` capability spec ("Tests live under
 * `packages/<pkg>/tests/`, never under `packages/<pkg>/src/`"). Failure
 * is the safety net for accidental re-introductions of co-located test
 * code or test-only support code under any package's `src/`.
 *
 * Walks `packages/<pkg>/src/**` for every workspace member and asserts:
 *
 *   - no file matches `*_test.{ts,tsx}` (test files belong under `tests/`);
 *   - no directory is named `fakes/`, `fixtures/`, `__fixtures__/`,
 *     `__tests__/`, or `tests/` (test-only support code belongs under
 *     `tests/`);
 *   - no file is named `contract_test.ts` (contract helpers live under
 *     `tests/contracts/` with non-`_test.ts` names so Deno's auto-load
 *     does not register a no-op test).
 *
 * Also asserts that every package has a `tests/` directory — the
 * eight-package "every-package-contributes-a-test" floor still holds.
 *
 * The `split-role-runtimes-package` change replaced the legacy
 * monolithic role-runtime package with four granular siblings
 * (`runtime-common`, `runtime-workspace`, `runtime-engineer`,
 * `runtime-po`); the workspace-membership test below pins the eight
 * documented members and SHALL fail loudly if `packages/role-runtimes/`
 * is ever re-introduced.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, join, relative } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../../../../", import.meta.url));
const PACKAGES = [
  "cli",
  "server",
  "spa",
  "runtime-common",
  "runtime-workspace",
  "runtime-engineer",
  "runtime-po",
  "shared",
] as const;

const FORBIDDEN_DIR_NAMES = new Set([
  "fakes",
  "fixtures",
  "__fixtures__",
  "__tests__",
  "tests",
]);

interface LayoutFinding {
  readonly absPath: string;
  readonly reason: string;
}

async function scanSrcForViolations(pkgSrc: string): Promise<LayoutFinding[]> {
  const findings: LayoutFinding[] = [];
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(pkgSrc);
  } catch {
    return findings;
  }
  if (!stat.isDirectory) return findings;

  for await (const entry of walk(pkgSrc, { includeDirs: true, includeFiles: true })) {
    if (entry.path === pkgSrc) continue;

    if (entry.isDirectory) {
      const base = entry.name;
      if (FORBIDDEN_DIR_NAMES.has(base)) {
        findings.push({
          absPath: entry.path,
          reason: `directory named '${base}/' under src/ — move under tests/`,
        });
      }
      continue;
    }

    if (entry.isFile) {
      const base = entry.name;
      if (base === "contract_test.ts") {
        findings.push({
          absPath: entry.path,
          reason:
            "contract_test.ts under src/ — move under tests/contracts/ and rename off the _test.ts suffix",
        });
        continue;
      }
      if (/_test\.tsx?$/.test(base)) {
        findings.push({
          absPath: entry.path,
          reason: "*_test.{ts,tsx} under src/ — move to tests/unit/ (or integration/, e2e/)",
        });
      }
    }
  }
  return findings;
}

Deno.test("repo layout — no *_test.ts(x) files under any packages/<pkg>/src/", async () => {
  const allFindings: LayoutFinding[] = [];
  for (const pkg of PACKAGES) {
    const pkgSrc = join(REPO_ROOT, "packages", pkg, "src");
    const findings = await scanSrcForViolations(pkgSrc);
    allFindings.push(
      ...findings.filter((f) => /_test\.tsx?$/.test(f.absPath)),
    );
  }
  assert(
    allFindings.length === 0,
    `expected zero *_test.{ts,tsx} files under packages/*/src; found ${allFindings.length}:\n${
      allFindings.map((f) => `  - ${relative(REPO_ROOT, f.absPath)}`).join("\n")
    }`,
  );
});

Deno.test(
  "repo layout — no fakes/ or fixtures/ directories under any packages/<pkg>/src/",
  async () => {
    const allFindings: LayoutFinding[] = [];
    for (const pkg of PACKAGES) {
      const pkgSrc = join(REPO_ROOT, "packages", pkg, "src");
      const findings = await scanSrcForViolations(pkgSrc);
      allFindings.push(
        ...findings.filter((f) =>
          f.reason.startsWith("directory named ") &&
          !f.reason.startsWith("directory named 'tests/")
        ),
      );
    }
    assert(
      allFindings.length === 0,
      `expected zero fakes/ / fixtures/ / __fixtures__/ / __tests__/ directories under packages/*/src; found ${allFindings.length}:\n${
        allFindings.map((f) => `  - ${relative(REPO_ROOT, f.absPath)} (${f.reason})`).join("\n")
      }`,
    );
  },
);

Deno.test("repo layout — no contract_test.ts file exists under any packages/<pkg>/src/", async () => {
  const allFindings: LayoutFinding[] = [];
  for (const pkg of PACKAGES) {
    const pkgSrc = join(REPO_ROOT, "packages", pkg, "src");
    const findings = await scanSrcForViolations(pkgSrc);
    allFindings.push(...findings.filter((f) => f.absPath.endsWith("/contract_test.ts")));
  }
  assert(
    allFindings.length === 0,
    `expected zero contract_test.ts files under packages/*/src; found ${allFindings.length}:\n${
      allFindings.map((f) => `  - ${relative(REPO_ROOT, f.absPath)}`).join("\n")
    }`,
  );
});

Deno.test("repo layout — every workspace package has a tests/ directory", async () => {
  const missing: string[] = [];
  for (const pkg of PACKAGES) {
    const pkgTests = join(REPO_ROOT, "packages", pkg, "tests");
    try {
      const stat = await Deno.stat(pkgTests);
      if (!stat.isDirectory) missing.push(pkg);
    } catch {
      missing.push(pkg);
    }
  }
  assert(
    missing.length === 0,
    `expected every package to have a tests/ directory; missing for: ${missing.join(", ")}`,
  );
});

/**
 * `split-role-runtimes-package` §11.6 — pin the workspace's eight
 * documented members. The test reads the root `deno.json` directly
 * (via JSON parse, not import-assert, to avoid a static-analysis
 * dependency edge into the repo root) and compares the `workspace`
 * array to {@link PACKAGES} verbatim. Drift in either direction —
 * adding a member without registering it here, or removing a member
 * without updating the consumer-side documentation — fails loudly.
 */
Deno.test("repo layout — workspace deno.json lists exactly the eight documented members", async () => {
  const denoJsonPath = join(REPO_ROOT, "deno.json");
  const raw = await Deno.readTextFile(denoJsonPath);
  const parsed = JSON.parse(raw) as { readonly workspace?: readonly string[] };
  const members = parsed.workspace ?? [];
  const expected = PACKAGES.map((p) => `./packages/${p}`);
  assertEquals(
    [...members].sort(),
    [...expected].sort(),
    `workspace members drifted from PACKAGES; deno.json lists ${
      JSON.stringify(members)
    }, expected ${JSON.stringify(expected)}`,
  );
});

/**
 * `split-role-runtimes-package` §11.2 / §11.6 — the legacy
 * `packages/role-runtimes/` directory was deleted as part of the
 * granular-split atomic flip. This test is a tripwire that fires if
 * the directory is ever re-introduced (intentionally or by a stale
 * branch merge).
 */
Deno.test("repo layout — packages/role-runtimes/ does not exist", async () => {
  const legacyPath = join(REPO_ROOT, "packages", "role-runtimes");
  let exists = false;
  try {
    const stat = await Deno.stat(legacyPath);
    exists = stat.isDirectory || stat.isFile;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  assertEquals(
    exists,
    false,
    `expected packages/role-runtimes/ to be absent (the split-role-runtimes-package change deleted it); found something at ${legacyPath}`,
  );
});

/**
 * `split-role-runtimes-package` §11.6 — every package's `deno.json`
 * SHALL declare a `name` field that matches its directory under
 * `@keni/<dir>`. This catches accidental rename-without-rewire bugs.
 */
Deno.test("repo layout — every package's deno.json `name` matches its directory", async () => {
  const mismatches: string[] = [];
  for (const pkg of PACKAGES) {
    const denoJsonPath = join(REPO_ROOT, "packages", pkg, "deno.json");
    let raw: string;
    try {
      raw = await Deno.readTextFile(denoJsonPath);
    } catch {
      mismatches.push(`${pkg}: missing packages/${pkg}/deno.json`);
      continue;
    }
    const parsed = JSON.parse(raw) as { readonly name?: string };
    const expected = `@keni/${pkg}`;
    if (parsed.name !== expected) {
      mismatches.push(`${pkg}: name=${JSON.stringify(parsed.name)}, expected ${expected}`);
    }
  }
  assertEquals(
    mismatches,
    [],
    `package deno.json name drift detected:\n  ${mismatches.join("\n  ")}`,
  );
});
