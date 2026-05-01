## ADDED Requirements

### Requirement: `keni init` is a CLI subcommand of `@keni/cli` and accepts an optional target directory

The `@keni/cli` package SHALL expose a CLI entry point whose `init` subcommand bootstraps a Keni project. When invoked with no positional arguments, `keni init` SHALL operate against the current working directory; when invoked with one positional argument, that argument SHALL be resolved to an absolute path and used as the target directory. Invocations with two or more positional arguments SHALL exit with a usage error (exit code 2). The subcommand SHALL be non-interactive: it MUST NOT read from stdin, MUST NOT prompt for input, and MUST exit cleanly even when run in environments without a TTY.

#### Scenario: `keni init` defaults to the current working directory

- **WHEN** a user runs `keni init` from inside `/path/to/project`
- **THEN** the command initialises a Keni project rooted at `/path/to/project`
- **AND** no further user input is required
- **AND** the command exits with status code 0 on success

#### Scenario: `keni init <path>` initialises the named directory

- **WHEN** a user runs `keni init /path/to/other-project`
- **AND** `/path/to/other-project` exists and is writable
- **THEN** the command initialises a Keni project rooted at `/path/to/other-project`
- **AND** the user's current working directory is unchanged

#### Scenario: Too many arguments produce a usage error

- **WHEN** a user runs `keni init foo bar`
- **THEN** the command exits with status code 2
- **AND** stderr contains a usage message naming the maximum-one-positional-argument rule

#### Scenario: Unknown subcommand produces a usage error

- **WHEN** a user runs `keni unknown-subcommand`
- **THEN** the command exits with status code 2
- **AND** stderr contains a usage message naming the available subcommands

### Requirement: After `keni init` succeeds, `<root>/.keni/` matches the prototype layout in `spec.md` §5.1

After a successful `keni init`, the project root SHALL contain a `.keni/` directory whose immediate children are exactly: `tickets/`, `prs/`, `activity/`, `project.yaml`, and `state.json`. The three subdirectories (`tickets/`, `prs/`, `activity/`) SHALL exist and SHALL contain no domain artefacts (no `ticket-*.md`, no `pr-*.md`, no `*.jsonl` files); each SHALL contain exactly one zero-byte `.gitkeep` placeholder file so the directory is tracked in git (per design.md Decision 4b). `project.yaml` SHALL be a parseable YAML file whose top-level value is a mapping. `state.json` SHALL be a parseable JSON file. The directories `de-facto-spec/`, `changes/`, and `chat/` SHALL NOT be created by `keni init` — those are reserved for MVP steps and SHALL appear only when their owning steps land.

#### Scenario: `.keni/` tree contains the prototype subset

- **WHEN** `keni init` completes successfully in an empty directory
- **THEN** `<root>/.keni/` exists as a directory
- **AND** `<root>/.keni/tickets/` exists as a directory
- **AND** `<root>/.keni/prs/` exists as a directory
- **AND** `<root>/.keni/activity/` exists as a directory
- **AND** `<root>/.keni/project.yaml` exists as a file
- **AND** `<root>/.keni/state.json` exists as a file

#### Scenario: MVP-only directories are absent

- **WHEN** `keni init` completes successfully in an empty directory
- **THEN** `<root>/.keni/de-facto-spec/` does not exist
- **AND** `<root>/.keni/changes/` does not exist
- **AND** `<root>/.keni/chat/` does not exist
- **AND** `<root>/.keni/workspaces/` does not exist (engineer workspaces live under `<home>/.keni/workspaces/<project-id>/`, never under the project)

#### Scenario: `tickets/`, `prs/`, `activity/` contain only `.gitkeep` after init

