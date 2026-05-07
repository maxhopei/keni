# AGENTS.md

Quick orientation for coding agents working in this repo. Optimised for _finding the right
authoritative document fast_ — this file is intentionally light and links out for detail.

## What Keni is

A locally-run **building agent**: an orchestration system that simulates an Agile product team (PO,
Engineers, QA, Writer) and ships software end-to-end against shared artifacts (spec, kanban,
repository, PRs, activity log). Vision lives in [`spec.md`](./spec.md); operator-facing surface
lives in [`README.md`](./README.md).

## Tech stack

- **Runtime:** Deno **2.7.x** (pinned via [`.tool-versions`](./.tool-versions)). No `node` / `npm` /
  `pnpm` invocations; everything is `deno install` / `deno task ...`.
- **Language:** TypeScript with `strict`, `noImplicitOverride`, `noUncheckedIndexedAccess`, and
  `verbatimModuleSyntax` (see [`deno.json`](./deno.json)). Type imports must use `import type`.
- **HTTP / MCP:** `@hono/hono`, `@modelcontextprotocol/sdk`. Validation via `zod`. Std lib via
  `jsr:@std/*`.
- **SPA:** React 18 + Vite 5 via `@deno/vite-plugin` ([`packages/spa/`](./packages/spa/)).
- **Lockfile:** [`deno.lock`](./deno.lock) is committed; CI runs `deno install --frozen`. Regenerate
  locally with a plain `deno install` after touching `deno.json` imports.

## Workspace layout

Single Deno workspace declared in [`deno.json`](./deno.json) with five members:

| Package                                            | Purpose                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`@keni/cli`](./packages/cli/)                     | The `keni` command — `init`, `start`                                                                |
| [`@keni/server`](./packages/server/)               | Orchestration server (REST + WS), engineer MCP server (stdio), in-process scheduler                 |
| [`@keni/role-runtimes`](./packages/role-runtimes/) | Common role cycle wrapper + per-role specialisations (engineer today, QA/PO next)                   |
| [`@keni/shared`](./packages/shared/)               | Wire types, storage interfaces (`TicketStore`, `PRStore`, `ActivityLogStore`, `ConfigStore`), utils |
| [`@keni/spa`](./packages/spa/)                     | Browser dashboard                                                                                   |

Per-package READMEs (where present) carry the load-bearing detail:
[`packages/role-runtimes/README.md`](./packages/role-runtimes/README.md),
[`packages/shared/src/storage/README.md`](./packages/shared/src/storage/README.md).

## Common tasks (run from repo root)

```bash
deno install                  # restore cache from deno.lock
deno task fmt                 # format in place (also: fmt:check for CI parity)
deno task lint
deno task check               # type-check every workspace member
deno task test                # deno test -A across the workspace
deno task build               # fan out @keni/* package builds
```

Always run `fmt`, `lint`, `check`, and `test` before declaring a task done. CI fails on any of them.

## OpenSpec workflow (mandatory for substantive changes)

Every non-trivial change ships through OpenSpec:

1. **Propose** — use the `openspec-propose` skill (or `/opsx-propose`). Creates
   `openspec/changes/<name>/` with `proposal.md`, `design.md`, and `tasks.md`.
2. **Apply** — use the `openspec-apply-change` skill (or `/opsx-apply`). Drives the tasks list to
   completion, ticking `- [ ]` → `- [x]` as it goes.
3. **Archive** — use the `openspec-archive-change` skill. Folds deltas into
   [`openspec/specs/`](./openspec/specs/) and moves the change folder under
   `openspec/changes/archive/`.

The four skills sit under [`.cursor/skills/openspec-*`](./.cursor/skills/) — read the matching
`SKILL.md` _before_ doing the action. The OpenSpec config is at
[`openspec/config.yaml`](./openspec/config.yaml) (`schema: spec-driven`).

### Capability specs are the source of truth

Capability specs in [`openspec/specs/`](./openspec/specs/) are normative — when behaviour and code
disagree, the spec wins until a delta says otherwise. The capabilities currently archived include:

- `cli-start`, `orchestration-server`, `scheduler`, `interrupt-and-timeout-ux`
- `role-runtime`, `engineer-runtime`, `engineer-prompt`, `mcp-engineer-surface`
- `storage`, `project-layout`, `developer-setup`
- `spa-shell`, `spa-agent-roster`, `spa-board`, `spa-ticket-detail`, `spa-pr-detail`,
  `spa-activity-log`

