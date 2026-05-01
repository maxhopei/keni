## Context

Step 02 has landed: `@keni/shared` exports four storage interfaces (`TicketStore`, `PRStore`, `ActivityLogStore`, `ConfigStore`) plus their file-backed and in-memory adapters, the centralised id-generation module, the typed error model, the atomic-write helper, and the path resolvers (`resolveProjectPaths`, `resolveGlobalPaths`). Every adapter writes through `writeFileAtomic` (write-then-rename) and lazy-creates parent directories. `ConfigStore.writeProjectConfig` is the canonical path for writing `.keni/project.yaml`, and `readGlobalConfig` returns `{}` when `~/.keni/config.yaml` is missing. There is, however, **no `writeGlobalConfig`** — Decision 11 of step 02's design.md deferred it on the grounds that "the global file is created on install and edited manually in prototype". Step 03 picks up that deferral: `keni init` is the install action that creates the global file.

`@keni/cli` currently exports a placeholder `packageName` constant from `packages/cli/src/main.ts`; there is no command surface yet. The CLI member compiles, lints, and tests cleanly under `deno task *`, but its only test is a string-equality assertion against the package name. Building the `keni` command on top of this is greenfield work — every architectural choice is open.

Several spec principles drive this design:

- **§7.1 — `keni init` UX.** "Run `keni init` in an empty or existing folder. This initialises git if needed, creates the `.keni/` metadata directory, writes a `project.yaml` with a generated project id, and stages initial commits." The contract is precise: the command must work in either an empty folder or an existing folder, must initialise git if needed (and only if needed), must produce a `project.yaml` with a generated id, and must stage commits. The "On first use, Keni creates `~/.keni/` with an empty global `config.yaml`" sentence in the same section means the first ever `keni init` also bootstraps the user's global directory.
- **§5.1 — Project folder layout.** This step's job is to put the exact paths in §5.1 onto disk. `tickets/`, `prs/`, `activity/` are created up front (empty); `de-facto-spec/`, `changes/`, `chat/` are MVP and **must not** be created here.
- **§5.2 — Global directory layout.** `~/.keni/config.yaml` is the user-level defaults file. `~/.keni/workspaces/<project-id>/` is created lazily by step 09. `~/.keni/logs/` is created up front so the orchestration server has a place to write logs. Most critically, the spec calls out that the project id (in `project.yaml`) is what keeps engineer workspaces stable across project-folder renames — so generating and persisting `project_id` is non-negotiable.
- **§2#6, §11#5 — Files-first storage abstracted.** Even at init time, `keni init` writes `project.yaml` through `ConfigStore.writeProjectConfig`, not raw `Deno.writeTextFile`. Same for the global stub via the new `writeGlobalConfig`. The init code is at the composition root: it instantiates `FileConfigStore(projectPaths, globalPaths)` and calls the interface methods. This keeps the architectural commitment ("every consumer goes through an interface") true even for the bootstrap step.
- **§5.3 — `.keni/` write boundary.** `keni init` is a one-time setup action that runs *before* the orchestration server is up; there is no MCP/REST gating layer to go through, and no agent runtime exists yet. It is the user's CLI command, executing in their shell, with their permissions. Going through `ConfigStore` (an in-process interface) is enough — that interface is the §5.3 "API" boundary in this context.

Constraints and givens:

- Runtime is Deno 2.7+ (from step 01). All CLI code targets Deno; no Node-specific shims, no `node_modules`. Deno's permission model means `keni init` must be run with `-A` (or, more precisely, with the read/write/run permissions it needs); the entrypoint we ship configures this in the recommended `deno run` invocation and the README.
- `git` is an external dependency. The README already assumes git is on the path (step 01); we add `git init`, `git add`, and `git commit` to the assumed surface, plus `git rev-parse --git-dir` (or equivalent) for the "is this already a git repo?" check.
- The `@std/*` libraries pinned in step 02 (`@std/path`, `@std/fs`, `@std/uuid`, `@std/yaml`, `@std/assert`) are sufficient. UUID v4 is available in `@std/uuid/v4`; we already import `@std/uuid/v7` for activity log ids.
- The CLI must be runnable in two modes during the prototype: `deno run -A packages/cli/src/main.ts init [path]` (developer / CI) and (post-packaging) the actual `keni` binary on the user's PATH (out of scope for this step; lands in a packaging change).

Non-constraints (explicitly free to choose):

- Internal layout under `packages/cli/src/`.
- Argument parser (hand-rolled vs. `@std/cli`).
- Whether `state.json` ships with concrete fields or just `{}`. The cron scheduler (step 08) and PO chat queue (step 14+) own its real schema; we just need a placeholder.
- Whether `keni init` shells out to `git` via `Deno.Command` or via a thin abstraction. Either is fine; pick what tests well.
- Initial-commit strategy: one commit covering everything vs. `git init` + a Keni commit. Either is acceptable per the step file; pick one.

## Goals / Non-Goals

**Goals:**

- A `keni init [path]` subcommand exists in `@keni/cli` and, when run in any folder (empty or existing, repo or not), produces a project that satisfies the on-disk layout in `spec.md` §5.1 (prototype subset) plus a stable `project_id`, a working `.gitignore`, and an initial git commit covering the new files.
- The same command, run a second time on an already-initialised project, exits cleanly with exit code 0 and a clear message — no overwrites, no duplicate commits, no half-applied changes.
- The user's `~/.keni/` directory is bootstrapped on first ever `keni init`: directory exists, `config.yaml` stub written, `logs/` directory created. Subsequent `keni init` runs (in different projects) leave the global directory alone.
- `ConfigStore` gains `writeGlobalConfig` so both project- and global-level config writes go through the same atomic, single-writer-documented interface. The contract test enforces behavioural equivalence between file-backed and in-memory adapters for the new method, just like every other store method.
- `keni init` exits non-zero, with a clearly-categorised error message and **without** half-applied changes, when it encounters: a non-writable target directory, a partially-corrupt existing project (e.g., `project.yaml` with malformed YAML), a `git init` / `git commit` failure, or a `project_id` mismatch on idempotent re-run.
- Integration tests cover every documented case (fresh dir, existing repo, existing non-repo dir, existing `.gitignore`, partial state, idempotent re-run, golden layout). Tests run inside `Deno.makeTempDir()` against the real `git` binary; CI already has `git`.
- The `project-layout` capability spec exists, names the on-disk contract end-to-end, and is the document every later step reads to know what they can rely on.