- **WHEN** `keni init` completes successfully in an empty directory
- **THEN** `<root>/.keni/tickets/` contains exactly one entry, named `.gitkeep`, and that entry is a zero-byte regular file
- **AND** `<root>/.keni/prs/` contains exactly one entry, named `.gitkeep`, and that entry is a zero-byte regular file
- **AND** `<root>/.keni/activity/` contains exactly one entry, named `.gitkeep`, and that entry is a zero-byte regular file
- **AND** none of the three subdirectories contain any `ticket-*.md`, `pr-*.md`, or `*.jsonl` files

### Requirement: `project.yaml` is written via `ConfigStore.writeProjectConfig` with the documented initial content

`keni init` SHALL write `<root>/.keni/project.yaml` by constructing a `FileConfigStore` and calling its `writeProjectConfig` method. `keni init` SHALL NOT call `Deno.writeTextFile` or any other filesystem primitive on `project.yaml` directly — every project-config write goes through the storage abstraction. The initial `ProjectConfig` SHALL contain a freshly-generated UUIDv4 `project_id`, a `name` equal to the basename of the project root, an `agents` list containing exactly one entry (`{ id: "alice", role: "engineer" }`), and a `schedules` mapping containing the entry `alice: "*/1 * * * *"`. The `stack` field SHALL be unset.

#### Scenario: Initial `project.yaml` has the documented shape

- **WHEN** `keni init` completes successfully in an empty directory named `my-app`
- **THEN** `<root>/.keni/project.yaml` parses as YAML and contains a top-level mapping
- **AND** the mapping has `project_id` matching `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`
- **AND** the mapping has `name: my-app`
- **AND** the mapping has `agents: [ { id: alice, role: engineer } ]`
- **AND** the mapping has `schedules.alice` set to a non-empty cron-like string
- **AND** the mapping does not have a `stack` field

#### Scenario: `project.yaml` is written via the storage abstraction

- **WHEN** the source code of `packages/cli/src/init/` is inspected
- **THEN** the only write to `<root>/.keni/project.yaml` is via a `ConfigStore.writeProjectConfig` call
- **AND** there is no `Deno.writeTextFile`, `Deno.writeFile`, or other direct-filesystem write targeting `project.yaml`

### Requirement: `project_id` is a UUIDv4 generated by the Web Crypto API

`keni init` SHALL generate the `project_id` for a fresh project using `crypto.randomUUID()` (the Web Crypto API available in Deno without import). The resulting id SHALL be a UUIDv4: 36 characters total, hyphenated `8-4-4-4-12`, with the `4` version nibble in position 14 and a `[89ab]` variant nibble in position 19. The id SHALL be persisted to `project.yaml` and SHALL NOT change on subsequent `keni init` runs against the same project.

#### Scenario: Generated id is a valid UUIDv4

- **WHEN** `keni init` completes successfully on a fresh directory
- **AND** the value of `project_id` in `<root>/.keni/project.yaml` is read
- **THEN** the value matches the regex `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`

#### Scenario: `project_id` is preserved across re-runs

- **WHEN** `keni init` runs in a project, generating `project_id = X`
- **AND** `keni init` runs again in the same project
- **THEN** the second run does not modify `<root>/.keni/project.yaml`
- **AND** the value of `project_id` in `<root>/.keni/project.yaml` after the second run is still `X`

### Requirement: `state.json` is written as a placeholder skeleton, git-ignored

`keni init` SHALL write `<root>/.keni/state.json` containing the literal JSON `{ "watermarks": {} }` (single line, trailing newline). The file SHALL be excluded from git tracking by the entry `.keni/state.json` in `<root>/.gitignore` (see the gitignore-merge requirement below). `state.json` SHALL NOT be written through a storage interface in this step; later steps that own runtime state (cron scheduler, PO chat queue) introduce the relevant store and own subsequent writes.

#### Scenario: `state.json` skeleton is on disk

- **WHEN** `keni init` completes successfully in an empty directory
- **THEN** `<root>/.keni/state.json` exists as a regular file
- **AND** parses as JSON to a top-level object
- **AND** the object contains the key `watermarks` mapped to an empty object

#### Scenario: `state.json` is git-ignored

