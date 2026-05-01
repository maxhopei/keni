/**
 * Path resolution for Keni's file-backed storage adapters.
 *
 * The storage adapters never read environment variables, `Deno.cwd()`, or any
 * implicit root — every path is resolved upfront by these helpers from an
 * explicit project root or home directory. This keeps the adapters trivially
 * testable (tests pass in `Deno.makeTempDir()` output) and explicit about what
 * paths will be touched.
 *
 * The resolved layout mirrors `spec.md` §5.1 (project) and §5.2 (global)
 * exactly.
 *
 * @module
 */

import { join, normalize } from "@std/path";

/** Resolved filesystem paths for every file-backed artifact inside a project. */
export interface ProjectPaths {
  /** Project root (the folder containing `.keni/` and the user's code). */
  readonly root: string;
  /** `<root>/.keni/` — everything Keni owns per-project. */
  readonly keni: string;
  /** `<root>/.keni/tickets/` — one `ticket-NNNN.md` per ticket. */
  readonly tickets: string;
  /** `<root>/.keni/prs/` — one `pr-NNNN.md` per PR record. */
  readonly prs: string;
  /** `<root>/.keni/activity/` — date-partitioned `YYYY-MM-DD.jsonl` files. */
  readonly activity: string;
  /** `<root>/.keni/project.yaml` — committed project config. */
  readonly projectConfig: string;
}

/** Resolved filesystem paths under the user's home `~/.keni/` directory. */
export interface GlobalPaths {
  /** Home directory supplied by the caller (never read from env). */
  readonly home: string;
  /** `<home>/.keni/` — user-level Keni state. */
  readonly keni: string;
  /** `<home>/.keni/config.yaml` — optional user-level defaults. */
  readonly globalConfig: string;
  /** `<home>/.keni/workspaces/` — engineer workspace clones (used by later steps). */
  readonly workspaces: string;
  /** `<home>/.keni/logs/` — server-level logs (used by later steps). */
  readonly logs: string;
}

/**
 * Resolve every project-scoped path used by file-backed adapters.
 * `projectRoot` is the folder that contains (or will contain) `.keni/` —
 * typically the git repo root.
 *
 * The returned paths are normalised (collapsing `.` and `..`) but are not
 * checked for existence; the adapters lazy-create subdirectories on first
 * write via `@std/fs` `ensureDir` or `Deno.mkdir({ recursive: true })`.
 */
export function resolveProjectPaths(projectRoot: string): ProjectPaths {
  const root = normalize(projectRoot);
  const keni = join(root, ".keni");
  return {
    root,
    keni,
    tickets: join(keni, "tickets"),
    prs: join(keni, "prs"),
    activity: join(keni, "activity"),
    projectConfig: join(keni, "project.yaml"),
  };
}

/**
 * Resolve every global (per-user) path used by file-backed adapters. `home`
 * is the user's home directory; callers pass `Deno.env.get("HOME") ?? "/"`
 * or a test temp dir as appropriate.
 */
export function resolveGlobalPaths(home: string): GlobalPaths {
  const normalisedHome = normalize(home);
  const keni = join(normalisedHome, ".keni");
  return {
    home: normalisedHome,
    keni,
    globalConfig: join(keni, "config.yaml"),
    workspaces: join(keni, "workspaces"),
    logs: join(keni, "logs"),
  };
}
