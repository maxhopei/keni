/**
 * End-to-end integration tests for `runInit`.
 *
 * Each test runs `runInit` in a fresh `Deno.makeTempDir()` against the real
 * `git` binary and asserts on the resulting filesystem state, the git log,
 * and the success summary printed to stdout. The home directory is also a
 * temp dir so the user's real `~/.keni/` is never touched.
 *
 * The suite is skipped if `git` is not on PATH, with a clear message naming
 * the missing prerequisite (matches `git_test.ts`).
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { ProjectStateError } from "../../../src/init/errors.ts";
import { parseInitArgs, runInit } from "../../../src/init/mod.ts";

async function isGitOnPath(): Promise<boolean> {
  try {
    const proc = new Deno.Command("git", { args: ["--version"], stdout: "null", stderr: "null" });
    return (await proc.output()).code === 0;
  } catch {
    return false;
  }
}
const GIT_AVAILABLE = await isGitOnPath();

const itGit = (label: string, fn: () => Promise<void>) => {
  if (GIT_AVAILABLE) {
    Deno.test(`runInit :: ${label}`, fn);
  } else {
    Deno.test.ignore(`runInit :: ${label} (skipped: git not on PATH)`, fn);
  }
};

interface TestEnv {
  readonly root: string;
  readonly home: string;
  readonly stdout: string[];
  readonly stderr: string[];
}

async function withEnv(fn: (env: TestEnv) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "keni-cli-runinit-root-" });
  const home = await Deno.makeTempDir({ prefix: "keni-cli-runinit-home-" });
  try {
    await fn({ root, home, stdout: [], stderr: [] });
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
}

/**
 * `withEnv` plus strict git identity isolation — exists specifically to
 * reproduce the CI runner's identity-less environment so the `git.ts`
 * fallback path is exercised regardless of the host's `~/.gitconfig`.
 *
 * Sets `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, and
 * `HOME=<env.home>` (the temp home `withEnv` already created) for the
 * duration of `fn`; subprocesses spawned during `runInit` inherit these so
 * git's identity-resolution chain finds nothing in any layer above per-repo
 * config. Every env-var change is restored in `finally`. POSIX-only —
 * matches `git_test.ts :: withTempRepoIdentityIsolated`.
 */