- **WHEN** `keni init` completes successfully in an empty directory
- **AND** the user runs `git status --porcelain`
- **THEN** the output does not list `.keni/state.json` as untracked or modified
- **AND** the output does not list any path under `.keni/state.json`

### Requirement: After `keni init` succeeds for the first time, `<home>/.keni/` exists with a stub `config.yaml`

`keni init` SHALL ensure that `<home>/.keni/` exists as a directory and that `<home>/.keni/logs/` exists as a directory. If `<home>/.keni/config.yaml` does not already exist, `keni init` SHALL write a stub global config (an empty `GlobalConfig`) via `ConfigStore.writeGlobalConfig` so subsequent reads via `readGlobalConfig` and `resolve` see a real file. If `<home>/.keni/config.yaml` already exists, `keni init` SHALL leave it untouched. `keni init` SHALL NOT create `<home>/.keni/workspaces/`; that directory is the responsibility of the engineer-runtime change (step 09).

#### Scenario: First-ever `keni init` bootstraps `<home>/.keni/`

- **WHEN** `<home>/.keni/` does not exist before `keni init` runs
- **AND** `keni init` completes successfully
- **THEN** `<home>/.keni/` exists as a directory
- **AND** `<home>/.keni/logs/` exists as a directory
- **AND** `<home>/.keni/config.yaml` exists as a file
- **AND** `<home>/.keni/config.yaml` parses as YAML to an empty mapping

#### Scenario: Subsequent `keni init` runs preserve an existing global config

- **WHEN** `<home>/.keni/config.yaml` exists with content `log_level: debug`
- **AND** `keni init` runs in any project (whether or not previously initialised)
- **THEN** `<home>/.keni/config.yaml` is unchanged
- **AND** its contents still parse to `{ log_level: "debug" }`

#### Scenario: `keni init` does not create `<home>/.keni/workspaces/`

- **WHEN** `keni init` completes successfully (whether bootstrapping the global directory or not)
- **THEN** `<home>/.keni/workspaces/` does not exist (unless created by an unrelated process)

### Requirement: `keni init` initialises git when needed and produces a single initial commit

When the target directory is not already a git repository (no `.git/` at the root, and `git rev-parse --git-dir` reports failure), `keni init` SHALL run `git init` before any other filesystem mutation. When the target directory is already a git repository, `keni init` SHALL NOT re-initialise git. After all filesystem mutations succeed, `keni init` SHALL stage the precise paths it created or modified (the `.keni/` tree minus `state.json`, plus a possibly-modified `.gitignore`) and SHALL produce one git commit covering those changes. `keni init` SHALL NOT use `git add .` or any pattern that could stage unrelated user changes. If there are no changes to commit (idempotent re-run on a clean repo), `keni init` SHALL skip the commit step rather than producing an empty commit.

#### Scenario: Fresh directory without `.git/` is initialised

- **WHEN** `keni init` runs in a directory containing no `.git/`
- **THEN** `git rev-parse --git-dir` succeeds in that directory after the command completes
- **AND** `git log --oneline` shows exactly one commit
- **AND** the commit message starts with `Initialise Keni project`
- **AND** the commit references include `<root>/.keni/project.yaml` and `<root>/.gitignore`
- **AND** the commit references do not include `<root>/.keni/state.json`

#### Scenario: Existing git repo is preserved

- **WHEN** the target directory is already a git repo with a non-empty history
- **AND** `keni init` runs in that directory
- **THEN** the existing commits are still reachable via `git log`
- **AND** exactly one new commit is added on top of the previous HEAD
- **AND** the new commit includes only the files `keni init` created or modified

#### Scenario: Idempotent re-run produces no new commits

- **WHEN** `keni init` runs successfully in a project
- **AND** `keni init` runs again with no intervening changes
- **THEN** the second run does not add any commits
- **AND** `git log --oneline` shows the same commit list as before the second run

### Requirement: `.gitignore` is merged additively with Keni's required entries

