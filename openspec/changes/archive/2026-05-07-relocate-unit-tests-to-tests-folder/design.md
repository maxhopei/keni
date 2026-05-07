## Context

Keni's five-package monorepo currently follows a pure co-location convention: every `*_test.ts(x)` file sits next to the production module it covers, somewhere under `packages/<pkg>/src/`. The convention emerged organically from the seed-step "every package has at least one test" floor in the `developer-setup` capability, and is reinforced by 107 existing test files. The `developer-setup` spec does not (today) say anything about WHERE test files live within a package — only that they exist.

A small number of test-only support files have already been pushed out of `src/` precisely because they did not fit the co-location story:

- `packages/role-runtimes/tests/integration/cursorAgent_test.ts` — needs the real `cursor-agent` binary; lives in a `tests/integration/` bucket so it's clearly external-binary-gated.
- `packages/role-runtimes/tests/fixtures/fake-coding-agent.ts` — a script the cycle's subprocess invoker tests run as a child process; not importable application code.

Three categories of files inside `src/` are not actually production code but are forced to live there today:

1. **Test fakes** that need to be importable from sibling packages' tests:
   - `packages/role-runtimes/src/common/fakes/fakeCodingAgentInvoker.ts`
   - `packages/role-runtimes/src/engineer/workspace/fakes/fakeWorkspaceProvisioner.ts`
   - These are re-exported from `packages/role-runtimes/src/main.ts` because the `@keni/server` and `@keni/cli` test suites need them. Placing them under `src/` was the lowest-friction way to expose them via the package's `exports` string.
   - `packages/server/src/scheduler/fakes/fakeClock.ts` — only used by `scheduler_test.ts` in the same package; re-exported through nothing.
2. **Contract-test helpers** that are named `_test.ts` only so Deno's discovery loads them, even though they register no tests at module top-level:
   - `packages/shared/src/storage/{tickets,prs,activity,config}/contract_test.ts` — each exports a single `runXContract(name, factory)` helper that the sibling `memory_test.ts` and `file_test.ts` call to register tests. The `_test.ts` suffix is a workaround that makes Deno load them; if they were named anything else, they'd still work (Deno's auto-load only matters for files with top-level `Deno.test` calls).
3. **In-line test doubles** declared inside `_test.ts` files (e.g. the `FakeClock` class inside `packages/spa/src/transport/eventsClient_test.ts`). These are local to the test file and not affected by this change.

The `role-runtimes` package's existing `tests/` directory shows the path forward, but the rule was never written down. This change writes it down once, applies it to every package, and uses the deno-workspace `exports` map to keep cross-package fake imports clean.

## Goals / Non-Goals

**Goals:**

- One canonical rule: under `packages/<pkg>/`, prod code lives in `src/`, tests and test-only support code live in `tests/`. The rule is enforced by both the `developer-setup` capability spec and a structural test in CI.
- Predictable per-package structure: `tests/unit/`, `tests/integration/`, `tests/e2e/`, `tests/contracts/`, `tests/fakes/`, `tests/fixtures/` are the named buckets. Not every package needs every bucket; an absent bucket simply means no tests of that kind exist.
- Cross-package fake sharing stays first-class: `@keni/role-runtimes` declares a `./test-fakes` secondary export so `@keni/server` and `@keni/cli` can keep importing `FakeWorkspaceProvisioner` and `createFakeCodingAgentInvoker` by name without reaching into the file tree. Production code (the `./` entry) loses these re-exports.
- `deno task fmt`, `lint`, `check`, and `test` continue to work on a `packages/`-rooted include glob; no root-level config edits are needed beyond what's already there.
- The four contract helpers stop pretending to be `_test.ts` files; they're imported helpers that compose into other tests.

**Non-Goals:**

- Renaming the `_test.ts` suffix to `.test.ts` (Deno-conventional) or vice-versa. The existing suffix stays; only file paths change. (One exception: the four `contract_test.ts` files lose their `_test.ts` suffix because they no longer pretend to register tests.)
- Splitting integration / e2e tests into separate Deno test runs or CI jobs. Today's flat `deno task test` is preserved.
- Changing what any test asserts. This is a pure refactor: each test file's body is unchanged after the move; only relative-import paths inside the file are rewritten to the new location.
- Reorganising `src/` itself. The mirror under `tests/unit/` follows whatever shape `src/` happens to have today.
- Introducing a new test framework, mocking library, or test runner. Tests still use `Deno.test` + `@std/assert` + `@std/testing`.
- Touching prompts. The "prompts as code" rule (no `prompts/` directory) is not changed — prompt modules and their `_test.ts` partners both move into the `src/` → `tests/unit/` mirror like every other pair.

