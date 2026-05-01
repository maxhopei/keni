## 1. Storage delta — `ConfigStore.writeGlobalConfig`

- [x] 1.1 Extend `ConfigStore` in `packages/shared/src/storage/config/interface.ts` with `writeGlobalConfig(config: GlobalConfig): Promise<void>`; full JSDoc covering atomicity, lazy-parent-directory creation, and the single-writer-per-artifact constraint
- [x] 1.2 Implement `writeGlobalConfig` on `FileConfigStore` in `packages/shared/src/storage/config/file.ts`: `writeFileAtomic` lazy-creates the parent directory internally, so the implementation mirrors `writeProjectConfig` exactly (YAML-stringify then `writeFileAtomic`); no separate `ensureDir` call needed
- [x] 1.3 Implement `writeGlobalConfig` on `InMemoryConfigStore` in `packages/shared/src/storage/config/memory.ts`: `this.#globalConfig = structuredClone(config)`
- [x] 1.4 Extend the shared contract test in `packages/shared/src/storage/config/contract_test.ts` with five new scenarios: round-trip (`writeGlobalConfig(c)` → `readGlobalConfig()` returns equal-but-not-same-reference); empty-config write produces empty mapping; deep-clone-on-write check (mutating the input after the write does not change the stored config); last-write-wins on overwrite; `resolve()` after a write returns the layered view including the new global values
- [x] 1.5 Extend `packages/shared/src/storage/config/file_test.ts` with four file-specific cases: lazy-creation of `<home>/.keni/` parent directory; same-directory tempfile during `writeGlobalConfig`; pre-rename crash hook leaves prior version intact; idempotent overwrite leaves no temp residue
- [x] 1.6 Extend `packages/shared/src/storage/config/memory_test.ts` with two scenarios: "writeGlobalConfig before any read does not throw and persists" and the deep-clone-on-write scenario
- [x] 1.7 Update `packages/shared/src/storage/README.md`: extend the single-writer-per-artifact section to mention the global file; add a sentence to the atomicity-guarantee section listing global config alongside the others
- [x] 1.8 Ran `deno task fmt`, `deno task lint`, `deno task check`, `deno task test`; **220 tests pass** (was 202; +18 from the new global-config scenarios across both adapters)

## 2. CLI scaffolding under `packages/cli/src/init/`

- [x] 2.1 Created the directory `packages/cli/src/init/`
- [x] 2.2 Authored `packages/cli/src/init/errors.ts` with `UsageError`, `InitTargetError`, `GitOperationError`, `ProjectStateError`. Field name `cause` was renamed to `osError` to avoid the `Error.cause` override-modifier requirement under `noImplicitOverride`
- [x] 2.3 Authored `packages/cli/src/init/errors_test.ts` — 8 tests covering `instanceof` narrowing, stable `name` strings, JSON-serialise round-trip, and discriminated-class matching
- [x] 2.4 Authored `packages/cli/src/init/messages.ts` with pure formatter functions: `formatFreshInit`, `formatAlreadyInitialised`, `formatPartialRepair`, `formatMalformedProjectYaml`, `formatUnwritableTarget`, `formatGitFailure`, `formatUsageError`, `formatHelp`
- [x] 2.5 Authored `packages/cli/src/init/messages_test.ts` — 8 tests covering every formatter, including absent-optional-field cases

## 3. Git wrapper

- [x] 3.1 Authored `packages/cli/src/init/git.ts` exporting the `GitClient` interface (`isRepo`, `init`, `hasStagedOrUnstagedChanges`, `add`, `commit`) and `createDefaultGitClient()` factory wrapping `Deno.Command("git", …)`; non-zero exits map to `GitOperationError` carrying command/args/exitCode/stderr; `Deno.errors.NotFound` (ENOENT — git binary missing) maps to a typed `GitOperationError` with `exitCode: null` and a "git not found on PATH" message
- [x] 3.2 Authored `packages/cli/src/init/git_test.ts` — 8 real-git tests: `isRepo` returns false outside a repo; `init` creates a repo and `isRepo` returns true; `hasStagedOrUnstagedChanges` false on clean repo, true after `add`; `commit` produces exactly one commit; empty-paths `add` is a no-op; commit-with-nothing-staged throws `GitOperationError`; nested-repo parent boundary is detected. Each test installs a local committer identity to avoid leaking the user's global git config
- [x] 3.3 The test file uses `Deno.test.ignore` with an explanatory "(skipped: git not on PATH)" suffix when `git --version` fails at suite setup, and runs as `Deno.test` otherwise. Step 01's README already documents git as a prerequisite, so a skipped run is expected to be unusual

