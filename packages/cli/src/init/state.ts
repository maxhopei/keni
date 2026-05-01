/**
 * Inspect the current on-disk state of a Keni project.
 *
 * `inspectProjectState` is intentionally read-only: it scans for every file /
 * directory `keni init` would create or modify and reports what is present
 * vs. missing, plus the parsed `project.yaml` (or `null` if absent). The
 * planner then turns this snapshot into the minimal action list.
 *
 * Errors:
 *
 * - A malformed `project.yaml` propagates as `ProjectStateError`
 *   (`reason: "malformed_project_yaml"`) so `runInit` can refuse to repair it.
 * - A missing `project.yaml` is **not** an error; it shows up as
 *   `projectConfig: null` and the planner schedules `write_project_config`.
 *
 * @module
 */

import { join } from "@std/path";
import { InvalidArtifactError, StoreNotFoundError } from "@keni/shared";
import type { ConfigStore, GlobalPaths, ProjectConfig, ProjectPaths } from "@keni/shared";
import { ProjectStateError } from "./errors.ts";
import type { GitClient } from "./git.ts";

/** Resolved on-disk snapshot of a project at the moment `keni init` is invoked. */
export interface ProjectState {
  readonly projectPaths: ProjectPaths;
  readonly globalPaths: GlobalPaths;
  /** True iff the project root contains a `.git/` and `git rev-parse --git-dir` succeeds. */
  readonly isGitRepo: boolean;
  /** True iff `<root>/.keni/` exists. */
  readonly keniDirExists: boolean;
  /** True iff `<root>/.keni/tickets/` exists as a directory. */
  readonly ticketsDirExists: boolean;
  /** True iff `<root>/.keni/tickets/.gitkeep` exists as a regular file. */
  readonly ticketsGitkeepExists: boolean;
  /** True iff `<root>/.keni/prs/` exists as a directory. */
  readonly prsDirExists: boolean;
  /** True iff `<root>/.keni/prs/.gitkeep` exists as a regular file. */
  readonly prsGitkeepExists: boolean;
  /** True iff `<root>/.keni/activity/` exists as a directory. */
  readonly activityDirExists: boolean;
  /** True iff `<root>/.keni/activity/.gitkeep` exists as a regular file. */
  readonly activityGitkeepExists: boolean;
  /** Parsed project config, or `null` if `project.yaml` does not exist. */
  readonly projectConfig: ProjectConfig | null;
  /** True iff `<root>/.keni/state.json` exists (any contents). */
  readonly stateJsonExists: boolean;
  /** Existing `<root>/.gitignore` contents, or `null` if missing. */
  readonly gitignore: string | null;
  /** True iff `<home>/.keni/` exists. */
  readonly globalKeniDirExists: boolean;
  /** True iff `<home>/.keni/logs/` exists. */
  readonly globalLogsDirExists: boolean;
  /** True iff `<home>/.keni/config.yaml` exists (regardless of contents). */
  readonly globalConfigExists: boolean;
}

/**
 * Inspect the project root and the user's home directory and return a
 * `ProjectState`. The function does not mutate anything.
 *
 * @throws {ProjectStateError} when `project.yaml` exists but is malformed.
 */
export async function inspectProjectState(
  projectPaths: ProjectPaths,
  globalPaths: GlobalPaths,
  configStore: ConfigStore,
  gitClient: GitClient,
): Promise<ProjectState> {
  const isGitRepo = await gitClient.isRepo(projectPaths.root);
  const keniDirExists = await dirExists(projectPaths.keni);
  const ticketsDirExists = await dirExists(projectPaths.tickets);
  const ticketsGitkeepExists = await fileExists(join(projectPaths.tickets, ".gitkeep"));
  const prsDirExists = await dirExists(projectPaths.prs);
  const prsGitkeepExists = await fileExists(join(projectPaths.prs, ".gitkeep"));
  const activityDirExists = await dirExists(projectPaths.activity);
  const activityGitkeepExists = await fileExists(join(projectPaths.activity, ".gitkeep"));
  const stateJsonExists = await fileExists(join(projectPaths.keni, "state.json"));
  const gitignore = await readFileOrNull(join(projectPaths.root, ".gitignore"));
  const globalKeniDirExists = await dirExists(globalPaths.keni);
  const globalLogsDirExists = await dirExists(globalPaths.logs);
  const globalConfigExists = await fileExists(globalPaths.globalConfig);

  let projectConfig: ProjectConfig | null = null;
  try {
    projectConfig = await configStore.readProjectConfig();
  } catch (err) {
    if (err instanceof StoreNotFoundError) {
      projectConfig = null;
    } else if (err instanceof InvalidArtifactError) {
      throw new ProjectStateError(
        "malformed_project_yaml",
        err.message,
        err.path ?? projectPaths.projectConfig,
      );
    } else {
      throw err;
    }
  }

  return {
    projectPaths,
    globalPaths,
    isGitRepo,
    keniDirExists,
    ticketsDirExists,
    ticketsGitkeepExists,
    prsDirExists,
    prsGitkeepExists,
    activityDirExists,
    activityGitkeepExists,
    projectConfig,
    stateJsonExists,
    gitignore,
    globalKeniDirExists,
    globalLogsDirExists,
    globalConfigExists,
  };
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}
