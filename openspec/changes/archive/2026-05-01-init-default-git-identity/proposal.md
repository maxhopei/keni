## Why

Step 03's `keni init` produces a single initial commit covering the `.keni/` scaffold (per `spec.md` §7.1: "stages an initial commit covering `.keni/` so the project is committable from the start"). The default git client (`packages/cli/src/init/git.ts` :: `defaultCommit`) shells `git commit -m "..."` without specifying an author or checking that one is configured. That works on a developer's workstation because the user typically has `user.name` / `user.email` set in `~/.gitconfig`, but it fails on every environment that lacks a global git identity — most prominently the GitHub Actions runner where Keni's own CI runs (`ubuntu-latest`, no preconfigured `~/.gitconfig`), but also fresh Docker images, dev-container bootstraps, and any first-time install on a machine where the user has never run `git config --global`.

CI run [#25211396931](https://github.com/maxhopei/keni/actions/runs/25211396931/job/73922621753) on `main` reports `523 passed | 6 failed`, with all six failures collapsing into the same diagnostic from git: `Author identity unknown — fatal: empty ident name (for <runner@…>) not allowed`. The failures are concentrated in two test files — five fresh-init paths in `packages/cli/src/init/init_integration_test.ts` and the end-to-end smoke test in `packages/cli/src/main_test.ts` — and the root cause is one line in `defaultCommit`. The bug also masks the broader symptom: locally on a developer machine the bug is invisible because `withEnv` overrides `homeDir` (a `runInit` parameter) but does not override the `HOME` environment variable for the subprocess git, so git still reads the user's real `~/.gitconfig` and identity flows through. The bug is real on every clean install; the local test harness just hides it.

This change closes the gap so `keni init` is non-interactive and just-works on every environment its README claims to support — fresh CI runner, blank Docker image, first-time install on a personal machine — without asking the user to run `git config --global` first. It also restores green CI on `main` (the immediate symptom) and removes a class of failures from the matrix every downstream change inherits.

## What Changes

- Detect git identity inside `defaultCommit` (`packages/cli/src/init/git.ts`):
  - Before invoking `git commit -m <message>`, query `git config user.name` and `git config user.email` against the project's working tree (this honours the layered precedence: per-repo > per-user-global > per-user-XDG > system).
  - If both values are non-empty, invoke `git commit` exactly as today — committer attribution is the user's, behaviour is identical to the current implementation.
  - If either is missing or empty, invoke `git commit` with the four standard env vars `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` set to `Keni` and `keni@example.invalid` respectively. The env vars apply to that single subprocess invocation only — no `git config --global`, no `git config --local`, no persistent state, no surprise next time the user runs git in this repo.
- Extend `runGit` (the internal helper in `git.ts`) to accept an optional `env` map and pass it as the `env` field on `Deno.Command`. The signature change is internal — the public `GitClient` interface is unchanged, every existing call site keeps working without modification.
- The fallback identity uses RFC 2606's reserved `.invalid` TLD (`keni@example.invalid`) so the address is unambiguously non-routable and matches the convention already used by `init_integration_test.ts` :: `configureGitInRepo` (`ci@example.invalid`). The display name `Keni` matches the project name. No PII, no implementation-detail (no hostname, no UUID, no timestamp) leaks into the committer line.
- Add unit tests to `packages/cli/src/init/git_test.ts` (~3 new tests):
  - `commit` succeeds and produces a commit attributed to `Keni <keni@example.invalid>` when invoked in a repo with no `user.name` / `user.email` configured (the test sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` for the subprocess so the fallback path is exercised regardless of the host's `~/.gitconfig`).
  - `commit` produces a commit attributed to the configured `user.name` / `user.email` when those are set in the local repo, even with `GIT_CONFIG_GLOBAL=/dev/null` (proving the fallback only kicks in when identity is absent, not when global is unreachable but local is set).
  - `commit` does not write any persistent git config — after the call, `git config --get user.name` / `user.email` in the repo still return their pre-call values (empty in the fallback case, the configured value in the user-identity case).
- Extend `init_integration_test.ts` with one new test asserting `runInit` succeeds and produces a single commit attributed to `Keni <keni@example.invalid>` when the test env strips git's view of any global config (`GIT_CONFIG_GLOBAL=/dev/null`, `HOME=<tempDir>`). This is the exact scenario that fails on CI today; pinning it as a test prevents regressions.
- Add an integration-test harness helper `withGitIdentityIsolated(fn)` in `init_integration_test.ts` (or its sibling test-utilities module) that wraps `withEnv` and additionally sets `GIT_CONFIG_GLOBAL=/dev/null` / `GIT_CONFIG_SYSTEM=/dev/null` / `HOME=<tempHome>` for the duration of the inner function. The five existing fresh-init tests are NOT moved onto this helper — they continue to use the user's real `~/.gitconfig` so the dev-machine "honours user identity" path keeps having coverage. Only the new test (and any future test that wants the CI-equivalent strict-isolation environment) uses the new helper.
- Extend the `project-layout` capability spec with one ADDED requirement covering the fallback contract (the existing "initialises git when needed and produces a single initial commit" requirement is left unmodified — its scenarios still pass; the new requirement is purely additive and orthogonal).
- Update `packages/cli/src/init/git.ts`'s module-level doc comment (currently says "the user's `git config user.name` / `user.email` are honoured") to reflect the additive fallback so a future contributor reading the file knows what the implementation guarantees and where the fallback lands.
- Update the root `README.md`'s "Run `keni init`" subsection (or whichever subsection documents init's contract) with one sentence naming the fallback so a user who later sees `Keni <keni@example.invalid>` in `git log` knows what it means and how to override it (run `git config --global user.email` and `user.name`, then re-amend or accept the existing commit).
- No changes to: the `GitClient` interface; `executeActions`; `planInit`; `inspectProjectState`; the success-summary messages in `messages.ts`; the `.gitignore` merge policy; the `project_id` generation; the `<home>/.keni/` bootstrap; any storage interface; any spec other than `project-layout`. The change is the smallest possible patch consistent with restoring CI green and meeting the spec's "just-works in any environment" UX promise.
- No CI workflow change. The CI workflow at `.github/workflows/ci.yml` could be patched to `git config --global user.email/name` before `deno task test` and that would also unblock CI, but it would not fix the bug for the actual users running `keni init` on their own fresh machines / Docker images. Fixing the code is the right place; the CI workflow stays clean.

## Capabilities

### New Capabilities

None. Every change in this proposal lands inside the existing `project-layout` capability.

### Modified Capabilities

- `project-layout`: add a single requirement covering the git-identity fallback contract. The new requirement is structurally additive: the existing "`keni init` initialises git when needed and produces a single initial commit" requirement (and every other requirement in the spec) is unchanged, both in wording and in the scenarios it pins. Today's tests for the existing requirement continue to satisfy it; the new requirement has its own scenarios that pin the fallback path explicitly.

## Impact

- **Affected code:**
  - `packages/cli/src/init/git.ts` (modified) — `defaultCommit` gains identity detection and a per-invocation env-var fallback; the internal `runGit` helper gains an optional `env` parameter; the module-level doc comment is updated. Net diff: ~25 lines added, ~3 lines modified.
  - `packages/cli/src/init/git_test.ts` (modified) — 3 new unit tests for the fallback / honour-user / no-persistent-write paths, plus one shared test helper to launch `git` subprocesses with `GIT_CONFIG_GLOBAL=/dev/null` for strict isolation. Net diff: ~80 lines added.
  - `packages/cli/src/init/init_integration_test.ts` (modified) — one new test pinning the CI-equivalent identity-isolated path; one new test helper (`withGitIdentityIsolated`). Net diff: ~50 lines added.
  - `openspec/specs/project-layout/spec.md` (effectively modified via the change's delta in `specs/project-layout/spec.md`) — one new ADDED requirement plus its scenarios.
  - `README.md` (modified) — one sentence in the init subsection naming the fallback identity and how to override it.
- **Affected APIs / contracts:**
  - **Public CLI:** unchanged. `keni init` accepts the same arguments, exits with the same codes, prints the same success summary lines, and produces the same on-disk layout. The only observable difference is that, when run in an identity-less environment, the initial commit is now attributed to `Keni <keni@example.invalid>` instead of producing exit code 1 and `fatal: empty ident name`.
  - **`GitClient` interface:** unchanged. `commit(cwd, message)` keeps its signature; identity handling is an implementation detail of the default client.
  - **`@keni/cli` exports:** unchanged.
  - **`@keni/shared` storage interfaces:** unchanged.
- **Affected dependencies:**
  - **No new runtime dependencies.** `Deno.Command` already supports the `env` field; `git config --get` is a built-in subcommand.
  - **No new dev dependencies.**
- **Affected tests:**
  - **New (~4 tests):** 3 in `git_test.ts` for the unit-level fallback path, 1 in `init_integration_test.ts` for the integration-level CI-equivalent path. Estimated line count ~130.
  - **Unchanged:** every existing `git_test.ts` test (the tests that pass today still pass); every existing `init_integration_test.ts` test (the tests that pass today still pass — including the 5 currently-failing-on-CI tests, which will pass on CI after this change without any test modification); every other test in the suite.
- **Affected CI pipeline:**
  - **Direct effect:** CI run on `main` returns to green. The 6 currently-failing tests (5 in `init_integration_test.ts` + 1 in `main_test.ts`) start passing on the GitHub Actions runner because the fallback path supplies an identity that the runner's git can use.
  - **No workflow file change.** `.github/workflows/ci.yml` is unchanged.
- **Downstream steps unblocked:**
  - **Step 09 (engineer workspaces).** When step 09 lands and engineer subprocesses commit code in their workspace clones, they will use a different git client (probably one that records the agent's id as the author). This change does not affect step 09's choices — the fallback applies to `keni init` only, not to the role runtime. Step 09 designs its own author policy.
  - **Every step after 03 that runs `deno task test` in CI.** All future PRs and proposals get a green CI run because the underlying init bug is gone. This unblocks the next change (step 06 or whichever lands next) from inheriting a known-failing test count.
- **Non-impact (deliberate):**
  - **No persistent git config.** Neither `git config --global` nor `git config --local` is invoked. The user's `~/.gitconfig` is untouched. Re-running `git commit` in the project after `keni init` (manually, by an editor, by a script) returns to whatever identity the user has — no surprise lingering override.
  - **No interactive prompt.** `keni init` stays non-interactive. The fallback is applied silently when needed; the user can override it (for the next commit) by running `git config --global user.name/email` like any other repo.
  - **No new error code.** The `keni init` exit-code surface (0 / 1 / 2) is unchanged. The previous `fatal: empty ident name` failure (which was an exit-1 path through `formatGitFailure`) is replaced by a successful exit-0 path.
  - **No change to the success-summary line that names the project_id, the default agent, or the next-step hint.** The fallback identity does not surface in stdout in this change. (A future change MAY add a one-line note when the fallback is used, but that is out of scope here.)
  - **No change to `git log` formatting.** The commit message is still `Initialise Keni project …` exactly as today. Only the committer / author headers change, and only when no user identity is configured.
  - **No retroactive amendment of past commits.** This change applies to commits produced by `keni init` going forward.
