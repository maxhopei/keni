import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { FileConfigStore, resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import type { ProjectConfig } from "@keni/shared";
import { ProjectStateError } from "./errors.ts";
import { inspectProjectState } from "./state.ts";

interface FakeGitClient {
  isRepo: () => Promise<boolean>;
  init: () => Promise<void>;
  hasStagedOrUnstagedChanges: () => Promise<boolean>;
  add: () => Promise<void>;
  commit: () => Promise<void>;
}

function fakeGitClient(opts: { isRepo: boolean }): FakeGitClient {
  return {
    isRepo: () => Promise.resolve(opts.isRepo),
    init: () => Promise.reject(new Error("init not expected in state tests")),
    hasStagedOrUnstagedChanges: () => Promise.reject(new Error("not expected in state tests")),
    add: () => Promise.reject(new Error("not expected in state tests")),
    commit: () => Promise.reject(new Error("not expected in state tests")),
  };
}

async function withTempDirs(
  fn: (root: string, home: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "keni-cli-state-root-" });
  const home = await Deno.makeTempDir({ prefix: "keni-cli-state-home-" });
  try {
    await fn(root, home);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("inspectProjectState — empty project + empty home reports everything missing", async () => {
  await withTempDirs(async (root, home) => {
    const projectPaths = resolveProjectPaths(root);
    const globalPaths = resolveGlobalPaths(home);
    const store = new FileConfigStore(projectPaths, globalPaths);
    const state = await inspectProjectState(
      projectPaths,
      globalPaths,
      store,
      fakeGitClient({ isRepo: false }),
    );
    assertEquals(state.isGitRepo, false);
    assertEquals(state.keniDirExists, false);
    assertEquals(state.ticketsDirExists, false);
    assertEquals(state.ticketsGitkeepExists, false);
    assertEquals(state.prsDirExists, false);
    assertEquals(state.prsGitkeepExists, false);
    assertEquals(state.activityDirExists, false);
    assertEquals(state.activityGitkeepExists, false);
    assertEquals(state.projectConfig, null);
    assertEquals(state.stateJsonExists, false);
    assertEquals(state.gitignore, null);
    assertEquals(state.globalKeniDirExists, false);
    assertEquals(state.globalLogsDirExists, false);
    assertEquals(state.globalConfigExists, false);
  });
});

Deno.test("inspectProjectState — partial state reports each piece accurately", async () => {
  await withTempDirs(async (root, home) => {
    const projectPaths = resolveProjectPaths(root);
    const globalPaths = resolveGlobalPaths(home);
    // Pre-populate: .keni/, .keni/prs/ + .gitkeep, project.yaml (valid), .gitignore, ~/.keni/
    await Deno.mkdir(projectPaths.prs, { recursive: true });
    await Deno.writeTextFile(join(projectPaths.prs, ".gitkeep"), "");
    const sample: ProjectConfig = {
      project_id: "proj-x",
      name: "test",
      agents: [{ id: "alice", role: "engineer" }],
    };
    const store = new FileConfigStore(projectPaths, globalPaths);
    await store.writeProjectConfig(sample);
    await Deno.writeTextFile(join(root, ".gitignore"), "node_modules/\n");
    await Deno.mkdir(globalPaths.keni, { recursive: true });

    const state = await inspectProjectState(
      projectPaths,
      globalPaths,
      store,
      fakeGitClient({ isRepo: true }),
    );
    assertEquals(state.isGitRepo, true);
    assertEquals(state.keniDirExists, true);
    assertEquals(state.prsDirExists, true);
    assertEquals(state.prsGitkeepExists, true);
    assertEquals(state.ticketsDirExists, false, "tickets dir was not created");
    assertEquals(state.ticketsGitkeepExists, false);
    assertEquals(state.activityDirExists, false, "activity dir was not created");
    assertEquals(state.activityGitkeepExists, false);
    assertEquals(state.projectConfig?.project_id, "proj-x");
    assertEquals(state.gitignore, "node_modules/\n");
    assertEquals(state.globalKeniDirExists, true);
    assertEquals(state.globalLogsDirExists, false);
    assertEquals(state.globalConfigExists, false);
  });
});

Deno.test("inspectProjectState — directory exists without .gitkeep is detected", async () => {
  await withTempDirs(async (root, home) => {
    const projectPaths = resolveProjectPaths(root);
    const globalPaths = resolveGlobalPaths(home);
    // Pre-populate the dir but NOT the .gitkeep
    await Deno.mkdir(projectPaths.tickets, { recursive: true });
    const store = new FileConfigStore(projectPaths, globalPaths);
    const state = await inspectProjectState(
      projectPaths,
      globalPaths,
      store,
      fakeGitClient({ isRepo: false }),
    );
    assertEquals(state.ticketsDirExists, true);
    assertEquals(state.ticketsGitkeepExists, false);
  });
});

Deno.test("inspectProjectState — malformed project.yaml throws ProjectStateError", async () => {
  await withTempDirs(async (root, home) => {
    const projectPaths = resolveProjectPaths(root);
    const globalPaths = resolveGlobalPaths(home);
    // Write a malformed YAML directly bypassing the store.
    await Deno.mkdir(projectPaths.keni, { recursive: true });
    await Deno.writeTextFile(projectPaths.projectConfig, "name: 'unclosed\n");
    const store = new FileConfigStore(projectPaths, globalPaths);
    const err = await assertRejects(
      () =>
        inspectProjectState(
          projectPaths,
          globalPaths,
          store,
          fakeGitClient({ isRepo: false }),
        ),
      ProjectStateError,
    );
    assertEquals(err.reason, "malformed_project_yaml");
    assert(err.path === projectPaths.projectConfig);
  });
});
