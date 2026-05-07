# developer-setup Specification

## Purpose

Defines the baseline contract for contributor onboarding and repository hygiene: a fresh clone of the Keni repository, on a machine with the documented Deno version installed, must reach a green build in one `deno install` plus the workspace-level tasks (`lint`, `fmt`, `check`, `test`, `build`). This specification covers the unified command surface, reproducible dependency installation, continuous integration enforcement, the five-package monorepo layout, repository hygiene files, the README onboarding path, and the prompts-as-code convention. Any change to Keni that would alter this contract must land as a delta spec against this capability.
## Requirements
### Requirement: Fresh clone produces a green build

After cloning the repository on a machine with the documented Deno version installed, a contributor SHALL be able to run `deno install` followed by the workspace-level tasks `deno task lint`, `deno task check`, `deno task test`, and `deno task build` in any order, and every command SHALL exit with status `0`.

#### Scenario: First-time clone on a fresh machine

- **WHEN** a contributor clones `git@github.com:maxhopei/keni.git` and, from the repo root, runs `deno install` exactly once
- **AND** then runs `deno task lint`
- **AND** then runs `deno task check`
- **AND** then runs `deno task test`
- **AND** then runs `deno task build`
- **THEN** every command completes with exit status `0`
- **AND** no command requires network access beyond the initial `deno install` plus Deno's module cache warm-up
- **AND** no command requires any file outside the repository (no global state, no `~/.keni/`, no `.env`)

#### Scenario: Re-running `deno install` on an unchanged working tree

- **WHEN** a contributor runs `deno install` twice in a row without changing any file
- **THEN** the second run completes without modifying `deno.lock`
- **AND** the second run does not re-download modules already present in the local `DENO_DIR`

### Requirement: Unified workspace tasks exist at the repository root

The root `deno.json` SHALL define a task set — `lint`, `fmt`, `fmt:check`, `check`, `test`, `build` — that each cover every package in the workspace. A contributor SHALL NOT need to `cd` into a package to run any of these tasks for the whole repo.

#### Scenario: Root-level `lint` covers every package

- **WHEN** a contributor introduces a lint violation in any package
- **AND** runs `deno task lint` from the repo root
- **THEN** the command exits non-zero
- **AND** the output identifies the offending file and rule

#### Scenario: Root-level `test` runs every package's tests

- **WHEN** a contributor runs `deno task test` from the repo root
- **THEN** at least one test from each of the five packages (`cli`, `server`, `spa`, `role-runtimes`, `shared`) executes
- **AND** the aggregate exit status is `0` when every package's tests pass
- **AND** the aggregate exit status is non-zero when any package has a failing test

#### Scenario: Root-level `fmt` rewrites files in place; `fmt:check` verifies without writing

- **WHEN** a contributor has unformatted files in one or more packages
- **AND** runs `deno task fmt` from the repo root
- **THEN** the unformatted files are rewritten to conform to `deno fmt`'s output
- **AND** already-formatted files are left unchanged
- **WHEN** the contributor then runs `deno task fmt:check` on the same tree
- **THEN** it exits `0` because every file is now formatted
- **AND** running `deno task fmt:check` against a tree with an unformatted file exits non-zero without modifying any file

### Requirement: Dependency installation is reproducible

The repository SHALL commit `deno.lock` pinning every direct and transitive dependency resolved via `jsr:`, `npm:`, and `http(s):` specifiers. The install step used in CI SHALL refuse to update the lockfile and SHALL fail if the lockfile does not match the imports declared in `deno.json` files.

#### Scenario: Lockfile out of sync fails CI

- **WHEN** a contributor modifies a `deno.json` `imports` map to add or change a dependency
- **AND** pushes the change without regenerating `deno.lock`
- **THEN** the CI step running `deno install --frozen` exits non-zero
- **AND** the failure message identifies the lockfile mismatch

#### Scenario: Lockfile in sync succeeds

