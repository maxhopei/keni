/**
 * `GitWorkspaceProvisioner` — production {@link WorkspaceProvisioner}
 * backed by the host's `git` binary.
 *
 * Responsibilities (engineer-runtime spec §"`ensureProvisioned` performs
 * a sparse clone…", §"`pullMain` runs `git pull --ff-only origin main`…",
 * §"`discardProvisioned` removes the workspace tree…"):
 *
 * - Materialise a sparse-checkout clone of `projectRepoPath` under
 *   `<homeDir>/.keni/workspaces/<projectId>/<agentId>/`.
 * - Configure the sparse pattern to exclude `.keni/` so the engineer
 *   agent never sees project metadata.
 * - Set per-workspace git identity via `git config --local`, never
 *   touching the host's `~/.gitconfig`.
 * - Idempotent re-provisioning: a second call after a successful first
 *   verifies invariants and repairs drift (sparse pattern, identity)
 *   without re-cloning.
 * - Fast-forward-only `git pull` against `main`; rejects non-fast-forward.
 * - Recursive `Deno.remove` for discard, no-op on missing path.
 *
 * Every git invocation flows through {@link runGit}, which centralises
 * `Deno.Command` construction, exit-code handling, and conversion to
 * {@link WorkspaceProvisioningError}.
 *
 * @module
 */

import { join as joinPath } from "@std/path";
import {
  type EnsureProvisionedOpts,
  type WorkspaceLogger,
  type WorkspaceProvisioner,
  WorkspaceProvisioningError,
  type WorkspaceProvisioningErrorCode,
} from "./interface.ts";

/**
 * Constructor options for {@link GitWorkspaceProvisioner}.
 *
 * `homeDir` is the parent directory under which workspaces are
 * materialised (`<homeDir>/.keni/workspaces/...`). Production wires
 * `Deno.env.get("HOME")` (or `USERPROFILE` on Windows); tests pass a
 * `Deno.makeTempDir()` so the host's real `~/.keni/` is untouched.
 *
 * `gitBinary` defaults to `"git"`; tests inject `/no/such/git` to
 * exercise the `git_clone_failed` error path.
 */
export interface GitWorkspaceProvisionerOpts {
  readonly homeDir: string;
  readonly gitBinary?: string;
  readonly logger: WorkspaceLogger;
}

/**
 * Production {@link WorkspaceProvisioner} backed by the host's `git`
 * binary. See module JSDoc for the full contract.
 */
export class GitWorkspaceProvisioner implements WorkspaceProvisioner {
  readonly homeDir: string;
  private readonly gitBinary: string;
  private readonly logger: WorkspaceLogger;

  constructor(opts: GitWorkspaceProvisionerOpts) {
    if (opts.homeDir === "") {
      throw new WorkspaceProvisioningError(
        "home_dir_unset",
        "GitWorkspaceProvisioner requires a non-empty homeDir; HOME / USERPROFILE were both unset",
      );
    }
    this.homeDir = opts.homeDir;
    this.gitBinary = opts.gitBinary ?? "git";
    this.logger = opts.logger;
  }

  workspacePathFor(projectId: string, agentId: string): string {
    return joinPath(this.homeDir, ".keni", "workspaces", projectId, agentId);
  }

  async ensureProvisioned(opts: EnsureProvisionedOpts): Promise<string> {
    const { projectId, agentId, projectRepoPath, sparseCheckoutPattern } = opts;
    if (sparseCheckoutPattern.length === 0) {
      throw new WorkspaceProvisioningError(
        "sparse_pattern_invalid",
        "ensureProvisioned requires a non-empty sparseCheckoutPattern",
        { reason: "empty_pattern" },
      );
    }
    const sparseFileBody = renderSparsePattern(sparseCheckoutPattern);

    const workspacePath = this.workspacePathFor(projectId, agentId);
    const gitDir = joinPath(workspacePath, ".git");
    const sparsePatternFile = joinPath(gitDir, "info", "sparse-checkout");

    const exists = await dirExists(gitDir);
    if (!exists) {
      await this.firstTimeProvision(
        workspacePath,
        projectRepoPath,
        agentId,
        sparseFileBody,
      );
      this.logger.log("info", "workspace.provisioned", {
        agent: agentId,
        project: projectId,
        path: workspacePath,
      });
    } else {
      await this.repairProvisioned(
        workspacePath,
        sparsePatternFile,
        agentId,
        sparseFileBody,
      );
      this.logger.log("debug", "workspace.verified", {
        agent: agentId,
        project: projectId,
        path: workspacePath,
      });
    }

    return workspacePath;
  }

  async pullMain(projectId: string, agentId: string): Promise<void> {
    const workspacePath = this.workspacePathFor(projectId, agentId);
    if (!(await dirExists(workspacePath))) {
      throw new WorkspaceProvisioningError(
        "workspace_missing",
        `Workspace ${workspacePath} does not exist`,
        { path: workspacePath },
      );
    }
    await this.runGit(
      ["-C", workspacePath, "pull", "--ff-only", "origin", "main"],
      "pull_main_failed",
    );
  }