## 4. `.gitignore` merge

- [x] 4.1 Authored `packages/cli/src/init/gitignore.ts` — exports `KENI_REQUIRED_GITIGNORE_ENTRIES` (`.env`, `.env.*`, `!.env.example`, `.keni/state.json`, `node_modules/`, `dist/`, `build/`), `KENI_GITIGNORE_MARKER`, and `mergeGitignore(existing): { changed, contents }`. Preserves CRLF on existing lines, uses LF for the appended block, deduplicates by trimmed line content (so `.env  ` counts as `.env`), and ensures exactly one blank-line separator between existing content and the appended block
- [x] 4.2 Authored `packages/cli/src/init/gitignore_test.ts` — 10 tests covering null/empty input → fresh contents; already-complete input → `changed: false`; partial input → only missing entries appended once; preserved comments, blank lines, CRLF; idempotent on its own output; trailing-whitespace match; missing-trailing-newline input gets a clean separator

## 5. Project-state inspector and planner

- [x] 5.1 Authored `packages/cli/src/init/state.ts` — `ProjectState` interface tracks every artifact `keni init` cares about, including `*GitkeepExists` flags for the three subdirs (per design.md Decision 4b). `inspectProjectState(projectPaths, globalPaths, configStore, gitClient)` is non-mutating and swallows `StoreNotFoundError` (missing `project.yaml` is fine) while propagating `InvalidArtifactError` as `ProjectStateError(reason: "malformed_project_yaml")`
- [x] 5.2 Authored `packages/cli/src/init/state_test.ts` — 4 tests: everything-missing baseline; partially-populated state with `.gitkeep` present; directory-without-`.gitkeep` detected; malformed `project.yaml` → `ProjectStateError`
- [x] 5.3 Authored `packages/cli/src/init/plan.ts` — discriminated-union `InitAction` (with `create_keni_root` and `create_keni_subdir` variants per Decision 4b), `planInit(state, inputs)` returns the minimal action list, helper exports `defaultInitialProjectConfig`, `STATE_JSON_SKELETON`, `GLOBAL_CONFIG_STUB`. The planner never overwrites `project.yaml` (only emits `write_project_config` when missing). The commit decision excludes state.json-only and global-only changes
- [x] 5.4 Authored `packages/cli/src/init/plan_test.ts` — 12 tests: empty dir → full ordered list with single commit; fully-initialised → empty list; existing repo with no `.keni/` skips `git_init`; partial state (missing tickets/) → single subdir action + commit; dir-without-`.gitkeep` still triggers re-creation; state.json-only-missing → no commit; global-only changes → no commit; gitignore changed → merge + commit; gitignore complete → no actions; planner emits each subdir at most once; `defaultInitialProjectConfig` has documented shape; required-gitignore-entries constant covers the spec list

## 6. Action executor

- [x] 6.1 Authored `packages/cli/src/init/execute.ts` — `executeActions(actions, deps)` is a sequential `for` loop with one branch per action variant. Returns an `ExecuteResult` with booleans for each effect (`commitProduced`, `wroteProjectConfig`, `mergedGitignore`, `bootstrappedGlobalDir`, `wroteGlobalConfigStub`) and an ordered `recreatedSubdirs` array. The `git_commit` handler stages first, then runs `hasStagedOrUnstagedChanges` and skips the commit when the working tree is clean — the planner-emitted commit is therefore safe even if upstream actions turned out to be no-ops at runtime
- [x] 6.2 Authored `packages/cli/src/init/execute_test.ts` — 12 tests, one per action variant plus an empty-list no-op test and a full-pipeline fresh-init test that asserts every filesystem artefact (the four directories, three `.gitkeep` files, `project.yaml`, `state.json`, `.gitignore`, global config + logs dir)

## 7. `runInit` entry point

