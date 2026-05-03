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

When `keni init` runs on a host where neither `user.name` nor `user.email` is configured in any git
layer (per-repo, per-user `~/.gitconfig`, XDG, or system), the initial commit is attributed to
`Keni <keni@example.invalid>` so the run can complete non-interactively (e.g. on a fresh CI runner).
To commit under your own identity, configure git first — `git config --global user.name "Your Name"`
and `git config --global user.email "you@example.com"` — or amend afterwards with
`git commit --amend --reset-author`. The fallback is per-invocation and never writes any persistent
git config.

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

The agent roster joined to runtime state is at `GET /agents`:

```bash
curl -H "X-Keni-Role: user" http://127.0.0.1:<port>/agents
# => { "data": [
#       { "id": "alice", "role": "engineer", "status": "idle",
#         "last_activity": null, "last_active_at": null, "paused": false }
#      ], "project_id": "<uuid>" }
```

`POST /agents/:id/pause` and `POST /agents/:id/resume` flip the `paused` flag (user-only, idempotent
— they emit `agent.state_changed` only when the flag actually changes). The flag is the seam
consumed by [the scheduler](#scheduler): a paused agent's tick is silently skipped on every fire,
and an in-flight cycle is allowed to complete (pause is a scheduling preference; `interrupt` is the
abort verb).

A live event stream is at `GET /events` (WebSocket). Every successful write on `/tickets`, `/prs`,
`/activity`, and `/agents/:id/{pause,resume}` is mirrored to every connected subscriber as one
`EventFrame` (`{ id (uuidv7), event, project_id, timestamp, payload }`). Two equivalent
authentication paths are accepted on the upgrade — the role header (preferred for CLI tools) or the
`?role=<role>` query parameter (browsers cannot set arbitrary headers on `new WebSocket(...)`):

```bash
# CLI tool (websocat / curl-style):
websocat -H 'X-Keni-Role: user' ws://127.0.0.1:<port>/events

# Browser-friendly:
ws://127.0.0.1:<port>/events?role=user
```

The server sends a protocol-level WS ping after 25 seconds of idle and closes the connection with
code 1011 if the client does not pong before the next idle window — a missed-pong tear-down modelled
at the protocol level so the application-event channel stays push-only. **Persistence tier (today):
in-memory.** Pause / resume flags, agent runtime status, and the event bus all reset on server
restart; the activity log on disk remains the durable record. Reconnect strategy: the client
re-fetches the canonical state from REST on each reconnect (`?since=<event-id>` replay is a
forward-compatible additive change documented in the capability spec).

Step 13 (`cli-start-and-end-to-end-wiring`) folds this invocation into a `keni start` subcommand
that handles signal management, `~/.keni/logs/server-YYYY-MM-DD.jsonl` log routing, and (later)
process supervision; `runServer` is already the dispatch target so that change is one line.

The full HTTP contract — endpoints, wire shapes, error envelope, role rules, agent roster, event
taxonomy, and WS lifecycle — lives in the
[`orchestration-server` capability spec](./openspec/changes/agents-api-and-websocket/specs/orchestration-server/spec.md).

### Run the engineer MCP server (development only)

`@keni/server` also ships a stdio-only MCP server that exposes a tightly scoped engineer toolset
(seven tools — list / read / update-body / transition tickets, append / query activity, get
workspace path) over the [Model Context Protocol](https://modelcontextprotocol.io). It is a thin
adapter that delegates every tool call to the orchestration server's REST surface; it never reads or
writes `.keni/` directly. Run it with the orchestration server already listening:

```bash
deno run -A packages/server/src/mcp/main.ts \
  --agent alice \
  --server-url http://127.0.0.1:<port> \
  --workspace "$HOME/.keni/workspaces/<project-id>/alice"
```

All three flags are required. `--agent` must match `/^[a-z0-9_-]+$/` (the orchestration server
identifies the caller via the closure-captured agent id, not via tool input — defense-in-depth
against an agent claiming to be someone else inside a tool call). `--workspace` must be an existing
directory; the value is what `get_workspace_path` returns. Step 07 (`role-runtime-common`) wires
this invocation into the engineer subprocess's `mcpServers` config block — until then, developers
attach a manual MCP client (e.g. the SDK's `mcp-cli` debugger or a coding-agent CLI's MCP debug
mode) to exercise the surface.

### Role runtimes (common)

`@keni/role-runtimes` exposes a deterministic seven-step cycle wrapper — `startCycle(params)` — that
any role (engineer, QA, PO) plugs into by supplying a precheck function, a bundled prompt, an
MCP-server config, and a `CodingAgentInvoker`. The cycle implements [`spec.md`](./spec.md) §6.2
step-for-step: precheck → log `session_start` → resolve the bundled prompt → build the invocation →
spawn and stream stdout/stderr per line → idle-detect → log `session_end` (or `idle`). The runtime
returns a typed `RoleCycleResult` discriminated union covering five outcomes (`completed`, `idle`,
`precheck_skipped`, `terminated`, `spawn_failed`) so callers — typically step 08's scheduler — can
`switch` over a closed shape.

The common cycle code lives in
[`packages/role-runtimes/src/common/`](./packages/role-runtimes/src/common/). Four invariants are
pinned by structural tests:

1. **Single cycle per invocation.** No looping, no scheduling, no retry — that is the scheduler's
   job. Each call generates a fresh uuidv7 `session_id` and runs to completion exactly once.
2. **Stateless across invocations.** No module-scope state survives between cycles; concurrent
   invocations against different agent ids are safe by construction.
3. **Activity log only via `POST /activity`.** No source file under
   `packages/role-runtimes/src/common/` reads or writes any path under `.keni/` or `~/.keni/`. The
   typed activity-log adapter at `activityClient.ts` stamps `X-Keni-Role` and `X-Keni-Agent` on
   every request.
4. **Role-agnostic.** No `role === "engineer"` branches; every role-shaped concern (precheck,
   prompt, env allowlist, MCP config) is a parameter on `RoleCycleParams`.

Step 09 (engineer specialisation) is the first concrete consumer; step 17 (PO mode selection) will
plug a four-mode arbiter into the precheck. Both inherit the cycle without modifying it.

### Scheduler

`@keni/server`'s in-process scheduler — owned by `runServer` and started immediately after the HTTP
listener binds — drives one role-runtime cycle per agent per tick. Source lives at
[`packages/server/src/scheduler/`](./packages/server/src/scheduler/) and the canonical contract is
the
[`scheduler` capability spec](./openspec/changes/cron-scheduler-with-pause/specs/scheduler/spec.md).

Three invariants frame everything else:

1. **In-process, single-server-per-project, no replay.** Tick state is in-memory only; on server
   restart the scheduler resumes ticking from "now" with no replay of missed ticks. Pause / resume
   flags also reset on restart (the activity log on disk is the durable record).
2. **Pause is a scheduling preference; `interrupt` is the abort verb.** Setting `paused: true`
   silently skips the next tick (no LLM tokens spent, no activity entry); it does not affect an
   in-flight cycle. `scheduler.interrupt(agentId)` aborts the in-flight cycle's `params.signal`
   immediately and appends a `session_interrupted` row carrying the cycle's `session_id`.
3. **Role-agnostic core.** The scheduler imports zero role-specific code; every role-shaped concern
   (precheck, prompt resolver, coding-agent invoker, env allowlist, MCP config) is supplied by the
   `AgentRunner` plug-in registered against the `AgentRunnerRegistry`. Step 09 (engineer
   specialisation) and step 17 (PO mode selection) `register(...)` their runners against this
   registry; tests register a fake runner.

The scheduler reads two `project.yaml` keys to size each agent's tick:

```yaml
# .keni/project.yaml
schedules:
  engineer: "5m" # cadence: any agent with role=engineer ticks every 5 minutes
  alice: "30s" # per-agent override beats the per-role entry
  qa: "*/2 * * * *" # simple "*/N * * * *" cron form is also accepted
timeouts:
  engineer: "30m" # hard wall-clock cap for one engineer cycle
  alice: 600000 # bare integer is interpreted as milliseconds
```

Both keys accept duration shorthands (`"500ms"`, `"5s"`, `"30m"`, `"1h"`), bare positive integers
(milliseconds), and the cron pattern `"*/N * * * *"` for `schedules` only. Resolution order is
`map[agentId] ?? map[role] ?? defaultForRole(role)`. Defaults: cadence `60_000` ms; timeout
`30 * 60 * 1_000` ms (engineer / qa) and `5 * 60 * 1_000` ms (po). An unparseable value logs a
single warning and falls back to the role default.

When a cycle exceeds its `timeoutMs`, the scheduler aborts the cycle's `params.signal` and appends a
`session_timeout` row carrying the cycle's `session_id` (the runtime separately emits its own
`session_end` with `terminated_by: "sigterm"` once the subprocess settles — both rows are on the
same `session_id` and tell complementary halves of the story). The scheduler does not auto-revert
ticket status on interrupt or timeout — that decision belongs to a future re-checkout flow.

The plug-in surface for roles is one interface:

```typescript
import type { AgentRunner } from "@keni/server/scheduler/registry";

const engineerRunner: AgentRunner = {
  role: "engineer",
  precheck: async (ctx) => /* "skip" | "proceed" */,
  promptResolver: (ctx) => /* { name, body } from a TS string constant */,
  codingAgentInvoker: createSubprocessCodingAgentInvoker(...),
  mcpServerConfig: { command: "deno", args: [...] },
};

scheduler.registerRunner(engineerRunner);
```

Steps 09 and 17 land the production engineer and PO runners; the integration test at
[`packages/server/src/scheduler/integration_test.ts`](./packages/server/src/scheduler/integration_test.ts)
exercises the end-to-end flow against a fake runner today.

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
    ├── server/               # @keni/server — orchestration server (REST + WebSocket APIs), engineer MCP server (stdio), and the in-process role-runtime scheduler (`scheduler/` subdir)
    ├── spa/                  # @keni/spa — browser dashboard (board, agent roster, chat, spec viewer)
    ├── role-runtimes/        # @keni/role-runtimes — common cycle wrapper plus per-role specialisations (engineer/QA/PO)
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
