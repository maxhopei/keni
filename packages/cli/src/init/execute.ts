/**
 * Sequential executor that applies a planned list of {@link InitAction}s.
 *
 * Handlers are sequential by construction (no `Promise.all`) so the order of
 * the action list is the order of the side effects. The executor does not
 * mutate `actions`; on success it returns a small summary describing what
 * happened (used by `runInit` to choose the right success message).
 *
 * The `git_commit` handler stages the supplied paths, checks
 * `hasStagedOrUnstagedChanges`, and skips the commit if there is nothing
 * staged. This handles the case where the planner emitted a commit but the
 * underlying actions left the working tree clean (e.g., a `merge_gitignore`
 * that was a no-op despite the planner thinking it was needed — defensive
 * check).
 *
 * @module
 */

import { join } from "@std/path";
import type { ConfigStore, GlobalPaths, ProjectPaths } from "@keni/shared";
import type { GitClient } from "./git.ts";
import type { InitAction, KeniSubdirKind } from "./plan.ts";
import { GLOBAL_CONFIG_STUB, STATE_JSON_SKELETON } from "./plan.ts";

/** Inputs the executor needs in addition to the action list. */
export interface ExecuteDeps {
  readonly projectPaths: ProjectPaths;
  readonly globalPaths: GlobalPaths;
  readonly configStore: ConfigStore;
  readonly gitClient: GitClient;
}

/** Summary of what `executeActions` did. Returned to `runInit`. */
export interface ExecuteResult {
  /**
   * True iff a `git_commit` action actually produced a new commit. False
   * when there was no commit action OR when the commit was skipped because
   * nothing was staged.
   */
  readonly commitProduced: boolean;
  /**
   * Names of the subdirectories whose contents were re-created during the
   * run, e.g. `["tickets", "activity"]`. Empty for a fresh init (the
   * `runInit` caller treats fresh-init separately via the planner output)
   * and empty for an idempotent no-op.
   */
  readonly recreatedSubdirs: readonly KeniSubdirKind[];
  /** True iff `write_project_config` ran. */
  readonly wroteProjectConfig: boolean;
  /** True iff `merge_gitignore` ran. */
  readonly mergedGitignore: boolean;
  /** True iff `ensure_global_dir` ran. */
  readonly bootstrappedGlobalDir: boolean;
  /** True iff `write_global_config_stub` ran. */
  readonly wroteGlobalConfigStub: boolean;
}

/**
 * Apply each action in order. Returns the run summary on success; throws on
 * the first failing action (subsequent actions are not attempted).
 */
export async function executeActions(
  actions: readonly InitAction[],
  deps: ExecuteDeps,
): Promise<ExecuteResult> {
  const recreatedSubdirs: KeniSubdirKind[] = [];
  let commitProduced = false;
  let wroteProjectConfig = false;
  let mergedGitignore = false;
  let bootstrappedGlobalDir = false;
  let wroteGlobalConfigStub = false;

  for (const action of actions) {
    switch (action.kind) {
      case "git_init":
        await deps.gitClient.init(deps.projectPaths.root);
        break;
      case "create_keni_root":
        await Deno.mkdir(deps.projectPaths.keni, { recursive: true });
        break;
      case "create_keni_subdir": {
        const dir = subdirPath(deps.projectPaths, action.subdir);
        await Deno.mkdir(dir, { recursive: true });
        const gitkeep = join(dir, ".gitkeep");
        await Deno.writeTextFile(gitkeep, "");
        recreatedSubdirs.push(action.subdir);
        break;
      }
      case "write_project_config":
        await deps.configStore.writeProjectConfig(action.config);
        wroteProjectConfig = true;
        break;
      case "write_state_json":
        await Deno.writeTextFile(
          join(deps.projectPaths.keni, "state.json"),
          STATE_JSON_SKELETON,
        );
        break;
      case "ensure_global_dir":
        await Deno.mkdir(deps.globalPaths.keni, { recursive: true });
        await Deno.mkdir(deps.globalPaths.logs, { recursive: true });
        bootstrappedGlobalDir = true;
        break;
      case "write_global_config_stub":
        await deps.configStore.writeGlobalConfig({ ...GLOBAL_CONFIG_STUB });
        wroteGlobalConfigStub = true;
        break;
      case "merge_gitignore":
        await Deno.writeTextFile(
          join(deps.projectPaths.root, ".gitignore"),
          action.contents,
        );
        mergedGitignore = true;
        break;
      case "git_commit": {
        await deps.gitClient.add(deps.projectPaths.root, action.paths);
        const dirty = await deps.gitClient.hasStagedOrUnstagedChanges(
          deps.projectPaths.root,
        );
        if (dirty) {
          await deps.gitClient.commit(deps.projectPaths.root, action.message);
          commitProduced = true;
        }
        break;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unhandled action kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return {
    commitProduced,
    recreatedSubdirs,
    wroteProjectConfig,
    mergedGitignore,
    bootstrappedGlobalDir,
    wroteGlobalConfigStub,
  };
}

function subdirPath(paths: ProjectPaths, kind: KeniSubdirKind): string {
  switch (kind) {
    case "tickets":
      return paths.tickets;
    case "prs":
      return paths.prs;
    case "activity":
      return paths.activity;
  }
}