**Non-Goals:**

- **No `keni start`.** That is step 13. The CLI dispatcher accepts `init` and reports an unknown-subcommand error for everything else; or, equivalently, prints a "not yet implemented" stub for `start`. The exact placeholder text is not load-bearing.
- **No engineer workspace clones.** `~/.keni/workspaces/<project-id>/<agent-id>/` is created lazily when an agent is added (step 09). `keni init` does not pre-create it. If the directory already exists from a previous Keni install, we do not touch it.
- **No `.keni/de-facto-spec/`, `.keni/changes/`, `.keni/chat/` directories.** Creating them now would mislead later steps into thinking the contract already covers them. Steps 14 and 15 add them.
- **No remote git.** No `git remote add`, no GitHub-specific behaviour, no SSH key checks. Local repo only, per spec §5.5.
- **No interactive prompts.** `keni init` is non-interactive in prototype: no "do you want to overwrite Y/N?", no "what name should this project have?". Defaults are derived deterministically (project name = directory basename); errors abort with a clear message asking the user to resolve manually.
- **No `--json` machine-readable mode** in this step. Human-readable stdout is enough for prototype. If a downstream tool needs machine-readable output, an additive change can add `--json`.
- **No coding-agent CLI installation check.** `keni init` does not verify that `claude`, `cursor-agent`, or any other configured CLI is on the path. That check, if it lands, is the engineer runtime's job (step 09) or a separate `keni doctor` command (post-MVP).
- **No upgrade / migration logic.** A Keni project initialised with this version stays this version. The `project.yaml` does not carry a Keni schema version field yet; if a later step needs one, it adds it additively.
- **No `state.json` semantics.** The skeleton has the placeholder shape, no more. Later steps own the real fields.
- **No prompt embedding work.** Prompts are a per-package concern (already documented in `developer-setup`); init does not touch them.
- **No `.env` template.** `.env` is git-ignored by `keni init`'s `.gitignore` merge, but no `.env.example` is created. Step 27 owns `.env`.

## Decisions

### Decision 1: CLI structure — flat subcommand dispatch in `main.ts`, one folder per subcommand under `src/`

**Why:** the prototype has two subcommands total (`init` now, `start` in step 13). A heavyweight command framework (Cliffy, oclif-style) is overkill; we want the dispatch to read like a `switch` and the subcommand bodies to live in their own files for testability.

**Layout:**

```
packages/cli/src/
├── main.ts                # entrypoint: parse argv, dispatch to a subcommand
├── main_test.ts           # existing placeholder; gets a help-text smoke test
├── init/
│   ├── mod.ts             # public entry: runInit(opts): Promise<InitResult>
│   ├── plan.ts            # pure function: project state → list of actions to take (idempotency lives here)
│   ├── execute.ts         # impure: applies the planned actions in order
│   ├── git.ts             # thin wrapper around the few git commands we need
│   ├── gitignore.ts       # parse + merge + serialise .gitignore
│   ├── messages.ts        # human-readable success / error messages
│   └── *_test.ts          # one test file per module, plus an integration test
└── (later) start/         # step 13 lands here
```

`main.ts`:

```ts
const [subcommand, ...rest] = Deno.args;
switch (subcommand) {
  case "init":
    Deno.exit(await runInit(parseInitArgs(rest)));
  case undefined:
  case "--help":
  case "-h":
    printHelp();
    Deno.exit(0);
  default:
    console.error(`Unknown subcommand: ${subcommand}\n`);
    printHelp();
    Deno.exit(2);
}
```

`runInit` returns an exit code (0 = ok, non-zero = error). It is a pure function over its inputs (`opts: InitOptions`) plus its filesystem effects, which makes it integration-testable end-to-end without a subprocess.

**Alternatives considered:**

- **Cliffy** (`jsr:@cliffy/command`). Mature, full-featured. Adds a dependency and an extra layer of indirection for two subcommands. Rejected for prototype scope; can be adopted in a later change if the CLI grows.
- **`@std/cli/parse-args`.** Useful for flag-rich subcommands. `init` has zero flags in prototype; we use a hand-rolled positional-argument parser for now. If `start` (step 13) needs flags, it can opt into `parseArgs` then.
- **One file per subcommand instead of a folder.** Works for `init` today but does not leave room for the half-dozen sub-modules `runInit` decomposes into. Folder-per-subcommand scales better.

### Decision 2: Plan-then-execute split — `plan(state)` returns actions, `execute(actions)` applies them

**Why:** idempotency and partial-state repair are easier to reason about and test as a pure function. Given the on-disk state (a `ProjectState` describing what already exists), `plan` returns a list of `InitAction`s to perform; `execute` performs them in order. Re-running `keni init` calls `plan` again over the now-updated state; if everything is in place, the action list is empty and `execute` is a no-op.

**Action shapes (sketch):**

