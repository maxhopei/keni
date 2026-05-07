## MODIFIED Requirements

### Requirement: Monorepo layout maps one-to-one to the product's surfaces

The repository SHALL expose exactly eight Deno workspace members — `cli`, `server`, `spa`, `runtime-common`, `runtime-workspace`, `runtime-engineer`, `runtime-po`, and `shared` — each inside a dedicated directory under `packages/`. The `packages/role-runtimes/` directory SHALL NOT exist (the legacy package was split into `runtime-common`, `runtime-workspace`, `runtime-engineer`, and `runtime-po`). Each member SHALL contain a `deno.json` with a `name` field of the form `@keni/<pkg>` (e.g., `@keni/runtime-common`), at least one source file under `src/`, and at least one test file under `tests/{unit,integration,e2e}/` so that every workspace-level task exercises it. The root `deno.json` SHALL declare all eight members in its `workspace` array.

#### Scenario: All eight packages are declared and discoverable

- **WHEN** the root `deno.json`'s `workspace` array is read
- **THEN** it contains exactly eight entries pointing to `packages/cli`, `packages/server`, `packages/spa`, `packages/runtime-common`, `packages/runtime-workspace`, `packages/runtime-engineer`, `packages/runtime-po`, and `packages/shared`
- **AND** each member directory contains a `deno.json` whose `name` is `@keni/<pkg>`
- **AND** the directory `packages/role-runtimes/` does not exist

#### Scenario: Every package contributes to the root `test` task

- **WHEN** `deno task test` runs from the repo root
- **THEN** each of the eight packages contributes at least one executed `Deno.test` case, sourced from its `packages/<pkg>/tests/{unit,integration,e2e}/**/*_test.{ts,tsx}` tree
- **AND** removing the package's `tests/` directory causes `deno task test` to no longer report a test for that package (it does not silently pass for that package)

#### Scenario: Workspace bare specifiers resolve across members

- **WHEN** a source file in one workspace member imports another member by its `@keni/<pkg>` name
- **THEN** Deno resolves the import to that member's `exports` entry via the root `workspace` declaration
- **AND** no relative path (`../../`) is required to import between members

### Requirement: Cross-package fakes are exposed via a `./test-fakes` secondary export entry

When a test-only double in one package needs to be importable from another package's tests, the producing package's `deno.json` SHALL declare its `exports` field as an object literal whose `"."` entry points at the production barrel (`./src/main.ts` or equivalent) and whose `"./test-fakes"` entry points at a `./tests/fakes/mod.ts` barrel under the same package. Cross-package consumers SHALL import the doubles by name from `@keni/<pkg>/test-fakes`. The production barrel (`@keni/<pkg>` without a path suffix) SHALL NOT re-export any symbol declared under `tests/`. A package whose fakes are consumed only by its own tests is NOT required to add a `./test-fakes` entry; the convention is mandatory only when at least one foreign package's tests import the fake.

The post-split layout SHALL distribute fakes across packages by responsibility:

- `@keni/runtime-common/test-fakes` exposes `createFakeCodingAgentInvoker` and the `placeholderPrompt` constant.
- `@keni/runtime-workspace/test-fakes` exposes `FakeWorkspaceProvisioner`.
- `@keni/runtime-engineer/test-fakes` and `@keni/runtime-po/test-fakes` MAY be added if engineer- or PO-specific fakes are needed; absence is allowed when no foreign package consumes them.

#### Scenario: `@keni/runtime-common` exposes a `./test-fakes` entry

- **WHEN** `packages/runtime-common/deno.json` is read
- **THEN** the `exports` field is a JSON object
- **AND** it contains the entry `"."` mapped to `"./src/main.ts"`
- **AND** it contains the entry `"./test-fakes"` mapped to `"./tests/fakes/mod.ts"`
- **AND** `packages/runtime-common/tests/fakes/mod.ts` exists and re-exports at least `createFakeCodingAgentInvoker` and `placeholderPrompt`

#### Scenario: `@keni/runtime-workspace` exposes a `./test-fakes` entry

- **WHEN** `packages/runtime-workspace/deno.json` is read
- **THEN** the `exports` field is a JSON object containing `"./test-fakes"` mapped to `"./tests/fakes/mod.ts"`
- **AND** `packages/runtime-workspace/tests/fakes/mod.ts` re-exports at least `FakeWorkspaceProvisioner`

#### Scenario: Cross-package consumers use the secondary entry

- **WHEN** a test file in `packages/server/tests/` or `packages/cli/tests/` imports a fake produced by another package
- **THEN** the import specifier is `@keni/<pkg>/test-fakes` (e.g., `@keni/runtime-common/test-fakes`, `@keni/runtime-workspace/test-fakes`), not the bare `@keni/<pkg>`
- **AND** `deno task check` resolves the symbol to the file under that package's `tests/fakes/`

#### Scenario: Production barrel does not leak fakes

- **WHEN** the file `packages/runtime-common/src/main.ts` (and the equivalent for every other split package) is inspected
- **THEN** no `export { ... } from "./...fakes/..."` statement exists
- **AND** no `export type { ... } from "./...fakes/..."` statement exists
- **AND** importing `import { createFakeCodingAgentInvoker } from "@keni/runtime-common"` (without `/test-fakes`) fails to resolve `createFakeCodingAgentInvoker`
- **AND** importing `import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace"` (without `/test-fakes`) fails to resolve `FakeWorkspaceProvisioner`

#### Scenario: A package without cross-package fakes does not need a secondary export

- **WHEN** `packages/server/deno.json` is read (its `fakeClock` is consumed only by tests inside `@keni/server`)
- **THEN** the `exports` field MAY be either a string (`"./src/main.ts"`) or an object whose only entry is `"."`
- **AND** the absence of a `"./test-fakes"` entry does NOT violate this requirement

### Requirement: Repository layout invariants are enforced by an automated test

The repository SHALL contain at least one Deno test that fails when any of the layout rules above is violated. The test SHALL walk `packages/*/src/**` and assert that no file matches `*_test.ts` or `*_test.tsx`, that no directory named `fakes/`, `fixtures/`, `__fixtures__/`, `__tests__/`, or `tests/` exists under any `src/`, and that no file matches `**/contract_test.ts`. Additionally, the test SHALL assert: (a) the workspace `deno.json`'s `workspace` array contains exactly the eight members enumerated in this capability (`cli`, `server`, `spa`, `runtime-common`, `runtime-workspace`, `runtime-engineer`, `runtime-po`, `shared`); (b) the directory `packages/role-runtimes/` does not exist on disk; (c) every package's `name` in its `deno.json` matches the directory name with the `@keni/` prefix. The test SHALL run as part of `deno task test` from the repo root, so accidental re-introductions of co-located test code, the legacy package directory, or naming drift are caught by CI without any additional lint pass.

#### Scenario: The structural test exists and is discovered

- **WHEN** `deno task test` runs from the repo root
- **THEN** at least one test case asserts `packages/*/src/**/*_test.{ts,tsx}` is empty
- **AND** at least one test case asserts no `fakes/` directory exists under any package's `src/`
- **AND** at least one test case asserts no `contract_test.ts` file exists under any package's `src/`
- **AND** at least one test case asserts the eight-member workspace list and the absence of `packages/role-runtimes/`

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

#### Scenario: Re-introducing `packages/role-runtimes/` makes the structural test fail

- **WHEN** a contributor recreates the directory `packages/role-runtimes/` (with or without files)
- **AND** runs `deno task test` from the repo root
- **THEN** the structural test reports a failure that names the legacy directory
- **AND** `deno task test` exits non-zero
