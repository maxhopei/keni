## 1. Repository initialisation

- [ ] 1.1 Initialise the git repository, set the default branch to `main`, and make an empty-tree initial commit so subsequent commits are additive
- [ ] 1.2 Add `git@github.com:maxhopei/keni.git` as the `origin` remote (do not push yet; a later task verifies CI end-to-end on the first real push)
- [ ] 1.3 Add a root `LICENSE` file with the MIT license text (copyright holder: "Max Hopei"; year: the current calendar year)

## 2. Runtime baseline

- [ ] 2.1 Install Deno 2.7.x locally (document the exact minor in the README); verify with `deno --version`
- [ ] 2.2 Add `.tool-versions` at the repo root pinning `deno 2.7.x` (use the current 2.7 patch version at commit time) for asdf / mise users
- [ ] 2.3 Confirm there is no `package.json` or `node_modules/` at the root — this is a Deno-native workspace, not a Node workspace

## 3. Root workspace configuration

- [ ] 3.1 Author root `deno.json` with:
  - `"workspace"`: explicit list of the five member paths (`./packages/cli`, `./packages/server`, `./packages/spa`, `./packages/role-runtimes`, `./packages/shared`)
  - `"imports"`: empty or near-empty (no shared dependencies yet)
  - `"compilerOptions"`: strict settings — `"strict": true`, `"noImplicitOverride": true`, `"noUncheckedIndexedAccess": true`, `"verbatimModuleSyntax": true`
  - `"fmt"`: include globs for `packages/*/src` plus `**/*.md`; `"lineWidth": 100`
  - `"lint"`: include globs for `packages/*/src`; start with Deno's default recommended rule set
- [ ] 3.2 Author root `deno.json` `"tasks"` block:
  - `"lint": "deno lint"`
  - `"fmt": "deno fmt"`
  - `"fmt:check": "deno fmt --check"`
  - `"check": "deno check packages"`
  - `"test": "deno test -A"`
  - `"build": "deno task --filter=@keni/* build"`
- [ ] 3.3 Run `deno install` once to materialise `deno.lock`; commit `deno.lock` at the repo root

## 4. Per-package scaffolding

Apply the same skeleton to every member. Do **not** add package-specific tooling (Vite, React, etc.) in this change; stack decisions are in `design.md` and wiring lands in later steps.

- [ ] 4.1 Create the five directories under `packages/`: `cli`, `server`, `spa`, `role-runtimes`, `shared`
- [ ] 4.2 For each package, author `deno.json` with:
  - `"name": "@keni/<pkg>"`
  - `"version": "0.0.0"`
  - `"exports": "./src/main.ts"`
  - `"tasks": { "build": "echo noop" }`
- [ ] 4.3 For each package, create `src/main.ts` with a single placeholder export (e.g., `export const packageName = "@keni/<pkg>";`)
- [ ] 4.4 For each package, create `src/main_test.ts` using Deno's built-in test runner (`Deno.test`) with one trivial test that imports and asserts on `packageName` — this proves the lint → check → test pipeline exercises that package
- [ ] 4.5 Verify workspace bare-specifier resolution end-to-end: add a throwaway import in `packages/cli/src/main_test.ts` that imports `packageName` from `@keni/shared`, assert something about it, confirm it resolves, then remove the throwaway
- [ ] 4.6 Run `deno task test` at the repo root and confirm all five packages contribute an executed test

## 5. Repository hygiene files

- [ ] 5.1 Author `.editorconfig` covering file types `deno fmt` does not format (e.g., shell scripts, Dockerfiles, `.env.example`): UTF-8, LF line endings, final newline, trim trailing whitespace, indent style and size
- [ ] 5.2 Author `.gitignore` at the repo root covering: `.DS_Store`, `Thumbs.db`, editor directories (`.vscode/`, `.idea/`), `.env` and `.env.local`, any optional repo-local `DENO_DIR` (`.deno-cache/`), build output directories (`dist/`, `build/`), and coverage artefacts
- [ ] 5.3 After running `deno install` and `deno task build` on a clean working tree, confirm `git status` reports no untracked or modified files

