/**
 * Unit tests for {@link FakeWorkspaceProvisioner}: the fake records
 * calls correctly, returns deterministic paths, and never touches the
 * filesystem.
 *
 * @module
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join as joinPath } from "@std/path";
import { WorkspaceProvisioningError } from "../../src/interface.ts";
import { FakeWorkspaceProvisioner } from "../fakes/fakeWorkspaceProvisioner.ts";

const ENGINEER_PATTERN: readonly string[] = ["/*", "!.keni/"];

function ensureOpts(
  projectId: string,
  agentId: string,
  projectRepoPath: string,
): {
  readonly projectId: string;
  readonly agentId: string;
  readonly projectRepoPath: string;
  readonly sparseCheckoutPattern: readonly string[];
} {
  return { projectId, agentId, projectRepoPath, sparseCheckoutPattern: ENGINEER_PATTERN };
}

Deno.test("workspacePathFor returns the deterministic path under homeDir", () => {
  const fake = new FakeWorkspaceProvisioner({ homeDir: "/tmp/home" });
  assertEquals(
    fake.workspacePathFor("p1", "alice"),
    joinPath("/tmp/home", ".keni", "workspaces", "p1", "alice"),
  );
});

Deno.test("workspacePathFor is deterministic for the same args", () => {
  const fake = new FakeWorkspaceProvisioner({ homeDir: "/tmp/home" });
  const a = fake.workspacePathFor("p1", "alice");
  const b = fake.workspacePathFor("p1", "alice");
  assertEquals(a, b);
});

Deno.test("workspacePathFor for different agentIds produces sibling paths", () => {
  const fake = new FakeWorkspaceProvisioner({ homeDir: "/tmp/home" });
  const a = fake.workspacePathFor("p1", "alice");
  const b = fake.workspacePathFor("p1", "bob");
  assertEquals(a, joinPath("/tmp/home", ".keni", "workspaces", "p1", "alice"));
  assertEquals(b, joinPath("/tmp/home", ".keni", "workspaces", "p1", "bob"));
});

Deno.test("calls array records every method invocation in arrival order", async () => {
  const fake = new FakeWorkspaceProvisioner({ homeDir: "/tmp/home" });
  fake.workspacePathFor("p1", "alice");
  await fake.ensureProvisioned(ensureOpts("p1", "alice", "/tmp/repo"));
  await fake.pullMain("p1", "alice");
  await fake.discardProvisioned("p1", "alice");

  assertEquals(fake.calls, [
    { method: "workspacePathFor", args: ["p1", "alice"] },
    { method: "ensureProvisioned", opts: ensureOpts("p1", "alice", "/tmp/repo") },
    { method: "pullMain", args: ["p1", "alice"] },
    { method: "discardProvisioned", args: ["p1", "alice"] },
  ]);
});

Deno.test("ensureProvisioned does not touch the filesystem", async () => {
  const fake = new FakeWorkspaceProvisioner({ homeDir: "/tmp/keni-fake-home-test" });
  await fake.ensureProvisioned(ensureOpts("p1", "alice", "/tmp/keni-fake-repo"));

  await assertRejects(
    () => Deno.lstat(fake.workspacePathFor("p1", "alice")),
    Deno.errors.NotFound,
  );
});

Deno.test("pullMain does not touch the filesystem", async () => {
  const fake = new FakeWorkspaceProvisioner({ homeDir: "/tmp/keni-fake-home-test" });
  await fake.pullMain("p1", "alice");

  await assertRejects(
    () => Deno.lstat(fake.workspacePathFor("p1", "alice")),
    Deno.errors.NotFound,
  );
});

Deno.test("discardProvisioned does not touch the filesystem", async () => {
  const fake = new FakeWorkspaceProvisioner({ homeDir: "/tmp/keni-fake-home-test" });
  await fake.discardProvisioned("p1", "alice");

  await assertRejects(
    () => Deno.lstat(fake.workspacePathFor("p1", "alice")),
    Deno.errors.NotFound,
  );
});

Deno.test("ensureProvisionedRejection makes the method reject with the configured error", async () => {
  const err = new WorkspaceProvisioningError(
    "git_clone_failed",
    "git binary missing",
  );
  const fake = new FakeWorkspaceProvisioner({ ensureProvisionedRejection: err });
  await assertRejects(
    () => fake.ensureProvisioned(ensureOpts("p1", "alice", "/tmp/repo")),
    WorkspaceProvisioningError,
    "git binary missing",
  );
});

Deno.test("pullMainRejection makes pullMain reject with the configured error", async () => {
  const err = new WorkspaceProvisioningError(
    "pull_main_failed",
    "non-fast-forward",
  );
  const fake = new FakeWorkspaceProvisioner({ pullMainRejection: err });
  await assertRejects(
    () => fake.pullMain("p1", "alice"),
    WorkspaceProvisioningError,
    "non-fast-forward",
  );
});

Deno.test("discardProvisionedRejection makes discardProvisioned reject with the configured error", async () => {
  const err = new WorkspaceProvisioningError(
    "workspace_missing",
    "workspace gone",
  );
  const fake = new FakeWorkspaceProvisioner({ discardProvisionedRejection: err });
  await assertRejects(
    () => fake.discardProvisioned("p1", "alice"),
    WorkspaceProvisioningError,
    "workspace gone",
  );
});

Deno.test("default homeDir is /tmp/keni-fake-home", () => {
  const fake = new FakeWorkspaceProvisioner();
  assertEquals(fake.homeDir, "/tmp/keni-fake-home");
  assertEquals(
    fake.workspacePathFor("p1", "alice"),
    joinPath("/tmp/keni-fake-home", ".keni", "workspaces", "p1", "alice"),
  );
});