## Decisions

### Decision 1: Mirror `src/`'s tree under `tests/unit/` rather than flattening

A test file that today lives at `packages/server/src/wire/tickets_test.ts` will move to `packages/server/tests/unit/wire/tickets_test.ts`. Every directory level under `src/` is preserved. Imports of the unit under test become `../../../src/wire/tickets.ts` (three `..` to climb out of `tests/unit/wire/`, then back into `src/`).

**Why mirror rather than flatten:** the mirror is mechanically derivable (the move is `s|/src/(.*)_test\.ts$|/tests/unit/\1_test.ts|`), it preserves grep-ability ("where are the wire-tickets tests?" → `tests/unit/wire/tickets_test.ts`), and it keeps cousin tests visually grouped (e.g. all middleware tests stay under `tests/unit/middleware/`). A flat layout (`tests/unit/wireTicketsTest.ts`) would be one indirection more readable in a small package but a maze in `@keni/server` (49 files).

**Alternatives considered:**

- **Flat `tests/unit/<name>_test.ts`**: Rejected for the reason above plus the name-collision risk (two `errors_test.ts` exist today: `packages/server/src/errors_test.ts` and `packages/server/src/mcp/errors_test.ts`).
- **Per-feature folder grouping (`tests/unit/wire/tickets/test.ts`)**: Rejected — adds a directory level that doesn't pay for itself, and breaks the "one Deno.test file per source module" invariant.

### Decision 2: Three test buckets by suffix, plus contracts as a named exception

Mapping rule applied during the move:

| Source-of-truth signal | Destination bucket | Files |
| --- | --- | --- |
| `*_e2e_test.ts` | `tests/e2e/` | `engineerRunner_e2e_test.ts`, `start_e2e_test.ts` (CLI) |
| `*integration_test.ts` | `tests/integration/` | 5 files across server, cli, role-runtimes |
| `contract_test.ts` (in shared/storage/) | `tests/contracts/` (renamed off `_test.ts` suffix) | 4 files |
| Everything else | `tests/unit/` | The remaining ~96 files |

The contract helpers are renamed (`contract_test.ts` → `<artifact>StoreContract.ts`) because they don't register their own `Deno.test` cases — they expose a single `runXStoreContract(name, factory)` function. Once they live under `tests/contracts/` they can shed the `_test.ts` suffix; the existing callers (`memory_test.ts`, `file_test.ts`) just import the function under its new path and name.

The `*_test.ts` suffix is preserved for unit / integration / e2e files because that's what Deno's discovery uses; renaming to `.test.ts` is out of scope (and would also touch every CI invocation pattern we use).

**Alternative considered:** make the bucket assignment explicit via a per-file pragma comment. Rejected — the suffix already encodes intent unambiguously and is searchable.

### Decision 3: `deno.json` `exports` becomes a map for `@keni/role-runtimes`

`packages/role-runtimes/deno.json` switches from:

```json
"exports": "./src/main.ts"
```

to:

```json
"exports": {
  ".": "./src/main.ts",
  "./test-fakes": "./tests/fakes/mod.ts"
}
```

The new `tests/fakes/mod.ts` barrel re-exports `FakeWorkspaceProvisioner`, `FakeWorkspaceProvisionerCall`, `FakeWorkspaceProvisionerOpts`, `createFakeCodingAgentInvoker`, `FakeCodingAgentInvokerHandle`, `FakeCodingAgentInvokerOpts`. Cross-package callers update from:

```ts
import { FakeWorkspaceProvisioner } from "@keni/role-runtimes";
```

to:

```ts
import { FakeWorkspaceProvisioner } from "@keni/role-runtimes/test-fakes";
```

The default barrel (`./src/main.ts`) drops its re-exports of the fake types — it now exposes only what production code is allowed to import (interfaces, the `Git` provisioner, the registry, the cycle wrapper, prompts).

