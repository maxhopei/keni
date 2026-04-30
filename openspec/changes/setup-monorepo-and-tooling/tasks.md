## 1. Repository initialisation

- [x] 1.1 Initialise the git repository, set the default branch to `main`, and make an empty-tree initial commit so subsequent commits are additive
- [x] 1.2 Add `git@github.com:maxhopei/keni.git` as the `origin` remote (do not push yet; a later task verifies CI end-to-end on the first real push)
- [x] 1.3 Add a root `LICENSE` file with the MIT license text (copyright holder: "Max Hopei"; year: the current calendar year)

## 2. Runtime baseline

- [x] 2.1 Install Deno 2.7.x locally (document the exact minor in the README); verify with `deno --version` — verified `deno 2.7.7` locally, pinned in `.tool-versions`
- [x] 2.2 Add `.tool-versions` at the repo root pinning `deno 2.7.x` (use the current 2.7 patch version at commit time) for asdf / mise users
- [x] 2.3 Confirm there is no `package.json` or `node_modules/` at the root — this is a Deno-native workspace, not a Node workspace

## 3. Root workspace configuration

- [x] 3.1 Author root `deno.json` with:
  - `"workspace"`: explicit list of the five member paths (`./packages/cli`, `./packages/server`, `./packages/spa`, `./packages/role-runtimes`, `./packages/shared`)
  - `"imports"`: `@std/assert` (shared across all package tests; otherwise empty)
  - `"compilerOptions"`: strict settings — `"strict": true`, `"noImplicitOverride": true`, `"noUncheckedIndexedAccess": true`, `"verbatimModuleSyntax": true`
  - `"fmt"`: narrowed during implementation to files this change owns (`packages/`, `README.md`) so the planning-era markdown isn't reformatted; `"lineWidth": 100`
  - `"lint"` and `"test"`: include `packages/` with Deno's default recommended rule set
- [x] 3.2 Author root `deno.json` `"tasks"` block:
  - `"lint": "deno lint"`
  - `"fmt": "deno fmt"`
  - `"fmt:check": "deno fmt --check"`
  - `"check": "deno check packages"`
  - `"test": "deno test -A"`
  - `"build": "deno task --filter=@keni/* build"`
- [x] 3.3 Run `deno install` once to materialise `deno.lock`; commit `deno.lock` at the repo root

## 4. Per-package scaffolding

Apply the same skeleton to every member. Do **not** add package-specific tooling (Vite, React, etc.) in this change; stack decisions are in `design.md` and wiring lands in later steps.

- [x] 4.1 Create the five directories under `packages/`: `cli`, `server`, `spa`, `role-runtimes`, `shared`
- [x] 4.2 For each package, author `deno.json` with:
  - `"name": "@keni/<pkg>"`
  - `"version": "0.0.0"`
  - `"exports": "./src/main.ts"`
  - `"tasks": { "build": "echo noop" }`
- [x] 4.3 For each package, create `src/main.ts` with a single placeholder export (e.g., `export const packageName = "@keni/<pkg>";`)
- [x] 4.4 For each package, create `src/main_test.ts` using Deno's built-in test runner (`Deno.test`) with one trivial test that imports and asserts on `packageName` — this proves the lint → check → test pipeline exercises that package
- [x] 4.5 Verify workspace bare-specifier resolution end-to-end: added a throwaway import of `@keni/shared` into `packages/cli/src/main_test.ts`, confirmed `deno task test` resolved the bare specifier and passed, then reverted
- [x] 4.6 Run `deno task test` at the repo root and confirm all five packages contribute an executed test — 5 passed, 0 failed

## 5. Repository hygiene files

- [x] 5.1 Author `.editorconfig` covering file types `deno fmt` does not format (e.g., shell scripts, Dockerfiles, `.env.example`): UTF-8, LF line endings, final newline, trim trailing whitespace, indent style and size
- [x] 5.2 Author `.gitignore` at the repo root covering: `.DS_Store`, `Thumbs.db`, editor directories (`.vscode/`, `.idea/`), `.env` and `.env.local`, any optional repo-local `DENO_DIR` (`.deno-cache/`), build output directories (`dist/`, `build/`), and coverage artefacts
- [ ] 5.3 After running `deno install` and `deno task build` on a clean working tree, confirm `git status` reports no untracked or modified files

