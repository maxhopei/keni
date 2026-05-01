/**
 * Pure planner: turn a {@link ProjectState} snapshot into the minimal list of
 * {@link InitAction}s needed to bring the project into compliance with the
 * `project-layout` capability spec.
 *
 * The function is total and deterministic. Re-running it after an
 * `executeActions` pass that succeeded produces an empty list (idempotent
 * no-op) — that is the test of correctness for the whole module.
 *
 * Behaviour matches the matrix in `design.md` Decision 9, with the
 * `.gitkeep` clarification from Decision 4b. The planner does no I/O; the
 * executor (in `execute.ts`) applies the returned actions sequentially.
 *
 * @module
 */

import type { ProjectConfig } from "@keni/shared";
import { mergeGitignore } from "./gitignore.ts";
import type { ProjectState } from "./state.ts";

/**
 * Identifier for the three Keni-managed `.keni/` subdirectories that need a
 * `.gitkeep` placeholder so git tracks them even when empty.
 */
export type KeniSubdirKind = "tickets" | "prs" | "activity";

/** A single planned mutation. The executor maps each variant to one effect. */
export type InitAction =
  /** Run `git init` in the project root. */
  | { readonly kind: "git_init" }
  /** Create `<root>/.keni/` (no placeholder file — `project.yaml` lives here). */
  | { readonly kind: "create_keni_root" }
  /**
   * Ensure `<root>/.keni/<subdir>/` exists and contains a zero-byte
   * `.gitkeep` placeholder so the directory is tracked by git even when
   * empty (per `design.md` Decision 4b).
   */
  | { readonly kind: "create_keni_subdir"; readonly subdir: KeniSubdirKind }
  /** Write `<root>/.keni/project.yaml` via `ConfigStore.writeProjectConfig`. */
  | { readonly kind: "write_project_config"; readonly config: ProjectConfig }
  /** Write the `<root>/.keni/state.json` placeholder skeleton. */
  | { readonly kind: "write_state_json" }
  /** Ensure `<home>/.keni/` and `<home>/.keni/logs/` exist as directories. */
  | { readonly kind: "ensure_global_dir" }
  /** Write the empty `<home>/.keni/config.yaml` stub via `ConfigStore.writeGlobalConfig`. */
  | { readonly kind: "write_global_config_stub" }
  /** Write `<root>/.gitignore` with the merged contents. */
  | { readonly kind: "merge_gitignore"; readonly contents: string }
  /**
   * Stage the supplied paths (relative to `<root>`) and produce one commit.
   * Emitted last when at least one tracked file was created or modified.
   */
  | {
    readonly kind: "git_commit";
    readonly paths: readonly string[];
    readonly message: string;
  };

/** Inputs to {@link planInit} that the planner cannot derive from `state`. */
export interface PlanInputs {
  /** Freshly-generated UUIDv4 used iff `project.yaml` is missing. */
  readonly freshProjectId: string;
  /** Project name to write into a fresh `project.yaml` (typically the directory basename). */
  readonly projectName: string;
}

/** The default initial `ProjectConfig` written by `keni init`. */
export function defaultInitialProjectConfig(
  projectId: string,
  projectName: string,
): ProjectConfig {
  return {
    project_id: projectId,
    name: projectName,
    agents: [{ id: "alice", role: "engineer" }],
    schedules: { alice: "*/1 * * * *" },
  };
}

/** The placeholder skeleton written to `<root>/.keni/state.json`. */
export const STATE_JSON_SKELETON = `{ "watermarks": {} }\n`;

/** The stub global config (`{}`) used when bootstrapping `~/.keni/config.yaml`. */
export const GLOBAL_CONFIG_STUB = Object.freeze({});

/**
 * Compute the minimal action list to bring `state` into compliance with the
 * `project-layout` capability spec. The list is empty when the project is
 * already fully initialised.
 */
export function planInit(state: ProjectState, inputs: PlanInputs): readonly InitAction[] {
  const actions: InitAction[] = [];

  if (!state.isGitRepo) {
    actions.push({ kind: "git_init" });
  }

  if (!state.keniDirExists) {
    actions.push({ kind: "create_keni_root" });
  }

  if (!state.ticketsDirExists || !state.ticketsGitkeepExists) {
    actions.push({ kind: "create_keni_subdir", subdir: "tickets" });
  }
  if (!state.prsDirExists || !state.prsGitkeepExists) {
    actions.push({ kind: "create_keni_subdir", subdir: "prs" });
  }
  if (!state.activityDirExists || !state.activityGitkeepExists) {
    actions.push({ kind: "create_keni_subdir", subdir: "activity" });
  }

  if (state.projectConfig === null) {
    actions.push({
      kind: "write_project_config",
      config: defaultInitialProjectConfig(inputs.freshProjectId, inputs.projectName),
    });
  }

  if (!state.stateJsonExists) {
    actions.push({ kind: "write_state_json" });
  }

  if (!state.globalKeniDirExists || !state.globalLogsDirExists) {
    actions.push({ kind: "ensure_global_dir" });
  }
  if (!state.globalConfigExists) {
    actions.push({ kind: "write_global_config_stub" });
  }

  const gitignoreMerge = mergeGitignore(state.gitignore);
  if (gitignoreMerge.changed) {
    actions.push({ kind: "merge_gitignore", contents: gitignoreMerge.contents });
  }

  // Decide whether to emit a final git commit. We commit when at least one
  // tracked file is created or modified inside the project root. State.json
  // is git-ignored; global directory bootstrap happens outside the project
  // root; neither warrants a commit on its own. `git_init` alone never
  // warrants a commit (we'd produce an empty repo with nothing to track).
  const hasTrackedProjectChanges = actions.some((action) =>
    action.kind === "create_keni_subdir" ||
    action.kind === "write_project_config" ||
    action.kind === "merge_gitignore"
  );

  if (hasTrackedProjectChanges) {
    const commitPaths: string[] = [".keni"];
    if (gitignoreMerge.changed || state.gitignore === null) {
      commitPaths.push(".gitignore");
    }
    const message = state.projectConfig === null
      ? `Initialise Keni project (project_id: ${inputs.freshProjectId})`
      : `Update Keni project metadata (project_id: ${state.projectConfig.project_id})`;
    actions.push({ kind: "git_commit", paths: commitPaths, message });
  }

  return actions;
}