**Why a secondary export rather than a separate package:** keeping fakes in the same package they pair with means a single `deno install` resolves both sides and the workspace lock file pins one version. A `@keni/role-runtimes-test-fakes` workspace member would multiply boilerplate (deno.json, README, test of its own, etc.) for zero functional gain.

**Why not put fakes inside `src/test/` and keep the single string export:** it would re-introduce the smell this change is removing — test-only code under `src/`. The workspace `exports`-as-map is the Deno-native seam for "expose this without putting it in the prod entry point".

**Why `@keni/server`'s `fakeClock` does not need a secondary export:** it's only used by tests in the same package, so it just moves to `packages/server/tests/fakes/fakeClock.ts` and its test (`scheduler_test.ts`, now under `tests/unit/scheduler/scheduler_test.ts`) imports it via a relative path.

### Decision 4: Production-side `tests/`-aware import seams stay out of `src/`

Two production files currently reference test-only types in JSDoc:

- `packages/role-runtimes/src/engineer/workspace/interface.ts` — mentions `FakeWorkspaceProvisioner` in a doc comment.
- `packages/server/src/scheduler/registry.ts` — mentions `fakeCodingAgentInvoker` in a doc comment.
- `packages/server/src/runServer.ts` — mentions `FakeWorkspaceProvisioner` in a doc comment.
- `packages/cli/src/start/mod.ts` — mentions `FakeWorkspaceProvisioner` in a doc comment.

These are JSDoc references only (no `import` statements). They stay as plain text — production code never imports test fakes. The doc strings are updated to point readers at `@keni/role-runtimes/test-fakes` instead of the old `src/.../fakes/` path.

### Decision 5: Structural enforcement via a single test in `@keni/shared`

A new test file `packages/shared/tests/unit/repoLayout_test.ts` walks `packages/*/src/**` and asserts no file matches `*_test.{ts,tsx}`, no directory named `fakes/` exists under `src/`, and no file named `contract_test.ts` exists. It also asserts every package has a `tests/` directory. The test runs as part of `deno task test` and so any contributor accidentally re-introducing a `*_test.ts` file under `src/` gets a red CI without needing a separate linter.

**Why `@keni/shared`:** the repo-layout invariant is shared across packages, and `@keni/shared` already houses cross-package contract tests (the storage contract helpers); putting the structural test here keeps it discoverable.

**Alternatives considered:** a dedicated `@keni/repo-tools` package or a Deno script wired into a new `deno task lint:layout`. Rejected — both add tooling for one assertion; a single Deno test is the smallest reversible commitment.

### Decision 6: Migration runs as one atomic OpenSpec change

The 107-file move is a single change because:

- Splitting per-package would leave the repo in a hybrid state (some packages enforced, some not) for the duration of the chain, and the structural test must go in last (otherwise it red-lights every intermediate commit).
- The cross-package `@keni/role-runtimes/test-fakes` export rewires both producer and consumers; partial application leaves unresolvable imports.
- Tests pass or fail as a single unit; bisecting a bad import path is straightforward when the move is one commit.

The commit ordering inside the change is: (1) add `tests/fakes/mod.ts` and the new `exports` map; (2) move fakes to `tests/fakes/`; (3) move tests in mirror order, batched per package; (4) rename and move the four contract helpers; (5) update consumer import paths; (6) add the structural test; (7) update READMEs and the developer-setup spec; (8) run `deno task fmt && lint && check && test`.

## Risks / Trade-offs

- **[Risk]** Relative imports inside moved files have to climb three levels (`../../../src/...`) instead of staying within a package directory.
  → **Mitigation:** the climb depth is uniform across all moved files and trivially scriptable; tests pass or fail loudly. Future contributors can use the path-mapping in `deno.json` if relative noise becomes painful — but no remap is in scope here.

- **[Risk]** A consumer outside the monorepo (none today) importing `FakeWorkspaceProvisioner` from `@keni/role-runtimes` would break.
  → **Mitigation:** there are no external consumers — Keni is locally-run software and `@keni/*` packages are not published to JSR/npm. This is documented as a deliberate **BREAKING** change in the proposal.

