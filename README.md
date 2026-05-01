# Keni

A locally-run **building agent** — an orchestration system that simulates an autonomous Agile
product team (Product Owner, Engineers, QA, Writer) and ships software end-to-end against a shared
set of artifacts: a living specification, a kanban board of tickets, a code repository, a
pull-request registry, and an activity log.

See [`spec.md`](./spec.md) for the full vision.

## Getting started

Keni is built and tested with **Deno 2.7.x** (pinned via [`.tool-versions`](./.tool-versions)).

```bash
git clone git@github.com:maxhopei/keni.git
cd keni
deno install
deno task fmt:check
deno task lint
deno task check
deno task test
deno task build
```

`deno install` reads the root `deno.json` workspace manifest, fetches every dependency into the
local Deno cache, and reconciles `deno.lock`. Every subsequent task is workspace-wide — you never
need to `cd` into an individual package to lint, type-check, or run tests for the whole repo.

| Task                  | What it does                                      |
| --------------------- | ------------------------------------------------- |
| `deno task fmt`       | Format every source and markdown file in place    |
| `deno task fmt:check` | Fail if any file is unformatted (used in CI)      |
| `deno task lint`      | Run `deno lint` across every workspace member     |
| `deno task check`     | Run `deno check` across every workspace member    |
| `deno task test`      | Run `deno test -A` across every workspace member  |
| `deno task build`     | Fan out the `build` task to each `@keni/*` member |

### Initialise a Keni project (`keni init`)

Once the workspace is installed, run `keni init` in any folder (empty or with existing code) to
bootstrap a Keni project. During the prototype, the `keni` binary is not yet packaged, so invoke the
CLI directly through Deno:

```bash
deno run -A packages/cli/src/main.ts init [path]
```

`path` defaults to the current working directory. The first run produces:

```
<path>/
├── .gitignore                         (created or merged additively)
└── .keni/
    ├── project.yaml                   (UUIDv4 project_id, default agent `alice`)
    ├── state.json                     (gitignored placeholder skeleton)
    ├── tickets/.gitkeep
    ├── prs/.gitkeep
    └── activity/.gitkeep
~/.keni/                               (created on first ever run)
├── config.yaml                        (empty stub)
└── logs/
```

The first run also calls `git init` if needed and stages a single initial commit covering the new
`.keni/` tree and the merged `.gitignore`. Subsequent runs are idempotent: a fully-initialised
project re-runs as a no-op (`already initialised`); a partial state (e.g., `.keni/tickets/` deleted)
is repaired in place. The `project_id` is stable across re-runs and across project-folder renames.

The on-disk contract is formalised in the
[`project-layout` capability spec](./openspec/changes/project-and-global-layout-with-init/specs/project-layout/spec.md)
(active until archived). Once archived, the canonical reference moves to
[`openspec/specs/project-layout/spec.md`](./openspec/specs/).

### Run the orchestration server

`@keni/server` is the local HTTP service the SPA, role runtimes, and (later) the MCP layer talk to.
During the prototype it has no `keni start` wrapper yet — invoke it directly with `deno run`:

```bash
deno run -A packages/server/src/main.ts --project /absolute/path/to/keni-project --port 0
```

`--project` points at a `keni init`-produced directory (the one containing `.keni/project.yaml`).
`--port 0` lets the OS assign a free port (the bound URL is printed to stdout); pass `--port 8080`
to pin one. The server binds to `127.0.0.1` by default; override with `--host` if you really need
to. **Trust model:** the server is local-only with no auth, no TLS, no CORS — every request is
identified by an `X-Keni-Role: <user|engineer|qa|po|writer>` header that the server takes at face
value. Do not expose this port off the loopback.

A one-line smoke test against the running server:

```bash
curl -H "X-Keni-Role: user" http://127.0.0.1:<port>/tickets
# => { "data": [], "project_id": "<uuid>" }
```

Step 13 (`cli-start-and-end-to-end-wiring`) folds this invocation into a `keni start` subcommand
that handles signal management, `~/.keni/logs/server-YYYY-MM-DD.jsonl` log routing, and (later)
process supervision; `runServer` is already the dispatch target so that change is one line.

The full HTTP contract — endpoints, wire shapes, error envelope, role rules — lives in the
[`orchestration-server` capability spec](./openspec/changes/orchestration-server-and-rest-apis/specs/orchestration-server/spec.md).

## Repository layout

```
keni/
├── deno.json                 # workspace manifest, imports, tasks, fmt/lint config
├── deno.lock                 # committed; CI enforces with `deno install --frozen`
├── .tool-versions            # pins the Deno minor for asdf / mise
├── .editorconfig             # fallback for files deno fmt does not touch
├── .gitignore
├── .github/workflows/ci.yml
├── LICENSE                   # MIT
├── README.md                 # this file
├── spec.md                   # Keni's vision spec
├── openspec/                 # OpenSpec changes and archived specs
├── initial-implementation-plan/  # step-by-step /opsx:propose inputs (prototype → MVP)
└── packages/
    ├── cli/                  # @keni/cli — the `keni` command, project init and server boot
    ├── server/               # @keni/server — orchestration server, REST + WebSocket APIs, MCP surface
    ├── spa/                  # @keni/spa — browser dashboard (board, agent roster, chat, spec viewer)
    ├── role-runtimes/        # @keni/role-runtimes — thin subprocess wrappers per role (PO, engineer, QA, writer)
    └── shared/               # @keni/shared — types, storage interfaces, utilities
```

### SPA stack (to be wired)

`packages/spa` will be built with **React + Vite via
[`@deno/vite-plugin`](https://jsr.io/@deno/vite-plugin)**. Step 01 scaffolds the package as a plain
Deno workspace member; the actual Vite configuration, React root, and `dev`/`build` tasks land in a
later change (`spa-shell-and-agent-roster` in
[`initial-implementation-plan/`](./initial-implementation-plan/)).

## Conventions

### Prompts are code, not files

Per [`spec.md`](./spec.md) §11#3 and §6.2, every agent's system prompt is bundled with Keni's binary
or Docker image. Prompts live as TypeScript string exports inside the package that owns them — for
example, the engineer's prompt will live at `packages/role-runtimes/src/prompts/engineer.ts` as a
named `export const` — and are imported by the role runtime like any other module.

There is **no** top-level `prompts/` directory. No runtime reads a prompt from disk. This convention
is load-bearing: it lets prompts evolve with Keni's source, version cleanly in git, and stay out of
per-project state.

### Lockfile is frozen in CI

`deno.lock` is committed. CI runs `deno install --frozen` first, which refuses to update the
lockfile and fails loudly if `deno.json` and `deno.lock` have drifted apart. Regenerate the lockfile
locally by running `deno install` without `--frozen` after adding or changing an import.

### Storage abstractions

Every artifact (tickets, PRs, activity log, project / global config) is read and written through a
storage interface in [`packages/shared/src/storage/`](./packages/shared/src/storage/). The
file-backed adapters under `.keni/` are the default; in-memory test doubles ship for unit tests. See
that folder's [`README.md`](./packages/shared/src/storage/README.md) for the contract.

### OpenSpec-driven changes

Every substantive change to Keni ships through
[OpenSpec](https://github.com/MichaelVeksler/openspec) — propose with `/opsx-propose`, implement
with `/opsx-apply`, archive with `/opsx-archive`. The active changes live under
[`openspec/changes/`](./openspec/changes/); archived ones under `openspec/changes/archive/`.

## License

MIT — see [`LICENSE`](./LICENSE).
