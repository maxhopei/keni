import { assert, assertEquals } from "@std/assert";
import { resolveGlobalPaths, resolveProjectPaths } from "@keni/shared";
import type { ProjectConfig } from "@keni/shared";
import { KENI_REQUIRED_GITIGNORE_ENTRIES, mergeGitignore } from "../../../src/init/gitignore.ts";
import { defaultInitialProjectConfig, type InitAction, planInit } from "../../../src/init/plan.ts";
import type { ProjectState } from "../../../src/init/state.ts";

function fullyInitialisedGitignore(): string {
  return mergeGitignore(null).contents;
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  const projectPaths = resolveProjectPaths("/tmp/proj");
  const globalPaths = resolveGlobalPaths("/tmp/home");
  const baseConfig: ProjectConfig = {
    project_id: "existing-id",
    name: "proj",
    agents: [{ id: "alice", role: "engineer" }],
    schedules: { alice: "*/1 * * * *" },
  };
  const fullyInitialised: ProjectState = {
    projectPaths,
    globalPaths,
    isGitRepo: true,
    keniDirExists: true,
    ticketsDirExists: true,
    ticketsGitkeepExists: true,
    prsDirExists: true,
    prsGitkeepExists: true,
    activityDirExists: true,
    activityGitkeepExists: true,
    projectConfig: baseConfig,
    stateJsonExists: true,
    gitignore: fullyInitialisedGitignore(),
    globalKeniDirExists: true,
    globalLogsDirExists: true,
    globalConfigExists: true,
  };
  return { ...fullyInitialised, ...overrides };
}

const FRESH_INPUTS = {
  freshProjectId: "11111111-1111-4111-8111-111111111111",
  projectName: "proj",
};

Deno.test("planInit — empty directory emits the full action list with one git commit", () => {
  const state = makeState({
    isGitRepo: false,
    keniDirExists: false,
    ticketsDirExists: false,
    ticketsGitkeepExists: false,
    prsDirExists: false,
    prsGitkeepExists: false,
    activityDirExists: false,
    activityGitkeepExists: false,
    projectConfig: null,
    stateJsonExists: false,
    gitignore: null,
    globalKeniDirExists: false,
    globalLogsDirExists: false,
    globalConfigExists: false,
  });
  const actions = planInit(state, FRESH_INPUTS);
  const kinds = actions.map((a) => a.kind);
  assertEquals(kinds, [
    "git_init",
    "create_keni_root",
    "create_keni_subdir",
    "create_keni_subdir",
    "create_keni_subdir",
    "write_project_config",
    "write_state_json",
    "ensure_global_dir",
    "write_global_config_stub",
    "merge_gitignore",
    "git_commit",
  ]);
  // Commit message uses the fresh project id.
  const commit = actions.find((a) => a.kind === "git_commit") as Extract<
    InitAction,
    { kind: "git_commit" }
  >;
  assert(commit.message.includes(FRESH_INPUTS.freshProjectId));
  assert(commit.message.startsWith("Initialise Keni project"));
  assertEquals(commit.paths, [".keni", ".gitignore"]);
});

Deno.test("planInit — fully-initialised project emits an empty action list", () => {
  const state = makeState();
  assertEquals(planInit(state, FRESH_INPUTS), []);
});

Deno.test("planInit — existing git repo with no .keni/ does not emit git_init", () => {
  const state = makeState({
    keniDirExists: false,
    ticketsDirExists: false,
    ticketsGitkeepExists: false,
    prsDirExists: false,
    prsGitkeepExists: false,
    activityDirExists: false,
    activityGitkeepExists: false,
    projectConfig: null,
    stateJsonExists: false,
    gitignore: null,
  });
  const kinds = planInit(state, FRESH_INPUTS).map((a) => a.kind);
  assert(!kinds.includes("git_init"));
  assert(kinds.includes("create_keni_root"));
});

Deno.test("planInit — partial state (only tickets/ missing) emits one create_keni_subdir + one commit", () => {
  const state = makeState({
    ticketsDirExists: false,
    ticketsGitkeepExists: false,
  });
  const actions = planInit(state, FRESH_INPUTS);
  const kinds = actions.map((a) => a.kind);
  assertEquals(kinds, ["create_keni_subdir", "git_commit"]);
  const subdir = actions[0] as Extract<InitAction, { kind: "create_keni_subdir" }>;
  assertEquals(subdir.subdir, "tickets");
  // Commit references the existing project id (not the fresh one).
  const commit = actions[1] as Extract<InitAction, { kind: "git_commit" }>;
  assert(commit.message.includes("existing-id"));
  assert(commit.message.startsWith("Update Keni project metadata"));
});

