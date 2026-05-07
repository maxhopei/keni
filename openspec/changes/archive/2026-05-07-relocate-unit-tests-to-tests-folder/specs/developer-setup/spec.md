# developer-setup Spec Delta — relocate-unit-tests-to-tests-folder

## ADDED Requirements

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

## MODIFIED Requirements

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