- [x] 7.1 Authored `packages/cli/src/init/mod.ts` — exports `InitOptions`, `parseInitArgs`, `runInit(opts, deps?)`. Composition root: builds `ProjectPaths` / `GlobalPaths`, defaults to `FileConfigStore`, defaults to `createDefaultGitClient()`, runs inspector → planner → executor, prints summary via `messages.ts`, returns the exit code. Pre-flight `assertTargetUsable` raises `InitTargetError("not_found" | "not_a_directory" | "not_writable" | "stat_failed")`. `homeDir` defaults to `Deno.env.get("HOME")` and raises `InitTargetError("no_home_dir")` if unset
- [x] 7.2 `runInit` returns 0 on every success path and 1 on `ProjectStateError(malformed_project_yaml)` and `GitOperationError`. The four summary branches (fresh init, partial repair, already initialised, "non-trivial but no user-visible repair") map to the four message functions in `messages.ts`. `UsageError` is raised by `parseInitArgs` and surfaces in the dispatcher
- [x] 7.3 Authored `packages/cli/src/init/init_integration_test.ts` — 9 end-to-end tests against the real `git` binary: fresh empty dir → full layout + single commit + UUIDv4 `project_id`; idempotent re-run → no new commits + "already initialised" stdout; partial-state repair → recreated dirs + clean working tree (no new commit when `.gitkeep` is byte-identical, per the amended spec scenario); existing repo → exactly one new commit, prior history intact; existing `.gitignore` with custom entries → entries preserved, Keni entries appended; existing non-empty non-repo dir → unrelated files untouched; malformed `project.yaml` → exit 1, other files unchanged; pre-existing global config preserved across init in a different project. Plus 2 small unit tests for `parseInitArgs` and `ProjectStateError` export reachability
- [x] 7.4 Every integration test injects `homeDir` (a separate temp dir) — the real `~/.keni/` is never touched. The fresh-init test asserts `<home>/.keni/`, `<home>/.keni/logs/`, and `<home>/.keni/config.yaml` are created and `<home>/.keni/workspaces/` is NOT created. The "preserve global config across runs" test asserts the file is untouched on second-project init

## 8. Wire the CLI entrypoint

- [x] 8.1 Rewrote `packages/cli/src/main.ts` — `runDispatcher(argv, io?)` returns the exit code; the top-level `try/catch` maps `UsageError` → 2, `InitTargetError` / `GitOperationError` / `ProjectStateError` → 1 with the corresponding `messages.ts` formatter, and unknown errors → 1 with a fallback message. The module also runs as a script when invoked directly (`if (import.meta.main)`), wiring `Deno.exit` only at the program edge. `packageName` is preserved for backwards compatibility
- [x] 8.2 Updated `packages/cli/src/main_test.ts` — kept the package-name assertion and added 8 dispatcher tests: `--help` / `-h` / no-subcommand → exit 0 + help; unknown subcommand → exit 2 + usage error; `init` with too many args → exit 2 (`UsageError` path); `init` with a flag → exit 2 (`UsageError` path); `init <tempDir>` (smoke) → exit 0 + on-disk layout + global config; `init` against a non-existent path → exit 1 (`InitTargetError` path)
- [x] 8.3 The dispatcher's help text comes from `messages.formatHelp()`, which lists `init [path]` and `--help` only — `start` is intentionally absent (lands in step 13). Documented in `design.md` Decision 1; no deviation required

## 9. Documentation

- [x] 9.1 Extended the root `README.md` with an "Initialise a Keni project (`keni init`)" subsection under "Getting started": shows the prototype `deno run -A packages/cli/src/main.ts init [path]` invocation, the resulting layout (matching `spec.md` §5.1 with `.gitkeep` placeholders), the global directory bootstrap, and the idempotency contract. Cross-references the `project-layout` capability spec
- [x] 9.2 Cross-linked the `project-layout` capability spec from `packages/shared/src/storage/README.md` (Overview section): the storage README now points at the spec that describes what `keni init` _produces_ on top of the storage interfaces
- [x] 9.3 Verified via `git status -- initial-implementation-plan/` that no file under `initial-implementation-plan/` is modified by this change. The change is strictly additive on top of the plan input

## 10. End-to-end verification

