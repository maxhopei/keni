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
 * No global config is touched; the user's `git config user.name` / `user.email`
 * are honoured.
 *
 * @module
 */

import { GitOperationError } from "./errors.ts";

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
): Promise<{ stdout: string; stderr: string; code: number }> {
  let proc: Deno.Command;
  try {
    proc = new Deno.Command("git", {
      args: [command, ...args],
      cwd,
      stdout: "piped",
      stderr: "piped",
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

async function defaultCommit(cwd: string, message: string): Promise<void> {
  const result = await runGit("commit", ["-m", message], cwd);
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