Deno.test("planInit — directory exists but .gitkeep missing still re-emits create_keni_subdir", () => {
  const state = makeState({
    ticketsDirExists: true,
    ticketsGitkeepExists: false,
  });
  const kinds = planInit(state, FRESH_INPUTS).map((a) => a.kind);
  assertEquals(kinds, ["create_keni_subdir", "git_commit"]);
});

Deno.test("planInit — only state.json missing → no commit (state.json is git-ignored)", () => {
  const state = makeState({ stateJsonExists: false });
  const actions = planInit(state, FRESH_INPUTS);
  assertEquals(actions.length, 1);
  assertEquals(actions[0]?.kind, "write_state_json");
});

Deno.test("planInit — global config missing but project complete → only global actions, no commit", () => {
  const state = makeState({
    globalConfigExists: false,
    globalLogsDirExists: false,
    globalKeniDirExists: false,
  });
  const kinds = planInit(state, FRESH_INPUTS).map((a) => a.kind);
  assertEquals(kinds, ["ensure_global_dir", "write_global_config_stub"]);
});

Deno.test("planInit — gitignore changed → emits merge_gitignore + commit", () => {
  const state = makeState({
    gitignore: "node_modules/\n",
  });
  const kinds = planInit(state, FRESH_INPUTS).map((a) => a.kind);
  assertEquals(kinds, ["merge_gitignore", "git_commit"]);
});

Deno.test("planInit — gitignore complete → no merge_gitignore", () => {
  const state = makeState({ gitignore: fullyInitialisedGitignore() });
  const actions = planInit(state, FRESH_INPUTS);
  assertEquals(actions, []);
});

Deno.test("planInit — emits each path target at most once across the action list", () => {
  const state = makeState({
    isGitRepo: false,
    keniDirExists: false,
    ticketsDirExists: false,
    ticketsGitkeepExists: false,
    prsDirExists: false,
    prsGitkeepExists: false,
    activityDirExists: false,
    activityGitkeepExists: false,
    projectConfig: null,
    stateJsonExists: false,
    gitignore: null,
    globalKeniDirExists: false,
    globalLogsDirExists: false,
    globalConfigExists: false,
  });
  const actions = planInit(state, FRESH_INPUTS);
  // Count subdir actions per subdir kind.
  const subdirCounts: Record<string, number> = {};
  for (const action of actions) {
    if (action.kind === "create_keni_subdir") {
      subdirCounts[action.subdir] = (subdirCounts[action.subdir] ?? 0) + 1;
    }
  }
  assertEquals(subdirCounts, { tickets: 1, prs: 1, activity: 1 });
  // No duplicate write_project_config or merge_gitignore.
  const kinds = actions.map((a) => a.kind);
  for (const k of ["write_project_config", "merge_gitignore", "git_init", "create_keni_root"]) {
    assertEquals(
      kinds.filter((x) => x === k).length,
      1,
      `${k} must appear exactly once for fresh init`,
    );
  }
});

Deno.test("defaultInitialProjectConfig — has the documented shape", () => {
  const config = defaultInitialProjectConfig(
    "00000000-0000-4000-8000-000000000000",
    "my-app",
  );
  assertEquals(config.project_id, "00000000-0000-4000-8000-000000000000");
  assertEquals(config.name, "my-app");
  assertEquals(config.agents, [{ id: "alice", role: "engineer" }]);
  assertEquals(config.schedules, { alice: "*/1 * * * *" });
  assert(config.stack === undefined, "stack must be unset by default");
});

// Sanity check on the gitignore constants used by the planner.
Deno.test("KENI_REQUIRED_GITIGNORE_ENTRIES — contains the spec-required entries", () => {
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
    assert(
      KENI_REQUIRED_GITIGNORE_ENTRIES.includes(required),
      `KENI_REQUIRED_GITIGNORE_ENTRIES must include ${required}`,
    );
  }
});
