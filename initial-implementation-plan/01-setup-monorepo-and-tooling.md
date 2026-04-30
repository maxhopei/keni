# Step 01 — setup-monorepo-and-tooling

**Phase:** Prototype
**Suggested change name:** `setup-monorepo-and-tooling`
**Depends on:** —

## Goal

Stand up Keni's own codebase — the repo that houses the CLI, orchestration server, SPA, role runtimes, and shared modules. After this step, a fresh clone gives contributors a green build, working lint/format/type-check/test, and a CI run on push. No application logic — pure scaffolding.

## Scope

- Repo layout with workspaces/packages for `cli`, `server`, `spa`, `role-runtimes`, and `shared`.
- Language and runtime selection for Keni itself (see "Open decisions" below).
- Tooling: linter, formatter, type-checker, unit-test runner, all wired through the workspace tool.
- Minimal CI that runs lint + type-check + tests on push and pull requests.
- Root `README.md` with one-paragraph dev setup (clone, install, build, test).
- Editor config (`.editorconfig`) and a base `.gitignore` covering build artefacts.

## Out of scope

- Any Keni feature code (storage, server endpoints, runtimes, SPA views) — all of those are later steps.
- Project-folder layout (`.keni/`) and global layout (`~/.keni/`) — those land in step 03.
- Coding-agent CLI integration — handled inside step 09.

## Spec references

- §2#9 — "One step at a time. Prototype first, MVP next, rest deferred."
- §6.4 — Coding-agent agnosticism (Claude Code, Cursor agent, OpenCode are the targets the engineer subprocess invokes; this constrains *integration*, not Keni's own runtime).
- §8 — Prototype "Included" list (frames everything that lands later in this folder).
- §11#3 — Thin wrapper, prompts as code; influences how the bundle is structured (prompts will be importable strings, not files on disk).

## Open decisions for the proposer

- **Keni's language and runtime.** The spec does not pin one. TypeScript on Node or Bun is the path of least resistance because (a) the engineer prompt targets TS/Deno/React, so reuse of types/tooling between Keni and its own engineer runtime is plausible, and (b) the SPA naturally lives in TS. Go or Rust are also viable for a CLI-plus-server but increase friction with the SPA. Capture the decision and rationale in `design.md`.
- **Package manager and monorepo tool.** pnpm workspaces, Turborepo, Nx, Moon — pick one. Justify in `design.md`.
- **Test framework.** Vitest, Jest, Bun's built-in, etc. Pick one and apply consistently across packages.

## Notes for /opsx:propose

- `proposal.md` should describe the change as "stand up the Keni monorepo so contributors have a working baseline." Mention what changes (repo created, packages scaffolded, CI green) and what does not (no Keni features yet).
- `design.md` should justify language/runtime, package manager, monorepo tool, test framework, and sketch the package layout. Include a tree.
- `tasks.md` should cover: init repo, choose tools, scaffold packages, wire lint/format/type-check/test commands, set up CI workflow, write root README. Keep tasks bite-sized.
- A capability spec is optional but a "developer-setup" capability spec covering "fresh clone produces a green build" is a clean way to document the contract.
