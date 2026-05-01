/**
 * Integration tests for the default git wrapper.
 *
 * These exercise the real `git` binary inside `Deno.makeTempDir()`. If `git`
 * is not on PATH, the suite is skipped cleanly with an explanatory message —
 * the repository's contributor docs (step 01 README) require git, so a
 * skipped run is unusual and points at the missing prerequisite, not at a
 * Keni bug.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { GitOperationError } from "./errors.ts";
import { createDefaultGitClient } from "./git.ts";

async function isGitOnPath(): Promise<boolean> {
  try {
    const proc = new Deno.Command("git", { args: ["--version"], stdout: "null", stderr: "null" });
    const out = await proc.output();
    return out.code === 0;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = await isGitOnPath();

const itGit = (label: string, fn: () => Promise<void>) => {
  if (GIT_AVAILABLE) {
    Deno.test(`createDefaultGitClient :: ${label}`, fn);
  } else {
    Deno.test.ignore(
      `createDefaultGitClient :: ${label} (skipped: git not on PATH)`,
      fn,
    );
  }
};

async function withTempRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "keni-cli-git-test-" });
  // Configure committer identity locally so commit tests work without inheriting
  // the user's global git config.
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function configureCommitter(dir: string): Promise<void> {
  for (
    const args of [
      ["config", "user.email", "ci@example.invalid"],
      ["config", "user.name", "Keni CI"],
      ["config", "commit.gpgsign", "false"],
    ]
  ) {
    const proc = new Deno.Command("git", { args, cwd: dir, stdout: "null", stderr: "null" });
    const result = await proc.output();
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}`);
  }
}

itGit("isRepo returns false outside a git repo", async () => {
  await withTempRepo(async (dir) => {
    const git = createDefaultGitClient();
    assertEquals(await git.isRepo(dir), false);
  });
});

itGit("init creates a repo and isRepo subsequently returns true", async () => {
  await withTempRepo(async (dir) => {
    const git = createDefaultGitClient();
    await git.init(dir);
    assertEquals(await git.isRepo(dir), true);
  });
});

itGit(
  "hasStagedOrUnstagedChanges returns false on a freshly-initialised repo with no files",
  async () => {
    await withTempRepo(async (dir) => {
      const git = createDefaultGitClient();
      await git.init(dir);
      await configureCommitter(dir);
      assertEquals(await git.hasStagedOrUnstagedChanges(dir), false);
    });
  },
);

itGit("add then hasStagedOrUnstagedChanges returns true", async () => {
  await withTempRepo(async (dir) => {
    const git = createDefaultGitClient();
    await git.init(dir);
    await configureCommitter(dir);
    await Deno.writeTextFile(join(dir, "README.md"), "# hi\n");
    await git.add(dir, ["README.md"]);
    assertEquals(await git.hasStagedOrUnstagedChanges(dir), true);
  });
});

itGit("commit produces a single new commit", async () => {
  await withTempRepo(async (dir) => {
    const git = createDefaultGitClient();
    await git.init(dir);
    await configureCommitter(dir);
    await Deno.writeTextFile(join(dir, "README.md"), "# hi\n");
    await git.add(dir, ["README.md"]);
    await git.commit(dir, "test commit");
    // After the commit the tree is clean again.
    assertEquals(await git.hasStagedOrUnstagedChanges(dir), false);
    // Verify the commit landed via raw git log.
    const proc = new Deno.Command("git", {
      args: ["log", "--oneline"],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    });
    const out = await proc.output();
    assertEquals(out.code, 0);
    const log = new TextDecoder().decode(out.stdout).trim().split("\n");
    assertEquals(log.length, 1);
    assert(log[0]?.includes("test commit"));
  });
});

itGit("add with empty paths is a no-op (no git invocation)", async () => {
  await withTempRepo(async (dir) => {
    const git = createDefaultGitClient();
    await git.init(dir);
    // Nothing thrown, no error.
    await git.add(dir, []);
  });
});

itGit("commit with no staged changes throws GitOperationError", async () => {
  await withTempRepo(async (dir) => {
    const git = createDefaultGitClient();
    await git.init(dir);
    await configureCommitter(dir);
    await assertRejects(
      () => git.commit(dir, "empty"),
      GitOperationError,
    );
  });
});

itGit("isRepo on a parent directory of a git repo returns false", async () => {
  await withTempRepo(async (parent) => {
    const child = join(parent, "child");
    await Deno.mkdir(child);
    const git = createDefaultGitClient();
    await git.init(child);
    // Parent has no .git/ — isRepo should return false. Note: git looks
    // upward by default; rev-parse --git-dir from `parent` would fail because
    // there is no parent .git/.
    assertEquals(await git.isRepo(parent), false);
  });
});