  async discardProvisioned(projectId: string, agentId: string): Promise<void> {
    const workspacePath = this.workspacePathFor(projectId, agentId);
    try {
      await Deno.remove(workspacePath, { recursive: true });
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    this.logger.log("info", "engineer.workspace_discarded", {
      agent: agentId,
      path: workspacePath,
    });
  }

  private async firstTimeProvision(
    workspacePath: string,
    projectRepoPath: string,
    agentId: string,
    sparseFileBody: string,
  ): Promise<void> {
    const parentDir = parentOf(workspacePath);
    await Deno.mkdir(parentDir, { recursive: true });

    await this.runGit(
      ["clone", "--no-checkout", "--origin", "origin", projectRepoPath, workspacePath],
      "git_clone_failed",
    );

    await this.runGit(
      ["-C", workspacePath, "sparse-checkout", "init", "--no-cone"],
      "sparse_init_failed",
    );

    await writeSparsePatternFile(workspacePath, sparseFileBody);

    await this.runGit(
      ["-C", workspacePath, "sparse-checkout", "reapply"],
      "sparse_reapply_failed",
    );

    await this.runGit(
      ["-C", workspacePath, "checkout", "main"],
      "checkout_failed",
    );

    await this.writeIdentity(workspacePath, agentId);
  }

  private async repairProvisioned(
    workspacePath: string,
    sparsePatternFile: string,
    agentId: string,
    sparseFileBody: string,
  ): Promise<void> {
    let drift = false;
    let currentPattern = "";
    try {
      currentPattern = await Deno.readTextFile(sparsePatternFile);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      drift = true;
    }
    if (currentPattern !== sparseFileBody) drift = true;
    if (drift) {
      await writeSparsePatternFile(workspacePath, sparseFileBody);
      await this.runGit(
        ["-C", workspacePath, "sparse-checkout", "reapply"],
        "sparse_reapply_failed",
      );
    }

    const wantName = agentId;
    const wantEmail = `${agentId}@keni.invalid`;
    const currentName = await this.readGitConfig(workspacePath, "user.name");
    const currentEmail = await this.readGitConfig(workspacePath, "user.email");
    if (currentName !== wantName || currentEmail !== wantEmail) {
      await this.writeIdentity(workspacePath, agentId);
    }
  }

  private async writeIdentity(workspacePath: string, agentId: string): Promise<void> {
    await this.runGit(
      ["-C", workspacePath, "config", "--local", "user.name", agentId],
      "git_config_failed",
    );
    await this.runGit(
      ["-C", workspacePath, "config", "--local", "user.email", `${agentId}@keni.invalid`],
      "git_config_failed",
    );
  }

  private async readGitConfig(
    workspacePath: string,
    key: string,
  ): Promise<string | null> {
    try {
      const command = new Deno.Command(this.gitBinary, {
        args: ["-C", workspacePath, "config", "--local", "--get", key],
        stdout: "piped",
        stderr: "piped",
      });
      const out = await command.output();
      if (!out.success) return null;
      return new TextDecoder().decode(out.stdout).trimEnd();
    } catch {
      return null;
    }
  }

  /**
   * Centralised `Deno.Command` driver for every `git` invocation.
   * Captures stdout / stderr; on a non-zero exit (or a spawn failure
   * such as a missing binary), throws {@link WorkspaceProvisioningError}
   * tagged with the supplied `code`.
   */
  private async runGit(
    args: readonly string[],
    failureCode: WorkspaceProvisioningErrorCode,
  ): Promise<{ stdout: string; stderr: string }> {
    let output: Deno.CommandOutput;
    try {
      const command = new Deno.Command(this.gitBinary, {
        args: [...args],
        stdout: "piped",
        stderr: "piped",
      });
      output = await command.output();
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      throw new WorkspaceProvisioningError(
        failureCode,
        `git ${args.join(" ")} failed to spawn: ${stderr}`,
        { stderr, args },
      );
    }
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) {
      throw new WorkspaceProvisioningError(
        failureCode,
        `git ${args.join(" ")} exited ${output.code}: ${stderr.trim()}`,
        { stderr, stdout, exitCode: output.code, args },
      );
    }
    return { stdout, stderr };
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.lstat(path);
    return stat.isDirectory;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function renderSparsePattern(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

async function writeSparsePatternFile(
  workspacePath: string,
  sparseFileBody: string,
): Promise<void> {
  const file = joinPath(workspacePath, ".git", "info", "sparse-checkout");
  await Deno.mkdir(joinPath(workspacePath, ".git", "info"), { recursive: true });
  await Deno.writeTextFile(file, sparseFileBody);
}

function parentOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/u, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSep <= 0 ? "/" : trimmed.slice(0, lastSep);
}
