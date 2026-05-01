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
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Drop-in replacement for `withTempRepo` that additionally isolates spawned
 * git subprocesses from the host's global / system / XDG git config —
 * matching the conditions a CI runner sees when no `~/.gitconfig` exists.
 *
 * Sets `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, and
 * `HOME=<temp dir without .gitconfig>` on the test process for the duration
 * of `fn`; the subprocess inherits these so its identity-resolution chain
 * sees only per-repo config (which is empty on a fresh `git init`). Every
 * env-var change is restored in `finally`.
 *
 * POSIX-only: `/dev/null` does not exist on Windows. A platform check
 * (`nul` on Windows) would be a one-line addition the day Keni supports
 * Windows; today the prototype is Linux/macOS-only.
 */
async function withTempRepoIdentityIsolated(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const isolatedHome = await Deno.makeTempDir({ prefix: "keni-cli-git-test-isohome-" });
  const previous = {
    GIT_CONFIG_GLOBAL: Deno.env.get("GIT_CONFIG_GLOBAL"),
    GIT_CONFIG_SYSTEM: Deno.env.get("GIT_CONFIG_SYSTEM"),
    HOME: Deno.env.get("HOME"),
  };
  Deno.env.set("GIT_CONFIG_GLOBAL", "/dev/null");
  Deno.env.set("GIT_CONFIG_SYSTEM", "/dev/null");
  Deno.env.set("HOME", isolatedHome);
  try {
    await withTempRepo(fn);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(isolatedHome, { recursive: true });
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

async function gitLogAuthor(dir: string): Promise<string> {
  const proc = new Deno.Command("git", {
    args: ["log", "-1", "--format=%an <%ae>"],
    cwd: dir,
    stdout: "piped",
    stderr: "null",
  });
  const out = await proc.output();
  if (out.code !== 0) throw new Error(`git log failed in ${dir}`);
  return new TextDecoder().decode(out.stdout).trim();
}

async function gitLogCommitter(dir: string): Promise<string> {
  const proc = new Deno.Command("git", {
    args: ["log", "-1", "--format=%cn <%ce>"],
    cwd: dir,
    stdout: "piped",
    stderr: "null",
  });
  const out = await proc.output();
  if (out.code !== 0) throw new Error(`git log failed in ${dir}`);
  return new TextDecoder().decode(out.stdout).trim();
}

async function gitConfigGet(
  dir: string,
  key: string,
): Promise<{ code: number; stdout: string }> {
  const proc = new Deno.Command("git", {
    args: ["config", "--get", key],
    cwd: dir,
    stdout: "piped",
    stderr: "null",
  });
  const out = await proc.output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
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

itGit(
  "commit produces a Keni-fallback identity when no user.name / user.email is configured",
  async () => {
    await withTempRepoIdentityIsolated(async (dir) => {
      const git = createDefaultGitClient();
      await git.init(dir);
      // Deliberately do NOT call configureCommitter — proving the path works
      // without it is the entire point of this test.
      await Deno.writeTextFile(join(dir, "README.md"), "# fallback\n");
      await git.add(dir, ["README.md"]);
      await git.commit(dir, "test commit under fallback identity");
      assertEquals(await gitLogAuthor(dir), "Keni <keni@example.invalid>");
      assertEquals(await gitLogCommitter(dir), "Keni <keni@example.invalid>");
    });
  },
);

itGit(
  "commit honours configured user identity even when GIT_CONFIG_GLOBAL is /dev/null",
  async () => {
    await withTempRepoIdentityIsolated(async (dir) => {
      const git = createDefaultGitClient();
      await git.init(dir);
      await configureCommitter(dir);
      await Deno.writeTextFile(join(dir, "README.md"), "# user\n");
      await git.add(dir, ["README.md"]);
      await git.commit(dir, "test commit under configured identity");
      // The fallback fires only when no layer has identity. Per-repo config
      // (written by configureCommitter) is a layer git resolves before
      // global; the commit MUST be attributed to the configured identity.
      assertEquals(await gitLogAuthor(dir), "Keni CI <ci@example.invalid>");
      assertEquals(await gitLogCommitter(dir), "Keni CI <ci@example.invalid>");
    });
  },
);

itGit("commit fallback does not write any persistent git config", async () => {
  await withTempRepoIdentityIsolated(async (dir) => {
    const git = createDefaultGitClient();
    await git.init(dir);
    await Deno.writeTextFile(join(dir, "README.md"), "# fallback no-persist\n");
    await git.add(dir, ["README.md"]);
    await git.commit(dir, "test commit");
    // The four GIT_AUTHOR_* / GIT_COMMITTER_* env vars apply only to that
    // single subprocess — neither user.name nor user.email is left behind.
    const name = await gitConfigGet(dir, "user.name");
    const email = await gitConfigGet(dir, "user.email");
    assertEquals(name.code, 1);
    assertEquals(name.stdout, "");
    assertEquals(email.code, 1);
    assertEquals(email.stdout, "");
    // And nothing was written into .git/config under a [user] section.
    const config = await Deno.readTextFile(join(dir, ".git", "config"));
    assert(
      !config.includes("[user]"),
      `expected .git/config to have no [user] section, got:\n${config}`,
    );
  });
});
