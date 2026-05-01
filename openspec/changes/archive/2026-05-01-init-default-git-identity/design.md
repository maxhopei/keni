## Context

Step 03's `keni init` runs a deterministic plan (`git_init` → directory creation → `write_project_config` → `merge_gitignore` → `write_state_json` → `git_commit`) over a small `GitClient` abstraction. The `git_commit` action stages the planned paths and invokes `gitClient.commit(cwd, message)`. The default implementation (`packages/cli/src/init/git.ts` :: `defaultCommit`) shells `git commit -m <message>` without specifying an author — it relies on whatever identity git can resolve from the user's environment (per-repo config → per-user `~/.gitconfig` → per-user XDG → system config). When the resolution chain finds no `user.name` / `user.email`, git aborts with `fatal: empty ident name (for <committer@hostname>) not allowed` and exits 128. The existing `defaultCommit` propagates that as `GitOperationError`, the executor stops mid-plan, and `runInit` returns 1 with the canned `formatGitFailure` stderr message.

The CI runner (`ubuntu-latest`) is the canonical environment where this happens: `actions/checkout@v4` fetches the repo, but the runner image deliberately does **not** ship a global `~/.gitconfig` with identity. Every Keni test that exercises the full init pipeline therefore aborts at the commit step. The CI run on `main` ([#25211396931](https://github.com/maxhopei/keni/actions/runs/25211396931/job/73922621753)) currently shows `523 passed | 6 failed`, with the six failures clustered in:

- `packages/cli/src/init/init_integration_test.ts` — 5 failing tests:
  - `runInit :: fresh empty dir produces full layout, single commit, valid UUIDv4 project_id`
  - `runInit :: idempotent re-run on a clean project produces no new commits`
  - `runInit :: partial-state repair recreates missing tickets/ with byte-identical .gitkeep …`
  - `runInit :: existing .gitignore with custom entries is preserved verbatim, Keni entries appended`
  - `runInit :: existing non-empty non-repo dir does not touch unrelated files`
- `packages/cli/src/main_test.ts` — 1 failing test:
  - `runDispatcher: init <tempDir> succeeds end-to-end (smoke)`

The three remaining tests in `init_integration_test.ts` that *do* pass on CI either configure git identity locally before exercising commit (`runInit :: existing git repo with non-Keni history gains exactly one new commit` calls `configureGitInRepo` to set `user.email = ci@example.invalid` / `user.name = Keni CI`) or never reach a successful commit (`malformed project.yaml aborts repair` is testing the parse-error path; `subsequent runs preserve a pre-existing global config` ignores the first `runInit`'s exit code and asserts on the global-config side-effect, which lands before the commit step). The pattern confirms the bug: `runInit` works wherever git identity exists, fails wherever it doesn't.

The bug is invisible on a developer machine because the test harness `withEnv` overrides the `homeDir` argument passed to `runInit` (used to resolve `<home>/.keni/`) but does not override the `HOME` environment variable for spawned subprocesses. So when `Deno.Command("git", { args: ["commit", ...] })` runs, git inherits the developer's real `HOME` and reads the developer's real `~/.gitconfig`. Identity flows in from the developer's machine even though the test thinks it isolated the home directory. This is incidental, not by design — and it is exactly why the bug landed on `main`.

Several constraints shape the fix:

- **Spec § 7.1 contract.** `keni init` must "run in any folder" and "stage an initial commit". No spec text says identity must come from the user; the spec only says a commit must be produced.
- **No interactive prompts.** Per spec §6.2 / §11 the prototype is non-interactive — we cannot ask the user for their email at first run.
- **No persistent global / local git config writes.** `keni init` does not own the user's git environment; touching `~/.gitconfig` would surprise users and pollute their machine for unrelated commits.
- **Honour an existing user identity when one is set.** A developer who has `git config --global user.email "alice@example.com"` should see commits attributed to them, not to a generic `Keni`.
- **Stable, testable, RFC-compliant fallback identity.** The fallback's email must be unambiguously non-routable so it cannot accidentally land in a real inbox. The display name should match Keni's branding.
- **Preserve the small `GitClient` interface.** The interface is consumed by tests with fake clients; widening it adds surface that every test must adopt.

The bug is small. The fix is small. This design doc exists to pin the trade-offs (which fallback values, where the detection lives, how tests prove the path) so the implementation is mechanical.

## Goals / Non-Goals

**Goals:**

- `keni init` succeeds end-to-end on any environment with `git` on PATH but no `user.name` / `user.email` set in any git config (global, XDG, system, repo-local). The single initial commit is produced, the working tree ends clean, the success summary prints normally.
- The committer attribution falls back to a stable, documented identity (`Keni <keni@example.invalid>`) **only** when no user identity is reachable. When the user's git is configured (per-repo, global, or system), the user's identity is used verbatim — current behaviour is preserved bit-for-bit.
- The fallback applies for one `git commit` invocation. No `git config --global`, `git config --local`, or any other persistent state is written. A subsequent `git commit` performed by the user (or another tool) returns to whatever identity git would normally resolve.
- The `GitClient` interface signature stays stable. Identity handling is an implementation detail of `defaultCommit`, not a parameter the caller threads through.
- The CI run on `main` returns to green: the 6 currently-failing tests pass without changes to their assertions.
- The fallback path is covered by at least one unit test and one integration test, both of which run in environments that explicitly disable git's resolution of global / system config (so the test passes regardless of whether the host has a `~/.gitconfig` with identity).
- The capability spec (`project-layout`) gains one ADDED requirement that pins the contract; every existing requirement in the spec is unchanged.
- A reader of `git log` after `keni init` who sees `Keni <keni@example.invalid>` can map that back to documentation (the README) and learn how to override it for future commits.

**Non-Goals:**

- **No interactive prompt for the user's email.** `keni init` stays non-interactive (spec §11 #12).
- **No `git config --global` write to record the fallback.** That would silently take over the user's git for every other repo on the machine. Out of scope; explicitly rejected.
- **No `git config --local` write to record the fallback in the project repo.** That would surprise users on every subsequent `git commit` in this project, and it would persist into clones (engineer workspaces in step 09). Out of scope; explicitly rejected.
- **No new `GitClient` method or parameter.** A `commit(cwd, message, identity?)` shape would force every test fake to handle identity, and the caller would either always pass it or always receive default — both of which leak the choice into the call sites. Out of scope.
- **No fallback for downstream commits.** Step 09's engineer-workspace commits, step 25's `manual_override` commits, and any future commit produced by Keni outside `keni init` are NOT covered by this change. Each owning step decides its own identity policy. The fallback is `defaultCommit`-local to `@keni/cli/init`, not a shared library.
- **No success-summary line announcing the fallback.** Adding "committed as Keni <keni@example.invalid> because no git user.name / user.email is configured" to stdout is friendly but is UX scope creep for a bug fix; it can land additively in a follow-up if it proves valuable.
- **No CI workflow tweak to set git identity globally.** The fix belongs in the code, not in the workflow. A workflow tweak would mask the bug for CI but leave it broken for every real user running `keni init` on a fresh machine.
- **No retroactive change to `init_integration_test.ts`'s 5 currently-failing tests.** Their assertions stay verbatim; they pass on CI after this change because the underlying `runInit` no longer aborts. The new test added by this change explicitly covers the fallback-identity path that those 5 tests don't pin (their assertions are agnostic about who the committer is).
- **No spec change to `keni init` exit codes** (still 0 / 1 / 2 with the same trigger conditions). The previous "git commit fails → exit 1" failure mode for the identity-less case is *removed* (the commit no longer fails), but the exit-code surface for *other* git failures is unchanged.

## Decisions

### Decision 1: Identity fallback is delivered via `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment variables on the single `git commit` subprocess invocation

**Why:** these four env vars are git's documented per-invocation override channel for committer attribution (see `man git-commit` and `man git-config`'s "Environment Variables" section). They take precedence over every config layer for the duration of one process. Setting them on the `Deno.Command` env map applies them to the spawned `git` subprocess only — no parent-process leakage, no other subprocess affected, no config file touched. The variables are exactly the right granularity: one commit, one identity override, no side-effect.

The `git config user.name/user.email` resolution we use to *detect* the missing identity uses the same precedence chain git would use to *resolve* it during commit. So if `git config user.email` returns a non-empty value, we know `git commit` would also resolve it; we skip setting the env vars and let the user's identity flow through unchanged. There is exactly one source of truth for "is identity set" and it is `git config` itself.

**Alternatives considered:**

- **`-c user.name=Keni -c user.email=keni@example.invalid` flags on the git invocation.** Equivalent effect: `-c key=value` adds a config override for that command only. We pick env vars instead because (a) the env-var path doesn't grow the args list (cleaner with the existing `runGit(command, args, cwd)` helper, which already uses positional `args`), (b) env vars are a common idiom for this exact problem in other tools (`git lfs`, `git-imerge`, `git-revise` all use them when they need a deterministic identity), and (c) `Deno.Command`'s `env` field is a typed map, while building `["-c", "user.name=…", "-c", "user.email=…", "commit", ...]` interleaves identity config with the actual git command in the args array. The env-var path is also closer in spirit to what git's own porcelain does internally.
- **`git config --local user.name "Keni" && git config --local user.email "keni@example.invalid"`** (write per-repo config before the commit). Persistent in `<repo>/.git/config`. Surprises the user the next time they run `git commit` in this repo (their identity is silently overridden). Persists into clones if `<repo>/.git/config` is ever distributed (engineer workspaces in step 09 are sparse clones — they would inherit). Has the additional cost that we'd have to either leave the override in place forever or run a delete after the commit, which doubles the surface area. Rejected.
- **`git config --global …`** — same problem on a global scope. Rejected outright.
- **Refuse to commit and ask the user to configure git first.** Aligns with `cargo new`'s behaviour, but contradicts the spec's "non-interactive, just-works in any folder" promise. Rejected.
- **Skip the commit when identity is missing.** Aligns with "if there's nothing to commit, don't commit" but the existing tests assert on the commit's existence (`git log --oneline` shows exactly one commit). Skipping would break the existing tests AND leave the project in a half-bootstrapped state (`git status` would show `.keni/` as untracked). Rejected.

### Decision 2: Fallback identity is `Keni <keni@example.invalid>`

**Why:** the values need to be (a) stable so tests can pin them, (b) clearly Keni-attributable so a reader of `git log` knows where the commit came from, (c) RFC-compliant non-routable so the email cannot accidentally bounce somewhere unintended, and (d) consistent with the repository's own conventions for fake addresses.

Looking at the test suite for "what fake-but-valid email convention does this repo already use":

- `packages/cli/src/init/init_integration_test.ts` :: `configureGitInRepo` sets `user.email = "ci@example.invalid"` and `user.name = "Keni CI"`.
- `packages/cli/src/init/git_test.ts` :: `configureCommitter` sets `user.email = "ci@example.invalid"` and `user.name = "Keni CI"`.

Both use RFC 2606's reserved `.invalid` TLD. Per RFC 2606 §2, `.invalid` is permanently reserved as a top-level domain that DNS resolution will never resolve — exactly the property we want. We pick `keni@example.invalid` for the fallback (matching the repo's existing pattern, just rebranded from the test's `ci@…` to `keni@…` because `keni` is the actor that produces the commit, not "ci").

The display name is `Keni` (no suffix). `Keni CI` would imply this fallback is CI-specific; it is not — it applies to every identity-less environment, including a developer's first-run-on-new-laptop case. `Keni` keeps the attribution generic and consistent with the project name.

The full attribution is therefore:

```
Author: Keni <keni@example.invalid>
Committer: Keni <keni@example.invalid>
```

both lines because the `GIT_AUTHOR_*` and `GIT_COMMITTER_*` env-var pairs are independent and we set both to the same values (a single-author Keni commit; the user is conceptually neither author nor committer in the identity-less case).

**Alternatives considered:**

- **`Keni <keni@noreply.invalid>`** — `noreply` is a common subdomain hint but `.invalid` already does the no-DNS work. `example.invalid` is the canonical RFC 2606 example domain combined with the reserved TLD; cleaner.
- **`Keni Init <keni-init@…>`** — names the subcommand specifically. Slightly more precise but committers in `git log` typically don't carry sub-tool granularity; the project name is the right level. Rejected.
- **`<runner@<hostname>>` (or any computed value)** — this is what git tries when fully unconfigured, and it is exactly what produces the failing message we're trying to fix (`fatal: empty ident name (for <runner@<hostname>>)`). The value depends on the runner host's name, which is unstable, leaks the host's identity, and is what we are explicitly avoiding. Rejected.
- **`Keni <noreply@<project_id>.keni>`** — embeds the project's UUID. Stable per project, opaque to readers, and makes every fresh init produce a different committer email. The opacity is a liability (a reader of `git log` cannot search for "Keni's fallback" across multiple projects). Rejected; uniformity wins.

### Decision 3: Identity detection uses `git config user.name` / `git config user.email`, treating an empty stdout (with exit 1) as "not set"

**Why:** `git config <key>` writes the resolved value to stdout (one line, no key) and exits 0 when the key is set, or exits 1 with empty stdout when the key is unset. That is git's documented contract for "is this set". Using the same command git itself uses to resolve identity ensures we agree exactly on "set vs unset" — there is no path where we think identity is unset but git thinks it is set, or vice versa.

Implementation shape:

```ts
async function readGitConfigValue(cwd: string, key: string): Promise<string | null> {
  const result = await runGit("config", [key], cwd);
  if (result.code === 0) {
    const v = result.stdout.trim();
    return v === "" ? null : v;
  }
  // Exit 1 with no stderr means "not set". Any other failure mode
  // (unparseable config, permission error) is bubbled up as an error.
  if (result.code === 1 && result.stderr.trim() === "") return null;
  throw new GitOperationError(
    "config",
    [key],
    result.code,
    result.stderr.trim(),
    `git config ${key} failed in ${cwd}`,
  );
}
```

The check runs once per `commit` call, against the project's working tree (`cwd = projectPaths.root`). It is two short-lived `git config` subprocess calls (≤ 5 ms each) before the actual commit — negligible cost on the init path, which already runs `git init`, `git add`, and `git commit` plus several filesystem operations.

**Alternatives considered:**

- **`git var GIT_AUTHOR_IDENT`.** Returns the resolved author ident string (e.g., `Alice <alice@example.com> 1234567890 +0000`) when identity is set, and exits non-zero with the canonical "Author identity unknown" stderr message when it isn't. Functional, but requires parsing the formatted ident string and matching the error message text — more brittle than two `git config` calls. Rejected.
- **Read `~/.gitconfig` and `<repo>/.git/config` directly.** Reimplements git's config-resolution chain (which also includes XDG and system config). Always wrong in some edge case. Rejected.
- **Try the commit, catch the error, retry with fallback.** Two-phase commit-by-error-handling is brittle: the error message is locale-dependent and version-dependent (older gits say "Please tell me who you are", newer ones say "empty ident name"); pattern-matching it across versions is a maintenance hazard. Rejected.

### Decision 4: Identity handling lives entirely inside `defaultCommit`; the `GitClient` interface and the executor stay unchanged

**Why:** the `GitClient` interface (`isRepo`, `init`, `hasStagedOrUnstagedChanges`, `add`, `commit`) is a pre-existing abstraction with several test fakes (one in each `*_test.ts`). Adding a parameter or a new method means every fake gains code; for a problem that affects only the default implementation, that is the wrong place to put the fix. The interface guarantees "make a commit"; *how* the implementation sources the committer identity is a private concern of each implementation.

**Layout:**

```
packages/cli/src/init/
└── git.ts
    ├── runGit(command, args, cwd, env?)             — internal helper, +env param
    ├── readGitConfigValue(cwd, key)                 — new; private to git.ts
    ├── resolveCommitIdentityEnv(cwd)                — new; private to git.ts
    │     returns Record<string,string> | undefined  (undefined = identity is set, no override)
    └── defaultCommit(cwd, message)                  — modified; calls the helper
```

`resolveCommitIdentityEnv` returns `undefined` when both `user.name` and `user.email` are set (in any layer of git's config), and the four-key map otherwise:

```ts
{
  GIT_AUTHOR_NAME: "Keni",
  GIT_AUTHOR_EMAIL: "keni@example.invalid",
  GIT_COMMITTER_NAME: "Keni",
  GIT_COMMITTER_EMAIL: "keni@example.invalid",
}
```

`defaultCommit` calls `resolveCommitIdentityEnv(cwd)` once, passes the result through to `runGit("commit", ["-m", message], cwd, env)`, and behaves identically to today on every other axis.

Tests that consume the `GitClient` interface with their own fakes are unaffected — none of them invoke the default git client, so none of them touch this path.

**Alternatives considered:**

- **Add `commit(cwd, message, identity?: { name, email })` to the interface.** Requires updating every test fake in the codebase (4 files) and every call site (1 file in `executeActions`). Spreads the change across the codebase for no concrete benefit — no caller actually wants to pass a custom identity today. Rejected.
- **Extract identity resolution into a separate `gitIdentity.ts` module.** Reasonable for a larger feature, overkill for two helpers and an env map. The existing `git.ts` is ~170 lines; +25 lines keeps it under 200 and self-contained. Rejected as premature.
- **Resolve identity in the executor or in `runInit`.** The executor would need to know enough about git to decide; `runInit` would need a new dependency on the git client's identity-detection. Both move the concern away from where it belongs (the git wrapper). Rejected.

### Decision 5: Tests pin the fallback path under strict identity isolation (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `HOME=<tempDir>`)

**Why:** the existing test suite's `withEnv` helper does not isolate the spawned git's view of the user's identity. The 5 currently-failing-on-CI tests pass on dev machines because the developer's `~/.gitconfig` flows through. To prove the new fallback path is exercised — and that the test result is stable across "developer machine" and "CI runner" — the new tests must explicitly disable git's normal config resolution.

Git's documented escape hatches are:

- `GIT_CONFIG_GLOBAL=<path>` — overrides the location of the per-user global config. Setting it to `/dev/null` makes git read no global config.
- `GIT_CONFIG_SYSTEM=<path>` — same for system config (`/etc/gitconfig`). Setting it to `/dev/null` makes git read no system config.
- `HOME=<tempDir>` — git's fallback when `GIT_CONFIG_GLOBAL` is unset is `$HOME/.gitconfig`. Overriding `HOME` to a temp dir without a `.gitconfig` is a belt-and-braces measure for git versions that don't honour `GIT_CONFIG_GLOBAL` (very old gits — not relevant for the supported v2.30+ runtime, but harmless).

The new test helper `withGitIdentityIsolated(fn)` wraps `withEnv` and additionally sets these three env vars on the *current process* (`Deno.env.set` for the duration of `fn`, restored in `finally`). The spawned `git` subprocesses inherit them and resolve identity exclusively from the project's `<repo>/.git/config` — which is empty on a fresh `git init`, so the fallback path fires.

The 5 existing fresh-init tests are NOT migrated to this helper. They keep their current behaviour (identity flows from the dev machine's `~/.gitconfig` on the dev machine; identity is empty on CI and the fallback fires there). After this change, the 5 tests pass in both environments — the assertions don't depend on who the committer is, only that the commit exists. The new test pins the fallback identity verbatim (`Keni <keni@example.invalid>`) and runs under `withGitIdentityIsolated` so its result is deterministic on every host.

**Alternatives considered:**

- **Migrate the 5 existing tests to `withGitIdentityIsolated`.** Tighter isolation overall, but it makes the dev-machine path (where the user's identity flows through) untested from the integration layer. The honour-user-identity path then has only `git_test.ts`-level coverage, not integration-level. Keeping the split (5 honour-user-identity tests + 1 strict-fallback test) gives broader coverage. Rejected as an over-rotation.
- **Set `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` to empty strings in the test environment.** Empty env vars override config to *empty strings*, which git treats as "still empty" and aborts with the same error. So a test that sets them to empty strings would simulate "git commit fails" — but our new behaviour is "git commit succeeds because we set them to fallback values inside `defaultCommit`". The test would pass for a wrong reason (the env vars from the test propagate to the subprocess and override our in-`defaultCommit` settings). Rejected.
- **Use a fully fake `GitClient` for the fallback test.** Doesn't exercise the actual `runGit` / `Deno.Command` / git binary path that fails on CI. The whole point is to pin the real-binary behaviour. Rejected.

### Decision 6: Documentation lives in three places: the spec delta, the `git.ts` module doc-comment, and the README

**Spec delta** (`openspec/changes/init-default-git-identity/specs/project-layout/spec.md`): one ADDED requirement that names the fallback contract verbatim (committer values, no persistent config write, honour-user-identity). Future contributors looking at `openspec/specs/project-layout/spec.md` after archive will see the requirement next to the surrounding init-flow contracts; the committed scenarios pin the behaviour as test cases.

**Module doc-comment** (`packages/cli/src/init/git.ts`, top): one short paragraph naming what the module does, what changed, and where to look for the policy ("identity falls back to `Keni <keni@example.invalid>` when neither user.name nor user.email is set in any git config layer; see the `project-layout` capability spec for the full contract"). Today's doc comment says "No global config is touched; the user's `git config user.name` / `user.email` are honoured" — that line is updated to reflect the additive fallback.

**README** (`README.md`): one sentence in the existing "Run `keni init`" subsection explaining what users will see in `git log` if their environment has no git identity, and how to adopt their own identity for future commits (`git config --global user.email "..."` / `git config --global user.name "..."`). No reformatting of the section, just one line added.

The three locations cover three audiences: (1) the architect reading the capability spec to understand the contract, (2) the engineer reading the source to implement / debug, and (3) the user running `keni init` and reading the README. Each has just enough information for its audience and references the others.

## Risks / Trade-offs

- **[A user with malformed git config (e.g. `user.name` set but `user.email` empty) may see the fallback applied to BOTH name and email, overriding their partial identity.]** The `resolveCommitIdentityEnv` decision treats "either field missing" as "all four env vars set", so a user with `user.name = "Alice"` and no `user.email` ends up with a commit attributed to `Keni <keni@example.invalid>` instead of `Alice <…>`. → **Mitigation:** this is the semantically correct behaviour: a commit needs both name and email, and no value other than the fallback would be safe (we cannot invent `alice@<???>`). The README's one-line note instructs the user to configure `user.email` if they want their own identity. The alternative — set only the missing field — risks producing `Alice <keni@example.invalid>` commits, which is more confusing than `Keni <keni@example.invalid>`.
- **[A user who happens to have `Keni` as their literal git user.name finds their own commits attributed correctly to `Keni <their-email@…>`, but a reader of `git log` cannot distinguish those from the fallback.]** → **Mitigation:** the email is the discriminator. `Keni <keni@example.invalid>` is the fallback; `Keni <somethingelse@…>` is the user. The `.invalid` TLD makes the disambiguation unambiguous to anyone who reads RFC 2606. For readers who don't, the README is the documentation surface.
- **[The integration-test isolation helper depends on `GIT_CONFIG_GLOBAL=/dev/null` working on Windows.]** Windows has no `/dev/null`; the equivalent is `nul` (Windows device path). → **Mitigation:** Keni's prototype is Linux/macOS-targeted (deno + standard POSIX). Step 01 documents this. If Windows support lands later (post-MVP) this helper changes one line to detect the platform and use `nul` on Windows. Documented as a known limitation in the helper's doc-comment.
- **[A subprocess inheriting our process's env vars could see `GIT_CONFIG_GLOBAL=/dev/null` if the integration test forgets to restore env state.]** The test helper uses `try { … } finally { restore }` to restore env vars, but a process crash during the test would leave the dev machine's process env in a weird state. → **Mitigation:** Deno tests are spawned subprocesses themselves (`deno test`), so the parent shell's env is unaffected by anything the test does. The "leaked env" risk is contained to the test process which exits when the test finishes. No persistent damage.
- **[`git config user.name` could output a value containing only whitespace, which `.trim()` would treat as empty.]** Edge case: a user with `user.email = "   "` (whitespace) would have it treated as missing, and the fallback would fire even though the user "set" it. → **Mitigation:** this matches git's own behaviour — `git commit` with a whitespace-only email also fails with `fatal: empty ident name`. Treating whitespace as missing is the correct, identity-preserving choice.
- **[The fallback masks user-error: a user who forgets to configure git won't be told they did something wrong.]** Missing identity is genuinely fine for the common case (CI, fresh boxes), but it would help to surface a one-liner. → **Mitigation:** post-MVP enhancement, not in scope here. The README's one sentence is the user-facing breadcrumb. A future change can add a stdout line at fallback time.
- **[Env-var override of identity is overridden by `git -c user.name=...` flags in the user's `commit.template` or other tooling.]** If the user's git is set up with a `commit-msg` hook that calls `git -c user.email=…` internally, that runs *inside* our subprocess's env and could see the env vars we set, but the `-c` flag in their hook would win for any commit it triggers. → **Mitigation:** this is correct behaviour; user-configured hooks should win. The fallback is only the *default* identity for the init commit; if the user's tooling has stronger preferences, those preferences propagate.
- **[A test environment that already sets `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (e.g., a parent CI script) would have those values flow into our subprocess unchanged.]** Today's `defaultCommit` sets no env, so the parent's env wins. After this change, when `resolveCommitIdentityEnv` returns the fallback map, those vars are *replaced* (Deno's `env` field on `Command` replaces inherited env vars by key). → **Mitigation:** this is a regression of sorts — a parent that set `GIT_AUTHOR_NAME` expecting it to flow through would see it overridden when the *config*-level identity is missing. In practice the only callers that set these env vars are themselves wrappers like Keni, and they typically also set `git config`. The risk is theoretical; if it bites a real consumer, the fix is to only set a subset of the env vars (only the ones not already inherited) — a one-liner change.

## Migration Plan

Not applicable — additive fix. Rollback is `git revert` of the commit landing this change. No on-disk artefacts are produced or consumed differently before and after the change (the same `.keni/` tree, the same `project.yaml`, the same `.gitignore`, the same single git commit; only the committer header on environments without identity changes from "fatal error" to "Keni <keni@example.invalid>").

If the change ships and a user reports a problem with the fallback identity on a project where they later configure `user.email`, the remedy is: `git commit --amend --reset-author -m "Initialise Keni project"` after `git config --global user.email` is set. Documented in the README's one-sentence note.

## Open Questions

- **Should the fallback identity also include a `Co-authored-by:` trailer naming the runtime hostname / user account?** Could help debug "where did this commit come from" later. **Decision for this step:** no. Trailers are commit-message content, and changing the commit message would also require updating every `formatFreshInit` test that asserts on the message text. Out of scope for a bug fix; revisit if commit provenance becomes a real need.
- **Should the README include a verbatim `git log -1` example showing what the commit looks like with and without user identity?** Friendly documentation, slightly verbose. **Decision for this step:** no. One sentence is enough; a contributor or user who wants the example can run `keni init` themselves. Revisit when the README's init section is restructured (likely in step 13's `keni start` introduction).
- **Should `defaultCommit` warn-log to stderr when the fallback fires?** Useful for power users who want to know; potential noise for the common case. **Decision for this step:** no. Stick to the existing stdout summary. A `--verbose` flag on `keni init` (which the prototype does not have) would be the right channel. Out of scope.
- **Should the spec delta also mention the env-var implementation as a normative requirement (e.g., "SHALL use `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars and SHALL NOT write to `git config --local` or `--global`")?** Pinning the no-persistence-write part is meaningful; pinning the env-var mechanism is implementation detail that ties future contributors' hands. **Decision for this step:** the spec delta names the no-persistent-config-write contract verbatim and leaves the mechanism (env vars vs `-c` flags) as an implementation choice. Pinning the *observable behaviour* (no config files modified) without pinning the *implementation* keeps the spec at the right level of abstraction.