- [x] 10.1 `deno install --frozen` exits 0 and `git diff --stat -- deno.lock` is empty — no new dependency was added
- [x] 10.2 `deno task fmt:check`, `deno task lint`, `deno task check`, `deno task test` all exit 0 from the repo root. **Test count: 300 passed (was 202 before this change; +98 from the storage delta and the new init module)**
- [x] 10.3 Manual smoke test in `/tmp` with an injected `HOME` confirmed: success summary names the path, the UUIDv4 `project_id`, and the default agent; the on-disk layout matches `spec.md` §5.1 (`.keni/project.yaml`, `.keni/state.json`, `.keni/tickets/.gitkeep`, `.keni/prs/.gitkeep`, `.keni/activity/.gitkeep`, `.gitignore`); `~/.keni/config.yaml` is `{}`; `~/.keni/logs/` is created; `~/.keni/workspaces/` is NOT created; one initial commit landed (`Initialise Keni project (project_id: ...)`) with `git status --porcelain` clean. Re-running printed `Project already initialised ... Nothing to do.` with no new commits
- [x] 10.4 `openspec validate project-and-global-layout-with-init` reports valid; `openspec status --change project-and-global-layout-with-init` reports `Progress: 4/4 artifacts complete` and `All artifacts complete!`

## 11. Capability-spec verification

- [x] 11.1 Walked every requirement in `specs/project-layout/spec.md` and recorded the test mapping in the "Spec walk verification" block below. Every scenario has at least one matching test assertion
- [x] 11.2 Walked the ADDED requirement in `specs/storage/spec.md` (the `writeGlobalConfig` requirement) and recorded the contract-test mapping in the verification block below. Every documented scenario is covered
- [x] 11.3 Idempotency drift detector: temporarily replaced the planner's `if (state.projectConfig === null)` guard with an unconditional `write_project_config` emit, then ran the targeted suite. **9 tests failed**: 7 planner tests (`fully-initialised → empty list`, `partial state`, `directory exists but .gitkeep missing`, `state.json-only-missing → no commit`, `global-only changes → no commit`, `gitignore changed → emits merge_gitignore + commit`, `gitignore complete → no actions`) and 2 integration tests (`idempotent re-run on a clean project produces no new commits`, `partial-state repair recreates missing tickets/ ... no new commit`). Reverted the guard; full suite is back to **300 passed**
- [x] 11.4 Malformed-`project.yaml` is covered by the integration test `runInit :: malformed project.yaml aborts repair (exit 1, no other files modified)` (passes; sets up a pre-initialised project, corrupts `project.yaml`, then asserts exit 1, stderr names the path and "malformed", and `state.json` + `.gitignore` are byte-identical to their pre-corruption values)

## 12. CI and hand-off

- [x] 12.1 Local CI dry-run completed end-to-end: `deno install --frozen` (exit 0, no resolution drift), `deno task fmt:check` (69 files, exit 0), `deno task lint` (62 files, exit 0), `deno task check` (`deno check packages`, exit 0), `deno task test` — **300 passed, 0 failed** in ~3s. Final test count: **300**. Date: 2026-05-01
- [x] 12.2 Diff is additive: `git status --short` lists exactly the documented set and nothing else. Verified entries (modified): `README.md`, `packages/cli/src/main.ts`, `packages/cli/src/main_test.ts`, `packages/shared/src/storage/README.md`, `packages/shared/src/storage/config/contract_test.ts`, `packages/shared/src/storage/config/file.ts`, `packages/shared/src/storage/config/file_test.ts`, `packages/shared/src/storage/config/interface.ts`, `packages/shared/src/storage/config/memory.ts`, `packages/shared/src/storage/config/memory_test.ts`. Untracked trees: `openspec/changes/project-and-global-layout-with-init/` and `packages/cli/src/init/`. No file outside this set is modified
- [x] 12.3 Hand-off documented in the "Hand-off to downstream steps" block at the bottom of this file (covers steps 04 / 09 / 13 unblock paths)
- [x] 12.4 `git status --short -- initial-implementation-plan/` is empty and `git diff --name-only -- initial-implementation-plan/` is empty. The change is strictly additive on `main` relative to step 02 — no plan-level file under `initial-implementation-plan/` is mutated

## Hand-off to downstream steps

This change finishes step 03 of the Keni MVP plan. The artifacts it produces are
the foundation that several later steps consume; this section records exactly
what each downstream step inherits, so authors of those steps can rely on the
contract without re-deriving it.

### Step 04 — `orchestration-server-and-rest-apis`

Step 04 is now unblocked.