- **WHEN** `deno.lock` matches every `deno.json` `imports` map in the repo
- **THEN** `deno install --frozen` completes successfully
- **AND** the resolved module versions are byte-for-byte identical to a separate install on the same commit

### Requirement: Continuous integration enforces the baseline on every change

Every push to `main` and every pull request targeting `main` SHALL trigger a GitHub Actions workflow that executes, in order: `deno install --frozen`, `deno task fmt:check`, `deno task lint`, `deno task check`, and `deno task test`. Any non-zero exit SHALL block merge of the pull request and SHALL be reported as a failed check on the commit.

#### Scenario: CI passes on a green change

- **WHEN** a pull request is opened whose HEAD commit passes fmt, lint, check, and test locally
- **THEN** the CI workflow runs automatically
- **AND** every step completes with exit status `0`
- **AND** the pull request shows a passing check

#### Scenario: CI blocks a lint failure

- **WHEN** a pull request introduces a lint violation in any package
- **THEN** the CI workflow runs automatically
- **AND** the `deno task lint` step exits non-zero
- **AND** later steps in the same workflow are skipped or also fail
- **AND** the pull request shows a failed check that names the lint step

#### Scenario: CI runs on every push to `main`

- **WHEN** a commit lands on `main` (via merge or direct push)
- **THEN** the CI workflow runs for that commit independently of any pull request

### Requirement: Monorepo layout maps one-to-one to the product's surfaces

The repository SHALL expose exactly five Deno workspace members — `cli`, `server`, `spa`, `role-runtimes`, and `shared` — each inside a dedicated directory under `packages/`. Each member SHALL contain a `deno.json` with a `name` field of the form `@keni/<pkg>`, at least one source file under `src/`, and at least one test file under `tests/{unit,integration,e2e}/` so that every workspace-level task exercises it. The root `deno.json` SHALL declare all five members in its `workspace` array.

#### Scenario: All five packages are declared and discoverable

- **WHEN** the root `deno.json`'s `workspace` array is read
- **THEN** it contains exactly five entries pointing to `packages/cli`, `packages/server`, `packages/spa`, `packages/role-runtimes`, and `packages/shared`
- **AND** each member directory contains a `deno.json` whose `name` is `@keni/<pkg>`

#### Scenario: Every package contributes to the root `test` task

- **WHEN** `deno task test` runs from the repo root
- **THEN** each of the five packages contributes at least one executed `Deno.test` case, sourced from its `packages/<pkg>/tests/{unit,integration,e2e}/**/*_test.{ts,tsx}` tree
- **AND** removing the package's `tests/` directory causes `deno task test` to no longer report a test for that package (it does not silently pass for that package)

#### Scenario: Workspace bare specifiers resolve across members

- **WHEN** a source file in one workspace member imports another member by its `@keni/<pkg>` name
- **THEN** Deno resolves the import to that member's `exports` entry via the root `workspace` declaration
- **AND** no relative path (`../../`) is required to import between members

### Requirement: Repository hygiene files are present

The repository SHALL contain an `.editorconfig` file specifying indentation, line endings, and final-newline policy for files that `deno fmt` does not cover (shell scripts, Dockerfiles, `.env.example`), a `.tool-versions` file pinning the Deno minor version for asdf / mise users, and a `.gitignore` that excludes Deno's local cache (when `DENO_DIR` is set to a repo-local path), build outputs, editor-specific directories, and OS metadata. These files SHALL live at the repository root.

#### Scenario: `.editorconfig` sets a consistent indentation style

- **WHEN** a contributor opens a shell script or Dockerfile in a compliant editor
- **THEN** the editor applies the indentation and final-newline policy declared in the root `.editorconfig`

#### Scenario: `.tool-versions` pins the Deno minor

- **WHEN** a contributor using asdf or mise runs the tool's `install` command in the repo root
- **THEN** the tool installs the Deno version named in `.tool-versions` (e.g., `deno 2.7.x`)

#### Scenario: `.gitignore` excludes build outputs and local caches

