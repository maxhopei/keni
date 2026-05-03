/**
 * Tests for {@link GitWorkspaceProvisioner}.
 *
 * Each test creates two temp dirs (`tempProjectRepo`, `tempHome`) and
 * cleans them up in a `finally` block. The host's real `~/.gitconfig`
 * is never read or written by the production code; the per-workspace
 * identity is verified via `git -C <workspacePath> config --get`.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { exists } from "@std/fs";
import { join as joinPath } from "@std/path";
import { GitWorkspaceProvisioner, SPARSE_CHECKOUT_PATTERN } from "./git.ts";
import type { WorkspaceLogger } from "./interface.ts";
import { WorkspaceProvisioningError } from "./interface.ts";

interface CapturedLine {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function captureLogger(): { logger: WorkspaceLogger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  return {
    logger: {
      log: (level, event, fields) => {
        lines.push({ level, event, fields: fields ?? {} });
      },
    },
    lines,
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr);
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return new TextDecoder().decode(out.stdout).trimEnd();
}

async function makeProjectRepo(): Promise<string> {
  const repo = await Deno.makeTempDir({ prefix: "keni-git-test-repo-" });
  await runGit(repo, ["init", "-q", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "test-author"]);
  await runGit(repo, ["config", "user.email", "test@example.invalid"]);
  await Deno.mkdir(joinPath(repo, "src"), { recursive: true });
  await Deno.writeTextFile(joinPath(repo, "src", "main.ts"), "export {};\n");
  await Deno.mkdir(joinPath(repo, ".keni"), { recursive: true });
  await Deno.writeTextFile(
    joinPath(repo, ".keni", "project.yaml"),
    "project_id: 11111111-1111-1111-1111-111111111111\nname: demo\n",
  );
  await runGit(repo, ["add", "."]);
  await runGit(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

async function setup(): Promise<{ home: string; repo: string }> {
  const home = await Deno.makeTempDir({ prefix: "keni-git-test-home-" });
  const repo = await makeProjectRepo();
  return { home, repo };
}

async function teardown(home: string, repo: string): Promise<void> {
  await Deno.remove(home, { recursive: true }).catch(() => {});
  await Deno.remove(repo, { recursive: true }).catch(() => {});
}

Deno.test("constructor throws home_dir_unset on empty homeDir", () => {
  const { logger } = captureLogger();
  try {
    new GitWorkspaceProvisioner({ homeDir: "", logger });
    throw new Error("expected throw");
  } catch (err) {
    assert(err instanceof WorkspaceProvisioningError);
    assertEquals(err.code, "home_dir_unset");
  }
});

Deno.test("workspacePathFor returns the deterministic path under homeDir", () => {
  const { logger } = captureLogger();
  const provisioner = new GitWorkspaceProvisioner({ homeDir: "/tmp/h", logger });
  assertEquals(
    provisioner.workspacePathFor("p1", "alice"),
    joinPath("/tmp/h", ".keni", "workspaces", "p1", "alice"),
  );
});

Deno.test("workspacePathFor does not consult the filesystem", () => {
  const { logger } = captureLogger();
  const provisioner = new GitWorkspaceProvisioner({
    homeDir: "/no/such/home/at/all",
    logger,
  });
  const path = provisioner.workspacePathFor("p1", "alice");
  assertEquals(path, joinPath("/no/such/home/at/all", ".keni", "workspaces", "p1", "alice"));
});

Deno.test("ensureProvisioned: first-time provisioning produces a sparse clone with .keni absent", async () => {
  const { home, repo } = await setup();
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });
    await provisioner.ensureProvisioned("p1", "alice", repo);

    const workspace = provisioner.workspacePathFor("p1", "alice");
    assert(await exists(joinPath(workspace, ".git")));
    assert(await exists(joinPath(workspace, "src", "main.ts")));
    assertEquals(await exists(joinPath(workspace, ".keni")), false);

    const pattern = await Deno.readTextFile(
      joinPath(workspace, ".git", "info", "sparse-checkout"),
    );
    assertEquals(pattern, SPARSE_CHECKOUT_PATTERN);
  } finally {
    await teardown(home, repo);
  }
});

Deno.test("ensureProvisioned: per-workspace identity is set, host gitconfig untouched", async () => {
  const { home, repo } = await setup();
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });
    await provisioner.ensureProvisioned("p1", "alice", repo);
    const workspace = provisioner.workspacePathFor("p1", "alice");

    assertEquals(await runGit(workspace, ["config", "--local", "--get", "user.name"]), "alice");
    assertEquals(
      await runGit(workspace, ["config", "--local", "--get", "user.email"]),
      "alice@keni.invalid",
    );

    assertEquals(await exists(joinPath(home, ".gitconfig")), false);
  } finally {
    await teardown(home, repo);
  }
});

Deno.test("ensureProvisioned: idempotent re-provisioning is a near-no-op", async () => {
  const { home, repo } = await setup();
  try {
    const { logger, lines } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });
    await provisioner.ensureProvisioned("p1", "alice", repo);
    const workspace = provisioner.workspacePathFor("p1", "alice");
    const headBefore = await runGit(workspace, ["rev-parse", "HEAD"]);
    const linesAfterFirst = lines.length;

    await provisioner.ensureProvisioned("p1", "alice", repo);

    const headAfter = await runGit(workspace, ["rev-parse", "HEAD"]);
    assertEquals(headAfter, headBefore);
    assertEquals(await runGit(workspace, ["config", "--local", "--get", "user.name"]), "alice");
    const verifyEvents = lines.slice(linesAfterFirst).filter((l) =>
      l.event === "engineer.workspace_verified"
    );
    assertEquals(verifyEvents.length, 1);
  } finally {
    await teardown(home, repo);
  }
});

Deno.test("ensureProvisioned: drifted sparse pattern is repaired", async () => {
  const { home, repo } = await setup();
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });
    await provisioner.ensureProvisioned("p1", "alice", repo);
    const workspace = provisioner.workspacePathFor("p1", "alice");
    const patternFile = joinPath(workspace, ".git", "info", "sparse-checkout");

    await Deno.writeTextFile(patternFile, "/*\n");

    await provisioner.ensureProvisioned("p1", "alice", repo);

    assertEquals(await Deno.readTextFile(patternFile), SPARSE_CHECKOUT_PATTERN);
    assertEquals(await exists(joinPath(workspace, ".keni")), false);
  } finally {
    await teardown(home, repo);
  }
});

Deno.test("ensureProvisioned: missing git binary surfaces git_clone_failed", async () => {
  const home = await Deno.makeTempDir({ prefix: "keni-git-test-home-" });
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({
      homeDir: home,
      logger,
      gitBinary: "/no/such/git",
    });
    const err = await assertRejects(
      () => provisioner.ensureProvisioned("p1", "alice", "/tmp/repo"),
      WorkspaceProvisioningError,
    );
    assertEquals(err.code, "git_clone_failed");
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("pullMain: succeeds on fast-forward", async () => {
  const { home, repo } = await setup();
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });
    await provisioner.ensureProvisioned("p1", "alice", repo);

    await Deno.writeTextFile(joinPath(repo, "src", "v2.ts"), "export {};\n");
    await runGit(repo, ["add", "."]);
    await runGit(repo, ["commit", "-q", "-m", "v2"]);
    const projectHead = await runGit(repo, ["rev-parse", "HEAD"]);

    await provisioner.pullMain("p1", "alice");
    const workspace = provisioner.workspacePathFor("p1", "alice");
    const workspaceHead = await runGit(workspace, ["rev-parse", "HEAD"]);
    assertEquals(workspaceHead, projectHead);
  } finally {
    await teardown(home, repo);
  }
});

Deno.test("pullMain: rejects with pull_main_failed on non-fast-forward", async () => {
  const { home, repo } = await setup();
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });
    await provisioner.ensureProvisioned("p1", "alice", repo);
    const workspace = provisioner.workspacePathFor("p1", "alice");

    await Deno.writeTextFile(joinPath(workspace, "src", "ws.ts"), "export {};\n");
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-q", "-m", "workspace divergent"]);

    await Deno.writeTextFile(joinPath(repo, "src", "repo.ts"), "export {};\n");
    await runGit(repo, ["add", "."]);
    await runGit(repo, ["commit", "-q", "-m", "repo divergent"]);

    const err = await assertRejects(
      () => provisioner.pullMain("p1", "alice"),
      WorkspaceProvisioningError,
    );
    assertEquals(err.code, "pull_main_failed");
  } finally {
    await teardown(home, repo);
  }
});

Deno.test("pullMain: missing workspace rejects with workspace_missing", async () => {
  const home = await Deno.makeTempDir({ prefix: "keni-git-test-home-" });
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });

    const err = await assertRejects(
      () => provisioner.pullMain("p1", "ghost"),
      WorkspaceProvisioningError,
    );
    assertEquals(err.code, "workspace_missing");
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("discardProvisioned: removes the workspace tree recursively", async () => {
  const { home, repo } = await setup();
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });
    await provisioner.ensureProvisioned("p1", "alice", repo);
    const workspace = provisioner.workspacePathFor("p1", "alice");
    assert(await exists(workspace));

    await provisioner.discardProvisioned("p1", "alice");

    assertEquals(await exists(workspace), false);
    assert(await exists(joinPath(home, ".keni", "workspaces", "p1")));
  } finally {
    await teardown(home, repo);
  }
});

Deno.test("discardProvisioned: no-op on missing path", async () => {
  const home = await Deno.makeTempDir({ prefix: "keni-git-test-home-" });
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });
    await provisioner.discardProvisioned("p1", "ghost");
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("discardProvisioned: sibling workspaces are unaffected", async () => {
  const { home, repo } = await setup();
  try {
    const { logger } = captureLogger();
    const provisioner = new GitWorkspaceProvisioner({ homeDir: home, logger });
    await provisioner.ensureProvisioned("p1", "alice", repo);
    await provisioner.ensureProvisioned("p1", "bob", repo);
    const aliceWs = provisioner.workspacePathFor("p1", "alice");
    const bobWs = provisioner.workspacePathFor("p1", "bob");

    await provisioner.discardProvisioned("p1", "alice");

    assertEquals(await exists(aliceWs), false);
    assert(await exists(bobWs));
    assert(await exists(joinPath(bobWs, ".git")));
  } finally {
    await teardown(home, repo);
  }
});