```ts
type InitAction =
  | { kind: "git_init" }
  | { kind: "create_dir"; path: string }
  | { kind: "write_project_config"; config: ProjectConfig }
  | { kind: "write_state_json"; contents: StateJsonSkeleton }
  | { kind: "ensure_global_dir" }
  | { kind: "write_global_config_stub" }
  | { kind: "merge_gitignore"; entriesToAdd: string[] }
  | { kind: "git_commit"; paths: string[]; message: string };
```

`plan(state)` walks the state and emits the minimal action list that brings the project into compliance:

| State observed | Action emitted |
| --- | --- |
| `<root>/.git` missing | `git_init` |
| `<root>/.keni/` missing | `create_dir <root>/.keni/` |
| `<root>/.keni/tickets/` missing | `create_dir <root>/.keni/tickets/` |
| `<root>/.keni/prs/` missing | `create_dir <root>/.keni/prs/` |
| `<root>/.keni/activity/` missing | `create_dir <root>/.keni/activity/` |
| `<root>/.keni/project.yaml` missing | `write_project_config` (with newly-generated `project_id`) |
| `<root>/.keni/project.yaml` present | (no action; `project_id` preserved) |
| `<root>/.keni/state.json` missing | `write_state_json` |
| `<home>/.keni/` missing | `ensure_global_dir` |
| `<home>/.keni/config.yaml` missing | `write_global_config_stub` |
| `<root>/.gitignore` missing required entries | `merge_gitignore` (or `merge_gitignore` always, idempotent in `gitignore.ts`) |
| Any of the above changed something | final `git_commit` covering the changes |
| Nothing changed | empty list — exit "already initialised" |

**Alternatives considered:**

- **Inline imperative steps.** Faster to write, harder to test the idempotent path without filesystem fixtures. Rejected.
- **Dry-run mode.** Easy to add by stopping after `plan` and printing the action list. Useful for debugging; not in scope for the prototype, but the architecture supports adding it.

### Decision 3: `project_id` is UUIDv4

**Why:** the step's open decision explicitly suggests UUIDv4. v4 is universally available, opaque, collision-resistant for any realistic number of projects, and not time-ordered (so users don't infer creation order from id). We already pull `@std/uuid` for the v7 ids in `ActivityLogStore`; v4 is the same package.

**Generated as:** `crypto.randomUUID()` (Web Crypto API, available in Deno without any import) → e.g., `"a3f5b1c7-8e29-4d1a-9c4b-f5e7d8a9b0c1"`. We use the platform call directly rather than the `@std/uuid/v4` wrapper because the platform call is one line, matches the wrapper's behaviour, and avoids an extra import for a one-liner. This is documented in `init/mod.ts` JSDoc.

**Persistence:** the id is written to `project.yaml`'s `project_id` field by `ConfigStore.writeProjectConfig`. Once written, it never changes — even if the project folder is moved or renamed, the id stays stable, so engineer workspaces under `~/.keni/workspaces/<project-id>/` keep matching.

**Alternatives considered:**