- **WHEN** the tasks `deno install` and `deno task build` have both run
- **AND** the contributor runs `git status`
- **THEN** no build output directories and no Deno cache directories appear in the list of untracked or modified files

### Requirement: README documents the contributor onboarding path

The repository root SHALL contain a `README.md` whose first executable section describes, in one short paragraph, how to go from a fresh clone to a green build: the required Deno version, the `deno install` step, and the set of workspace-level tasks (`deno task lint`, `deno task fmt`, `deno task check`, `deno task test`, `deno task build`). The README SHALL also identify the five packages and what each is for, and state the SPA's stack — React + Vite via [`@deno/vite-plugin`](https://jsr.io/@deno/vite-plugin) — together with a "Run the SPA" subsection naming the `cd packages/spa && deno task dev` invocation, the `KENI_SERVER_URL` environment variable that points the dev server's proxy at a running orchestration server (default `http://127.0.0.1:8000`), the `deno task build` invocation that produces a production `dist/` bundle, and a one-line forward reference to step 13 (the `keni start` change) which will host the bundle from the orchestration server.

#### Scenario: README onboarding paragraph is runnable in order

- **WHEN** a contributor reads the README's setup paragraph top to bottom
- **AND** executes the commands it lists, in the order given
- **THEN** the repository reaches the green-build state without any undocumented step

#### Scenario: README lists the five packages

- **WHEN** a contributor reads the README's layout section
- **THEN** it names all five packages (`cli`, `server`, `spa`, `role-runtimes`, `shared`) and gives a one-line description of each

#### Scenario: README records the SPA stack decision

- **WHEN** a contributor reads the README
- **THEN** a sentence notes that the SPA (`packages/spa`) is built with React and Vite via `@deno/vite-plugin`
- **AND** the sentence does NOT defer the wiring to a later change (the wiring exists in this repo state)

#### Scenario: README documents the SPA dev workflow

- **WHEN** a contributor reads the README
- **THEN** a "Run the SPA" subsection documents `cd packages/spa && deno task dev` (Vite dev server), `deno task build` (production bundle to `packages/spa/dist/`), and `deno task preview` (preview the production bundle locally)
- **AND** the subsection names the `KENI_SERVER_URL` environment variable, its default `http://127.0.0.1:8000`, and how to point it at a server bound on a different port (e.g., the printed port from `--port 0`)
- **AND** the subsection cross-links both the `spa-shell` and `spa-agent-roster` capability specs

### Requirement: The SPA package's `build` task produces a real production bundle

The `@keni/spa` package's `build` task in `packages/spa/deno.json` SHALL invoke Vite (`vite build` via `deno run -A --node-modules-dir npm:vite build`) and SHALL produce a static bundle at `packages/spa/dist/` containing at least an `index.html` and one bundled `.js` chunk. The task SHALL NOT be `echo noop` or any other no-op. The workspace-root `deno task build` SHALL fan out to this task per the existing `developer-setup` requirement and SHALL exit non-zero when the SPA build fails.

#### Scenario: The SPA `build` task is a real Vite build

- **WHEN** the file `packages/spa/deno.json` is read
- **THEN** the `tasks.build` entry invokes Vite (the command string contains `vite build` directly or via the `npm:vite` specifier)
- **AND** the entry is not `echo noop`

#### Scenario: A clean `deno task build` produces a populated `dist/`

- **WHEN** `packages/spa/dist/` is removed and `deno task build` is invoked from the repository root
- **THEN** the workspace-aggregate exit status is 0
- **AND** `packages/spa/dist/index.html` exists after the run
- **AND** `packages/spa/dist/` contains at least one bundled `.js` chunk

#### Scenario: A SPA build failure fails the workspace `build`

- **WHEN** a contributor introduces a TypeScript / bundle error in a SPA source file (e.g., a syntactically invalid `main.tsx`)
- **AND** runs `deno task build` from the repository root
- **THEN** the workspace-aggregate exit status is non-zero
- **AND** the failure output identifies the SPA's `vite build` step

