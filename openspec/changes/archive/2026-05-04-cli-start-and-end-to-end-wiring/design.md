## Context

The orchestration server (`@keni/server`) and the SPA (`@keni/spa`) are both fully specced and implemented as of step 12. The bridge that turns them into a single user-facing experience does not yet exist:

- **The CLI dispatcher (`packages/cli/src/main.ts`) has only one subcommand** — `init` — and explicitly carries a `// Future subcommands (notably keni start, lands in step 13) plug in here.` marker. Today, a user who has just run `keni init` must hand-craft `deno run -A packages/server/src/main.ts --project /abs/path --port 0` to start the server, and a *second* `cd packages/spa && KENI_SERVER_URL=http://127.0.0.1:<port> deno task dev` to see the dashboard.
- **The orchestration server does not serve the SPA bundle.** The README's existing "Run the SPA" subsection acknowledges this: "Step 13 (`cli-start-and-end-to-end-wiring`) will host the production bundle from the orchestration server itself — the dev-server proxy is only required during local SPA development." Today, every browser session for a Keni project depends on a live `vite dev` server.
- **`runServer` already does the heavy lifting** for in-process composition (the `runServer.ts` reading at change-design time confirms it instantiates the bus, the runtime-state store, the scheduler, and provisions every engineer's workspace before `Deno.serve` accepts), but it owns no user-friendly affordances: no port-conflict recovery, no `.env` loading, no layered config merge with `~/.keni/config.yaml`, no graceful-shutdown coordination beyond a SIGINT-installs-then-`scheduler.stop()`-then-`serverHandle.abort()` chain, and no health endpoint for the smoke test or for forthcoming process-supervision tooling.
- **The prototype's exit criterion (`spec.md` §8 plus §11#12)** is the loop a *user* can drive: `keni init`, `keni start`, open the URL, create a ticket, watch the engineer move it through the lifecycle. Without `keni start`, the loop is reachable only by Keni's own contributors with a coding-shaped mental model. Step 13 closes that.
- **Source plan and existing capabilities pin the boundaries.** Per the source plan (`initial-implementation-plan/13-cli-start-and-end-to-end-wiring.md`):
  - One server, one project (`spec.md` §7.1).
  - Heavy `.env` UX is step 27 (this step ships the minimum).
  - Pause / interrupt UX exists end-to-end (steps 08, 12, `interrupt-and-timeout-ux` capability) — `keni start` consumes those verbs in shutdown, does not re-implement them.
  - Multi-project, auth, TLS — out of MVP.

This change wires the seam.

## Goals / Non-Goals

**Goals:**

- A user with `keni init`-produced `.keni/` runs `keni start` (or `deno run -A packages/cli/src/main.ts start` in the prototype, before the binary is packaged) and sees `Keni server running at http://127.0.0.1:<port>` on stdout in under three seconds against a fresh project on a typical laptop.
- The printed URL serves the SPA bundle directly — no second terminal, no `cd packages/spa`, no `KENI_SERVER_URL` env var. Deep links (`/tickets/abc`, `/prs/xyz`, `/activity`) work because the SPA fallthrough re-serves `index.html` for unmatched non-`/api`-prefixed GETs.
- `keni start` reads `.keni/project.yaml` and `~/.keni/config.yaml` together (project wins) and `<projectDir>/.env`. The merge and the `.env` loader are pure, testable functions; no global state escapes.
- Port-conflict recovery is deterministic: `keni start` walks the configured port range (default `7777..7787`) on `EADDRINUSE` and surfaces a clear error after the last port. The user can pin a single port with `--port <n>` (no fallback if pinned).
- A `GET /health` endpoint responds `200` once the listener binds. The endpoint is the smoke-test target *and* the future-supervision target. It bypasses the role-identity middleware (the only documented exemption) and never mutates any store.
- SIGINT and SIGTERM run the documented graceful-shutdown sequence: scheduler stop → interrupt every running cycle → wait the configured grace → `serverHandle.abort()`. A second SIGINT short-circuits to exit `130`.
- The new code is a thin **caller** of existing capabilities: `runServer` is the dispatch target (one-line addition to the dispatcher); `Scheduler.interrupt(...)` is the in-flight-cycle abort verb; the existing `agentRuntimeStateStore` is the source of truth for "which agents are running" during shutdown; the existing `EventBus` and `WS` surface are unchanged.
- The prototype's end-to-end loop becomes a reproducible runbook captured in the README and exercised by an automated smoke test.

**Non-Goals:**

- Rich `.env` UX (multiline values, variable interpolation, `.env.local` precedence, secret-redacted logs). The minimum here covers the prototype; step 27 owns the upgrade.
- Multi-project orchestration in one server. Out of MVP. The data model already carries `project_id` on every wire shape; a future multi-project switcher is purely additive.
- Authentication, TLS, CORS, rate limiting. The orchestration-server capability already pins the trust model (`127.0.0.1`, role-header trusted); `keni start` inherits it verbatim.
- Process supervision (auto-restart, log rotation beyond what `runServer` already does, daemonisation). Post-MVP. The new `/health` endpoint is the seam an external supervisor would consume; this step does not implement the supervisor.
- Bundling the `keni` binary. The prototype invokes the CLI via `deno run -A packages/cli/src/main.ts start`; binary distribution is post-MVP.
- Modifying `keni init`. The init flow is already specced and the project layout is unchanged. `keni start` reads what `keni init` writes — no new fields are added to `project.yaml`.
- Changing the existing `runServer` argv contract. `runServer` continues to accept `--project / --port / --host` for direct-invocation users; `keni start` calls `runServer` in-process via the existing entry point with a small extension to `RunServerDeps` for `staticAssetsRoot` and `serverStartedAt`.

## Decisions

### Decision 1 — `keni start` is a thin wrapper over `runServer`, in the same process

`keni start` SHALL NOT spawn `deno run packages/server/src/main.ts` as a subprocess. It SHALL call `runServer(argv, deps)` (already exported from `@keni/server`) in-process via a typed import, threading the new behaviour (port-range fallback, `.env` overlay, layered config, SPA-bundle deps, graceful-shutdown sequence) through `RunServerDeps`. The dispatcher's `case "start":` arm constructs the deps bag and awaits `runServer`'s exit code.

Rationale: `runServer` is already the "argv-level entry point" the orchestration-server capability documents (the spec literally says `runServer` SHALL be reusable from step 13's `keni start` arm); composing in-process keeps a single Deno runtime, a single set of dependencies, a single signal handler, and a single shutdown path. A subprocess would require IPC for shutdown coordination and would burn an extra ~150 ms on every start.

**Alternatives considered:** `keni start` shells out to `deno run`. Rejected — burns runtime startup time, doubles the process tree, complicates SIGINT routing (the parent must forward signals to the child *and* wait for the child's graceful shutdown), and forks the dependency graph (the SPA bundle would need a second resolution path).

### Decision 2 — Port range, default `7777..7787`, with deterministic `EADDRINUSE` fallback

The default port range is `7777..7787` (eleven ports). `keni start` walks the range in order on `EADDRINUSE`. The user can override the range with `--port-range <start>-<end>` or pin a single port with `--port <n>` (in which case `EADDRINUSE` is fatal — exit 1 with the clear message naming the busy port and suggesting `--port-range`).

The range default is configurable in `~/.keni/config.yaml` (`server.port_range: { start: 7777, end: 7787 }`) and per-project in `.keni/project.yaml` (project wins per the layered-config merge). When neither config file specifies the range, the in-source default applies.

Rationale: `7777` is far enough from common dev defaults (`3000`, `5173`, `8000`, `8080`) to avoid stepping on a Vite or a Postgres; eleven ports is enough headroom for "I have multiple Keni projects open" without becoming a security smell (every port still binds to `127.0.0.1` only). Walking a range beats picking a random ephemeral port because users want a stable URL across restarts of the *same* project — the printed URL after the first start is the URL the second start prints too, when the same port is free.

**Alternatives considered:**

- *`--port 0` (OS-assigned) as the default.* Rejected — every restart prints a different port, breaking bookmarks and the smoke-test runbook.
- *A single hardcoded default with no fallback.* Rejected — collides with anyone running a hobby service on `7777`; forces the user into `--port` discovery.
- *Random port in the ephemeral range (`49152..65535`).* Rejected — same bookmarking problem, plus harder to firewall-allowlist for users who care.

### Decision 3 — Static SPA serving lives on the orchestration server, mounted only when `staticAssetsRoot` is supplied

The `@keni/server` package SHALL gain an additive route group that serves `index.html` at `/`, immutable hashed assets at `/assets/*` (with `Cache-Control: public, max-age=31536000, immutable`), and SHALL serve `index.html` for any unmatched GET path that does NOT match a documented REST prefix (`/agents`, `/tickets`, `/prs`, `/activity`, `/health`, `/events`). The route group is mounted only when `ServerDeps.staticAssetsRoot: string` is provided; absent, the server's behaviour is unchanged (every existing `createServer(deps, opts)` call site stays green without modification).

`keni start` SHALL resolve `staticAssetsRoot` to the production SPA bundle's `dist/` directory. In the prototype this is `<repoRoot>/packages/spa/dist/` (resolved via the workspace member's location); in a future packaged binary this is the bundle path embedded in the binary. The dev-mode override `--spa-dev-url <url>` SHALL skip mounting the static route group entirely; in dev mode the user runs `cd packages/spa && deno task dev` separately and the SPA's existing Vite dev-server proxy continues to talk to the orchestration server at the printed `http://127.0.0.1:<port>`.

The fallthrough rule's "documented REST prefix" allowlist is encoded as a closed `const REST_PREFIXES = ["/agents", "/tickets", "/prs", "/activity", "/health", "/events"] as const` — adding a new REST prefix is a code change, by design (so a future contributor cannot accidentally swallow a new endpoint into the SPA fallthrough).

Rationale: The SPA's `react-router-dom` `BrowserRouter` rewrites `/tickets/ticket-0001` and friends client-side; when the user reloads on a deep link the server must respond with `index.html` so the SPA can re-mount. A SPA fallthrough is the standard pattern. Hosting the bundle on the same origin as the API also collapses CORS into a non-issue and gives the user a single URL to bookmark.

**Alternatives considered:**

- *A separate static-file server bound to a different port.* Rejected — two ports, two URLs, CORS pre-flights on every API call. The single-origin model is the SPA's natural fit.
- *Always mount the static route group; treat absence of `dist/` as an empty bundle.* Rejected — every existing test that builds `createServer` would now exercise a static-route path, and the absence of `dist/` would surface as a 404 on `/` instead of a clear "you need to run `deno task build` first" error from `keni start` itself.
- *Stream the bundle from the workspace's source files (no `vite build` required).* Rejected — production-mode hosting demands the bundled, hashed, immutable assets; a non-bundled mode is exactly the dev-server proxy.

### Decision 4 — `GET /health` is unconditionally `200` and bypasses the role-identity middleware

The orchestration server SHALL expose `GET /health`. The endpoint SHALL respond `200 { data: { status: "ok", project_id, uptime_ms, version }, project_id }` to any GET request, *without* requiring the `X-Keni-Role` header. This is the **only** documented exemption from the role-identity middleware, and it SHALL be implemented by registering the handler *before* `roleIdentity` in the middleware chain (not via a per-route bypass — the chain order is the contract).

`uptime_ms` SHALL be computed as `Date.now() - serverStartedAt.getTime()`, where `serverStartedAt` is captured by `runServer` when `Deno.serve`'s `onListen` fires. `version` SHALL be a string read from a build-time-injected constant in `@keni/shared` (`VERSION = "0.0.0-prototype"` for the prototype; future binary packaging will replace it via a `--build-arg`).

Rationale: A health endpoint that requires authentication is a process-supervision anti-pattern — every supervisor must learn the auth scheme to read the basic "is the server up?" signal. The exemption is documented, narrow (only this one endpoint, only the GET verb, no body, no mutation), and structurally enforced (the middleware chain is asserted in tests).

**Alternatives considered:**

- *`/health` requires `X-Keni-Role: user` like every other endpoint.* Rejected — every smoke test, every supervisor, every `curl` would have to encode the trust-model header for a check that has zero security relevance (the response carries no project state beyond the public `project_id` and the cosmetic uptime).
- *`/health` returns `503` when paused agents exist.* Rejected — confuses "the server is up" with "the team is making progress"; the activity log + the agent roster card already surface the latter.
- *`/health` lives at `/api/health` to fit a future namespacing scheme.* Rejected — no existing endpoint is `/api`-prefixed; namespacing is an MVP-or-later concern, and `/health` at the root is the universal convention (Kubernetes liveness probes, AWS ELB health checks, etc.).

### Decision 5 — Layered config: project wins, helper is pure, neither file is mutated

A pure helper `loadKeniConfig({ projectDir, homeDir, env })` SHALL: (1) read `~/.keni/config.yaml` if present (else treat as `{}`); (2) read `.keni/project.yaml` (REQUIRED — absence is a fatal `ProjectStateError` exit-1, the same error class the existing `init` flow already uses); (3) deep-merge with the project file winning per key (top-level keys are the only supported merge depth — an `agents` array on `project.yaml` REPLACES the global `agents` array entirely, it does NOT element-merge); (4) extract a separate `KeniStartConfig` (the new `server.port_range`, `server.host`, `server.shutdown_grace_ms`, `spa.mode` keys) so the existing `ConfigStore.readProjectConfig()` callers continue to see the unchanged `ProjectConfig` shape.

Neither file SHALL be written by `keni start`. The merged value is in-memory only.

Rationale: Pure functions are easy to test (the existing `packages/cli/src/init/`-style harness already proves the pattern). Project-wins is the conventional layering policy (per-project always overrides global). Top-level key replacement instead of deep merge avoids the surprising "I removed `alice` from project.yaml and got the global default `alice` back" behaviour that confuses users coming from layered shell configs.

**Alternatives considered:**

- *Deep merge across arrays and mappings.* Rejected — the surprise-removal problem above. Top-level replacement is unambiguous.
- *No global config at all in the prototype.* Rejected — the existing `developer-setup` README already documents `~/.keni/config.yaml` as a legitimate seam; rebuilding the layering later is more disruptive than wiring it once now.
- *A YAML-merge library (e.g., `merge-yaml`).* Rejected — the merge is shallow and trivially in-house (≤30 lines); a library buys nothing.

### Decision 6 — Minimal `.env` loader: `KEY=VALUE` per line, double-quoted values, comments, no interpolation

`loadEnvFile({ projectDir })` SHALL read `<projectDir>/.env` (when present), parse each non-blank, non-`#`-prefix line as `^([A-Za-z_][A-Za-z0-9_]*)=(.*)$`, strip surrounding double quotes from the value, and return a `Record<string, string>`. The loader SHALL NOT support multiline values, command substitution, variable interpolation, single quotes, or escape sequences. The loader SHALL log a one-line `warn`-level entry (via the existing `LogSink`) for each line that does not match the regex, and SHALL continue parsing.

`keni start` SHALL apply the parsed entries to `Deno.env` via `Deno.env.set(key, value)` for every key NOT already set by the calling shell (the calling shell wins — `.env` provides defaults, not overrides). The application happens **before** `runServer` constructs any store, so the orchestration server, the scheduler, and every engineer-runtime invocation see the merged environment.

Rationale: The minimum here covers 95% of `.env` files (the API-key shape `OPENAI_API_KEY=...`); the remaining 5% (multiline RSA keys, interpolated `${HOME}/cache`, etc.) are step 27's concern. The "calling shell wins" rule lets the user override a `.env` value for one invocation by exporting it in the shell, which matches the convention of every popular `.env` library (`dotenv`, `direnv`).

**Alternatives considered:**

- *`npm:dotenv` or `jsr:@std/dotenv`.* Rejected for this step — the parser is ≤50 lines, adding a dependency for a one-off is noise; step 27 may pick `@std/dotenv` once the spec includes interpolation. (`jsr:@std/dotenv` is on the existing dependency wishlist.)
- *Always overlay (`.env` overrides shell).* Rejected — surprises users who `OPENAI_API_KEY=test deno run ...` for a one-off invocation.
- *No `.env` support in this step at all (defer to step 27).* Rejected — the prototype's coding-agent invoker needs `OPENAI_API_KEY` (or the equivalent) on `Deno.env` to spawn a real subprocess; without `.env` the user would have to `export` every key in every terminal.

### Decision 7 — Graceful shutdown: scheduler.stop → interrupt-running → wait grace → server.abort

On the first SIGINT or SIGTERM, `keni start` SHALL execute, in this exact order:

1. **Stop the scheduler.** Call `scheduler.stop()` (already idempotent per the `scheduler` capability). New ticks are no longer armed.
2. **Interrupt every running cycle.** Iterate `agentRuntimeStateStore.list()`; for every entry whose `status === "running"`, `await scheduler.interrupt(id)` in series. The scheduler's existing `interrupt` contract handles SIGTERM → grace → SIGKILL and posts `session_interrupted` to the activity log, which flows through the runtime-state store and out as `agent.state_changed` to any connected SPA. The interrupts run in series (not in parallel) so a crashing agent cannot starve another agent's interrupt.
3. **Wait the configured grace period.** Default `2_000` ms; configurable in `~/.keni/config.yaml` / `.keni/project.yaml` as `server.shutdown_grace_ms`; hard-capped at `10_000` ms (the cap is the absolute bound — a misconfigured `100_000` clamps to `10_000`). The wait absorbs any in-flight `POST /activity` round-trips from agents that are mid-flush.
4. **Abort the listener.** Call `await serverHandle.abort()` (already exposed from the `startServer` capability).
5. **Return exit code 0.**

A second SIGINT (or SIGTERM) received during the shutdown sequence SHALL short-circuit to exit code `130` (the conventional SIGINT exit code for forced shutdown) without awaiting any further step. This is the user's "I really mean it" escape hatch.

The shutdown sequence is encoded in `packages/cli/src/start/shutdown.ts` as a pure-ish function `runShutdownSequence({ scheduler, runtimeStore, serverHandle, graceMs, signal })` that takes the abort signal of the second-signal escape hatch and resolves to the exit code.

Rationale: The existing capabilities cover every step; this decision is about the *sequence* and the *contract on second-signal behaviour*. Stopping the scheduler before interrupting prevents a tick from arming a new cycle in the middle of the interrupt loop. Series interrupt prevents starvation. The grace period is small enough to feel snappy and large enough to cover normal `POST /activity` round-trips.

**Alternatives considered:**

- *Parallel interrupts.* Rejected — a single hung `Scheduler.interrupt` (e.g., a coding-agent subprocess that ignores SIGTERM and is mid-SIGKILL grace) would block every other agent's interrupt by holding the JS event loop. Series gives each agent its full grace.
- *Skip the grace period entirely.* Rejected — burns the in-flight `POST /activity` for every agent that was mid-flush; the activity log would lose the `session_interrupted` row that should accompany the abort.
- *Forced exit on first SIGINT.* Rejected — the user's first signal is "please shut down"; the second is "I'm serious." Conflating the two surprises users coming from `node` / `python` / `go` toolchains.
- *Auto-revert ticket statuses on shutdown-induced interrupt.* Rejected — the existing `interrupt-and-timeout-ux` capability explicitly pins "ticket status is NOT auto-reverted"; that rule applies to user-initiated interrupts and to shutdown-initiated interrupts identically.

### Decision 8 — Exit codes follow the existing `runInit` convention plus one for graceful-shutdown SIGINT-twice

`keni start` SHALL return:

| Exit | Meaning |
| ---- | ------- |
| `0` | Server started, ran, and shut down cleanly on first SIGINT/SIGTERM. |
| `1` | Filesystem / git / project-state failure (e.g., `.keni/project.yaml` missing, malformed YAML, unwritable workspace, port range exhausted, SPA bundle path missing in production mode). |
| `2` | Usage error (unknown flag, bad `--port` / `--port-range` value, unknown `--spa-dev-url` shape). |
| `130` | Second SIGINT/SIGTERM during graceful shutdown (forced shutdown, conventional). |

The `0` / `1` / `2` codes match the existing `runInit` and `runServer` conventions; `130` is the new code added for the second-signal escape hatch.

Rationale: Exit-code consistency across subcommands keeps the dispatcher's `try/catch` simple (one shared error-to-exit table). `130` is the universal convention for "process killed by the user via Ctrl-C" (`128 + SIGINT(2)`).

**Alternatives considered:**

- *No special code for the second signal — just exit `0`.* Rejected — supervisors look at exit codes to decide whether to restart; a forced shutdown should not look like a clean shutdown.
- *Use `137` (SIGKILL) for the forced exit.* Rejected — the shutdown is initiated by SIGINT, not SIGKILL; `137` would mislead operators about the cause.

### Decision 9 — `paused_agents` boot honouring is structural, not a new field

The orchestration-server capability already specs that `runServer` seeds the `agentRuntimeStateStore` with each agent starting `paused: false`. The source plan asks `keni start` to "honour pause state from `project.yaml` and `state.json` on boot."

This decision pins the interpretation: **`keni start` SHALL NOT introduce a new `paused_agents` field on `project.yaml`.** Instead, the existing `state.json` (created by `keni init`, defined by the `project-layout` capability as `{ "watermarks": {} }` in this step) is extended by `keni start` to optionally carry a `paused_agents: string[]` array. When `keni start` boots and the array is present, the runtime-state store seeds the named agents with `paused: true`. When the array is absent (the default after `keni init`), every agent boots `paused: false` per the existing capability.

The seam to write `paused_agents` is `POST /agents/:id/pause` and `POST /agents/:id/resume`: those handlers already mutate the in-memory `paused` flag; this change extends them to also write through to `<projectDir>/.keni/state.json` so the choice survives a restart. The write is fire-and-forget at the end of the request (after the `agent.state_changed` emit); a failure logs at warn level and does NOT fail the request.

Rationale: `state.json` is already the prototype's "runtime state survives a restart" file (the `project-layout` spec's `watermarks` is exactly that pattern). Adding `paused_agents` as a sibling key is structurally honest — `paused` is runtime state, not project configuration. Pushing it onto `project.yaml` would invite the question "why doesn't `agents` carry the `paused` flag?", which is the answer to a different question (the answer being: `agents` is the *roster*, `state.json` is the *runtime memory*).

**Alternatives considered:**

- *Add `paused: bool` to each `agents[]` entry on `project.yaml`.* Rejected — conflates roster and runtime state; would require `keni start` to write back into `project.yaml` on every pause/resume, polluting git history with non-decision noise.
- *Use a separate `~/.keni/runtime/<project-id>.json` file outside the project tree.* Rejected — couples runtime state to the home directory in a way that breaks "delete the project folder, the project is gone" intuition.
- *Don't honour pause across restarts at all (the source plan's requirement is interpreted as "honour at boot if the in-memory store is somehow seeded").* Rejected — the source plan literally says "Honours pause state from `project.yaml` and `state.json` on boot." This decision satisfies that.

