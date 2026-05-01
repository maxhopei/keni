/**
 * Thin wrapper over the few `git` operations `keni init` performs.
 *
 * The wrapper exposes a `GitClient` interface so unit tests can substitute a
 * fake. The default implementation shells out to `git` via `Deno.Command`; on
 * non-zero exit it throws `GitOperationError` with the captured stderr and
 * exit code. ENOENT (the `git` binary is not on `PATH`) is mapped to a
 * typed `GitOperationError` with `exitCode: null` and a clear message.
 *
 * Operations covered (matching `design.md` Decision 10):
 *
 * - `isRepo(cwd)`               → boolean (delegates to `git rev-parse --git-dir`)
 * - `init(cwd)`                 → `git init <cwd>`
 * - `hasStagedOrUnstagedChanges(cwd)` → boolean (`git status --porcelain`)
 * - `add(cwd, paths)`           → `git add -- <paths…>`
 * - `commit(cwd, message)`      → `git commit -m <message>`
 *
 * Identity policy on `commit`. The default implementation honours the user's
 * `git config user.name` / `user.email` whenever git's own resolution chain
 * (per-repo → per-user global → XDG → system) yields a non-empty value for
 * both keys — the commit's author and committer match the user's identity
 * verbatim. When either key is unset (or whitespace-only), `defaultCommit`
 * supplies a per-invocation fallback identity `Keni <keni@example.invalid>`
 * via the four standard `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment
 * variables on the single `git commit` subprocess. The fallback applies to
 * that one invocation only — no `git config --local`, no `git config
 * --global`, no XDG or system config is ever written, so the user's git
 * environment is unchanged after the run. The full contract (and its
 * scenarios) is pinned in the `project-layout` capability spec.
 *
 * @module
 */

import { GitOperationError } from "./errors.ts";

/**
 * Per-invocation fallback identity used when no git layer has `user.name` /
 * `user.email` configured. RFC 2606's reserved `.invalid` TLD makes the
 * email unambiguously non-routable; the display name `Keni` matches the
 * project name so a reader of `git log` can immediately identify the
 * fallback. Pinned by the `project-layout` capability spec.
 */
const FALLBACK_IDENTITY = {
  name: "Keni",
  email: "keni@example.invalid",
} as const;

/** Minimal git surface required by `keni init`. */
export interface GitClient {
  /** Resolves true iff `cwd` is inside a git working tree. */
  isRepo(cwd: string): Promise<boolean>;
  /** Runs `git init` in `cwd`. */
  init(cwd: string): Promise<void>;
  /** Resolves true iff there are staged or unstaged changes (anything `git status --porcelain` would print). */
  hasStagedOrUnstagedChanges(cwd: string): Promise<boolean>;
  /** Stages the given paths (relative to `cwd`) via `git add -- <paths…>`. */
  add(cwd: string, paths: readonly string[]): Promise<void>;
  /** Creates one commit with the supplied message. */
  commit(cwd: string, message: string): Promise<void>;
}

/**
 * Build the default git client backed by `Deno.Command("git", …)`.
 *
 * On any non-zero exit the wrapper throws `GitOperationError` with the captured
 * stderr; on ENOENT (git missing) it throws a `GitOperationError` carrying a
 * "git not found on PATH" message.
 */
export function createDefaultGitClient(): GitClient {
  return {
    isRepo: defaultIsRepo,
    init: defaultInit,
    hasStagedOrUnstagedChanges: defaultHasChanges,
    add: defaultAdd,
    commit: defaultCommit,
  };
}

async function runGit(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let proc: Deno.Command;
  try {
    proc = new Deno.Command("git", {
      args: [command, ...args],
      cwd,
      stdout: "piped",
      stderr: "piped",
      ...(env === undefined ? {} : { env }),
    });
  } catch (err) {
    throw new GitOperationError(
      command,
      args,
      null,
      err instanceof Error ? err.message : String(err),
      "Failed to spawn `git`. Is git installed and on PATH?",
    );
  }
  let output: Deno.CommandOutput;
  try {
    output = await proc.output();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new GitOperationError(
        command,
        args,
        null,
        "",
        "`git` binary not found on PATH. Install git and re-run `keni init`.",
      );
    }
    throw err;
  }
  const decoder = new TextDecoder();
  return {
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    code: output.code,
  };
}