async function withGitIdentityIsolated(
  fn: (env: TestEnv) => Promise<void>,
): Promise<void> {
  await withEnv(async (env) => {
    const previous = {
      GIT_CONFIG_GLOBAL: Deno.env.get("GIT_CONFIG_GLOBAL"),
      GIT_CONFIG_SYSTEM: Deno.env.get("GIT_CONFIG_SYSTEM"),
      HOME: Deno.env.get("HOME"),
    };
    Deno.env.set("GIT_CONFIG_GLOBAL", "/dev/null");
    Deno.env.set("GIT_CONFIG_SYSTEM", "/dev/null");
    Deno.env.set("HOME", env.home);
    try {
      await fn(env);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
}

async function configureGitInRepo(repoDir: string): Promise<void> {
  for (
    const args of [
      ["config", "user.email", "ci@example.invalid"],
      ["config", "user.name", "Keni CI"],
      ["config", "commit.gpgsign", "false"],
    ]
  ) {
    const proc = new Deno.Command("git", { args, cwd: repoDir, stdout: "null", stderr: "null" });
    if ((await proc.output()).code !== 0) {
      throw new Error(`git ${args.join(" ")} failed`);
    }
  }
}

async function gitLog(repoDir: string): Promise<string[]> {
  const proc = new Deno.Command("git", {
    args: ["log", "--oneline"],
    cwd: repoDir,
    stdout: "piped",
    stderr: "null",
  });
  const out = await proc.output();
  if (out.code !== 0) return [];
  return new TextDecoder().decode(out.stdout).trim().split("\n").filter((l) => l.length > 0);
}

async function gitStatusPorcelain(repoDir: string): Promise<string> {
  const proc = new Deno.Command("git", {
    args: ["status", "--porcelain"],
    cwd: repoDir,
    stdout: "piped",
    stderr: "null",
  });
  const out = await proc.output();
  return new TextDecoder().decode(out.stdout);
}

async function gitLogFormat(repoDir: string, format: string): Promise<string> {
  const proc = new Deno.Command("git", {
    args: ["log", "-1", `--format=${format}`],
    cwd: repoDir,
    stdout: "piped",
    stderr: "null",
  });
  const out = await proc.output();
  if (out.code !== 0) throw new Error(`git log -1 --format=${format} failed in ${repoDir}`);
  return new TextDecoder().decode(out.stdout).trim();
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

itGit("fresh empty dir produces full layout, single commit, valid UUIDv4 project_id", async () => {
  await withEnv(async (env) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runInit({ targetDir: env.root }, {
      homeDir: env.home,
      out: (m) => stdout.push(m),
      err: (m) => stderr.push(m),
    });
    assertEquals(code, 0, `runInit failed; stderr=${stderr.join("\n")}`);

    // Configure committer identity in the new repo and verify the commit
    // landed. Note: the commit was already made by runInit before
    // configureGitInRepo runs — but `git init` honours user-level git config,
    // so we configure user.email at the user-level via env vars below.
    // Simpler: just check the log is non-empty.
    const log = await gitLog(env.root);
    assertEquals(log.length, 1, `expected exactly one commit, got: ${log.join(" / ")}`);
    assert(log[0]?.includes("Initialise Keni project"));

    // Layout
    for (
      const dir of [".keni", ".keni/tickets", ".keni/prs", ".keni/activity"]
    ) {
      const stat = await Deno.stat(join(env.root, dir));
      assert(stat.isDirectory, `${dir} should be a directory`);
    }
    for (
      const file of [
        ".keni/project.yaml",
        ".keni/state.json",
        ".keni/tickets/.gitkeep",
        ".keni/prs/.gitkeep",
        ".keni/activity/.gitkeep",
        ".gitignore",
      ]
    ) {
      const stat = await Deno.stat(join(env.root, file));
      assert(stat.isFile, `${file} should be a file`);
    }

    // project.yaml
    const yaml = parseYaml(
      await Deno.readTextFile(join(env.root, ".keni/project.yaml")),
    ) as Record<string, unknown>;
    assert(typeof yaml.project_id === "string");
    assert(UUID_V4.test(yaml.project_id), `project_id ${yaml.project_id} should match UUIDv4`);
    assertEquals(yaml.name, env.root.split("/").pop());
    assertEquals(
      yaml.agents,
      [{ id: "alice", role: "engineer" }],
    );
    assert(yaml.stack === undefined);

    // state.json
    const stateJson = JSON.parse(
      await Deno.readTextFile(join(env.root, ".keni/state.json")),
    );
    assertEquals(stateJson, { watermarks: {} });

    // .gitignore
    const gitignore = await Deno.readTextFile(join(env.root, ".gitignore"));
    for (
      const required of [
        ".env",
        ".env.*",
        "!.env.example",
        ".keni/state.json",
        "node_modules/",
        "dist/",
        "build/",
      ]
    ) {
      assert(gitignore.includes(required), `gitignore should include ${required}`);
    }

    // Global directory
    const globalDir = await Deno.stat(join(env.home, ".keni"));
    assert(globalDir.isDirectory);
    const logsDir = await Deno.stat(join(env.home, ".keni", "logs"));
    assert(logsDir.isDirectory);
    const globalConfig = await Deno.stat(join(env.home, ".keni", "config.yaml"));
    assert(globalConfig.isFile);
    // Workspaces dir SHALL NOT be created by init.
    await assertRejects(
      () => Deno.stat(join(env.home, ".keni", "workspaces")),
      Deno.errors.NotFound,
    );

    // Working tree must be clean (everything we created is committed or ignored)
    const status = await gitStatusPorcelain(env.root);
    assertEquals(status, "");

    // stdout summary
    assert(stdout.some((m) => m.includes("Initialised Keni project")));
    assert(stdout.some((m) => m.includes("project_id:")));
    assert(stdout.some((m) => m.includes("alice (engineer)")));
  });
});

itGit("idempotent re-run on a clean project produces no new commits", async () => {
  await withEnv(async (env) => {
    const r1 = await runInit({ targetDir: env.root }, {
      homeDir: env.home,
      out: () => {},
      err: () => {},
    });
    assertEquals(r1, 0);
    const log1 = await gitLog(env.root);

    const stdout: string[] = [];
    const r2 = await runInit({ targetDir: env.root }, {
      homeDir: env.home,
      out: (m) => stdout.push(m),
      err: () => {},
    });
    assertEquals(r2, 0);
    const log2 = await gitLog(env.root);

    assertEquals(log1, log2, "second run must not add any commits");
    assert(
      stdout.some((m) => m.includes("already initialised")),
      "stdout should include 'already initialised'",
    );

    // project_id stable across runs
    const yaml = parseYaml(
      await Deno.readTextFile(join(env.root, ".keni/project.yaml")),
    ) as Record<string, unknown>;
    assert(stdout.some((m) => m.includes(`project_id: ${yaml.project_id}`)));
  });
});

itGit(
  "partial-state repair recreates missing tickets/ with byte-identical .gitkeep (clean working tree, no new commit)",
  async () => {
    await withEnv(async (env) => {
      await runInit({ targetDir: env.root }, { homeDir: env.home, out: () => {}, err: () => {} });
      const before = await gitLog(env.root);
      const yamlBefore = await Deno.readTextFile(join(env.root, ".keni/project.yaml"));

      await Deno.remove(join(env.root, ".keni/tickets"), { recursive: true });

      const stdout: string[] = [];
      const r = await runInit({ targetDir: env.root }, {
        homeDir: env.home,
        out: (m) => stdout.push(m),
        err: () => {},
      });
      assertEquals(r, 0);

      // tickets/ + .gitkeep restored
      const dirStat = await Deno.stat(join(env.root, ".keni/tickets"));
      assert(dirStat.isDirectory);
      const keepStat = await Deno.stat(join(env.root, ".keni/tickets/.gitkeep"));
      assert(keepStat.isFile);
      assertEquals(keepStat.size, 0);

      // project.yaml unchanged
      const yamlAfter = await Deno.readTextFile(join(env.root, ".keni/project.yaml"));
      assertEquals(yamlAfter, yamlBefore);

      // The recreated .gitkeep is byte-identical to the original, so the
      // working tree matches HEAD again — no new commit is produced.
      const after = await gitLog(env.root);
      assertEquals(after.length, before.length, "no new commit when recreation is byte-identical");

      // Working tree is clean.
      const status = await gitStatusPorcelain(env.root);
      assertEquals(status, "");

      // Repair message named tickets/.
      assert(stdout.some((m) => m.includes("Repaired Keni project")));
      assert(stdout.some((m) => m.includes(".keni/tickets/")));
    });
  },
);

itGit("existing git repo with non-Keni history gains exactly one new commit", async () => {
  await withEnv(async (env) => {
    // Pre-populate as a real git repo with one commit.
    {
      const proc = new Deno.Command("git", {
        args: ["init", env.root],
        stdout: "null",
        stderr: "null",
      });
      assertEquals((await proc.output()).code, 0);
    }
    await configureGitInRepo(env.root);
    await Deno.writeTextFile(join(env.root, "README.md"), "# Existing\n");
    {
      const a = new Deno.Command("git", {
        args: ["add", "README.md"],
        cwd: env.root,
        stdout: "null",
        stderr: "null",
      });
      assertEquals((await a.output()).code, 0);
      const c = new Deno.Command("git", {
        args: ["commit", "-m", "initial"],
        cwd: env.root,
        stdout: "null",
        stderr: "null",
      });
      assertEquals((await c.output()).code, 0);
    }
    const before = await gitLog(env.root);
    assertEquals(before.length, 1);

    const r = await runInit({ targetDir: env.root }, {
      homeDir: env.home,
      out: () => {},
      err: () => {},
    });
    assertEquals(r, 0);
    const after = await gitLog(env.root);
    assertEquals(after.length, 2, "exactly one new commit should be added");
    // README still tracked
    const status = await gitStatusPorcelain(env.root);
    assertEquals(status, "");
  });
});

itGit(
  "existing .gitignore with custom entries is preserved verbatim, Keni entries appended",
  async () => {
    await withEnv(async (env) => {
      await Deno.writeTextFile(join(env.root, ".gitignore"), "__pycache__/\n.vscode/\n");
      const r = await runInit({ targetDir: env.root }, {
        homeDir: env.home,
        out: () => {},
        err: () => {},
      });
      assertEquals(r, 0);
      const text = await Deno.readTextFile(join(env.root, ".gitignore"));
      assert(text.includes("__pycache__/"));
      assert(text.includes(".vscode/"));
      assert(text.includes(".env"));
      assert(text.includes(".keni/state.json"));
    });
  },
);

itGit("existing non-empty non-repo dir does not touch unrelated files", async () => {
  await withEnv(async (env) => {
    await Deno.writeTextFile(join(env.root, "user-script.sh"), "#!/bin/sh\necho hi\n");
    await Deno.writeTextFile(join(env.root, "data.json"), '{"x":1}\n');
    const r = await runInit({ targetDir: env.root }, {
      homeDir: env.home,
      out: () => {},
      err: () => {},
    });
    assertEquals(r, 0);
    assertEquals(
      await Deno.readTextFile(join(env.root, "user-script.sh")),
      "#!/bin/sh\necho hi\n",
    );
    assertEquals(
      await Deno.readTextFile(join(env.root, "data.json")),
      '{"x":1}\n',
    );
  });
});

itGit("malformed project.yaml aborts repair (exit 1, no other files modified)", async () => {
  await withEnv(async (env) => {
    // Pre-init the project, then corrupt project.yaml
    await runInit({ targetDir: env.root }, { homeDir: env.home, out: () => {}, err: () => {} });
    await Deno.writeTextFile(
      join(env.root, ".keni/project.yaml"),
      "name: 'unclosed\n",
    );
    const stateBefore = await Deno.readTextFile(join(env.root, ".keni/state.json"));
    const gitignoreBefore = await Deno.readTextFile(join(env.root, ".gitignore"));

    const stderr: string[] = [];
    const r = await runInit({ targetDir: env.root }, {
      homeDir: env.home,
      out: () => {},
      err: (m) => stderr.push(m),
    });
    assertEquals(r, 1);
    assert(stderr.some((m) => m.includes(".keni/project.yaml")));
    assert(stderr.some((m) => m.includes("malformed")));

    // Other files untouched
    assertEquals(await Deno.readTextFile(join(env.root, ".keni/state.json")), stateBefore);
    assertEquals(await Deno.readTextFile(join(env.root, ".gitignore")), gitignoreBefore);
  });
});

itGit("subsequent runs preserve a pre-existing global config", async () => {
  await withEnv(async (env) => {
    // Bootstrap with one run
    await runInit({ targetDir: env.root }, { homeDir: env.home, out: () => {}, err: () => {} });
    // Overwrite the global config with custom content
    await Deno.writeTextFile(
      join(env.home, ".keni/config.yaml"),
      "log_level: debug\n",
    );

    // Run init in a *different* project — global config must be preserved
    const root2 = await Deno.makeTempDir({ prefix: "keni-cli-runinit-other-" });
    try {
      await runInit({ targetDir: root2 }, { homeDir: env.home, out: () => {}, err: () => {} });
      const text = await Deno.readTextFile(join(env.home, ".keni/config.yaml"));
      assertEquals(text, "log_level: debug\n");
    } finally {
      await Deno.remove(root2, { recursive: true });
    }
  });
});

itGit(
  "produces a Keni-fallback initial commit when no git identity is configured",
  async () => {
    await withGitIdentityIsolated(async (env) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runInit({ targetDir: env.root }, {
        homeDir: env.home,
        out: (m) => stdout.push(m),
        err: (m) => stderr.push(m),
      });
      assertEquals(
        code,
        0,
        `runInit failed under identity-less env; stderr=${stderr.join("\n")}`,
      );

      // Exactly one commit, attributed to the documented Keni fallback.
      const log = await gitLog(env.root);
      assertEquals(log.length, 1, `expected one commit, got: ${log.join(" / ")}`);
      assert(
        log[0]?.includes("Initialise Keni project"),
        `commit subject should start with "Initialise Keni project", got: ${log[0]}`,
      );
      assertEquals(
        await gitLogFormat(env.root, "%an <%ae>"),
        "Keni <keni@example.invalid>",
      );
      assertEquals(
        await gitLogFormat(env.root, "%cn <%ce>"),
        "Keni <keni@example.invalid>",
      );

      // Working tree clean — every created file is committed or ignored.
      assertEquals(await gitStatusPorcelain(env.root), "");
    });
  },
);

Deno.test("parseInitArgs — too many positional args throws UsageError", () => {
  let threw = false;
  try {
    parseInitArgs(["a", "b"]);
  } catch (e) {
    threw = true;
    assert(e instanceof Error);
    assert((e as Error).message.includes("at most one"));
  }
  assert(threw, "parseInitArgs should throw UsageError on too many args");
});

Deno.test("ProjectStateError is exported and constructable from outside the module", () => {
  // Sanity: even if no test explicitly imports ProjectStateError, the
  // typed-error path is exercised by the malformed-yaml test above. Keep
  // this test tiny to ensure the export is reachable.
  assert(typeof ProjectStateError === "function");
});
