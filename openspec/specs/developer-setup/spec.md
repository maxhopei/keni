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

The repository SHALL expose exactly five Deno workspace members — `cli`, `server`, `spa`, `role-runtimes`, and `shared` — each inside a dedicated directory under `packages/`. Each member SHALL contain a `deno.json` with a `name` field of the form `@keni/<pkg>`, at least one source file, and at least one test file so that every workspace-level task exercises it. The root `deno.json` SHALL declare all five members in its `workspace` array.

#### Scenario: All five packages are declared and discoverable

- **WHEN** the root `deno.json`'s `workspace` array is read
- **THEN** it contains exactly five entries pointing to `packages/cli`, `packages/server`, `packages/spa`, `packages/role-runtimes`, and `packages/shared`
- **AND** each member directory contains a `deno.json` whose `name` is `@keni/<pkg>`

#### Scenario: Every package contributes to the root `test` task

- **WHEN** `deno task test` runs from the repo root
- **THEN** each of the five packages contributes at least one executed `Deno.test` case
- **AND** removing a package's test file causes `deno task test` to no longer report a test for that package (it does not silently pass for that package)

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

The repository root SHALL contain a `README.md` whose first executable section describes, in one short paragraph, how to go from a fresh clone to a green build: the required Deno version, the `deno install` step, and the set of workspace-level tasks (`deno task lint`, `deno task fmt`, `deno task check`, `deno task test`, `deno task build`). The README SHALL also identify the five packages and what each is for, and state the SPA's future stack (React + Vite via `@deno/vite-plugin`).

#### Scenario: README onboarding paragraph is runnable in order

- **WHEN** a contributor reads the README's setup paragraph top to bottom
- **AND** executes the commands it lists, in the order given
- **THEN** the repository reaches the green-build state without any undocumented step

#### Scenario: README lists the five packages

- **WHEN** a contributor reads the README's layout section
- **THEN** it names all five packages (`cli`, `server`, `spa`, `role-runtimes`, `shared`) and gives a one-line description of each

#### Scenario: README records the SPA stack decision

- **WHEN** a contributor reads the README
- **THEN** a sentence notes that the SPA (`packages/spa`) will be built with React and Vite via `@deno/vite-plugin`, with the actual Vite wiring deferred to a later change

### Requirement: Prompts-as-code convention is locked at the repository level

The repository SHALL NOT contain a top-level `prompts/` directory, and the README SHALL document the convention that agent prompts are added as TypeScript string exports inside the package that uses them, never as files loaded from the filesystem at runtime. This convention implements spec §11#3 and §6.2 from the day the repo is scaffolded.

#### Scenario: No filesystem prompt directory exists

- **WHEN** a contributor inspects the repository layout after the change lands
- **THEN** no `prompts/` directory exists at the repository root
- **AND** no package under `packages/` contains a `prompts/` directory whose contents are loaded via `Deno.readTextFile` or similar runtime file I/O

#### Scenario: README documents the convention

- **WHEN** a contributor reads the README
- **THEN** a section explains that prompts live as TypeScript module exports, are bundled with Keni at build time, and are imported — not read from disk — by the role runtimes

