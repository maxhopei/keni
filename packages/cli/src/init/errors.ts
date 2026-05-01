/**
 * Typed errors thrown by `keni init`. Each class extends `Error`, sets
 * `this.name` to its class name, and carries enough context for the
 * top-level handler in `main.ts` to format a useful stderr message and
 * choose an exit code.
 *
 * Exit-code mapping (enforced by the dispatcher in `main.ts`):
 *
 * | Class                | Exit code |
 * | -------------------- | --------- |
 * | `UsageError`         | 2         |
 * | `InitTargetError`    | 1         |
 * | `GitOperationError`  | 1         |
 * | `ProjectStateError`  | 1         |
 *
 * @module
 */

/**
 * Thrown when the user supplies command-line arguments that do not match the
 * subcommand's expected shape (unknown subcommand, too many positional
 * arguments, conflicting flags, etc.). Maps to exit code 2.
 */
export class UsageError extends Error {
  override readonly name = "UsageError";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when the resolved target directory is unusable: it does not exist,
 * it is not a directory, it is not writable by the current user. Maps to
 * exit code 1.
 */
export class InitTargetError extends Error {
  override readonly name = "InitTargetError";
  /** The path the user supplied (or cwd if none). */
  readonly targetDir: string;
  /** Short reason code: `"not_a_directory" | "not_writable" | "not_found" | "stat_failed"`. */
  readonly reason: string;
  /** The underlying OS error class name, when available (e.g., `"PermissionDenied"`, `"NotFound"`). */
  readonly osError?: string;

  constructor(reason: string, targetDir: string, message: string, osError?: string) {
    super(message);
    this.reason = reason;
    this.targetDir = targetDir;
    if (osError !== undefined) this.osError = osError;
  }
}

/**
 * Thrown when a `git` subprocess fails — non-zero exit, missing `git` binary,
 * or any other failure inside the git wrapper. Maps to exit code 1.
 */
export class GitOperationError extends Error {
  override readonly name = "GitOperationError";
  /** The git subcommand that was invoked, e.g., `"init"`, `"commit"`. */
  readonly command: string;
  /** The full args list, for debugging (does not include the leading `"git"`). */
  readonly args: readonly string[];
  /** The git process's exit code (or `null` if it never started). */
  readonly exitCode: number | null;
  /** The captured stderr (trimmed). Empty string if none. */
  readonly stderr: string;

  constructor(
    command: string,
    args: readonly string[],
    exitCode: number | null,
    stderr: string,
    message: string,
  ) {
    super(message);
    this.command = command;
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Thrown when the existing project state cannot be repaired by `keni init`:
 * a malformed `project.yaml` (parse error), or any other invariant violation
 * the planner refuses to autocorrect. Maps to exit code 1.
 */
export class ProjectStateError extends Error {
  override readonly name = "ProjectStateError";
  /** Short reason code: `"malformed_project_yaml"`, `"unexpected_state"`, etc. */
  readonly reason: string;
  /** Path to the offending file, when applicable. */
  readonly path?: string;

  constructor(reason: string, message: string, path?: string) {
    super(message);
    this.reason = reason;
    if (path !== undefined) this.path = path;
  }
}