- **UUIDv7.** Time-ordered. No benefit for project ids (we don't sort projects by creation time anywhere in MVP). Reserve v7 for activity log entries, where ordering matters.
- **Slugified directory name** (`my-app-7f2a`). Human-readable but not stable across renames — defeats the point of `project_id`.
- **User-supplied via `--id`.** No reason to expose this; collisions across projects on the same machine are user error. Rejected for prototype.

### Decision 4: Initial `project.yaml` content — minimum viable defaults derived from the directory

**Why:** the user runs `keni init` and gets a working project without further configuration. Defaults are deterministic so two `keni init` calls in similarly-named directories produce predictable, similar configs.

**Schema (matching the existing `ProjectConfig` interface):**

```yaml
project_id: <generated UUIDv4>
name: <basename of project root>
agents:
  - id: alice
    role: engineer
schedules:
  alice: "*/1 * * * *"   # every minute, prototype default
```

`stack` is intentionally unset in prototype. If a later step needs to derive a stack (e.g., `keni init --stack=deno-rest`), the additive change adds the flag and writes the field.

The single default agent (`alice`, role `engineer`) matches `spec.md` §8 ("One pre-configured engineer agent (default name: `alice`)"). Step 09 (engineer runtime) reads this entry to bootstrap the engineer's workspace; step 26 (multi-engineer) extends the roster.

**Schedule format:** cron-like 5-field strings. The scheduler in step 08 picks the parser; for now we just write the canonical `"*/1 * * * *"` (every minute) for the engineer, matching `spec.md` §6.1's prototype default. If step 08 picks a non-cron format, that step amends the defaults additively.

**Alternatives considered:**

- **Empty `agents` list, leave roster bootstrapping to step 09.** Possible, but then the prototype's `keni start` (step 13) has nothing to schedule on first run, which is a worse UX. Pre-populating with `alice` matches the spec and gives the user something visible.
- **Prompt for project name.** Non-interactive principle (see Non-Goals). Use the directory basename; the user can edit `project.yaml` afterwards.

### Decision 4b: Empty subdirectories are tracked via `.gitkeep` placeholders

**Why:** the spec's partial-repair scenario explicitly asserts that re-running `keni init` after `<root>/.keni/tickets/` is deleted produces _one new git commit covering the recreated directories_. Git does not track empty directories. To make that scenario realisable — and to keep a single, canonical answer to "is the project's `.keni/` tree intact?" — `keni init` writes a zero-byte `.gitkeep` file inside each of `<root>/.keni/tickets/`, `<root>/.keni/prs/`, and `<root>/.keni/activity/` on creation.

**Implications:**

- The "empty subdirectories" scenario in the project-layout spec means "contains no domain artefacts (no `ticket-*.md`, no `pr-*.md`, no `*.jsonl`)" — the lone `.gitkeep` placeholder is permitted, and the spec language is clarified accordingly.
- Inspector checks `<dir>/.gitkeep` for "this subdir is fully initialised". If either the directory or its `.gitkeep` is missing, the planner re-emits the create-with-gitkeep action so the next run heals the gap.
- `<root>/.keni/` itself does not need a `.gitkeep` because `<root>/.keni/project.yaml` is always tracked there.
- Domain stores (`FileTicketStore`, `FilePRStore`, `FileActivityLogStore`) ignore `.gitkeep` when listing. They were already required to ignore non-matching filenames per the storage spec; `.gitkeep` is one such name.

**Alternatives considered:**

- **No `.gitkeep`; partial-repair-of-empty-dirs produces no commit.** Honest in pure git terms but inconsistent with the partial-repair scenario in the project-layout spec. Adopting it would require softening that scenario across spec/design/tasks; `.gitkeep` is one localised file per subdir versus three artefact edits.
- **`README.md` placeholder per subdir.** Heavier, invites bikeshedding over content. `.gitkeep` is the universally-recognised idiom.

### Decision 5: `state.json` skeleton is `{ "watermarks": {} }` — a placeholder with intent

**Why:** spec §5.1 says `state.json` is "transient: active chat session id, conversation-to-CR checkpoint, conversation-to-CR queue, cron watermarks — git-ignored". Step 03 doesn't define those semantics, but writing an empty `{}` would be confusing — readers wonder if it's an error. `{ "watermarks": {} }` signals what the file is *for* without committing to a schema.

The cron scheduler (step 08) will add `watermarks: { alice: "<ISO timestamp>" }`-style entries; the PO runtime (step 14+) will add `chat_session_id`, `conversation_to_cr_queue`, etc. Both are additive and don't conflict with the placeholder.

The file is JSON, not YAML — matching the `.json` extension in spec §5.1. Written via `Deno.writeTextFile` (acceptable here because there is no `StateStore` interface yet; this file is owned by future steps' state managers, not by `storage`). When step 08 introduces a `StateStore`, it will own the writes; for now, `keni init` writes the skeleton directly with a one-line `Deno.writeTextFile` call, not through `writeFileAtomic` — the file is git-ignored, recreated on every server start, and a half-write at init time would just be a clear error the user can see and recover from.

**Alternatives considered:**

- **Don't write `state.json` at all.** `keni start` (step 13) can create it on first boot. Defensible. Rejected because: spec §5.1 lists `state.json` in the project layout; new contributors browsing a fresh project should see the file (and the comment in `.gitignore` explaining why it's not committed); `keni start` shouldn't have to bootstrap files that init is supposed to provide.
- **Atomic write via `writeFileAtomic`.** Heavier than needed for a git-ignored placeholder. The file's contents are unimportant; the *existence* matters. We can switch to atomic writes when step 08 introduces the real schema.

### Decision 6: Global directory bootstrap — `<home>/.keni/`, `<home>/.keni/logs/`, `<home>/.keni/config.yaml`

**Why:** spec §7.1 says: "Install the CLI (`keni`). On first use, Keni creates `~/.keni/` with an empty global `config.yaml`." `keni init` is the first command a user runs after installing, so it does the global bootstrap as part of its flow. Idempotent: subsequent `keni init` runs in different projects find the global directory already there and skip the bootstrap.

**What gets created:**

| Path | Action on init |
| --- | --- |
| `<home>/.keni/` | `ensureDir` (idempotent) |
| `<home>/.keni/logs/` | `ensureDir` (idempotent; server logs land here) |
| `<home>/.keni/config.yaml` | If missing, write `{}` via `ConfigStore.writeGlobalConfig` |
| `<home>/.keni/workspaces/` | **Not created.** Step 09 lazy-creates this when the first agent is added. |

Resolving the home directory: `Deno.env.get("HOME")` (POSIX) or `Deno.env.get("USERPROFILE")` (Windows). For the prototype, we target POSIX (macOS / Linux dev machines, Linux CI); Windows is post-MVP. We export a small helper `resolveHomeDir(env: typeof Deno.env): string` that throws a typed error if `HOME` is unset, so tests can inject a fake env to override.

**Why `writeGlobalConfig` and not raw `Deno.writeTextFile`:** consistency with `writeProjectConfig`. Both go through `ConfigStore`; both are atomic; both use the same single-writer documentation; both share the contract test. The init flow stays at the composition root: it builds the paths, builds the `FileConfigStore`, and calls the interface methods. There is no good reason to special-case the global file.

**The new `writeGlobalConfig` API:**

```ts
// packages/shared/src/storage/config/interface.ts
/**
 * Atomically write the global config. Replaces the on-disk file at
 * `<home>/.keni/config.yaml`. Lazy-creates the parent directory.
 *
 * Single-writer-per-artifact: see README. The user typically never has
 * two Keni processes writing the global file simultaneously, but the
 * documentation and atomicity guarantee match `writeProjectConfig`.
 */
writeGlobalConfig(config: GlobalConfig): Promise<void>;
```

File adapter implementation:

```ts
async writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await ensureDir(dirname(this.globalConfigPath));
  await writeFileAtomic(
    this.globalConfigPath,
    new TextEncoder().encode(stringify(config) /* @std/yaml */),
  );
}
```

In-memory adapter implementation: `this.globalConfig = structuredClone(config)`.

Contract-test scenarios added:

- `writeGlobalConfig({}) → readGlobalConfig() returns {}` (round-trip).
- `writeGlobalConfig({ log_level: "debug" }) → readGlobalConfig() returns { log_level: "debug" }`.
- `writeGlobalConfig` is idempotent (writing twice produces the same on-disk shape; the file adapter's atomic-write tempfile is cleaned up between calls).

File-adapter-specific test: `writeGlobalConfig` uses a same-directory tempfile for the rename (Decision 4 of step 02 generalises here).

**Alternatives considered:**

- **Skip global bootstrap; let the user create `~/.keni/config.yaml` by hand.** Spec §7.1 says Keni creates it; defying the spec without reason is wrong.
- **Lazy-create on first read.** `readGlobalConfig` already returns `{}` when the file is missing. But the directory creation must happen *somewhere* before anything reads the file (server logs in `~/.keni/logs/` need the parent), so init is the right place. Centralises bootstrapping.
- **Add `writeGlobalConfig` in a separate change.** Possible, but `keni init` is the only caller and it lands here; adding the method here keeps the change cohesive.

### Decision 7: `.gitignore` merge — additive, never destructive

**Why:** the user may already have a `.gitignore` they care about — language-specific entries (Python `__pycache__/`, Node `node_modules/`), editor entries (`.vscode/`), OS metadata (`.DS_Store`). `keni init` must not clobber any of those, must not reorder them, must not strip comments. It only ensures the Keni-required entries are present.

**Required entries** (from spec §5.1: ".gitignore — excludes .env, .keni/state.json, build artefacts" plus the runtime-equivalent for `node_modules`):

```
# Added by Keni — do not delete these entries unless you know what you are doing.
.env
.env.*
!.env.example
.keni/state.json
node_modules/
dist/
build/
```

**Merge algorithm (in `init/gitignore.ts`):**

1. Read the existing `.gitignore` if it exists (`Deno.readTextFile`); otherwise start from an empty string.
2. Parse into ordered lines (preserving comments and blank lines).
3. Compute the set of *required* entries that are not already present (string-matching on the non-comment portion of each line, with leading/trailing whitespace stripped).
4. If every required entry is already present: no action; the merge is a no-op.
5. Otherwise: append a marker comment (`# Added by Keni …`) then the missing entries, separated from the existing content by a single blank line if the file does not already end in one. Write the result via `Deno.writeTextFile` (atomicity is overkill here — `.gitignore` is small, idempotent, and a half-write produces an obvious diff the user notices in `git status`).

**Idempotency proof:** every required entry, once present, prevents itself from being re-added on the next run because step 3 already finds it in the parsed line set. The marker comment is added at most once because step 4 short-circuits when there are no missing entries.

**Alternatives considered:**

- **Overwrite the file with a Keni-managed template.** Trivial to implement, hostile to users with custom entries. Rejected.
- **Refuse to touch `.gitignore` if one already exists.** Forces the user to read the docs and manually add Keni's entries. Rejected — silent footgun for users who skip docs and then commit `.env`.
- **Match entries by regex (allow `*.env` to count as `.env`).** Over-engineered. We compare the full line. If a user already has `*.env`, they get an extra `.env` line; that's harmless (git treats them both as ignore patterns).

### Decision 8: Initial commit strategy — single commit covering all init changes

**Why:** the step file allows either "one commit" or "git init + one commit". Single commit is simpler to read in `git log` and easier to revert with `git revert HEAD` if the user wants to undo init. The commit message names what was added.

**Strategy:**

1. After all filesystem actions complete, run `git add` against the changed paths: `.keni/` (the new directory and its contents that should be tracked — `project.yaml` is tracked; `state.json` is **not** tracked because of the `.gitignore` line) plus the modified `.gitignore`. We add precise paths, not `git add .`, so we don't accidentally stage unrelated user changes.
2. Run `git status --porcelain` to confirm there is something to commit. If the working tree is clean (idempotent re-run), skip the commit.
3. `git commit -m "<message>"`. Message: `"Initialise Keni project (project_id: <id-prefix>)"` for fresh init, `"Update Keni project metadata"` for partial-state repair.

**`git init` is a separate prior step** (when needed). After `git init` we run `git status` so any already-staged files don't get folded into our commit; we only stage what we created.

**No author / email override.** The user's `git config user.name` and `user.email` are used. If they're unset, `git commit` will fail loudly — that's a git config problem, not a Keni problem; we surface the git error verbatim.

**No commit signing.** If the user has `commit.gpgsign = true`, `git commit` will respect it. We do not pass `--no-gpg-sign`.

**Alternatives considered:**

- **`git init` + first commit (Keni files) as two commits.** Minor benefit (cleaner separation in `git log`). Rejected — one commit is fewer moving parts and matches the step's "single commit covering `.keni/` scaffold" suggestion.
- **No commit at all; just stage.** Forces the user to run `git commit` themselves. Rejected — less ergonomic, and the spec says "stages an initial commit" (which we read as "stages **and commits**").
- **Use `--allow-empty` to always commit.** Rejected — silent re-init creating a fake "nothing changed" commit pollutes history.

### Decision 9: Idempotency contract — `keni init` is safe to re-run, repairs partial state, never overwrites `project.yaml`

**Why:** users will re-run init by accident, by intent (after `git clean -fdx` accidentally took out `tickets/`), or to script it. Re-running must be safe.

**Behaviour matrix:**

| Pre-run state | Post-run behaviour |
| --- | --- |
| Empty directory | Full init: git, `.keni/`, project config with new id, global bootstrap, gitignore, commit. |
| Existing git repo, no `.keni/` | Full init except `git init`. Initial commit covers the new `.keni/` and any gitignore changes. |
| `.keni/project.yaml` exists, all other directories present | No-op: print "already initialised" message with current `project_id`, exit 0. |
| `.keni/project.yaml` exists, but `.keni/tickets/` was deleted by user | Repair: re-create the missing directory and its `.gitkeep`, leave `project.yaml` untouched, exit 0. The git-commit handler stages the changes then runs `git status --porcelain`; if the recreated `.gitkeep` is byte-identical to the original (the common case for zero-byte placeholders), no commit is produced — the working tree is back to HEAD. If any tracked content actually differs, a single `"Update Keni project metadata"` commit lands. |
| `.keni/project.yaml` exists but is malformed | Error: refuse to repair (we cannot trust the project_id), print the parse error, exit non-zero. User must fix or delete and re-init. |
| `~/.keni/config.yaml` exists | Leave it alone (whether we are doing a repair or a fresh init). |
| `~/.keni/config.yaml` missing, but other Keni projects exist | Write the stub (we don't try to be clever; if the user has deleted it, they get the empty stub back). |

**Critical invariant:** `project_id` is *never* changed by `keni init` after the first run. If `project.yaml` exists and parses, its `project_id` is preserved. This is what keeps `~/.keni/workspaces/<project-id>/` stable.

**Implementation:** every action in the planner is idempotent on its own; the planner emits the action only when needed. `write_project_config` is in the action list **only** when `project.yaml` is missing. There is no "overwrite project.yaml" code path.

**Alternatives considered:**

- **`--force` flag to overwrite.** Tempting for "I know what I'm doing" users. Rejected for prototype: encouraging users to re-roll `project_id` will orphan their workspaces. If a user really wants a fresh init, they `rm -rf .keni` and re-run.
- **Refuse to re-run on already-initialised projects, exit non-zero.** Worse UX. The repair path (recreate missing tickets/ directory) is cheap and obviously correct.

### Decision 10: Git wrapper — thin module, `Deno.Command`-based, mockable

**Why:** all git interactions go through one module so tests can substitute a fake. We don't need a full `git` SDK for prototype; we need exactly five operations: `git init`, `git rev-parse --git-dir` (is this a repo?), `git status --porcelain` (is there something to commit?), `git add <paths>`, `git commit -m <message>`.

**API (`init/git.ts`):**

```ts
export interface GitClient {
  isRepo(cwd: string): Promise<boolean>;
  init(cwd: string): Promise<void>;
  hasStagedOrUnstagedChanges(cwd: string): Promise<boolean>;
  add(cwd: string, paths: readonly string[]): Promise<void>;
  commit(cwd: string, message: string): Promise<void>;
}

export function createDefaultGitClient(): GitClient {
  // wraps Deno.Command("git", { args: [...], cwd, ... })
}
```

`runInit` accepts an optional `GitClient` parameter (defaulting to `createDefaultGitClient()`); tests pass a fake. The fake records calls and produces canned responses, so unit tests can assert that we called `git init` exactly once on a non-repo, zero times on an existing repo, etc.

**Error handling:** every git call captures stderr; on non-zero exit, throws a typed `GitOperationError` carrying the command, exit code, and stderr. `runInit` catches these, prints a structured message ("Failed to <operation>: <stderr>"), and exits with code 1.

**Alternatives considered:**

- **`@std/cli` wrapping or `simple-git` (npm).** Heavy; unnecessary for five commands.
- **Use `Deno.Command` directly inline.** Couples tests to the real git binary, makes "what would happen if `git commit` failed" hard to test. Rejected.

### Decision 11: Argument parsing — hand-rolled positional argument, no flags

**Why:** the prototype's `init` accepts `keni init` (cwd) or `keni init <path>`. No flags. A hand-rolled parser is clearer than `parseArgs` for one positional argument.

**Parser (`parseInitArgs`):**

```ts
export interface InitOptions {
  readonly targetDir: string;  // absolute, validated
}

export function parseInitArgs(rest: readonly string[]): InitOptions {
  if (rest.length > 1) {
    throw new UsageError("keni init takes at most one positional argument: the target directory");
  }
  const target = rest[0] ?? Deno.cwd();
  return { targetDir: resolve(target) };  // @std/path resolve to absolute
}
```

If a future change wants `--json` or `--name`, it switches to `parseArgs` then. Document this in `init/mod.ts` JSDoc.

**Alternatives considered:**

- **`@std/cli/parse-args` from day one.** Six lines of boilerplate, three lines of logic, for one positional argument. Premature.

### Decision 12: Logging and exit codes — structured stdout, single-line summary on success

**Why:** the user runs `keni init` and wants to know what happened. The CLI prints a short summary covering: where the project was initialised, the `project_id`, what was created (or "already initialised; nothing to do"). On error, prints a clear message to stderr and exits non-zero.

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | Success (including idempotent no-op) |
| 1 | Filesystem or git error (target not writable, `git init` failed, parse error in existing project.yaml) |
| 2 | Usage error (unknown subcommand, too many arguments) |

**Stdout (success, fresh init):**

```
Initialised Keni project at /path/to/project
  project_id: a3f5b1c7-8e29-4d1a-9c4b-f5e7d8a9b0c1
  default agent: alice (engineer)

Next: run `keni start` to boot the orchestration server.
```

**Stdout (success, idempotent re-run, fully initialised):**

```
Project already initialised at /path/to/project (project_id: a3f5b1c7-8e29-…)
Nothing to do.
```

**Stdout (success, partial repair):**

```
Repaired Keni project at /path/to/project (project_id: a3f5b1c7-8e29-…)
  Re-created: .keni/tickets/, .keni/activity/
  Committed.
```

**Stderr (error, malformed project.yaml):**

```
Error: existing .keni/project.yaml is malformed and cannot be repaired automatically.
  Path: /path/to/project/.keni/project.yaml
  Underlying parse error: <YAMLException message>
  Fix the file by hand or remove .keni/ and re-run `keni init`.
```

Messages live in `init/messages.ts` so tests can assert on them and a future i18n change is a single-file edit.

**Alternatives considered:**

- **Verbose `--verbose` mode.** Defer; the success summary is concise enough.
- **JSON output mode.** Defer (see Non-Goals).

### Decision 13: Test layout — three concentric layers (unit, planner, integration)

**Why:** keeps the test pyramid tilted toward fast unit tests but still exercises the real `git` binary in a few high-value integration tests.

- **Unit tests** (`*_test.ts` next to source):
  - `gitignore_test.ts` — pure function, no I/O. Tests the merge algorithm exhaustively (empty file, file already containing all entries, file containing some, comments preserved, trailing newline preserved, etc.). Fast (sub-millisecond per case).
  - `plan_test.ts` — pure function over a `ProjectState` fixture. Tests every row of the behaviour matrix (Decision 9). Fast.
  - `git_test.ts` — uses `Deno.Command` against the real `git` binary in a temp dir. Tests `isRepo`, `init`, `hasStagedOrUnstagedChanges`, `add`, `commit` in isolation. Slower (~tens of ms per case) but high-value.
- **Integration tests** (`init_integration_test.ts`):
  - End-to-end `runInit` tests in temp dirs. Cover: fresh dir, existing repo, existing non-repo dir with files, existing `.gitignore`, partial state, idempotent re-run, golden-layout assertion. Each test asserts on:
    - `git log` (one commit, with the expected message).
    - The literal file tree under `.keni/` (using `Deno.readDir` and matching against an expected list).
    - The contents of `project.yaml` (parsed and compared field-by-field; `project_id` matches `/^[0-9a-f-]{36}$/` for fresh init, equals the pre-existing id on re-run).
    - `git status --porcelain` exits 0 with no untracked/modified files (i.e., we committed everything we created).
- **Cross-package**: a smoke test in `packages/cli/src/main_test.ts` that imports `runInit` from the new entry and runs it against a temp dir, to keep the entry point tested.

**Coverage target (informal):** every action in the planner has at least one integration test that exercises it.

**Alternatives considered:**

- **Mock the filesystem.** Deno doesn't have a stdlib filesystem mock; rolling one is more work than running `runInit` in `Deno.makeTempDir()`. Reject.
- **Skip the real-git tests; mock everything.** Rejected — we'd never catch e.g. a bad `git add` path. The few real-git tests are worth the test runtime.

### Decision 14: Error model — typed errors, propagated to a single top-level handler in `main.ts`

**Why:** consistent with `@keni/shared`'s error style (typed classes, stable `name`). Errors thrown inside `runInit` carry context (path, git stderr, parse error); `main.ts` catches everything, formats it, and chooses an exit code.

**Classes (in `init/errors.ts`, not exported beyond `@keni/cli`):**

- `UsageError` — bad argv shape (exit 2).
- `InitTargetError` — target dir does not exist, is not a directory, or is not writable (exit 1).
- `GitOperationError` — git binary failed (exit 1). Carries command, exit code, stderr.
- `ProjectStateError` — existing `project.yaml` malformed, or other unrecoverable inconsistency (exit 1).

`main.ts` has one `try / catch` around `runInit`:

```ts
try {
  const code = await runInit(opts);
  Deno.exit(code);
} catch (err) {
  if (err instanceof UsageError) { console.error(err.message); printHelp(); Deno.exit(2); }
  if (err instanceof InitTargetError) { console.error(formatTargetError(err)); Deno.exit(1); }
  if (err instanceof GitOperationError) { console.error(formatGitError(err)); Deno.exit(1); }
  if (err instanceof ProjectStateError) { console.error(formatStateError(err)); Deno.exit(1); }
  // Unknown — surface raw, exit 1
  console.error(`Unexpected error: ${err}`);
  Deno.exit(1);
}
```

**Alternatives considered:**

- **`Result<T, E>` algebraic types.** Same argument as in step 02's design — throws are idiomatic in Deno; subclasses give stable names and `instanceof` narrowing.
- **One catch per call site inside `runInit`.** Repetitive; the top-level handler is centralised and tested via integration tests.

### Decision 15: Where the new code lives in the workspace

**Why:** the change is mostly in `@keni/cli`, with a small additive piece in `@keni/shared`'s storage module. Both are existing workspace members; no new package.

**Files touched:**

```
packages/cli/src/
  main.ts                          (rewritten: dispatcher + help)
  main_test.ts                     (extended: smoke test for `init`)
  init/
    mod.ts                         (new — runInit entry)
    plan.ts                        (new — pure planner)
    plan_test.ts                   (new)
    execute.ts                     (new — executes actions)
    git.ts                         (new — git wrapper)
    git_test.ts                    (new — uses real git in temp dir)
    gitignore.ts                   (new — merge logic)
    gitignore_test.ts              (new — pure function tests)
    messages.ts                    (new — output strings)
    errors.ts                      (new — typed errors)
    init_integration_test.ts       (new — end-to-end in temp dirs)

packages/shared/src/storage/
  config/
    interface.ts                   (extended: writeGlobalConfig method)
    file.ts                        (extended: writeGlobalConfig impl)
    memory.ts                      (extended: writeGlobalConfig impl)
    contract_test.ts               (extended: round-trip scenarios)
    file_test.ts                   (extended: file-specific tests)
    memory_test.ts                 (extended: clone semantics)
  README.md                        (small addition: writeGlobalConfig note)

README.md                          (extended: keni init usage)
openspec/                          (new change directory + capability spec + storage delta)
```

No file outside this set is modified. `packages/cli/deno.json` does not change unless a new dependency is added (which it isn't, in the prototype).

**Alternatives considered:**

- **Move init into `@keni/shared`.** Bad layering — init is a CLI concern, not shared infrastructure.
- **Carve `@keni/init` as its own workspace member.** Three files for prototype is well below the threshold; revisit if init grows.

## Risks / Trade-offs

- **[Reliance on the user's `git` binary.]** If `git` is missing or too old, init fails. → Mitigation: the README already documents `git` as required; the error from `Deno.Command("git", …)` (ENOENT) is caught in `git.ts` and re-thrown as `GitOperationError("git not found on PATH; install git and re-run")`. Version-pinning is unnecessary — every git operation we use has been stable since git 1.7.
- **[Cross-platform paths.]** Windows uses `\` separators, drive letters, `USERPROFILE` instead of `HOME`. → Mitigation: use `@std/path` for every join; isolate the home-directory lookup in `resolveHomeDir(env)` so a Windows fallback can land additively. For prototype scope, we test on macOS and Linux only (matching CI).
- **[`writeGlobalConfig` race with another Keni process.]** A user running two `keni init`s in two different projects in parallel could race on `~/.keni/config.yaml`. → Mitigation: the file adapter uses `writeFileAtomic` (rename-based), which is the same single-writer-per-artifact contract documented for `writeProjectConfig`. The race produces last-writer-wins, no corruption. Add a sentence to `packages/shared/src/storage/README.md` extending the "single-writer" section to cover the global file.
- **[Idempotent re-run on a project at a stale Keni schema version.]** If a future Keni introduces `project.yaml` schema changes, an old `project_id`-only `project.yaml` may parse but be missing required fields. → Mitigation: this step does not introduce a schema version field. When a future step needs migrations, it adds the version field and a migration step. For now, parsed-`project.yaml` is honoured as-is.
- **[Half-applied state if the user ^Cs mid-init.]** SIGINT during `git commit` could leave a staged but uncommitted index. → Mitigation: the planner runs the commit *last*, after every filesystem mutation has succeeded. If the user ^Cs during commit, the project still has all the files in place, and re-running `keni init` (idempotent path) commits them. We do not catch SIGINT explicitly; the OS handles it.
- **[Initial commit pollutes existing users' git history.]** A user with a long-lived repo runs `keni init` in it; their commit graph gains a "Initialise Keni project" commit. → Mitigation: this is by design (the spec says "stages an initial commit"). Document the commit message clearly so users searching `git log` can find it.
- **[`.gitignore` merge corner cases.]** Users with weird CRLF line endings, BOM, or trailing-whitespace patterns might see Keni's appended block visually adjacent to existing entries. → Mitigation: parse with `text.split(/\r?\n/)` to normalise. If the user has `\r\n`, we preserve their line endings on existing lines and write Keni's appended block with `\n`; this is suboptimal but harmless (git treats both). If a user reports a real issue, we add a `gitignore_test.ts` case.
- **[Default schedule placeholder.]** Writing `"*/1 * * * *"` for the engineer means step 08 must support cron syntax (or accept the placeholder and replace it). → Mitigation: the cron scheduler change (step 08) is downstream; it picks the parser. If it picks something incompatible, it amends the `project.yaml` defaults additively in its own change.
- **[Error messages may leak filesystem paths.]** Exit-code-1 messages include paths under `<project-root>` or `<home>`. → This is intentional: the user needs to know which file failed. Sensitive paths are user paths, not secrets.
- **[Integration tests slow down CI.]** Five or six end-to-end `runInit` tests, each shelling out to git, add a few hundred ms. → Mitigation: the storage step's 200+ tests run in seconds; another half-second is fine. Revisit if it ever becomes a problem.
- **[`state.json` not via the storage abstraction.]** Step 03 writes it with `Deno.writeTextFile`, breaking the "everything goes through an interface" rule. → Mitigation: `state.json` is git-ignored, transient, and owned by future steps' state managers. The storage capability deliberately does not cover it (no `StateStore` yet). Step 08 (cron scheduler) introduces a `StateStore` interface and migrates the writes; until then, the one-line direct write is acceptable. Document this explicitly in the project-layout spec ("state.json is owned by future steps; init writes a placeholder").

## Migration Plan

Not applicable — additive to a greenfield CLI. No existing project state to migrate. Rollback is `git revert` of the change's commits.

If a user has hand-rolled their own `.keni/` layout before this change ships (unlikely; nothing has produced one), they should `git mv .keni .keni.bak` and re-run `keni init`, then merge their old contents back in. The change does not auto-migrate.

## Open Questions

- **`keni init` flag set.** Prototype ships zero flags. Likely additions in later steps: `--name <name>` (override the directory-basename default), `--agent <id> --role <role>` (add an additional engineer at init time, anticipating step 26), `--no-commit` (stage but don't commit, for users who want to inspect first). All deferable. → **Decision for this step:** zero flags; positional path argument only. Each future flag is a small additive change.
- **`keni start` placeholder.** Should `main.ts` reject `keni start` with "unknown subcommand", or print a "not yet implemented" stub? Either is fine; the user is not affected because step 13 lands soon. → **Decision for this step:** unknown-subcommand path (exit 2). Step 13 replaces the dispatcher branch.
- **Help text scope.** Should `keni --help` document `init` only, or list `init` + `start (coming soon)`? → **Decision for this step:** document `init` only. Step 13 adds `start`.
- **`writeGlobalConfig` API symmetry.** Should the file-backed `writeGlobalConfig` accept an `opts.fsync` like `writeFileAtomic`'s underlying call, or stay simple? → **Decision for this step:** stay simple. Match `writeProjectConfig`'s call pattern exactly; if the user wants `fsync`, they pass it via a future config flag.
- **`project.yaml` schema versioning.** Add a `keni_version: 0` field now to ease future migrations? → **Decision for this step:** no. Schema migration is post-MVP. When the first migration is needed, the change that introduces it adds the field and the migration logic.
- **Telemetry / first-run analytics.** Out of scope for prototype; flagging in case it ever needs to plug in. → No action.
- **Locale / encoding.** Project name derived from directory basename may contain non-ASCII characters. `@std/yaml` round-trips Unicode, so this is fine. → No action.
