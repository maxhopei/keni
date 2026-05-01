/**
 * Pure message-formatting functions for `keni init` stdout / stderr.
 *
 * Kept as pure functions (no I/O) so unit tests can assert on the exact
 * output strings, and a future i18n change is a single-file edit.
 *
 * The shapes match `design.md` Decision 12.
 *
 * @module
 */

/** Inputs for the fresh-init success summary. */
export interface FreshInitSummary {
  readonly targetDir: string;
  readonly projectId: string;
  readonly defaultAgent: { readonly id: string; readonly role: string };
}

/** Format the success summary for a fresh `keni init` run. */
export function formatFreshInit(summary: FreshInitSummary): string {
  return [
    `Initialised Keni project at ${summary.targetDir}`,
    `  project_id: ${summary.projectId}`,
    `  default agent: ${summary.defaultAgent.id} (${summary.defaultAgent.role})`,
    "",
    "Next: run `keni start` to boot the orchestration server.",
  ].join("\n");
}

/** Inputs for the already-initialised no-op summary. */
export interface AlreadyInitialisedSummary {
  readonly targetDir: string;
  readonly projectId: string;
}

/** Format the no-op summary for an idempotent re-run on a clean project. */
export function formatAlreadyInitialised(summary: AlreadyInitialisedSummary): string {
  return [
    `Project already initialised at ${summary.targetDir} (project_id: ${summary.projectId})`,
    "Nothing to do.",
  ].join("\n");
}

/** Inputs for the partial-repair summary. */
export interface PartialRepairSummary {
  readonly targetDir: string;
  readonly projectId: string;
  /** Human-readable list of paths or items that were recreated, e.g. `[".keni/tickets/", ".keni/activity/"]`. */
  readonly recreated: readonly string[];
  readonly committed: boolean;
}

/** Format the success summary for a partial-state repair run. */
export function formatPartialRepair(summary: PartialRepairSummary): string {
  const lines = [
    `Repaired Keni project at ${summary.targetDir} (project_id: ${summary.projectId})`,
    `  Re-created: ${summary.recreated.join(", ")}`,
  ];
  if (summary.committed) {
    lines.push("  Committed.");
  }
  return lines.join("\n");
}

/** Inputs for the malformed-project-yaml error message. */
export interface MalformedProjectYamlError {
  readonly path: string;
  readonly underlyingMessage: string;
}

/** Format the stderr message for a malformed `project.yaml`. */
export function formatMalformedProjectYaml(err: MalformedProjectYamlError): string {
  return [
    "Error: existing .keni/project.yaml is malformed and cannot be repaired automatically.",
    `  Path: ${err.path}`,
    `  Underlying parse error: ${err.underlyingMessage}`,
    "  Fix the file by hand or remove .keni/ and re-run `keni init`.",
  ].join("\n");
}

/** Inputs for the unwritable-target error message. */
export interface UnwritableTargetError {
  readonly targetDir: string;
  readonly reason: string;
  readonly osError?: string;
}

/** Format the stderr message for an unusable target directory. */
export function formatUnwritableTarget(err: UnwritableTargetError): string {
  const causeSuffix = err.osError ? ` (${err.osError})` : "";
  return [
    `Error: target directory ${err.targetDir} cannot be used for keni init.`,
    `  Reason: ${err.reason}${causeSuffix}`,
  ].join("\n");
}

/** Inputs for the git-failure error message. */
export interface GitFailureError {
  readonly command: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Format the stderr message for a `git` operation failure. */
export function formatGitFailure(err: GitFailureError): string {
  const code = err.exitCode === null ? "(no exit code)" : `(exit ${err.exitCode})`;
  const stderrLine = err.stderr ? `  stderr: ${err.stderr}` : "  stderr: (empty)";
  return [
    `Error: git ${err.command} failed ${code}.`,
    stderrLine,
  ].join("\n");
}

/** Format the stderr message for a usage error (unknown subcommand, bad argv). */
export function formatUsageError(message: string): string {
  return `Error: ${message}`;
}

/**
 * Top-level help text shown for `--help`, `-h`, or no subcommand.
 *
 * Prototype scope: only `init` is wired. `start` lands in step 13.
 */
export function formatHelp(): string {
  return [
    "keni — local building agent",
    "",
    "Usage:",
    "  keni init [path]    Initialise a Keni project in `path` (default: cwd).",
    "  keni --help         Show this help.",
    "",
    "Run `keni init` in any folder to create the project's .keni/ directory,",
    "bootstrap ~/.keni/ on first use, and stage an initial git commit.",
    "",
    "More subcommands (notably `keni start`) land in later changes.",
  ].join("\n");
}