- **[Risk]** Deno workspace tooling versions older than 2.7 may not handle `exports`-as-map cleanly.
  → **Mitigation:** the repo pins Deno 2.7.x via `.tool-versions`; `exports`-as-map has been stable since Deno 1.42. CI runs `deno install --frozen` against the pinned minor.

- **[Risk]** `deno test`'s recursive discovery may find tests in unexpected places (e.g. the new `tests/contracts/<artifact>StoreContract.ts` files don't end in `_test.ts`, so they will NOT be auto-loaded — which is correct — but a careless rename back to `_test.ts` would re-trigger the no-op-test problem).
  → **Mitigation:** the structural test asserts `tests/contracts/` files do NOT end in `_test.ts`. Drift gets caught immediately.

- **[Trade-off]** The `tests/unit/` mirror means moved tests are physically further from the source they cover (a `Cmd-P` away rather than a sibling). Reviewers and IDEs handle this fine; the pay-off is a single `tests/` directory you can grep / package / exclude.

- **[Trade-off]** Two `import` styles co-exist: production code imports `@keni/role-runtimes` (the default barrel), tests import `@keni/role-runtimes/test-fakes`. The split is the explicit signal we want — it makes "this is a test-only seam" obvious at the import site. The cost is one rule for contributors to remember.

- **[Risk]** `archived` capability specs occasionally name a co-located test path in their narrative (e.g. `packages/cli/src/start/start_e2e_test.ts` is referenced by name in `developer-setup`). Those references go stale after the move.
  → **Mitigation:** the same change that moves the file updates the (still-active, non-archived) `developer-setup` spec to point at the new path. Archived specs are not retroactively edited per OpenSpec convention; historical accuracy of an archive is acceptable drift.

## Migration Plan

This is a refactor, not a feature flag — it lands in one PR, atomically. Steps (executed by `/opsx-apply`):

1. Add `packages/role-runtimes/tests/fakes/mod.ts` re-exporting the two fakes' public symbols (the existing fake source files are still under `src/.../fakes/` at this point).
2. Update `packages/role-runtimes/deno.json` to use the `exports` map with the `./test-fakes` entry.
3. Move the fake files from `src/.../fakes/` to `tests/fakes/<mirrored>/` and update the barrel + their own unit tests to the new paths.
4. Move every other `*_test.ts(x)` file from `src/` to its `tests/<bucket>/` location, package by package, fixing relative imports as we go. Run `deno task test --filter=<pkg>` after each package to catch path errors early.
5. Rename and move the four `contract_test.ts` helpers; update their two callers per artefact (`memory_test.ts`, `file_test.ts`).
6. Rewrite cross-package fake imports (`@keni/server`, `@keni/cli`) to use `@keni/role-runtimes/test-fakes`.
7. Drop the fake re-exports from `packages/role-runtimes/src/main.ts` so the production barrel no longer leaks them; also strip the same names from any matching `export type { ... }` blocks.
8. Add `packages/shared/tests/unit/repoLayout_test.ts` — the structural enforcement test.
9. Update `packages/role-runtimes/README.md` (file-tree section) and `packages/shared/src/storage/README.md` (any `contract_test.ts` references) to match.
10. Update the `developer-setup` capability spec with the new requirement (one `## ADDED Requirements` block per the OpenSpec delta-spec format).
11. Final pass: `deno task fmt`, `deno task lint`, `deno task check`, `deno task test` — all must be green.

**Rollback:** if the move surfaces a structural problem post-merge, revert is a single `git revert <merge-sha>`; nothing on disk outside the repo (workspaces, projects, etc.) is touched by this change.

## Open Questions

None blocking. Decisions taken without escalating:

- **Bucket name for `*integration_test.ts` files vs `*_e2e_test.ts` files.** Decided: `tests/integration/` and `tests/e2e/` respectively. The proposal could have folded them into `tests/unit/`, but the suffix already says "this is not a pure unit test" — preserving that signal in the directory name carries the convention forward.
- **Whether to drop the `_test.ts` suffix on contract helpers.** Decided: yes. They're not tests; calling them tests was a Deno-discovery hack.
- **Whether `@keni/server` should also export its `fakeClock` via a `./test-fakes` map.** Decided: no — no other package imports it, and adding a secondary export for a non-shared symbol is overhead without payback. The structural test only requires "fakes live under `tests/`", not "every package has a `./test-fakes` entry".