`keni init` SHALL ensure that `<root>/.gitignore` contains, at minimum, the entries `.env`, `.env.*`, `!.env.example`, `.keni/state.json`, `node_modules/`, `dist/`, and `build/`. If `.gitignore` does not exist, `keni init` SHALL create it with these entries plus a leading comment line marking the section as Keni-managed. If `.gitignore` already exists, `keni init` SHALL append only the entries that are not already present (matching by stripped, comment-free line content). `keni init` SHALL NOT remove existing entries, SHALL NOT reorder them, SHALL NOT rewrite comments, and SHALL NOT change the line endings of existing lines.

#### Scenario: Fresh project gets the Keni-required entries

- **WHEN** `keni init` runs in a directory with no pre-existing `.gitignore`
- **THEN** `<root>/.gitignore` exists after the command completes
- **AND** the file contains a line `.env`
- **AND** the file contains a line `.keni/state.json`
- **AND** the file contains a line `node_modules/`
- **AND** the file contains a line `dist/`
- **AND** the file contains a line `build/`
- **AND** the file contains a comment line identifying the entries as Keni-managed

#### Scenario: Existing entries are preserved verbatim

- **WHEN** `<root>/.gitignore` contains `__pycache__/` and `.vscode/` before `keni init`
- **AND** `keni init` runs in that directory
- **THEN** `<root>/.gitignore` after the run still contains `__pycache__/` on the same line position
- **AND** still contains `.vscode/` on the same line position
- **AND** also contains the Keni-required entries appended after the original content
- **AND** any existing comments are preserved

#### Scenario: Already-present required entries are not duplicated

- **WHEN** `<root>/.gitignore` already contains `.env` and `node_modules/` before `keni init`
- **AND** `keni init` runs in that directory
- **THEN** `<root>/.gitignore` after the run contains exactly one occurrence each of `.env` and `node_modules/`
- **AND** the missing required entries (e.g. `.keni/state.json`, `dist/`, `build/`) are appended

### Requirement: `keni init` is idempotent and repairs partial state

Running `keni init` against a project that has previously been initialised SHALL succeed without modifying `project.yaml` and SHALL exit with status code 0. If parts of the `.keni/` directory tree are missing (for example, a user removed `.keni/tickets/` by hand or via `git clean -fdx`), `keni init` SHALL re-create the missing directories without touching the files that are still present. The `project_id` SHALL never change as a result of an idempotent re-run. If `<root>/.keni/project.yaml` exists but is unparseable, `keni init` SHALL refuse to repair the project, exit non-zero, and report the parse error and file path in stderr.

#### Scenario: Fully-initialised project re-run is a no-op

- **WHEN** `keni init` ran successfully and produced state X
- **AND** no files under `<root>/` have been changed since
- **AND** `keni init` is run again
- **THEN** the second run exits with status 0
- **AND** stdout names the existing project_id and contains the phrase "already initialised"
- **AND** the on-disk state under `<root>` is byte-for-byte identical to state X
- **AND** no new git commit is produced

#### Scenario: Partial-state repair recreates missing directories

- **WHEN** `keni init` ran successfully producing project_id X
- **AND** the user removes `<root>/.keni/tickets/` and `<root>/.keni/activity/` by hand
- **AND** `keni init` is run again
- **THEN** the second run exits with status 0
- **AND** `<root>/.keni/tickets/` and `<root>/.keni/activity/` exist after the run, each containing a zero-byte `.gitkeep` placeholder
- **AND** `<root>/.keni/project.yaml` is unchanged
- **AND** `project_id` is still X
- **AND** `git status --porcelain` reports a clean working tree (no untracked or modified files)
- **AND** if the recreated files are byte-identical to the originals, no new commit is produced (working tree restored to HEAD); if any tracked file's content differs, a single new commit covering only those differences is produced

#### Scenario: Malformed `project.yaml` aborts repair