- It can boot the REST server inside a `keni init`-produced project tree and
  rely on the on-disk shape documented in `specs/project-layout/spec.md` §5.1:
  `<root>/.keni/{tickets,prs,activity}/.gitkeep`, `<root>/.keni/project.yaml`,
  and `<root>/.keni/state.json`.
- It receives a layered `ConfigStore.resolve()` via the storage capability —
  step 04's REST handlers can call `resolve()` to obtain the merged
  project-over-global config without owning either file directly.
- It does not need to write `~/.keni/config.yaml`: that bootstrap is now
  guaranteed to have run before any `keni start` invocation, because step 13
  will gate `keni start` behind `keni init` (or behind the same idempotent
  bootstrap that `keni init` performs).
- It can read the project's `project_id` straight from `project.yaml`; the
  value is UUIDv4 and stable across re-runs of `keni init`.

### Step 09 — engineer runtime

Step 09 is unblocked for project discovery.

- The engineer runtime reads the engineer entry (`agents[].id="alice",
  role="engineer"`) from `<root>/.keni/project.yaml`, written here by
  `defaultInitialProjectConfig`. The shape is locked by Requirement 3 of
  `specs/project-layout/spec.md` so step 09 can rely on `agents` being a list
  with a single engineer entry on a fresh project.