### Requirement: The SPA package contributes more than the placeholder test to `deno task test`

The `@keni/spa` package SHALL contribute its component- and unit-test files (`apiClient_test.ts`, `eventsClient_test.ts`, `AppShell_test.tsx`, `AgentRosterPanel_test.tsx`, `formatRelativeTime_test.ts`, and any peer test files added in this step) to the workspace `deno task test` run. These tests SHALL live under `packages/spa/tests/unit/` (mirroring the `packages/spa/src/` tree). The placeholder test file from step 01 SHALL remain absent (the new tests collectively cover the package's behaviour and the existing `developer-setup` "at least one test" floor remains satisfied). The five-package contract from the existing `developer-setup` requirement SHALL be preserved: every other package (`cli`, `server`, `role-runtimes`, `shared`) is unchanged in spirit (every package's tests are under `packages/<pkg>/tests/`).

#### Scenario: The placeholder SPA test no longer exists

- **WHEN** the file system is inspected after this change lands
- **THEN** `packages/spa/src/main_test.ts` does not exist
- **AND** `packages/spa/src/main.ts` does not exist (replaced by `packages/spa/src/main.tsx`)
- **AND** `packages/spa/tests/unit/main_test.tsx` does not exist either (the placeholder is not relocated; it is gone)

#### Scenario: `deno task test` discovers and runs the new SPA tests

- **WHEN** `deno task test` is invoked from the repo root
- **THEN** the SPA package's contribution to the aggregate `Deno.test` count is at least the documented test files (per the `spa-shell` and `spa-agent-roster` capabilities)
- **AND** every SPA test file lives under `packages/spa/tests/unit/`
- **AND** removing `packages/spa/tests/` makes `deno task test` no longer report a test for the `spa` package (the existing five-package contract still holds)

#### Scenario: The other four packages' test contributions are unchanged

- **WHEN** `deno task test` is invoked
- **THEN** the `cli`, `server`, `role-runtimes`, and `shared` packages each contribute at least one `Deno.test`, sourced from their respective `tests/` trees
- **AND** the count is unchanged (modulo file moves) from the prior baseline

### Requirement: Prompts-as-code convention is locked at the repository level

The repository SHALL NOT contain a top-level `prompts/` directory, and the README SHALL document the convention that agent prompts are added as TypeScript string exports inside the package that uses them, never as files loaded from the filesystem at runtime. This convention implements spec §11#3 and §6.2 from the day the repo is scaffolded.

#### Scenario: No filesystem prompt directory exists

- **WHEN** a contributor inspects the repository layout after the change lands
- **THEN** no `prompts/` directory exists at the repository root
- **AND** no package under `packages/` contains a `prompts/` directory whose contents are loaded via `Deno.readTextFile` or similar runtime file I/O

#### Scenario: README documents the convention

- **WHEN** a contributor reads the README
- **THEN** a section explains that prompts live as TypeScript module exports, are bundled with Keni at build time, and are imported — not read from disk — by the role runtimes

### Requirement: README documents the `keni start` Quickstart as the first-class user entry point

