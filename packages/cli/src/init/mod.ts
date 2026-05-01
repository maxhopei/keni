/**
 * `keni init` entry point.
 *
 * Composition root for the subcommand: parses the positional argument, builds
 * the path resolvers and the `FileConfigStore`, instantiates the default
 * `GitClient` (or a caller-provided fake), runs `inspectProjectState` →
 * `planInit` → `executeActions`, prints the success summary via
 * `messages.ts`, and returns a process exit code.
 *
 * Dependencies (`InitDeps`) are exposed as a `Partial` parameter so tests can
 * substitute fakes for `gitClient`, `homeDir`, or `out`/`err` writers.
 *
 * Exit codes:
 *
 * | Code | Meaning |
 * | ---- | ------- |
 * | 0    | Success (including idempotent no-op) |
 * | 1    | Filesystem / git failure (or malformed `project.yaml`) |
 * | 2    | Usage error |
 *
 * `runInit` itself returns the exit code; it never calls `Deno.exit`. The
 * top-level dispatcher in `main.ts` is responsible for translating typed
 * errors raised inside `runInit` into stderr messages and the right exit
 * code.
 *
 * @module
 */

import { basename, resolve } from "@std/path";
import { FileConfigStore, resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import type { ConfigStore, GlobalPaths, ProjectPaths } from "@keni/shared";
import { GitOperationError, InitTargetError, ProjectStateError, UsageError } from "./errors.ts";
import { createDefaultGitClient, type GitClient } from "./git.ts";
import {
  formatAlreadyInitialised,
  formatFreshInit,
  formatGitFailure,
  formatMalformedProjectYaml,
  formatPartialRepair,
  formatUsageError,
} from "./messages.ts";
import { executeActions } from "./execute.ts";
import { planInit } from "./plan.ts";
import { inspectProjectState } from "./state.ts";

/** Parsed positional arguments for `keni init`. */
export interface InitOptions {
  /** Absolute path to the target directory. */
  readonly targetDir: string;
}

/**
 * Parse the rest-of-argv after `init`. Throws {@link UsageError} on shape
 * mismatch.
 *
 * Accepted shapes:
 *
 * - `keni init`            → cwd as target.
 * - `keni init <path>`     → resolved absolute path as target.
 *
 * Anything else (≥2 args, leading `--flag`) raises a usage error so the
 * dispatcher can show help. No `parseArgs` import — by design, the prototype
 * `init` carries zero flags. Future flags (`--name`, `--no-commit`, etc.)
 * land in additive changes that may switch to `parseArgs`.
 */
export function parseInitArgs(rest: readonly string[]): InitOptions {
  if (rest.length > 1) {
    throw new UsageError(
      "keni init takes at most one positional argument: the target directory",
    );
  }
  const first = rest[0];
  if (first !== undefined && first.startsWith("--")) {
    throw new UsageError(
      `keni init does not accept flags yet (got '${first}'); pass only an optional target path`,
    );
  }
  const target = first ?? Deno.cwd();
  return { targetDir: resolve(target) };
}

/**
 * Optional dependency overrides for {@link runInit}. Tests pass a partial set
 * to substitute fakes; production calls leave it undefined.
 */
export interface InitDeps {
  /** Override the home directory used for `<home>/.keni/`. Defaults to `$HOME`. */
  readonly homeDir: string;
  /** Override the git client. Defaults to `createDefaultGitClient()`. */
  readonly gitClient: GitClient;
  /** Override the `ConfigStore` factory. Defaults to `new FileConfigStore(...)`. */
  readonly makeConfigStore: (
    projectPaths: ProjectPaths,
    globalPaths: GlobalPaths,
  ) => ConfigStore;
  /** Stdout writer. Defaults to `console.log`. */
  readonly out: (message: string) => void;
  /** Stderr writer. Defaults to `console.error`. */
  readonly err: (message: string) => void;
}

/**
 * Run the `init` subcommand against the supplied options. Returns the
 * process exit code; never calls `Deno.exit`.
 *
 * @throws {UsageError | InitTargetError | GitOperationError | ProjectStateError}
 *   for any non-success path. The dispatcher in `main.ts` catches these and
 *   maps them to exit codes.
 */
export async function runInit(
  opts: InitOptions,
  deps?: Partial<InitDeps>,
): Promise<number> {
  const out = deps?.out ?? ((m) => console.log(m));
  const err = deps?.err ?? ((m) => console.error(m));

  await assertTargetUsable(opts.targetDir);

  const homeDir = deps?.homeDir ?? Deno.env.get("HOME");
  if (homeDir === undefined || homeDir === "") {
    throw new InitTargetError(
      "no_home_dir",
      opts.targetDir,
      "HOME environment variable is unset; cannot resolve `~/.keni/`",
    );
  }

  const projectPaths = resolveProjectPaths(opts.targetDir);
  const globalPaths = resolveGlobalPaths(homeDir);
  const configStore = deps?.makeConfigStore?.(projectPaths, globalPaths) ??
    new FileConfigStore(projectPaths, globalPaths);
  const gitClient = deps?.gitClient ?? createDefaultGitClient();

  let state;
  try {
    state = await inspectProjectState(projectPaths, globalPaths, configStore, gitClient);
  } catch (e) {
    if (e instanceof ProjectStateError && e.reason === "malformed_project_yaml") {
      err(formatMalformedProjectYaml({
        path: e.path ?? projectPaths.projectConfig,
        underlyingMessage: e.message,
      }));
      return 1;
    }
    throw e;
  }

  const freshProjectId = crypto.randomUUID();
  const projectName = basename(projectPaths.root);
  const actions = planInit(state, { freshProjectId, projectName });

  if (actions.length === 0) {
    out(
      formatAlreadyInitialised({
        targetDir: opts.targetDir,
        projectId: state.projectConfig?.project_id ?? "(unknown)",
      }),
    );
    return 0;
  }

  let result;
  try {
    result = await executeActions(actions, {
      projectPaths,
      globalPaths,
      configStore,
      gitClient,
    });
  } catch (e) {
    if (e instanceof GitOperationError) {
      err(formatGitFailure({
        command: e.command,
        stderr: e.stderr,
        exitCode: e.exitCode,
      }));
      return 1;
    }
    throw e;
  }

  if (result.wroteProjectConfig) {
    // Fresh init — re-read the freshly-written config to surface the actual
    // project_id (it should match `freshProjectId` but reading it back guards
    // against future planner refactors that vary the id source).
    const written = await configStore.readProjectConfig();
    out(
      formatFreshInit({
        targetDir: opts.targetDir,
        projectId: written.project_id ?? freshProjectId,
        defaultAgent: { id: "alice", role: "engineer" },
      }),
    );
    return 0;
  }

  if (result.recreatedSubdirs.length > 0 || result.mergedGitignore) {
    const recreated: string[] = result.recreatedSubdirs.map(
      (kind) => `.keni/${kind}/`,
    );
    if (result.mergedGitignore) recreated.push(".gitignore");
    out(
      formatPartialRepair({
        targetDir: opts.targetDir,
        projectId: state.projectConfig?.project_id ?? freshProjectId,
        recreated,
        committed: result.commitProduced,
      }),
    );
    return 0;
  }

  // Some non-trivial work happened (state.json, global bootstrap) but no
  // user-visible repair / fresh-init message applies. Use the
  // already-initialised summary as the closest fit.
  out(
    formatAlreadyInitialised({
      targetDir: opts.targetDir,
      projectId: state.projectConfig?.project_id ?? freshProjectId,
    }),
  );
  return 0;
}

/**
 * Assert the target directory exists, is a directory, and is writable.
 * Throws {@link InitTargetError} on failure with a stable `reason` code.
 */
async function assertTargetUsable(targetDir: string): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(targetDir);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new InitTargetError(
        "not_found",
        targetDir,
        `Target directory does not exist: ${targetDir}`,
        e.constructor.name,
      );
    }
    throw new InitTargetError(
      "stat_failed",
      targetDir,
      `Could not stat target directory: ${targetDir}`,
      e instanceof Error ? e.constructor.name : undefined,
    );
  }
  if (!stat.isDirectory) {
    throw new InitTargetError(
      "not_a_directory",
      targetDir,
      `Target path is not a directory: ${targetDir}`,
    );
  }
  // Probe writability by creating and removing a sentinel file.
  const probe = `${targetDir}/.keni-init-probe-${Date.now()}-${
    Math.random().toString(36).slice(2)
  }`;
  try {
    await Deno.writeTextFile(probe, "");
    await Deno.remove(probe);
  } catch (e) {
    if (e instanceof Deno.errors.PermissionDenied) {
      throw new InitTargetError(
        "not_writable",
        targetDir,
        `Target directory is not writable: ${targetDir}`,
        "PermissionDenied",
      );
    }
    throw new InitTargetError(
      "not_writable",
      targetDir,
      `Could not write to target directory: ${targetDir}`,
      e instanceof Error ? e.constructor.name : undefined,
    );
  }
}

/** Helper used by the dispatcher in `main.ts` to format usage errors. */
export { formatUsageError };