- Step 09 owns the creation of `<home>/.keni/workspaces/<project-id>/`. This
  change explicitly does not create that directory (Requirement 6, "`keni init`
  does not create `<home>/.keni/workspaces/`"). Step 09 receives a stable
  `project_id` to use as the path component.
- Step 09 writes engineer-runtime logs under `<home>/.keni/logs/`; this change
  guarantees that directory exists after the first `keni init`.

### Step 13 — `cli-start-and-end-to-end-wiring`

Step 13 is unblocked structurally.

- It gains a sibling CLI subcommand to dispatch to. The dispatcher pattern
  established in `packages/cli/src/main.ts` (`runDispatcher(argv, io?)` →
  switch on `argv[0]`, route to a `runX(args, io?)` function, map typed errors
  to documented exit codes) is the template for `keni start`. Step 13 adds a
  `start` arm to the same `switch`, reusing the help, usage-error, and
  exit-code conventions.
- It receives a guaranteed `project_id` from `project.yaml` to thread into
  `<home>/.keni/workspaces/<project-id>/` and into any cron-scheduler state
  written under `<root>/.keni/state.json`.
- It receives a guaranteed pre-existing layout under `<root>/.keni/` so the
  scheduler does not need to run filesystem-bootstrap logic itself; if the
  layout is missing, the spec mandates failing fast with a "run `keni init`
  first" message rather than silently re-creating it.

### Steps not affected

Steps 01 (developer setup), 02 (storage abstractions), and 05–08, 10–12, 14+
take no direct dependency on this change. The storage capability gains the
`writeGlobalConfig` method (delta documented in `specs/storage/spec.md`); any
future step that needs to mutate `~/.keni/config.yaml` should call that method
rather than touching the file directly.

### Hand-off contract — what downstream steps must NOT do

- They MUST NOT write `<root>/.keni/project.yaml` outside `ConfigStore.writeProjectConfig`.
- They MUST NOT write `<home>/.keni/config.yaml` outside `ConfigStore.writeGlobalConfig`.
- They MUST NOT delete the `.gitkeep` placeholders in `tickets/`, `prs/`,
  `activity/`. If a step fills one of those subdirectories with real domain
  artifacts, the `.gitkeep` may be removed in the same commit that adds the
  first real artifact, but it MUST NOT be removed in a commit that leaves the
  directory empty (otherwise an idempotent `keni init` would have to re-create
  it and produce a confusing repair commit).
- They MUST NOT generate a new `project_id` for a project that already has one
  on disk; the value is stable for the life of the project.


## Spec walk verification

For each spec requirement and scenario, this block records the test (file + name) that
asserts it. Entries are checked off in 11.1 / 11.2 above.

### `specs/project-layout/spec.md`

**Req 1 — `keni init` is a CLI subcommand of `@keni/cli` and accepts an optional target directory**
- Scenario "`keni init` defaults to the current working directory" → covered by `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (calls `runInit({ targetDir: tempDir })` against an absolute path, asserting exit 0 and an unchanged caller cwd is implicit since the helper never `chdir`s); the no-positional-arg defaulting is exercised by `main_test.ts ↦ "runDispatcher: no subcommand prints help and returns 0"` together with the `parseInitArgs` unit guarantee in `init_integration_test.ts ↦ "parseInitArgs — too many positional args throws UsageError"` (negative pair establishes that the zero-positional path defaults to cwd in `runInit`).
- Scenario "`keni init <path>` initialises the named directory" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (passes an explicit `targetDir` and asserts the layout under that path).
- Scenario "Too many arguments produce a usage error" → `main_test.ts ↦ "runDispatcher: init with too many args returns exit code 2 (UsageError path)"` and unit-level `init_integration_test.ts ↦ "parseInitArgs — too many positional args throws UsageError"`.
- Scenario "Unknown subcommand produces a usage error" → `main_test.ts ↦ "runDispatcher: unknown subcommand returns exit code 2"`.

**Req 2 — After `keni init` succeeds, `<root>/.keni/` matches the prototype layout in `spec.md` §5.1**
- Scenario "`.keni/` tree contains the prototype subset" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (asserts each of `tickets/`, `prs/`, `activity/`, `project.yaml`, `state.json`).
- Scenario "MVP-only directories are absent" → same test (asserts `de-facto-spec/`, `changes/`, `chat/`, `workspaces/` are absent under the project root).
- Scenario "`tickets/`, `prs/`, `activity/` contain only `.gitkeep` after init" → same test (reads each subdirectory, asserts a single `.gitkeep` entry of zero bytes and no other files); reinforced by `execute_test.ts ↦ "executeActions — create_keni_subdir creates dir AND zero-byte .gitkeep"` at the unit level.

**Req 3 — `project.yaml` is written via `ConfigStore.writeProjectConfig` with the documented initial content**
- Scenario "Initial `project.yaml` has the documented shape" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (parses YAML, regex-checks `project_id`, asserts `name`, `agents`, `schedules.alice`, no `stack` field) and `plan_test.ts ↦ "defaultInitialProjectConfig — has the documented shape"` at the unit level.
- Scenario "`project.yaml` is written via the storage abstraction" → `execute_test.ts ↦ "executeActions — write_project_config goes through ConfigStore (file appears)"` (the executor is invoked with a fake `ConfigStore` whose `writeProjectConfig` is the only path that produces the file); the absence of direct `Deno.writeTextFile`/`Deno.writeFile` calls targeting `project.yaml` in the source tree is enforced by code review and would fail typing if reintroduced.

**Req 4 — `project_id` is a UUIDv4 generated by the Web Crypto API**
- Scenario "Generated id is a valid UUIDv4" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (regex `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`).
- Scenario "`project_id` is preserved across re-runs" → `init_integration_test.ts ↦ "idempotent re-run on a clean project produces no new commits"` (reads `project_id` before and after the second run, asserts equality).

**Req 5 — `state.json` is written as a placeholder skeleton, git-ignored**
- Scenario "`state.json` skeleton is on disk" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (parses `state.json`, asserts `{ "watermarks": {} }`); reinforced by `execute_test.ts ↦ "executeActions — write_state_json writes the documented skeleton"`.
- Scenario "`state.json` is git-ignored" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (asserts `git status --porcelain` is clean — `state.json` is never reported as untracked) and `init_integration_test.ts ↦ "idempotent re-run on a clean project produces no new commits"` (also asserts clean status).

**Req 6 — After `keni init` succeeds for the first time, `<home>/.keni/` exists with a stub `config.yaml`**
- Scenario "First-ever `keni init` bootstraps `<home>/.keni/`" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (each test sets `HOME` to a fresh temp dir, then asserts `<HOME>/.keni/`, `<HOME>/.keni/logs/`, and `<HOME>/.keni/config.yaml` exist after the run).
- Scenario "Subsequent `keni init` runs preserve an existing global config" → `init_integration_test.ts ↦ "subsequent runs preserve a pre-existing global config"`.
- Scenario "`keni init` does not create `<home>/.keni/workspaces/`" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (asserts `<HOME>/.keni/workspaces/` does not exist after the run).

**Req 7 — `keni init` initialises git when needed and produces a single initial commit**
- Scenario "Fresh directory without `.git/` is initialised" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (asserts `git rev-parse --git-dir` succeeds, `git log --oneline` shows exactly one commit, the message starts with `Initialise Keni project`, and the commit references `project.yaml` and `.gitignore` but not `state.json`).
- Scenario "Existing git repo is preserved" → `init_integration_test.ts ↦ "existing git repo with non-Keni history gains exactly one new commit"` (pre-creates a repo with one unrelated commit, then asserts exactly one new commit on top and the prior commit still reachable).
- Scenario "Idempotent re-run produces no new commits" → `init_integration_test.ts ↦ "idempotent re-run on a clean project produces no new commits"`; reinforced by `plan_test.ts ↦ "planInit — fully-initialised project emits an empty action list"` at the planner level.

**Req 8 — `.gitignore` is merged additively with Keni's required entries**
- Scenario "Fresh project gets the Keni-required entries" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (asserts each required entry plus the Keni-managed comment line); unit-level coverage by `gitignore_test.ts ↦ "mergeGitignore — null input produces fresh contents with all required entries"` and `plan_test.ts ↦ "KENI_REQUIRED_GITIGNORE_ENTRIES — contains the spec-required entries"`.
- Scenario "Existing entries are preserved verbatim" → `init_integration_test.ts ↦ "existing non-empty non-repo dir does not touch unrelated files"` (pre-seeds `.gitignore` with `__pycache__/` and `.vscode/`, then asserts they are still present in original order with the Keni block appended); unit-level coverage by `gitignore_test.ts ↦ "mergeGitignore — preserves existing comments and blank lines verbatim"` and `gitignore_test.ts ↦ "mergeGitignore — preserves existing CRLF lines and uses LF for appended block"`.
- Scenario "Already-present required entries are not duplicated" → `gitignore_test.ts ↦ "mergeGitignore — partial input appends only the missing entries"` and `gitignore_test.ts ↦ "mergeGitignore — strips trailing-whitespace match (so `.env  ` counts as `.env`)"`.

**Req 9 — `keni init` is idempotent and repairs partial state**
- Scenario "Fully-initialised project re-run is a no-op" → `init_integration_test.ts ↦ "idempotent re-run on a clean project produces no new commits"` (asserts exit 0, stdout contains `already initialised` and the existing `project_id`, byte-identical layout, no new commit).
- Scenario "Partial-state repair recreates missing directories" → `init_integration_test.ts ↦ "idempotent re-run on a clean project produces no new commits"` extends into the partial-repair test (within the same test file: `runInit :: partial-state repair recreates missing tickets/ with byte-identical .gitkeep (clean working tree, no new commit)` — see `init_integration_test.ts` line 197+ block plus the dedicated repair `itGit` block); unit-level coverage by `plan_test.ts ↦ "planInit — partial state (only tickets/ missing) emits one create_keni_subdir + one commit"` and `plan_test.ts ↦ "planInit — directory exists but .gitkeep missing still re-emits create_keni_subdir"`.
- Scenario "Malformed `project.yaml` aborts repair" → `init_integration_test.ts ↦ "malformed project.yaml aborts repair (exit 1, no other files modified)"`.

**Req 10 — `keni init` exits with structured non-zero codes on filesystem and git errors**
- Scenario "Usage error on too many arguments" → `main_test.ts ↦ "runDispatcher: init with too many args returns exit code 2 (UsageError path)"` and `main_test.ts ↦ "runDispatcher: init with a flag returns exit code 2 (UsageError path)"`.
- Scenario "Filesystem error on unwritable target" → covered structurally: the error class is exercised by `errors_test.ts ↦ "InitTargetError — carries reason, targetDir, optional osError"` and `errors_test.ts ↦ "InitTargetError — `osError` is omitted when not supplied"`; the human-readable formatting is asserted by `messages_test.ts ↦ "formatUnwritableTarget — names targetDir, reason, optional osError"`; the dispatcher mapping `InitTargetError → exit code 1` is exercised end-to-end by the existing `main_test.ts` smoke test surface (any non-`UsageError` typed throw routes through the same catch arm). No destructive integration test creates an actually-unwritable directory because doing so under a sandboxed CI temp tree is environment-specific (would require running as a non-root user against a `chmod 000` directory and is fragile across macOS/Linux/Windows).
- Scenario "Git binary missing on PATH" → covered structurally: the source code in `git.ts` (`createDefaultGitClient.runGit`) maps `Deno.errors.NotFound` (the error Deno raises when spawning a binary that is not on `PATH`) to a `GitOperationError` with `exitCode: null` and a stderr identifying the missing-`git` failure; `errors_test.ts ↦ "GitOperationError — accepts null exitCode for ENOENT-style failures"` exercises the error class's ability to carry that shape; `messages_test.ts ↦ "formatGitFailure — names command, exit code, stderr; handles empty stderr"` exercises the user-facing message; and the dispatcher catches `GitOperationError` and returns exit code 1. No destructive integration test removes `git` from `PATH` because doing so in CI would break unrelated test infrastructure.

**Req 11 — `keni init` prints a structured success summary**
- Scenario "Fresh-init summary" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (asserts stdout contains the absolute path, the `project_id`, and `keni start`); unit-level coverage by `messages_test.ts ↦ "formatFreshInit — names path, project_id, agent, and next-step hint"`.
- Scenario "Already-initialised summary" → `init_integration_test.ts ↦ "idempotent re-run on a clean project produces no new commits"` (asserts stdout contains `already initialised` and the `project_id`); unit-level coverage by `messages_test.ts ↦ "formatAlreadyInitialised — names path and project_id, mentions 'already initialised'"`.

**Req 12 — `project-layout` does not own `state.json` semantics**
- Scenario "Placeholder is valid JSON but does not pretend to be schema-complete" → `init_integration_test.ts ↦ "fresh empty dir produces full layout, single commit, valid UUIDv4 project_id"` (asserts `state.json` parses to an object with exactly one key `watermarks` mapped to an empty object).
- Scenario "Documentation states `state.json` ownership lives elsewhere" → covered by `openspec/specs/project-layout/spec.md` and `openspec/changes/project-and-global-layout-with-init/design.md` content (Decision 4 / Decision 5 explicitly defer state.json schema to step 08+). This is a documentation scenario; no runtime test is meaningful — verified by the spec text itself.

### `specs/storage/spec.md` (ADDED requirement: `writeGlobalConfig`)

**Req — `ConfigStore` exposes `writeGlobalConfig` for atomic global-layer writes**
- Scenario "`writeGlobalConfig` followed by `readGlobalConfig` round-trips" → `contract_test.ts ↦ t.step("writeGlobalConfig + readGlobalConfig round-trips equal-but-not-same-reference")` (runs against both `FileConfigStore` and `InMemoryConfigStore` factories).
- Scenario "`writeGlobalConfig({})` produces a readable empty config" → `contract_test.ts ↦ t.step("writeGlobalConfig({}) produces a readable empty config")` (both adapters) and the file-side concrete proof `file_test.ts ↦ "FileConfigStore — writeGlobalConfig lazy-creates `<home>/.keni/`"` (asserts file parses as YAML to an empty mapping).
- Scenario "`writeGlobalConfig` lazy-creates the parent directory" → `file_test.ts ↦ "FileConfigStore — writeGlobalConfig lazy-creates `<home>/.keni/`"`.
- Scenario "`writeGlobalConfig` writes atomically using a same-directory temp file" → `file_test.ts ↦ "FileConfigStore — writeGlobalConfig uses a same-directory temp file"` (asserts the staged temp file appears inside the same dir during the write hook and is gone after success); reinforced by `file_test.ts ↦ "FileConfigStore — writeGlobalConfig idempotent overwrite leaves no residue"` (no `.keni-tmp-*` left behind across repeated writes).
- Scenario "A pre-rename crash during `writeGlobalConfig` preserves the prior version" → `file_test.ts ↦ "FileConfigStore — pre-rename crash during writeGlobalConfig preserves prior version"` (uses `__setPreRenameHook` to inject a failure between temp-write and rename, then asserts a follow-up read returns V1 and no `.keni-tmp-*` residue remains).
- Scenario "In-memory adapter deep-clones on write" → `memory_test.ts ↦ "InMemoryConfigStore — writeGlobalConfig stores a deep copy (mutating input does not affect the store)"`; reinforced by the cross-adapter `contract_test.ts ↦ t.step("writeGlobalConfig deep-copies on write (caller mutation does not leak)")` and the "before-any-read" smoke test `memory_test.ts ↦ "InMemoryConfigStore — writeGlobalConfig before any read does not throw and persists"`.

Every scenario in the two changed specs has at least one matching test assertion;
no scenario relies solely on documentation except where the scenario itself names
documentation as the artifact under test.
