import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FileConfigStore, resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import type { ProjectConfig } from "@keni/shared";
import { executeActions, type ExecuteDeps } from "./execute.ts";
import type { GitClient } from "./git.ts";
import { defaultInitialProjectConfig, type InitAction } from "./plan.ts";

interface FakeGitClient extends GitClient {
  readonly calls: string[];
}

function makeFakeGit(opts: {
  isRepoStartsTrue?: boolean;
  hasChangesAfterAdd?: boolean;
} = {}): FakeGitClient {
  const calls: string[] = [];
  let repo = opts.isRepoStartsTrue ?? false;
  return {
    calls,
    isRepo: () => {
      calls.push("isRepo");
      return Promise.resolve(repo);
    },
    init: () => {
      calls.push("init");
      repo = true;
      return Promise.resolve();
    },
    hasStagedOrUnstagedChanges: () => {
      calls.push("hasStagedOrUnstagedChanges");
      return Promise.resolve(opts.hasChangesAfterAdd ?? true);
    },
    add: (_cwd, paths) => {
      calls.push(`add:${paths.join(",")}`);
      return Promise.resolve();
    },
    commit: (_cwd, msg) => {
      calls.push(`commit:${msg}`);
      return Promise.resolve();
    },
  };
}

async function withTempDirs(
  fn: (deps: ExecuteDeps, fakeGit: FakeGitClient) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "keni-cli-execute-root-" });
  const home = await Deno.makeTempDir({ prefix: "keni-cli-execute-home-" });
  try {
    const projectPaths = resolveProjectPaths(root);
    const globalPaths = resolveGlobalPaths(home);
    const configStore = new FileConfigStore(projectPaths, globalPaths);
    const gitClient = makeFakeGit();
    await fn({ projectPaths, globalPaths, configStore, gitClient }, gitClient);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("executeActions — git_init delegates to gitClient.init", async () => {
  await withTempDirs(async (deps, git) => {
    await executeActions([{ kind: "git_init" }], deps);
    assert(git.calls.includes("init"));
  });
});

Deno.test("executeActions — create_keni_root creates .keni/ directory", async () => {
  await withTempDirs(async (deps) => {
    await executeActions([{ kind: "create_keni_root" }], deps);
    const stat = await Deno.stat(deps.projectPaths.keni);
    assert(stat.isDirectory);
  });
});

Deno.test("executeActions — create_keni_subdir creates dir AND zero-byte .gitkeep", async () => {
  await withTempDirs(async (deps) => {
    await Deno.mkdir(deps.projectPaths.keni, { recursive: true });
    const result = await executeActions(
      [{ kind: "create_keni_subdir", subdir: "tickets" }],
      deps,
    );
    const dirStat = await Deno.stat(deps.projectPaths.tickets);
    assert(dirStat.isDirectory);
    const gitkeepPath = join(deps.projectPaths.tickets, ".gitkeep");
    const gitkeepStat = await Deno.stat(gitkeepPath);
    assert(gitkeepStat.isFile);
    assertEquals(gitkeepStat.size, 0);
    assertEquals(result.recreatedSubdirs, ["tickets"]);
  });
});

Deno.test("executeActions — write_project_config goes through ConfigStore (file appears)", async () => {
  await withTempDirs(async (deps) => {
    await Deno.mkdir(deps.projectPaths.keni, { recursive: true });
    const config: ProjectConfig = defaultInitialProjectConfig(
      "00000000-0000-4000-8000-000000000000",
      "test-app",
    );
    const result = await executeActions(
      [{ kind: "write_project_config", config }],
      deps,
    );
    assertEquals(result.wroteProjectConfig, true);
    const text = await Deno.readTextFile(deps.projectPaths.projectConfig);
    assert(text.includes("project_id: 00000000-0000-4000-8000-000000000000"));
    assert(text.includes("name: test-app"));
  });
});

Deno.test("executeActions — write_state_json writes the documented skeleton", async () => {
  await withTempDirs(async (deps) => {
    await Deno.mkdir(deps.projectPaths.keni, { recursive: true });
    await executeActions([{ kind: "write_state_json" }], deps);
    const stateJsonPath = join(deps.projectPaths.keni, "state.json");
    const text = await Deno.readTextFile(stateJsonPath);
    const parsed = JSON.parse(text);
    assertEquals(parsed, { watermarks: {} });
  });
});

Deno.test("executeActions — ensure_global_dir creates <home>/.keni/ and logs/", async () => {
  await withTempDirs(async (deps) => {
    const result = await executeActions([{ kind: "ensure_global_dir" }], deps);
    assertEquals(result.bootstrappedGlobalDir, true);
    const keniStat = await Deno.stat(deps.globalPaths.keni);
    assert(keniStat.isDirectory);
    const logsStat = await Deno.stat(deps.globalPaths.logs);
    assert(logsStat.isDirectory);
  });
});

Deno.test("executeActions — write_global_config_stub uses ConfigStore.writeGlobalConfig", async () => {
  await withTempDirs(async (deps) => {
    await Deno.mkdir(deps.globalPaths.keni, { recursive: true });
    const result = await executeActions([{ kind: "write_global_config_stub" }], deps);
    assertEquals(result.wroteGlobalConfigStub, true);
    const text = await Deno.readTextFile(deps.globalPaths.globalConfig);
    // YAML stringification of {} is "{}\n" (depending on the lib it may be empty).
    // We just assert that readGlobalConfig reads back {}.
    const read = await deps.configStore.readGlobalConfig();
    assertEquals(read, {});
    // Sanity: the file is at the expected path.
    assert(text.length >= 0);
  });
});

Deno.test("executeActions — merge_gitignore writes the supplied contents to <root>/.gitignore", async () => {
  await withTempDirs(async (deps) => {
    const contents = "# Added by Keni\n.env\n";
    await executeActions(
      [{ kind: "merge_gitignore", contents }],
      deps,
    );
    const text = await Deno.readTextFile(join(deps.projectPaths.root, ".gitignore"));
    assertEquals(text, contents);
  });
});

Deno.test("executeActions — git_commit calls add, status, commit when changes are present", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-cli-execute-commit-" });
  const home = await Deno.makeTempDir({ prefix: "keni-cli-execute-home-" });
  try {
    const projectPaths = resolveProjectPaths(root);
    const globalPaths = resolveGlobalPaths(home);
    const configStore = new FileConfigStore(projectPaths, globalPaths);
    const git = makeFakeGit({ hasChangesAfterAdd: true });
    const result = await executeActions(
      [{ kind: "git_commit", paths: [".keni", ".gitignore"], message: "Init" }],
      { projectPaths, globalPaths, configStore, gitClient: git },
    );
    assert(git.calls.some((c) => c.startsWith("add:")));
    assert(git.calls.includes("hasStagedOrUnstagedChanges"));
    assert(git.calls.some((c) => c.startsWith("commit:Init")));
    assertEquals(result.commitProduced, true);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("executeActions — git_commit skips commit when status is clean", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-cli-execute-skip-" });
  const home = await Deno.makeTempDir({ prefix: "keni-cli-execute-home-" });
  try {
    const projectPaths = resolveProjectPaths(root);
    const globalPaths = resolveGlobalPaths(home);
    const configStore = new FileConfigStore(projectPaths, globalPaths);
    const git = makeFakeGit({ hasChangesAfterAdd: false });
    const result = await executeActions(
      [{ kind: "git_commit", paths: [".keni"], message: "noop" }],
      { projectPaths, globalPaths, configStore, gitClient: git },
    );
    assertEquals(result.commitProduced, false);
    assert(!git.calls.some((c) => c.startsWith("commit:")));
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("executeActions — empty action list is a no-op (no git calls)", async () => {
  await withTempDirs(async (deps, git) => {
    const result = await executeActions([], deps);
    assertEquals(result.commitProduced, false);
    assertEquals(result.recreatedSubdirs, []);
    assertEquals(git.calls, []);
  });
});

Deno.test("executeActions — full fresh-init pipeline produces every artifact", async () => {
  await withTempDirs(async (deps) => {
    const config: ProjectConfig = defaultInitialProjectConfig(
      "11111111-1111-4111-8111-111111111111",
      "fresh",
    );
    const actions: InitAction[] = [
      { kind: "git_init" },
      { kind: "create_keni_root" },
      { kind: "create_keni_subdir", subdir: "tickets" },
      { kind: "create_keni_subdir", subdir: "prs" },
      { kind: "create_keni_subdir", subdir: "activity" },
      { kind: "write_project_config", config },
      { kind: "write_state_json" },
      { kind: "ensure_global_dir" },
      { kind: "write_global_config_stub" },
      { kind: "merge_gitignore", contents: ".env\n.keni/state.json\n" },
      { kind: "git_commit", paths: [".keni", ".gitignore"], message: "Initialise" },
    ];
    const result = await executeActions(actions, deps);
    // Recreated subdirs in order
    assertEquals(result.recreatedSubdirs, ["tickets", "prs", "activity"]);
    // Filesystem artefacts
    for (
      const path of [
        deps.projectPaths.keni,
        deps.projectPaths.tickets,
        deps.projectPaths.prs,
        deps.projectPaths.activity,
      ]
    ) {
      const stat = await Deno.stat(path);
      assert(stat.isDirectory, `${path} should be a directory`);
    }
    for (
      const file of [
        deps.projectPaths.projectConfig,
        join(deps.projectPaths.keni, "state.json"),
        join(deps.projectPaths.tickets, ".gitkeep"),
        join(deps.projectPaths.prs, ".gitkeep"),
        join(deps.projectPaths.activity, ".gitkeep"),
        join(deps.projectPaths.root, ".gitignore"),
      ]
    ) {
      const stat = await Deno.stat(file);
      assert(stat.isFile, `${file} should be a file`);
    }
    // Global dir + config
    const gStat = await Deno.stat(deps.globalPaths.globalConfig);
    assert(gStat.isFile);
    const lStat = await Deno.stat(deps.globalPaths.logs);
    assert(lStat.isDirectory);
    assertEquals(result.commitProduced, true);
  });
});
