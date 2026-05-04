/**
 * SPA-bundle resolution for `keni start`.
 *
 * Resolves either:
 *
 *  - `{ mode: "dev", devUrl }`  — the user opted into proxying their
 *    Vite dev server via `--spa-dev-url <url>` or via the merged
 *    config's `spa.mode: "dev"` + `spa.dev_url`.
 *  - `{ mode: "bundled", root }` — the user wants the production
 *    bundle. The `root` is one of:
 *      1. the explicit `--spa-bundle <path>` flag (or `spa.bundle`
 *         in the merged config);
 *      2. the workspace-relative `<repoRoot>/packages/spa/dist/`
 *         (the default).
 *    Future binary-packaged paths land in a follow-up change; document
 *    the seam inline so a subsequent contributor knows where to extend.
 *
 * In `mode: "bundled"`, when the resolved `dist/index.html` does not
 * exist, throws {@link SpaBundleMissingError} naming the expected path
 * and the `deno task build` invocation.
 *
 * @module
 */

import { dirname, fromFileUrl, isAbsolute, join, resolve } from "@std/path";
import type { SpaSection } from "./loadConfig.ts";

/** Throws when the bundled mode cannot find an `index.html`. */
export class SpaBundleMissingError extends Error {
  override readonly name = "SpaBundleMissingError";
  readonly expectedRoot: string;

  constructor(expectedRoot: string) {
    super(
      `SPA bundle not found at ${expectedRoot}/index.html.\n` +
        `Run \`deno task build\` from the workspace root to produce the SPA bundle.`,
    );
    this.expectedRoot = expectedRoot;
  }
}

/** Resolved descriptor returned by {@link resolveSpaBundle}. */
export type ResolvedSpaBundle =
  | { readonly mode: "bundled"; readonly root: string }
  | { readonly mode: "dev"; readonly devUrl: string };

/** Inputs for {@link resolveSpaBundle}. */
export interface ResolveSpaBundleInput {
  readonly spa: SpaSection;
  /**
   * Project directory. Used as the resolution base for any relative
   * `--spa-bundle` path the user supplies (so `--spa-bundle dist/` is
   * interpreted relative to the project).
   */
  readonly projectDir: string;
  /**
   * Workspace root. When omitted, falls back to walking up from this
   * module's source URL until a `deno.json` with `workspace:` is found.
   */
  readonly repoRoot?: string;
}

/**
 * Resolve the SPA-serving descriptor and validate the bundled-mode
 * directory exists.
 *
 * @throws {SpaBundleMissingError} in bundled mode when the resolved
 *   path does not contain `index.html`.
 */
export function resolveSpaBundle(input: ResolveSpaBundleInput): ResolvedSpaBundle {
  if (input.spa.mode === "dev") {
    return { mode: "dev", devUrl: input.spa.dev_url };
  }
  const explicit = input.spa.bundle;
  let root: string;
  if (explicit !== undefined) {
    root = isAbsolute(explicit) ? explicit : resolve(input.projectDir, explicit);
  } else {
    const repoRoot = input.repoRoot ?? findRepoRoot();
    root = join(repoRoot, "packages", "spa", "dist");
  }
  // Future: when binary packaging lands, an additional fallback to a
  // path embedded in the binary's resources directory plugs in here.
  // (out of scope for the prototype — see the `cli-start` capability spec).
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(join(root, "index.html"));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) throw new SpaBundleMissingError(root);
    throw e;
  }
  if (!stat.isFile) throw new SpaBundleMissingError(root);
  return { mode: "bundled", root };
}

/**
 * Walk up from this module's directory until a `deno.json` with a
 * `workspace:` array is found. The result is cached because the
 * answer never changes within a process.
 */
let cachedRepoRoot: string | undefined;
function findRepoRoot(): string {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot;
  let cur = dirname(fromFileUrl(import.meta.url));
  for (let depth = 0; depth < 32; depth++) {
    const candidate = join(cur, "deno.json");
    try {
      const text = Deno.readTextFileSync(candidate);
      const json = JSON.parse(text) as Record<string, unknown>;
      if (Array.isArray(json["workspace"])) {
        cachedRepoRoot = cur;
        return cur;
      }
    } catch {
      // ignore — keep walking up
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Fallback: if the search fails, return the cwd. Tests that need a
  // deterministic root pass `repoRoot` explicitly.
  cachedRepoRoot = Deno.cwd();
  return cachedRepoRoot;
}