### Decision 10 — Dev-mode is opt-in via `--spa-dev-url`, not auto-detected

`keni start --spa-dev-url http://127.0.0.1:5173` SHALL skip mounting the static SPA route group; the user runs `cd packages/spa && deno task dev` separately and points the dev server's existing `KENI_SERVER_URL` at the printed orchestration-server URL. The orchestration server still serves `/health` and the REST + WS surfaces; the SPA route group is the only path that's skipped.

When `--spa-dev-url` is absent, the static route group is mounted; if the SPA bundle's `dist/` directory does not exist, `keni start` fails fast (exit 1) with a message naming the expected path and the `deno task build` invocation that produces it.

Rationale: Auto-detection ("if `dist/` exists, serve it; if not, look for a Vite dev server") is a footgun — a stale `dist/` from three weeks ago would silently win over a running `vite dev`, surfacing as "my edits don't show up." Opt-in is unambiguous.

**Alternatives considered:**

- *`KENI_SPA_DEV_URL` env var instead of a flag.* Rejected — the flag is consistent with the existing `--port` / `--port-range` / `--host` family on `keni start`; an env var would scatter the dev-mode seam.
- *Dev mode by default in the workspace, prod mode by default in the binary.* Rejected — same auto-detection footgun, plus a different default in two contexts is a separate footgun.

