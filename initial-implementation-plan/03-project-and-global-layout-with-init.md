# Step 03 — project-and-global-layout-with-init

**Phase:** Prototype
**Suggested change name:** `project-and-global-layout-with-init`
**Depends on:** 02

## Goal

Define and create the on-disk layouts that Keni operates against — the per-project `.keni/` directory, the global `~/.keni/` directory, and the `keni init` CLI command that bootstraps a project. After this step, a user can run `keni init` in any folder and end up with a valid Keni project ready for the next steps to drive.

## Scope

- `.keni/` per-project layout (matching `spec.md` §5.1):
  - `project.yaml` — project id (stable, generated), name, stack, agent roster, schedules.
  - Empty directories created up front: `tickets/`, `prs/`, `activity/`. (Spec/CR/chat directories are added in MVP — do **not** create them here.)
  - `state.json` skeleton with watermarks placeholder. Note: state.json is git-ignored.
- `~/.keni/` global layout (§5.2):
  - `config.yaml` for user-level defaults (preferred coding-agent CLI, default port range, log level).
  - `workspaces/` directory created lazily (engineer step 09 populates it).
  - `logs/` for server-level logs.
- `keni init` command:
  - Initialises git in the folder if not already a repo.
  - Creates `.keni/` with the layout above.
  - Generates a stable `project_id` (UUID or similar) and writes `project.yaml`.
  - Writes/updates `.gitignore` to exclude `.env`, `.keni/state.json`, build artefacts, and `node_modules` (or runtime-equivalent).
  - Stages an initial commit covering `.keni/` so the project is committable from the start.
  - Idempotent: re-running on an initialised project is a no-op with a clear message.
- Layered config resolution: `~/.keni/config.yaml` provides defaults; `.keni/project.yaml` overrides them.

## Out of scope

- `keni start` (step 13).
- Workspace clones in `~/.keni/workspaces/` (engineer step 09 creates them per agent).
- Spec, CR, chat directories — added in steps 14 and 15.
- `.env` loading — step 27.

## Spec references

- §5.1 — Project folder layout, including exactly which files/directories live under `.keni/` and what is git-ignored.
- §5.2 — Global directory and what it holds; `<project-id>` rationale ("renaming or moving the project folder does not orphan workspaces").
- §7.1 — `keni init` UX and the contract that running it in an empty folder produces a working project.
- §2#6 — Files-first storage commitment (this step puts the actual files where the spec said they go).

## Open decisions for the proposer

- **Where prompts live.** Per §11#3 prompts ship with Keni's binary and are NOT loaded from disk. Decide how they're embedded (compiled-in resources, bundled JSON, etc.) and document — this affects how the binary is packaged.
- **`project_id` generator.** UUIDv4 is fine. Confirm and document.
- **Initial commit strategy.** Single commit for `.keni/` scaffold vs. one for git-init + one for `.keni/`. Either is fine; pick one and document.

## Notes for /opsx:propose

- `proposal.md` should frame this as "the moment Keni gains a footprint on disk and a way to bootstrap projects."
- `design.md` should pin the `project.yaml` and global `config.yaml` schemas (fields, defaults, override semantics) and show example files. Sketch the `keni init` flow as pseudo-code.
- `tasks.md` should cover: implement schemas, implement `keni init`, layered config loader, `.gitignore` template, idempotency check, golden-test the layout against spec §5.1.
- A `project-layout` capability spec is the natural home for the on-disk contract.
