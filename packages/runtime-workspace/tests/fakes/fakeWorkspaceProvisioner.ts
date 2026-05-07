/**
 * Test-only fake {@link WorkspaceProvisioner} — records every call and
 * never touches the filesystem.
 *
 * Used by every cross-package test that needs to drive workspace-shaped
 * code paths without provisioning a real sparse-checkout clone. The
 * fake's `calls` array is the public surface tests assert against.
 *
 * Configurable via constructor options: every method's resolution can
 * be programmed to either resolve cleanly (default) or reject with a
 * supplied {@link WorkspaceProvisioningError}, exercising the error
 * paths in role precheck logic and in `routes/prs.ts`'s merge handler.
 *
 * @module
 */

import { join as joinPath } from "@std/path";
import type {
  EnsureProvisionedOpts,
  WorkspaceProvisioner,
  WorkspaceProvisioningError,
} from "../../src/interface.ts";

/**
 * One recorded call against a {@link FakeWorkspaceProvisioner}.
 *
 * `method` is the literal method name; `args` is the verbatim argument
 * list. `ensureProvisioned`'s args are recorded as the full opts bag so
 * tests can pin the supplied `sparseCheckoutPattern`.
 */
export type FakeWorkspaceProvisionerCall =
  | { readonly method: "workspacePathFor"; readonly args: readonly [string, string] }
  | {
    readonly method: "ensureProvisioned";
    readonly opts: EnsureProvisionedOpts;
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

  ensureProvisioned(opts: EnsureProvisionedOpts): Promise<string> {
    this.calls.push({ method: "ensureProvisioned", opts });
    if (this.ensureRejection !== undefined) {
      return Promise.reject(this.ensureRejection);
    }
    return Promise.resolve(this.workspacePathForFromOpts(opts));
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

  private workspacePathForFromOpts(opts: EnsureProvisionedOpts): string {
    return joinPath(this.homeDir, ".keni", "workspaces", opts.projectId, opts.agentId);
  }
}