Active (un-archived) changes live under [`openspec/changes/`](./openspec/changes/) — always check
both directories when a feature looks half-built.

## Load-bearing conventions

These are not stylistic preferences; violating them breaks the architecture. They are pinned by
structural tests.

1. **Prompts are code, not files.** No top-level `prompts/` directory. Every agent system prompt
   lives as a TypeScript `export const` inside the package that owns it (e.g.
   [`packages/role-runtimes/src/engineer/prompts/engineer.ts`](./packages/role-runtimes/src/engineer/prompts/engineer.ts)).
   No runtime reads a prompt from disk. (`spec.md` §11#3, §6.2.)
2. **Storage is interface-bound.** Tickets, PRs, activity log, and config are accessed only via the
   four storage interfaces in [`@keni/shared`](./packages/shared/src/storage/). Concrete adapters
   (`File*Store`, `InMemory*Store`) are imported only at the composition root. No REST handler, MCP
   tool, role runtime, or SPA module reaches into `.keni/` directly. (Capability spec: `storage`.)
3. **Role runtimes are stateless and side-effect-scoped.** `startCycle(params)` runs exactly one
   cycle, with no module-scope state, no `.keni/` reads, no `Deno.env` reads (env access is
   role-supplied via an allowlist), and no looping/retry. The scheduler owns retry policy.
   (Capability spec: `role-runtime`.)
4. **`X-Keni-Role` and `X-Keni-Agent` headers identify every API call.** The orchestration server
   trusts the headers (local-loopback trust model — no auth, no TLS, no CORS). Never expose the
   server off `127.0.0.1`. The only unauthenticated endpoint is `GET /health`.
5. **Same-origin `/api/*` mirror.** Every REST/WS endpoint is reachable at both the bare path
   (`/tickets`) and an `/api/`-prefixed mirror (`/api/tickets`). The bare form is canonical for
   non-browser callers; the prefixed form exists for the SPA.
6. **Engineer workspaces are sparse-checkouts under `~/.keni/workspaces/<projectId>/<agentId>/`.**
   `.keni/` is sparse-excluded so engineer agents cannot read tickets/PRs/config directly — the MCP
   tool surface is the only seam. Per-workspace local git identity; the host's `~/.gitconfig` is
   never read or written. (Capability spec: `engineer-runtime`.)
7. **Tests live under `packages/<pkg>/tests/`, never under `packages/<pkg>/src/`.** Each package
   carries a `tests/{unit,integration,e2e}/` tree; cross-package fakes are exposed via the
   `./test-fakes` secondary entry point on the package's `deno.json`. A structural test in
   `@keni/shared` (`tests/unit/repoLayout_test.ts`) pins this layout so accidental drift fails
   `deno task test`. (Capability spec: `developer-setup`.)

## Editing the codebase

- Use the dedicated file tools — never `cat`/`sed`/`echo >` for file ops.
- Keep changes minimal and scoped to the OpenSpec task currently in flight.
- After substantive edits: re-run `deno task fmt`, then `lint`, then `check`, then `test`. Fix any
  lint/type errors you introduced; leave pre-existing ones untouched unless asked.
- Don't introduce comments that narrate the code; only document non-obvious intent or constraints.
- Don't commit unless the user explicitly asks for it.

## Skills available

Project-specific skills live under [`.cursor/skills/`](./.cursor/skills/):

- `openspec-propose`, `openspec-apply-change`, `openspec-archive-change`, `openspec-explore`

Read the relevant `SKILL.md` before invoking — they describe the exact CLI calls and pause/resume
contract.

## Where to look first

| Question                              | Start here                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| Why does Keni exist?                  | [`spec.md`](./spec.md) §1–§3                                                  |
| How do I run / develop locally?       | [`README.md`](./README.md) "Getting started"                                  |
| What's the contract for capability X? | [`openspec/specs/<X>/spec.md`](./openspec/specs/)                             |
| What's currently being built?         | [`openspec/changes/`](./openspec/changes/) (non-archive subfolders)           |
| How does the engineer cycle work?     | `role-runtime` + `engineer-runtime` specs; `packages/role-runtimes/README.md` |
| How do storage interfaces compose?    | `storage` spec; `packages/shared/src/storage/README.md`                       |
| How does `keni start` boot?           | `cli-start` + `orchestration-server` specs                                    |
| What does the SPA do?                 | `spa-*` specs; [`packages/spa/`](./packages/spa/)                             |
