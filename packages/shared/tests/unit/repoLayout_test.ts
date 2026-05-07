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
 * five-package "every-package-contributes-a-test" floor still holds.
 *
 * @module
 */

import { assert } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, join, relative } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../../../../", import.meta.url));
const PACKAGES = ["cli", "server", "spa", "role-runtimes", "shared"] as const;

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
