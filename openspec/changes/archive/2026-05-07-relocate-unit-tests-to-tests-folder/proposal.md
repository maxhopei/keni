## Why

Today every Keni package co-locates `*_test.ts(x)` files next to the source they cover under `packages/<pkg>/src/`. The convention is established by the `developer-setup` capability and reinforced by ~107 test files across the five workspace members, plus a handful of test-only support modules (`fakes/`, `fixtures/`, `contract_test.ts` helpers) that are also scattered through `src/`. The mix has three real costs:

- A test file's location no longer signals "this is test code" — it's only the suffix that distinguishes it. New contributors (and AI agents) skimming `src/` see prod and test side-by-side and have to filter mentally.
- Test-only support code (fakes, fixtures, contract helpers) leaks into the prod tree. Two contract helper files (`contract_test.ts`) are deliberately named `_test.ts` only so Deno's discovery loads them, even though they register no tests of their own — a brittle workaround.
- Build / type-check / lint passes have to traverse test code on every run, and `deno publish`-style flows (future) cannot easily exclude the test surface because there is no clean directory boundary.

Moving every unit test into `packages/<pkg>/tests/unit/` (mirroring the `src/` tree) and every test-only support file into a dedicated `packages/<pkg>/tests/` subtree gives us one clean rule: **everything under `tests/` is test-only; everything under `src/` ships**. The `role-runtimes` package already partially uses `tests/` (`tests/integration/cursorAgent_test.ts`, `tests/fixtures/fake-coding-agent.ts`) — this change generalises that pattern to every package.

## What Changes

- **BREAKING (file layout)** — every existing `packages/<pkg>/src/**/<name>_test.ts(x)` file moves to `packages/<pkg>/tests/<bucket>/<mirrored-path>/<name>_test.ts(x)`, where `<bucket>` is one of:
  - `unit/` — default for all currently co-located `*_test.ts(x)` (`server`: 49, `cli`: 19, `role-runtimes`: 17, `shared`: 17, `spa`: 5, minus the already-bucketed integration / e2e / contract files identified below).
  - `integration/` — files named `*integration_test.ts` and the existing `packages/role-runtimes/tests/integration/cursorAgent_test.ts`.
  - `e2e/` — files named `*_e2e_test.ts` (CLI start-flow tests).
  - `contracts/` — the four `packages/shared/src/storage/*/contract_test.ts` helpers (renamed off the `_test.ts` suffix when moved, since they only register tests via a callable helper consumed by the sibling `memory_test.ts` / `file_test.ts`).
- Test-only support files move under `tests/`:
  - `tests/fakes/<mirrored>` for the test doubles currently at `packages/role-runtimes/src/common/fakes/fakeCodingAgentInvoker.ts`, `packages/role-runtimes/src/engineer/workspace/fakes/fakeWorkspaceProvisioner.ts`, and `packages/server/src/scheduler/fakes/fakeClock.ts`.
  - `tests/fixtures/<mirrored>` for runtime fixtures like `packages/role-runtimes/tests/fixtures/fake-coding-agent.ts` (already there — kept; one move only is the `tests/integration/cursorAgent_test.ts` re-pathing of its relative imports).
- **Cross-package fakes get a documented secondary export.** `@keni/role-runtimes`'s `deno.json` switches its `exports` field from a string to an object literal, adding a `"./test-fakes"` entry that points to a new `tests/fakes/mod.ts` barrel. Cross-package callers (`@keni/server`, `@keni/cli`) update their imports from `@keni/role-runtimes` → `@keni/role-runtimes/test-fakes` for `FakeWorkspaceProvisioner` and `createFakeCodingAgentInvoker`. The `./` (default) entry continues to expose only production code.
- The four contract helpers get renamed (e.g. `tickets/contract_test.ts` → `tests/contracts/tickets/ticketStoreContract.ts`) and their callers (`memory_test.ts`, `file_test.ts`, now under `tests/unit/`) update their import paths. The helpers no longer end in `_test.ts`, removing the no-op-test-discovery hack.
- The `developer-setup` capability spec is updated: a new requirement codifies the `tests/{unit,integration,e2e,contracts,fakes,fixtures}/` layout, the rule that `src/` contains no `*_test.ts(x)` files, and the rule that test-only support code lives under `tests/`. The five-package, every-package-contributes-a-test contract is preserved.
- Each package's test discovery still works under the workspace-level `deno task test` (which today runs `deno test -A` rooted at the repo). No task changes are required because Deno auto-discovers any `*_test.ts(x)` file regardless of directory; the new layout is naturally compatible.
- A repo-level structural test (added to `@keni/shared` or `developer-setup`'s validation surface) asserts that no file matching `packages/*/src/**/*_test.{ts,tsx}` exists, locking the convention in.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `developer-setup`: Adds a requirement defining the per-package `tests/` directory layout (with `unit/`, `integration/`, `e2e/`, `contracts/`, `fakes/`, `fixtures/` buckets), forbids `*_test.ts(x)` files under `packages/*/src/`, and clarifies that test-only support code (fakes, fixtures, contract helpers) lives under `tests/`. The existing "Every package contributes to the root `test` task" requirement gains a scenario that the per-package contribution is detected via `tests/` rather than `src/`.

## Impact

- **Code moved**: ~107 test files + 3 fake modules + 4 contract helpers, across all five packages (`cli`, `server`, `role-runtimes`, `shared`, `spa`). No production logic changes; only file paths and import specifiers.
- **Public-API impact (intra-workspace)**: `@keni/role-runtimes` adds a secondary export `./test-fakes`. The default barrel (`./src/main.ts`) loses its re-exports of `FakeWorkspaceProvisioner`, `FakeWorkspaceProvisionerCall`, `FakeWorkspaceProvisionerOpts`, and any fake-related types — a **BREAKING** import-path change for callers, all of which are inside this monorepo. Cross-package consumers (`@keni/server`, `@keni/cli`) are migrated in the same change.
- **Tooling**: Root `deno.json` `fmt`, `lint`, and `test` already include the entire `packages/` tree, so the new directories are picked up without config changes. The `developer-setup` "every package contributes a test" guarantee is verified by `deno task test` discovering `tests/unit/**`.
- **Docs**: The two existing in-tree docs that name test paths — `packages/role-runtimes/README.md` (which lists the `src/` tree shape) and `packages/shared/src/storage/README.md` (which references `contract_test.ts`) — are updated to match.
- **OpenSpec history**: This is a behavioural-no-op refactor — no scheduler / runtime / wire changes. The change is purely about the on-disk shape of each package; archived capabilities that mention test paths in their narrative (`role-runtime`, `engineer-runtime`, `scheduler`, etc.) keep their normative requirements untouched, since none of them pin a `src/`-vs-`tests/` location.
- **Risk**: Low. The risk surface is import-path correctness (107 file moves means 107 relative-import updates) and the deno workspace's understanding of the new `./test-fakes` exports key; both are catchable by `deno task check` + `deno task test`.