## 6. README

- [ ] 6.1 Author `README.md` with a title, one-sentence description sourced from spec §1, and a "Getting started" section listing the Deno version requirement and the exact command sequence: `deno install`, `deno task fmt`, `deno task lint`, `deno task check`, `deno task test`, `deno task build`
- [ ] 6.2 Add a "Repository layout" section naming each of the five packages (`cli`, `server`, `spa`, `role-runtimes`, `shared`) with a one-line description derived from spec §8
- [ ] 6.3 Add a short sentence in the SPA description (or a dedicated "SPA stack" note) stating that `packages/spa` will be built with React + Vite via `@deno/vite-plugin`, with Vite wiring to be added when the SPA gets real code (step 10 in the initial implementation plan)
- [ ] 6.4 Add a "Conventions" section that locks the prompts-as-code rule: prompts live as TypeScript module exports inside the package that uses them, bundled at build time, never loaded from disk at runtime (reference spec §11#3 and §6.2)

## 7. Continuous integration

- [ ] 7.1 Create `.github/workflows/ci.yml` that triggers on `push` to `main` and `pull_request` targeting `main`, running on `ubuntu-latest`
- [ ] 7.2 In the workflow, check out the repo and use `denoland/setup-deno@v2` with `deno-version: v2.7.x` (matching `.tool-versions`); enable Deno's cache action input so `$DENO_DIR` survives across runs
- [ ] 7.3 Add a step that runs `deno install --frozen` — this must be the first Deno-invoking step and must fail loudly if `deno.lock` is out of sync with `deno.json`
- [ ] 7.4 Add steps running, in order, each as its own step so CI summaries pinpoint failures: `deno task fmt:check`, `deno task lint`, `deno task check`, `deno task test`
- [ ] 7.5 Do not run `deno task build` in CI for this change — the `echo noop` stubs have nothing useful to verify; re-add `build` to CI in the first step that produces a real artefact

## 8. Verification

- [ ] 8.1 From a fresh clone of the pushed branch, run `deno install` (confirm it completes without modifying `deno.lock`), then `deno task fmt:check`, `deno task lint`, `deno task check`, `deno task test`, `deno task build`; confirm every command exits `0`
- [ ] 8.2 Run `deno install` a second time on the same tree and confirm the second run does not modify `deno.lock` and does not re-download any modules
- [ ] 8.3 Introduce a deliberate lint violation in one package, run `deno task lint` at the root, confirm non-zero exit that names the offending file, then revert
- [ ] 8.4 Introduce a deliberate failing `Deno.test` assertion in one package, run `deno task test` at the root, confirm the aggregate exits non-zero while other packages' tests still run and report, then revert
- [ ] 8.5 Introduce an unformatted file, run `deno task fmt:check`, confirm non-zero exit; run `deno task fmt`, confirm it rewrites the file; run `deno task fmt:check` again, confirm zero exit
- [ ] 8.6 Temporarily edit a `deno.json` import map and push; confirm CI's `deno install --frozen` step fails with a lockfile-mismatch message, then revert and push again to confirm CI returns to green
- [ ] 8.7 Push the initial commit(s) to `origin main` and open a dummy pull request (or confirm via a throwaway branch); confirm the CI workflow runs, every step passes, and the PR shows a green check

## 9. Hand-off

- [ ] 9.1 Cross-reference every requirement in `specs/developer-setup/spec.md` against the implemented state and confirm each scenario passes against the fresh clone
- [ ] 9.2 Do not touch `initial-implementation-plan/README.md` unless a dependency changed during implementation; this change is strictly additive
- [ ] 9.3 Note in the change archive readiness that step 02 (`storage-abstractions-and-file-impls`) is now unblocked
