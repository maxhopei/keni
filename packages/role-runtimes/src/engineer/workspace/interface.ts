/**
 * `WorkspaceProvisioner` — the seam between the engineer runtime and the
 * per-agent on-disk workspace clone.
 *
 * Every engineer agent gets its own sparse-checkout git clone of the
 * project repo, parked under `<homeDir>/.keni/workspaces/<projectId>/<agentId>/`.
 * The sparse pattern excludes `.keni/` so the engineer agent never sees
 * project metadata; the per-workspace git identity is set via
 * `git config --local` so the host's `~/.gitconfig` is never touched.
 *
 * The interface is the boundary between the cycle (which does not care
 * how the workspace is materialised) and the production
 * {@link GitWorkspaceProvisioner} (which shells out to `git`) or the
 * `FakeWorkspaceProvisioner` shipped via this package's
 * `./test-fakes` secondary entry point (which records calls without
 * touching the filesystem). Tests import the fake from
 * `@keni/role-runtimes/test-fakes`; `runServer` wires the git-backed
 * default.
 *
 * @module
 */

/**
 * Severity for the structural logger the workspace provisioner accepts.
 * Same level set as the scheduler's logger so a single log sink can
 * fan in both control-plane events and workspace-lifecycle events.
 */
export type WorkspaceLogLevel = "debug" | "info" | "warn";

/**
 * Minimal structural logger the workspace provisioner needs. The
 * surface deliberately mirrors `SchedulerLogger` from
 * `packages/server/src/scheduler/log.ts` so the orchestration server
 * can pass the same logger to both the scheduler and the provisioner
 * without an adapter.
 */
export interface WorkspaceLogger {
  log(
    level: WorkspaceLogLevel,
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
}

/**
 * The seam between the engineer runtime and the per-agent on-disk
 * workspace clone. Exactly four methods, every method scoped to a
 * single `(projectId, agentId)` pair.
 */
export interface WorkspaceProvisioner {
  /**
   * Pure path computation — `joinPath(homeDir, ".keni", "workspaces", projectId, agentId)`.
   * SHALL NOT consult the filesystem.
   */
  workspacePathFor(projectId: string, agentId: string): string;

  /**
   * Ensure the workspace directory exists and contains a sparse-checkout
   * git clone of `projectRepoPath`. Idempotent: a second call after a
   * successful first call is a near-no-op (verifies invariants and
   * repairs drift).
   */
  ensureProvisioned(
    projectId: string,
    agentId: string,
    projectRepoPath: string,
  ): Promise<void>;

  /**
   * Run `git -C <workspacePath> pull --ff-only origin main`. Resolves on
   * exit code 0; rejects with {@link WorkspaceProvisioningError} on any
   * non-zero exit (`pull_main_failed`) or missing workspace
   * (`workspace_missing`).
   */
  pullMain(projectId: string, agentId: string): Promise<void>;

  /**
   * Recursively remove the workspace directory. No-op when the path
   * does not exist. Sibling workspaces are unaffected.
   */
  discardProvisioned(projectId: string, agentId: string): Promise<void>;
}

/**
 * Discriminator for {@link WorkspaceProvisioningError}. New codes are
 * additive; existing codes never change semantics. Mirrors the closed
 * enum convention from `@keni/shared/wire/errors.ts` so a future
 * cross-cutting error mapper can switch on `code` exhaustively.
 *
 * - `home_dir_unset` — constructor was given an empty `homeDir` and
 *   `Deno.env.get("HOME")` / `Deno.env.get("USERPROFILE")` were both
 *   absent.
 * - `git_clone_failed` — `git clone --no-checkout` exited non-zero or
 *   the binary itself is missing / not executable.
 * - `sparse_init_failed` — `git sparse-checkout init --no-cone` exited
 *   non-zero.
 * - `sparse_reapply_failed` — `git sparse-checkout reapply` exited
 *   non-zero.
 * - `checkout_failed` — `git checkout main` exited non-zero (e.g.,
 *   the project repo has no `main` branch).
 * - `git_config_failed` — one of the per-workspace `git config --local`
 *   calls exited non-zero.
 * - `sparse_pattern_failed` — the post-checkout `.keni/` absence
 *   verification found `.keni/` present (the git binary silently
 *   ignored the sparse pattern, e.g. an ancient git build).
 * - `pull_main_failed` — `git pull --ff-only origin main` exited
 *   non-zero (typically a non-fast-forward).
 * - `workspace_missing` — `pullMain` was called for a `(projectId,
 *   agentId)` whose workspace directory does not exist.
 */
export type WorkspaceProvisioningErrorCode =
  | "home_dir_unset"
  | "git_clone_failed"
  | "sparse_init_failed"
  | "sparse_reapply_failed"
  | "checkout_failed"
  | "git_config_failed"
  | "sparse_pattern_failed"
  | "pull_main_failed"
  | "workspace_missing";

/**
 * Optional structured `details` carried by a {@link WorkspaceProvisioningError}.
 * Every field is optional because the error covers nine different
 * failure modes (see {@link WorkspaceProvisioningErrorCode}); only the
 * subset relevant to a given code is populated.
 */
export interface WorkspaceProvisioningErrorDetails {
  readonly stderr?: string;
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly path?: string;
  readonly args?: readonly string[];
}

/**
 * Typed error class for every workspace-provisioning failure. The
 * `code` field is the discriminator callers `switch` on; the optional
 * `details` field carries the underlying git stderr / exit code so the
 * engineer-runner precheck can log a clear "why".
 */
export class WorkspaceProvisioningError extends Error {
  override readonly name = "WorkspaceProvisioningError";
  readonly code: WorkspaceProvisioningErrorCode;
  readonly details: WorkspaceProvisioningErrorDetails | undefined;

  constructor(
    code: WorkspaceProvisioningErrorCode,
    message: string,
    details?: WorkspaceProvisioningErrorDetails,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
