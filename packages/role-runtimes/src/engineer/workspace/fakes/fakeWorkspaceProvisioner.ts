/**
 * Test-only fake {@link WorkspaceProvisioner} — records every call and
 * never touches the filesystem.
 *
 * Used by `runner_test.ts`, `merge_test.ts`, and any other test that
 * needs to drive engineer-runtime code paths without provisioning a
 * real sparse-checkout clone. The fake's `calls` array is the public
 * surface tests assert against.
 *
 * Configurable via constructor options: every method's resolution can
 * be programmed to either resolve cleanly (default) or reject with a
 * supplied {@link WorkspaceProvisioningError}, exercising the error
 * paths in the engineer runner's precheck and in the merge handler.
 *
 * @module
 */

import { join as joinPath } from "@std/path";
import type { WorkspaceProvisioner, WorkspaceProvisioningError } from "../interface.ts";

/**
 * One recorded call against a {@link FakeWorkspaceProvisioner}.
 *
 * `method` is the literal method name; `args` is the verbatim argument
 * list (positional). Tests typically `assertEquals(fake.calls, [...])`
 * to pin the call sequence.
 */
export type FakeWorkspaceProvisionerCall =
  | { readonly method: "workspacePathFor"; readonly args: readonly [string, string] }
  | {
    readonly method: "ensureProvisioned";
    readonly args: readonly [string, string, string];
  }
  | { readonly method: "pullMain"; readonly args: readonly [string, string] }
  | {
    readonly method: "discardProvisioned";
    readonly args: readonly [string, string];
  };

/** Construction options for the fake. All fields are optional. */
export interface FakeWorkspaceProvisionerOpts {
  /**
   * Pretend home dir for `workspacePathFor`. Defaults to `"/tmp/keni-fake-home"`.
   * The fake never creates anything under this path; the value is used
   * only to build the deterministic string return value.
   */
  readonly homeDir?: string;
  /** Reject `ensureProvisioned` with this error on every call. */
  readonly ensureProvisionedRejection?: WorkspaceProvisioningError;
  /** Reject `pullMain` with this error on every call. */
  readonly pullMainRejection?: WorkspaceProvisioningError;
  /** Reject `discardProvisioned` with this error on every call. */
  readonly discardProvisionedRejection?: WorkspaceProvisioningError;
}

/**
 * Test-only fake. Every method records its call into the public
 * `calls` array; no method touches the filesystem. Rejection behaviour
 * is configured per-method via the constructor options.
 */
export class FakeWorkspaceProvisioner implements WorkspaceProvisioner {
  /** Every call recorded in arrival order. Tests inspect this directly. */
  readonly calls: FakeWorkspaceProvisionerCall[] = [];
  readonly homeDir: string;
  private readonly ensureRejection: WorkspaceProvisioningError | undefined;
  private readonly pullRejection: WorkspaceProvisioningError | undefined;
  private readonly discardRejection: WorkspaceProvisioningError | undefined;

  constructor(opts: FakeWorkspaceProvisionerOpts = {}) {
    this.homeDir = opts.homeDir ?? "/tmp/keni-fake-home";
    this.ensureRejection = opts.ensureProvisionedRejection;
    this.pullRejection = opts.pullMainRejection;
    this.discardRejection = opts.discardProvisionedRejection;
  }

  workspacePathFor(projectId: string, agentId: string): string {
    this.calls.push({
      method: "workspacePathFor",
      args: [projectId, agentId],
    });
    return joinPath(this.homeDir, ".keni", "workspaces", projectId, agentId);
  }

  ensureProvisioned(
    projectId: string,
    agentId: string,
    projectRepoPath: string,
  ): Promise<void> {
    this.calls.push({
      method: "ensureProvisioned",
      args: [projectId, agentId, projectRepoPath],
    });
    if (this.ensureRejection !== undefined) {
      return Promise.reject(this.ensureRejection);
    }
    return Promise.resolve();
  }

  pullMain(projectId: string, agentId: string): Promise<void> {
    this.calls.push({ method: "pullMain", args: [projectId, agentId] });
    if (this.pullRejection !== undefined) {
      return Promise.reject(this.pullRejection);
    }
    return Promise.resolve();
  }

  discardProvisioned(projectId: string, agentId: string): Promise<void> {
    this.calls.push({
      method: "discardProvisioned",
      args: [projectId, agentId],
    });
    if (this.discardRejection !== undefined) {
      return Promise.reject(this.discardRejection);
    }
    return Promise.resolve();
  }
}