## 6. README

- [x] 6.1 Author `README.md` with a title, one-sentence description sourced from spec §1, and a "Getting started" section listing the Deno version requirement and the exact command sequence: `deno install`, `deno task fmt`, `deno task lint`, `deno task check`, `deno task test`, `deno task build`
- [x] 6.2 Add a "Repository layout" section naming each of the five packages (`cli`, `server`, `spa`, `role-runtimes`, `shared`) with a one-line description derived from spec §8
- [x] 6.3 Add a short sentence in the SPA description (or a dedicated "SPA stack" note) stating that `packages/spa` will be built with React + Vite via `@deno/vite-plugin`, with Vite wiring to be added when the SPA gets real code (step 10 in the initial implementation plan)
- [x] 6.4 Add a "Conventions" section that locks the prompts-as-code rule: prompts live as TypeScript module exports inside the package that uses them, bundled at build time, never loaded from disk at runtime (reference spec §11#3 and §6.2)

## 7. Continuous integration

- [x] 7.1 Create `.github/workflows/ci.yml` that triggers on `push` to `main` and `pull_request` targeting `main`, running on `ubuntu-latest`
- [x] 7.2 In the workflow, check out the repo and use `denoland/setup-deno@v2` with `deno-version: v2.7.x` (matching `.tool-versions`); cache `$DENO_DIR` across runs via `actions/cache@v4` keyed on `hashFiles('deno.lock')`
- [x] 7.3 Add a step that runs `deno install --frozen` — the first Deno-invoking step after setup, will fail loudly if `deno.lock` is out of sync with `deno.json`
- [x] 7.4 Add steps running, in order, each as its own step so CI summaries pinpoint failures: `deno task fmt:check`, `deno task lint`, `deno task check`, `deno task test`
- [x] 7.5 Do not run `deno task build` in CI for this change — the `echo noop` stubs have nothing useful to verify; re-add `build` to CI in the first step that produces a real artefact

## 8. Verification

- [x] 8.1 Full task sweep on the local tree: `deno install` → `deno task fmt:check` → `deno task lint` → `deno task check` → `deno task test` → `deno task build` all exit `0` (the "fresh clone" variant is covered end-to-end by task 8.7's CI run against a freshly-checked-out workspace)
- [x] 8.2 Second `deno install` on the same tree leaves `deno.lock` byte-identical (sha verified before/after)
- [x] 8.3 Deliberate `no-unused-vars` violation in `packages/shared/src/main.ts` caused `deno task lint` to exit non-zero and name the offending file and line; reverted
- [x] 8.4 Deliberate wrong-value `Deno.test` assertion in `packages/server/src/main_test.ts` caused `deno task test` to exit non-zero with 4 passed / 1 failed; reverted
- [x] 8.5 Removed a space from `packages/cli/src/main.ts`; `deno task fmt:check` exited non-zero naming the file, `deno task fmt` rewrote it, `deno task fmt:check` returned to green
- [ ] 8.6 Temporarily edit a `deno.json` import map and push; confirm CI's `deno install --frozen` step fails with a lockfile-mismatch message, then revert and push again to confirm CI returns to green
- [ ] 8.7 Push the initial commit(s) to `origin main` and open a dummy pull request (or confirm via a throwaway branch); confirm the CI workflow runs, every step passes, and the PR shows a green check

## 9. Hand-off

- [ ] 9.1 Cross-reference every requirement in `specs/developer-setup/spec.md` against the implemented state and confirm each scenario passes against the fresh clone
- [ ] 9.2 Do not touch `initial-implementation-plan/README.md` unless a dependency changed during implementation; this change is strictly additive
- [ ] 9.3 Note in the change archive readiness that step 02 (`storage-abstractions-and-file-impls`) is now unblocked