### Decision 11 — Smoke-test runbook lives in README + an automated `start_e2e_test.ts`

The README SHALL gain a top-level "End-to-end smoke test" subsection that lists the four steps a user runs after `keni init`: `keni start`, open the printed URL, create a ticket via the UI, observe the engineer drive the lifecycle. The runbook SHALL be runnable end-to-end on a fresh laptop in under five minutes (assuming the workspace is cloned and `deno install` has run).

In parallel, `packages/cli/src/start/start_e2e_test.ts` SHALL boot `keni start` against a fixture project (a temporary directory pre-populated by an in-test `runInit`) with a stubbed `makeEngineerRunner` that completes one cycle synchronously, asserts the printed URL responds `200` on `/health`, asserts `/` serves `index.html` containing the SPA's mount node, asserts `POST /tickets` creates a ticket and `GET /agents` shows the engineer's `last_activity` advancing through `session_start`, asserts the abort signal triggers the documented graceful-shutdown sequence in order (via instrumented `scheduler.stop` / `scheduler.interrupt` / `serverHandle.abort` deps), and verifies the exit code is `0`.

Rationale: The README runbook is the *user's* exit-criterion artefact (per `spec.md` §8); the automated test is *Keni's* — it stops a regression in any of the moving parts (CLI dispatcher, `runServer`, scheduler interrupt, SPA static serving, `/health`) from silently breaking the prototype's promise.