async function defaultIsRepo(cwd: string): Promise<boolean> {
  const result = await runGit("rev-parse", ["--git-dir"], cwd);
  if (result.code === 0) return true;
  // git exits non-zero with "not a git repository" on stderr when outside a repo
  if (/not a git repository/i.test(result.stderr)) return false;
  // Any other failure is treated as an error so the user sees what happened
  throw new GitOperationError(
    "rev-parse",
    ["--git-dir"],
    result.code,
    result.stderr.trim(),
    `git rev-parse failed in ${cwd}`,
  );
}

async function defaultInit(cwd: string): Promise<void> {
  const result = await runGit("init", [cwd], cwd);
  if (result.code !== 0) {
    throw new GitOperationError(
      "init",
      [cwd],
      result.code,
      result.stderr.trim(),
      `git init failed in ${cwd}`,
    );
  }
}

async function defaultHasChanges(cwd: string): Promise<boolean> {
  const result = await runGit("status", ["--porcelain"], cwd);
  if (result.code !== 0) {
    throw new GitOperationError(
      "status",
      ["--porcelain"],
      result.code,
      result.stderr.trim(),
      `git status failed in ${cwd}`,
    );
  }
  return result.stdout.trim() !== "";
}

async function defaultAdd(cwd: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const result = await runGit("add", ["--", ...paths], cwd);
  if (result.code !== 0) {
    throw new GitOperationError(
      "add",
      ["--", ...paths],
      result.code,
      result.stderr.trim(),
      `git add failed in ${cwd}`,
    );
  }
}

/**
 * Read a single git config key against `cwd` using git's own resolution
 * chain (per-repo → per-user global → XDG → system). Returns `null` for the
 * "unset" cases (exit 1 with empty stderr; or exit 0 with whitespace-only
 * stdout — which `git config` produces when the value is set but empty).
 * Returns the trimmed value otherwise.
 *
 * Any other failure mode (non-zero exit with non-empty stderr, or a thrown
 * subprocess error) surfaces as `GitOperationError` so the caller can map
 * it to its exit code policy.
 */
async function readGitConfigValue(cwd: string, key: string): Promise<string | null> {
  const result = await runGit("config", [key], cwd);
  if (result.code === 0) {
    const trimmed = result.stdout.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (result.code === 1 && result.stderr.trim() === "") return null;
  throw new GitOperationError(
    "config",
    [key],
    result.code,
    result.stderr.trim(),
    `git config ${key} failed in ${cwd}`,
  );
}

/**
 * Decide whether the next `git commit` against `cwd` needs a per-invocation
 * identity override. Returns `undefined` when both `user.name` and
 * `user.email` resolve to non-empty values via `git config` (the common
 * case — let git use the user's identity). Returns the four-key env-var map
 * to override author and committer to the documented Keni fallback when
 * either key is unset or whitespace-only.
 *
 * The detection uses git's own resolution machinery so the answer agrees
 * exactly with what `git commit` would resolve at commit time — there is no
 * path where this returns "set" but git would still abort with `fatal:
 * empty ident name`, or vice versa.
 */
async function resolveCommitIdentityEnv(
  cwd: string,
): Promise<Record<string, string> | undefined> {
  const name = await readGitConfigValue(cwd, "user.name");
  const email = await readGitConfigValue(cwd, "user.email");
  if (name !== null && email !== null) return undefined;
  return {
    GIT_AUTHOR_NAME: FALLBACK_IDENTITY.name,
    GIT_AUTHOR_EMAIL: FALLBACK_IDENTITY.email,
    GIT_COMMITTER_NAME: FALLBACK_IDENTITY.name,
    GIT_COMMITTER_EMAIL: FALLBACK_IDENTITY.email,
  };
}

async function defaultCommit(cwd: string, message: string): Promise<void> {
  const identityEnv = await resolveCommitIdentityEnv(cwd);
  const result = await runGit("commit", ["-m", message], cwd, identityEnv);
  if (result.code !== 0) {
    throw new GitOperationError(
      "commit",
      ["-m", message],
      result.code,
      result.stderr.trim(),
      `git commit failed in ${cwd}`,
    );
  }
}