The repository's root `README.md` SHALL contain, inside the existing top-level "Getting started" section, a new "Quickstart with `keni start`" subsection that is the canonical entry point for a user (not a contributor) running Keni for the first time. The subsection SHALL document, in order: (1) the prerequisite — a `keni init`-produced project (cross-link to the existing "Initialise a Keni project" subsection); (2) the build prerequisite — `deno task build` to produce the SPA bundle (named explicitly because step 13's production-mode SPA serving requires it); (3) the invocation — `deno run -A packages/cli/src/main.ts start [path]` (the prototype's pre-binary form), with a one-line note that a future packaged binary will provide `keni start`; (4) the expected stdout — exactly one line `Keni server running at http://127.0.0.1:<port>` (with the format byte-for-byte stable per the `cli-start` capability); (5) the next step — open the printed URL in a browser to load the SPA; (6) the `.env` seam — `<projectDir>/.env` is overlaid onto `Deno.env` with the calling-shell-wins rule; (7) the layered-config seam — `~/.keni/config.yaml` provides defaults the project's `.keni/project.yaml` overrides per top-level key; (8) the port-range default and override flags (`--port`, `--port-range`); (9) the shutdown contract — first SIGINT/SIGTERM runs the documented graceful sequence, second forces exit `130`; (10) a cross-link to the `cli-start` capability spec for the full contract.

The subsection SHALL appear AFTER the existing "Initialise a Keni project (`keni init`)" subsection and BEFORE the existing "Run the orchestration server" subsection (the existing direct-`deno run` invocation is preserved as a "Direct invocation (development)" subsection — see the next requirement). The subsection SHALL NOT duplicate the orchestration-server spec's trust-model paragraph (it cross-links instead).

#### Scenario: README's "Getting started" section names `keni start` as the entry point

- **WHEN** a contributor reads the README's "Getting started" section top-to-bottom
- **THEN** the section contains a "Quickstart with `keni start`" subsection
- **AND** the subsection appears after "Initialise a Keni project (`keni init`)" and before "Run the orchestration server"
- **AND** the subsection names the `deno task build` prerequisite explicitly

#### Scenario: README documents the expected stdout line byte-for-byte

- **WHEN** a contributor reads the "Quickstart with `keni start`" subsection
- **THEN** the documented stdout line is `Keni server running at http://127.0.0.1:<port>`
- **AND** the format is named as byte-for-byte stable
- **AND** the documented `--port-range` default is `7777..7787`

#### Scenario: README cross-links the `cli-start` capability spec

- **WHEN** a contributor reads the "Quickstart with `keni start`" subsection
- **THEN** a sentence in the subsection links to the `cli-start` capability spec
- **AND** the link target is `./openspec/changes/cli-start-and-end-to-end-wiring/specs/cli-start/spec.md` (during the in-progress phase) or `./openspec/specs/cli-start/spec.md` (after archive — both forms are documented as valid)

#### Scenario: README documents the second-signal exit-130 contract

- **WHEN** a contributor reads the "Quickstart with `keni start`" subsection
- **THEN** the shutdown paragraph names the documented sequence (scheduler stop → interrupt-running → grace → server abort)
- **AND** the paragraph names the second-signal escape hatch and the exit code `130`

### Requirement: README contains a top-level "End-to-end smoke test" runbook section

The README SHALL contain a top-level section titled "End-to-end smoke test" (peer to "Conventions" and "Repository layout") that captures the prototype's exit-criterion runbook (`spec.md` §8). The section SHALL list, in order, the four user-driven steps: (1) `keni init` an empty folder; (2) `keni start`; (3) open the printed URL in a browser; (4) create a ticket via the SPA's "New ticket" form and observe the engineer drive it through `in_progress → ready_for_review → in_review → approved → merged → ready_for_test`. The section SHALL state the expected wall-clock duration (under five minutes on a fresh laptop with the workspace cloned and `deno install` run). The section SHALL cross-link the automated `start_e2e_test` (the file path) and explicitly distinguish the manual runbook (the user's exit criterion) from the automated test (Keni's own regression net per the `cli-start` capability).

The section SHALL include one paragraph naming the prerequisites (Deno installed, `deno install` and `deno task build` already run, an `OPENAI_API_KEY` (or the relevant coding-agent's API key) exported in the shell or written to `<projectDir>/.env`). The section SHALL NOT replace any existing per-package documentation; it SHALL be a runbook on top of the existing Quickstart.

#### Scenario: README contains the "End-to-end smoke test" section

- **WHEN** a contributor reads the README from top to bottom
- **THEN** a top-level section titled "End-to-end smoke test" exists
- **AND** the section is a peer of "Conventions" and "Repository layout" (i.e., a `## ` heading)

#### Scenario: The runbook lists the four documented steps in order

- **WHEN** a contributor reads the "End-to-end smoke test" section
- **THEN** the section lists four steps in this order: `keni init`, `keni start`, open the printed URL, create a ticket via the UI
- **AND** the section names the expected lifecycle progression (`in_progress → ready_for_review → ... → ready_for_test`)
- **AND** the section names the expected wall-clock duration (under five minutes)

#### Scenario: The runbook cross-links the automated smoke test

- **WHEN** a contributor reads the "End-to-end smoke test" section
- **THEN** a sentence in the section links to `packages/cli/src/start/start_e2e_test.ts`
- **AND** the section explicitly distinguishes the manual runbook from the automated test

### Requirement: README's existing "Run the orchestration server" subsection is restructured to demote the direct invocation to "Direct invocation (development)"

The existing "Run the orchestration server" subsection's lead paragraph SHALL be updated to name `keni start` as the user-facing entry point (cross-link to the new "Quickstart with `keni start`" subsection) and SHALL preserve the existing direct-`deno run` invocation under a new "Direct invocation (development)" sub-subsection. The trust-model paragraph (`127.0.0.1` only, no auth, role headers trusted) SHALL be unchanged. The `curl -H "X-Keni-Role: user"` smoke-test snippet SHALL be unchanged. The `/health` endpoint's existence SHALL be added to the "Run the orchestration server" subsection in one sentence (the canonical reference is the `orchestration-server` capability spec's delta).

#### Scenario: "Run the orchestration server" names `keni start` as the user-facing entry point

- **WHEN** a contributor reads the "Run the orchestration server" subsection
- **THEN** the lead paragraph names `keni start` and links to the "Quickstart with `keni start`" subsection
- **AND** the existing direct-`deno run` invocation is preserved under a "Direct invocation (development)" sub-subsection
- **AND** the trust-model paragraph is unchanged byte-for-byte

#### Scenario: `/health` is documented in the orchestration-server subsection

- **WHEN** a contributor reads the "Run the orchestration server" subsection
- **THEN** a sentence names the `GET /health` endpoint and its role-header exemption
- **AND** the sentence cross-links the `orchestration-server` capability spec for the full contract

### Requirement: Tests live under `packages/<pkg>/tests/`, never under `packages/<pkg>/src/`

Every Keni workspace member (`cli`, `server`, `spa`, `role-runtimes`, `shared`) SHALL place its test files and test-only support code under a top-level `packages/<pkg>/tests/` directory. The package's `src/` directory SHALL contain only production code: no file matching `*_test.ts` or `*_test.tsx` SHALL exist anywhere under `packages/<pkg>/src/`, and no directory named `fakes/`, `fixtures/`, `__fixtures__/`, `__tests__/`, or `tests/` SHALL exist under `packages/<pkg>/src/`. The `tests/` directory SHALL be partitioned into the following named buckets, each of which is OPTIONAL (a bucket is absent when the package has no files of that kind):

- `tests/unit/` — every test that exercises a single module of the same package, mirroring the path of the unit under `src/`. The mirror is mechanical: a unit at `packages/<pkg>/src/<rel>/<name>.ts` is tested by `packages/<pkg>/tests/unit/<rel>/<name>_test.ts(x)`.
- `tests/integration/` — tests whose name ends in `integration_test.ts` (or `integration_test.tsx`); they exercise more than one production module or cross a process / network boundary owned by the package.
- `tests/e2e/` — tests whose name ends in `_e2e_test.ts` (or `_e2e_test.tsx`); they spawn external processes (the orchestration server, the CLI, an agent CLI) end-to-end.
- `tests/contracts/` — shared behavioural-contract helpers (e.g. `runTicketStoreContract`) that other test files import to register their own `Deno.test` cases. Files in this bucket SHALL NOT end in `_test.ts` (they are imported helpers, not auto-discovered test files).
- `tests/fakes/` — test-only doubles (in-memory fakes, recording stubs, fake clocks). Files in this bucket SHALL NOT end in `_test.ts`.
- `tests/fixtures/` — test-only static data, scripts, or files that are not TypeScript modules consumed via `import` from production code (e.g., a script run as a child-process subject under test). Files in this bucket SHALL NOT end in `_test.ts`.

The unit-test bucket SHALL be the default landing place for any new test that does not match the integration / e2e / contracts criteria.

#### Scenario: No `*_test.ts(x)` file exists under any package's `src/`

- **WHEN** the file system under `packages/` is walked
- **THEN** no file matching `packages/*/src/**/*_test.ts` exists
- **AND** no file matching `packages/*/src/**/*_test.tsx` exists
- **AND** no directory matching `packages/*/src/**/fakes/` exists
- **AND** no directory matching `packages/*/src/**/fixtures/` exists
- **AND** no file matching `packages/*/src/**/contract_test.ts` exists

#### Scenario: Every package that has tests has a `tests/` directory

- **WHEN** the file system under `packages/` is walked
- **THEN** for every package directory `packages/<pkg>/` that contributes at least one `Deno.test` to `deno task test`, a `packages/<pkg>/tests/` directory exists
- **AND** every test file the package contributes lives at `packages/<pkg>/tests/{unit,integration,e2e}/**/*_test.{ts,tsx}` (one of the three auto-discovered buckets)

#### Scenario: Unit tests mirror the `src/` tree

- **WHEN** a contributor creates a new unit test for a module at `packages/<pkg>/src/<rel>/<name>.ts`
- **THEN** the test file is placed at `packages/<pkg>/tests/unit/<rel>/<name>_test.ts`
- **AND** running `deno task test` from the repo root discovers and executes the new test
- **AND** the test imports the unit under test via the relative path `../../../src/<rel>/<name>.ts` (or whatever depth matches the chosen subdirectory)

#### Scenario: Integration tests live in `tests/integration/`

- **WHEN** a contributor adds a test whose filename ends in `integration_test.ts`
- **THEN** the test file is placed somewhere under `packages/<pkg>/tests/integration/`
- **AND** the test is auto-discovered by `deno task test`

#### Scenario: End-to-end tests live in `tests/e2e/`

- **WHEN** a contributor adds a test whose filename ends in `_e2e_test.ts`
- **THEN** the test file is placed somewhere under `packages/<pkg>/tests/e2e/`
- **AND** the test is auto-discovered by `deno task test`

#### Scenario: Contract helpers do not end in `_test.ts`

- **WHEN** a shared behavioural-contract helper is added (a function that registers `Deno.test` cases on behalf of one or more callers)
- **THEN** the helper is placed under `packages/<pkg>/tests/contracts/` with a name that does NOT end in `_test.ts` (e.g. `<artifact>StoreContract.ts`)
- **AND** `deno task test` does NOT auto-load the helper as a standalone test file
- **AND** the helper's tests are registered when a sibling unit / integration test file imports the helper and invokes its registration function

#### Scenario: Fakes live under `tests/fakes/`

- **WHEN** a test-only double (e.g. an in-memory store, a recording stub, a fake clock, a workspace-provisioner fake) is added
- **THEN** the file is placed somewhere under `packages/<pkg>/tests/fakes/`
- **AND** no file under `packages/<pkg>/src/` declares the double's symbol
- **AND** the double's filename does NOT end in `_test.ts`

#### Scenario: Static fixtures live under `tests/fixtures/`

- **WHEN** a non-TypeScript-module test fixture is added (a script run as a child process subject, a static data file, etc.)
- **THEN** the fixture is placed somewhere under `packages/<pkg>/tests/fixtures/`
- **AND** no production code under `packages/<pkg>/src/` reads from `tests/fixtures/` at runtime

### Requirement: Cross-package fakes are exposed via a `./test-fakes` secondary export entry

When a test-only double in one package needs to be importable from another package's tests, the producing package's `deno.json` SHALL declare its `exports` field as an object literal whose `"."` entry points at the production barrel (`./src/main.ts` or equivalent) and whose `"./test-fakes"` entry points at a `./tests/fakes/mod.ts` barrel under the same package. Cross-package consumers SHALL import the doubles by name from `@keni/<pkg>/test-fakes`. The production barrel (`@keni/<pkg>` without a path suffix) SHALL NOT re-export any symbol declared under `tests/`. A package whose fakes are consumed only by its own tests is NOT required to add a `./test-fakes` entry; the convention is mandatory only when at least one foreign package's tests import the fake.

#### Scenario: `@keni/role-runtimes` exposes a `./test-fakes` entry

- **WHEN** `packages/role-runtimes/deno.json` is read
- **THEN** the `exports` field is a JSON object
- **AND** it contains the entry `"."` mapped to `"./src/main.ts"`
- **AND** it contains the entry `"./test-fakes"` mapped to `"./tests/fakes/mod.ts"`
- **AND** `packages/role-runtimes/tests/fakes/mod.ts` exists and re-exports at least `FakeWorkspaceProvisioner` and `createFakeCodingAgentInvoker`

#### Scenario: Cross-package consumers use the secondary entry

- **WHEN** a test file in `packages/server/tests/` or `packages/cli/tests/` imports a fake from `@keni/role-runtimes`
- **THEN** the import specifier is `@keni/role-runtimes/test-fakes` (not the bare `@keni/role-runtimes`)
- **AND** `deno task check` resolves the symbol to the file under `packages/role-runtimes/tests/fakes/`

#### Scenario: Production barrel does not leak fakes

- **WHEN** the file `packages/role-runtimes/src/main.ts` is inspected
- **THEN** no `export { ... } from "./...fakes/..."` statement exists
- **AND** no `export type { ... } from "./...fakes/..."` statement exists
- **AND** importing `import { FakeWorkspaceProvisioner } from "@keni/role-runtimes"` (without `/test-fakes`) fails to resolve `FakeWorkspaceProvisioner`

#### Scenario: A package without cross-package fakes does not need a secondary export

- **WHEN** `packages/server/deno.json` is read (its `fakeClock` is consumed only by tests inside `@keni/server`)
- **THEN** the `exports` field MAY be either a string (`"./src/main.ts"`) or an object whose only entry is `"."`
- **AND** the absence of a `"./test-fakes"` entry does NOT violate this requirement

### Requirement: Repository layout invariants are enforced by an automated test

The repository SHALL contain at least one Deno test that fails when any of the layout rules above is violated. The test SHALL walk `packages/*/src/**` and assert that no file matches `*_test.ts` or `*_test.tsx`, that no directory named `fakes/`, `fixtures/`, `__fixtures__/`, `__tests__/`, or `tests/` exists under any `src/`, and that no file matches `**/contract_test.ts`. The test SHALL run as part of `deno task test` from the repo root, so accidental re-introductions of co-located test code or test-only support code are caught by CI without any additional lint pass.

#### Scenario: The structural test exists and is discovered

- **WHEN** `deno task test` runs from the repo root
- **THEN** at least one test case asserts `packages/*/src/**/*_test.{ts,tsx}` is empty
- **AND** at least one test case asserts no `fakes/` directory exists under any package's `src/`
- **AND** at least one test case asserts no `contract_test.ts` file exists under any package's `src/`

#### Scenario: Adding a `*_test.ts` file under `src/` makes the structural test fail

- **WHEN** a contributor places a new test file at `packages/<pkg>/src/foo_test.ts`
- **AND** runs `deno task test` from the repo root
- **THEN** the structural test reports a failure that names `packages/<pkg>/src/foo_test.ts`
- **AND** `deno task test` exits non-zero

#### Scenario: Adding a `fakes/` directory under `src/` makes the structural test fail

- **WHEN** a contributor places a new directory at `packages/<pkg>/src/<sub>/fakes/`
- **AND** runs `deno task test` from the repo root
- **THEN** the structural test reports a failure that names `packages/<pkg>/src/<sub>/fakes/`
- **AND** `deno task test` exits non-zero