**Alternatives considered:**

- *Replace the automated test with a Cypress / Playwright browser run.* Rejected — would add a new dependency family and would not catch the shutdown-sequence regressions that matter most.
- *Skip the automated test entirely; rely on the manual runbook.* Rejected — the prototype's exit criterion is too important to lean on a manual check.

### Decision 12 — `--project` defaults to `cwd`; positional argument wins; explicit `--project` flag is the third option

`keni start [path]` SHALL accept a single positional argument for the project path, mirroring `keni init`. When the positional argument is absent, the project path defaults to `Deno.cwd()`. An explicit `--project <path>` flag is also accepted (for symmetry with `runServer`'s direct invocation); when both the positional and the flag are present, the positional argument wins (with a warn-level log line naming the duplication).

Rationale: The source plan calls the subcommand `keni start [project-path]`, matching the positional shape `keni init` already established. Allowing `--project` as a fallback gives the symmetry users expect from a CLI family; the positional-wins rule resolves the ambiguity the same way every popular CLI does (`git -C <path> ...` is the explicit flag; `git status` defaults to `cwd`).

**Alternatives considered:**

- *No positional argument; `--project` is required.* Rejected — `keni init` already established the positional shape; deviating in `keni start` would be inconsistent.
- *No `--project` flag at all.* Rejected — the symmetry with `runServer`'s direct invocation is useful for advanced users who want to run `keni start` from a script without `cd`-ing.

## Risks / Trade-offs

- **[Risk] The `EADDRINUSE` retry can mask a configuration mistake.** A user who pinned `--port 8080` on every restart, then accidentally starts a second instance, sees `keni start` quietly walk to `8081` and bind there. → Mitigation: `--port <n>` (singular, no fallback) is the explicit-pin verb; `--port-range <start>-<end>` is the explicit-walk verb; the default range walks. The startup log line names the chosen port unambiguously, and a stderr warn fires when the range walked past the first port.
- **[Risk] Static SPA serving on the orchestration server can mask a stale build.** A user who edits SPA source, forgets to `deno task build`, and reloads the browser sees the old bundle. → Mitigation: README's "Quickstart with `keni start`" subsection names the `deno task build` step explicitly; `keni start --spa-dev-url <url>` is the documented dev-mode escape hatch. Future packaging will move the bundle into the binary, eliminating this footgun by construction.
- **[Risk] The graceful-shutdown sequence's series interrupt can take up to `N * grace_ms` for `N` running agents.** With ten agents and a 2 s grace, that's 20 s. → Mitigation: the prototype runs a single engineer (`alice`); the issue surfaces only at MVP scale (multiple engineers), and at that point the parallel-interrupt design becomes worth the complexity. For the prototype, series is correct.
- **[Risk] The `.env` loader's "calling shell wins" rule surprises users who expect `.env` to always win.** → Mitigation: README's "Quickstart" subsection names the rule explicitly; the rule matches every popular `.env` library; step 27 may add a `--env-overrides` flag if the data points say it's needed.
- **[Risk] `paused_agents` in `state.json` drifts from the in-memory state if a crash interrupts the fire-and-forget write.** → Mitigation: the persistence is best-effort by design (warn on failure, never fail the request); the next pause/resume corrects the drift; the activity log carries the canonical pause record. Drift is a cosmetic boot-time issue, not a correctness issue.
- **[Trade-off] `/health` bypasses the role-identity middleware.** → Acceptable: the response carries no actionable state beyond the public `project_id`; the bypass is the only documented exemption and is structurally enforced (asserted by a middleware-order test). A future auth layer would slot in front of `roleIdentity` and `/health` would also be exempt by the same explicit rule.
- **[Trade-off] `keni start` requires the SPA bundle's `dist/` directory in production mode.** Without `deno task build`, the first `keni start` fails with a clear "missing bundle" error. → Acceptable: the README's quickstart names `deno task build` explicitly; future packaging eliminates the gap; the alternative (a 404 on `/`) is worse.
- **[Trade-off] The `2_000` ms default shutdown grace is short for very chatty cycles.** → Acceptable: the cap is configurable up to `10_000` ms; the default is tuned for the prototype's typical cycle (a single `POST /activity` flush); operators with slower agents pin a higher value in `~/.keni/config.yaml`.

## Migration Plan

This change is purely additive at the capability level: a new `cli-start` capability, two delta-only additions to `orchestration-server` (`/health` plus the optional static-asset route group), and a structural rewrite of three README subsections in `developer-setup`. No existing endpoint, wire shape, error code, or middleware order is modified. There is no on-disk schema migration: `state.json` gains an OPTIONAL `paused_agents: string[]` array (existing files without the array continue to load).

Rollout:

1. Land the orchestration-server changes (new `/health` route, optional static-asset route group, extended `ServerDeps`). Every existing test that builds `createServer({...}, opts)` without the new fields continues to pass; the new behaviour activates only when the new field is supplied.
2. Land the `@keni/cli` `start` subcommand and its supporting modules (`loadConfig`, `loadEnv`, `port`, `shutdown`, `start_e2e_test`). The dispatcher's `case "start":` arm activates the new behaviour without touching the existing `case "init":` path.
3. Land the README rewrites and the new "End-to-end smoke test" subsection. Cross-link from the existing "Getting started" section.
4. Run the full workspace-level test suite, the new `start_e2e_test`, and the manual end-to-end smoke runbook from the README.

Rollback: revert in inverse order. The new `state.json` `paused_agents` field is OPTIONAL and forward-compatible — a `state.json` written by this change is readable by the pre-change codebase (which simply ignores the unknown field).

## Open Questions

- **Should the SPA's static-asset route group support gzip / Brotli pre-compressed files?** Vite emits `index.html`, the bundled JS, and the bundled CSS but does NOT emit `.gz` / `.br` siblings by default. The static handler in this step does NOT serve pre-compressed files; gzip-on-the-fly is a Hono middleware concern that lands in a follow-up if browser-side performance becomes a concern. The decision is documented in the spec; readers should not expect Content-Encoding negotiation on `/assets/*` in this step.
- **Should `/health` carry a `db: "ok"` field for forward compatibility with a future on-disk-store health check?** Deferred. The current health surface is purely about "the listener is up"; expanding it requires a dependency-injectable health-check protocol that is properly designed once the on-disk-store change lands.
- **Should `keni start` print the SPA route as a separate log line for ergonomic clarity?** The current `Keni server running at http://127.0.0.1:<port>` line is sufficient; the SPA serves at the same URL. A future "richer startup banner" change can add the breakdown without breaking the existing log-line contract.
- **Should the second-SIGINT exit code (`130`) be configurable?** Deferred — the conventional value is the standard and overrides surprise operators reading `man wait` or `kubectl describe pod`. A future need can land additively.