- **WHEN** `<root>/.keni/project.yaml` exists but contains invalid YAML (e.g., an unterminated string)
- **AND** `keni init` is run in that project
- **THEN** the command exits with non-zero status
- **AND** stderr names the path `<root>/.keni/project.yaml`
- **AND** stderr includes the parse error
- **AND** no other files under `<root>/.keni/` are modified by the failed run
- **AND** no git commit is produced

### Requirement: `keni init` exits with structured non-zero codes on filesystem and git errors

`keni init` SHALL exit with code 0 on success, code 2 on usage errors (unknown subcommand, too many arguments), and code 1 on every other failure (target not writable, target not a directory, `git init` failed, `git commit` failed, malformed existing `project.yaml`). Error messages SHALL be written to stderr and SHALL identify the operation that failed and the path or context that caused the failure. `keni init` SHALL NOT leave the project in an unrecoverable half-applied state on filesystem-level failures: every non-trivial mutation it performs prior to a failure SHALL be either fully completed (and therefore safe for a subsequent re-run to honour as already-done) or fully absent (and therefore safe for a subsequent re-run to perform from scratch).

#### Scenario: Usage error on too many arguments

- **WHEN** the command line is `keni init a b`
- **THEN** the process exits with code 2
- **AND** stderr identifies the maximum-arguments rule

#### Scenario: Filesystem error on unwritable target

- **WHEN** the target directory exists but is not writable by the current user
- **AND** `keni init <target>` is run
- **THEN** the process exits with code 1
- **AND** stderr names the target directory and the `EACCES`-style failure

#### Scenario: Git binary missing on PATH

- **WHEN** `git` is not installed (or not on `PATH`)
- **AND** `keni init` is run in a directory that is not already a git repo
- **THEN** the process exits with code 1
- **AND** stderr identifies the missing-`git` failure
- **AND** no `<root>/.keni/` directory remains on disk after the failed run (or, equivalently, the run is structured so that subsequent re-runs after installing git complete cleanly)

### Requirement: `keni init` prints a structured success summary

On success, `keni init` SHALL print a multi-line summary to stdout identifying the initialised path, the `project_id`, and the next recommended step (`keni start`). When the run was an idempotent no-op, the summary SHALL state that the project was already initialised and name its `project_id`. When the run repaired partial state, the summary SHALL list which files or directories were recreated.

#### Scenario: Fresh-init summary

- **WHEN** `keni init` completes a fresh initialisation
- **THEN** stdout contains a line naming the absolute project path
- **AND** stdout contains the `project_id` value (full UUID, optionally truncated for display but matching the value in `project.yaml`)
- **AND** stdout contains a hint mentioning `keni start`

#### Scenario: Already-initialised summary

- **WHEN** `keni init` runs against a project where every required file is in place
- **THEN** stdout contains the phrase "already initialised"
- **AND** stdout names the existing `project_id`

### Requirement: `project-layout` does not own `state.json` semantics; that responsibility passes to later steps

`keni init` SHALL write only the placeholder shape `{ "watermarks": {} }` to `<root>/.keni/state.json`. The capability spec SHALL note that the cron scheduler change (step 08) and the PO chat-queue change (steps 14+) introduce the real schema and the `StateStore` abstraction that owns subsequent writes. The `state.json` produced by `keni init` SHALL be a minimal valid placeholder, not a fully-typed document.

#### Scenario: Placeholder is valid JSON but does not pretend to be schema-complete

- **WHEN** `keni init` completes successfully
- **AND** the contents of `<root>/.keni/state.json` are read and parsed
- **THEN** the result is a JSON object whose only key is `watermarks`
- **AND** the value of `watermarks` is an empty object
- **AND** no other top-level keys are present

#### Scenario: Documentation states `state.json` ownership lives elsewhere

- **WHEN** the `project-layout` capability spec is read
- **THEN** it states explicitly that `state.json`'s real schema is introduced by future steps (cron scheduler and PO chat queue)
- **AND** it states that `keni init` writes a placeholder skeleton, not a fully-typed file
