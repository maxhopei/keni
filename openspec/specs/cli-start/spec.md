# cli-start Specification

## Purpose
TBD - created by archiving change cli-start-and-end-to-end-wiring. Update Purpose after archive.
## Requirements
### Requirement: `@keni/cli` exposes a `start` subcommand that boots the orchestration server in-process

The `@keni/cli` package SHALL extend its dispatcher with a `start` subcommand. The dispatcher's argv handling SHALL be `keni start [project-path] [flags]`: `project-path` is OPTIONAL positional argument resolved to an absolute path (default: `Deno.cwd()`); supported flags are `--project <path>` (alias for the positional, positional wins on conflict with a warn-level log), `--port <n>` (pin a single port; `EADDRINUSE` is fatal — exit 1), `--port-range <start>-<end>` (override the configured range), `--host <hostname>` (defaults to `127.0.0.1`), `--spa-dev-url <url>` (skip mounting the static SPA route group; the SPA's existing Vite dev-server proxy talks to the printed orchestration-server URL). The dispatcher SHALL invoke `runStart(parsedArgs, io)` and return its exit code; `runStart` SHALL be exported from `packages/cli/src/start/mod.ts` so tests can drive it in-process.

`runStart` SHALL NOT spawn a subprocess; it SHALL call `runServer(argv, deps)` (already exported from `@keni/server`) in the same Deno runtime, passing the new behaviour (port-range fallback, layered config, `.env` overlay, SPA-bundle path, graceful-shutdown sequence) through `RunServerDeps` and the new fields the orchestration-server delta adds (`staticAssetsRoot`, `serverStartedAt`).

#### Scenario: `keni start` defaults to the current working directory

- **WHEN** a user runs `keni start` from inside a directory containing `.keni/project.yaml`
- **THEN** the subcommand resolves the project path to that directory
- **AND** no positional argument is required
- **AND** the dispatcher returns the exit code that `runStart` resolves to

#### Scenario: `keni start <path>` resolves the named project

- **WHEN** a user runs `keni start /abs/path/to/project`
- **AND** `/abs/path/to/project/.keni/project.yaml` exists
- **THEN** the subcommand boots against `/abs/path/to/project`
- **AND** the user's current working directory is unchanged

#### Scenario: Positional argument wins over `--project` flag

- **WHEN** a user runs `keni start /a --project /b`
- **THEN** the subcommand boots against `/a`
- **AND** a warn-level log line names the duplication and the chosen value (`/a`)

#### Scenario: Unknown flag produces a usage error

- **WHEN** a user runs `keni start --unknown-flag`
- **THEN** the dispatcher returns exit code 2
- **AND** stderr names the unknown flag and lists the supported flags

#### Scenario: Missing `.keni/project.yaml` fails fast with exit 1

- **WHEN** a user runs `keni start` against a directory that does not contain `.keni/project.yaml`
- **THEN** the dispatcher returns exit code 1
- **AND** stderr names the missing file and instructs the user to run `keni init` first

### Requirement: `runStart` resolves the layered config (project wins over global) without mutating either file

`runStart` SHALL read both `<homeDir>/.keni/config.yaml` (when present) and `<projectDir>/.keni/project.yaml` (REQUIRED) via a pure helper `loadKeniConfig({ projectDir, homeDir, env })`. The helper SHALL return `{ projectConfig: ProjectConfig, startConfig: KeniStartConfig }`. The merge SHALL be top-level-key shallow: the project file's value replaces the global file's value verbatim per top-level key (no deep merge, no array element merge). Neither file SHALL be written by `runStart`. When `~/.keni/config.yaml` is absent, the helper SHALL treat it as `{}` and SHALL NOT create it.

`KeniStartConfig` SHALL carry `server.port_range: { start: number, end: number }` (default `{ start: 7777, end: 7787 }`), `server.host: string` (default `"127.0.0.1"`), `server.shutdown_grace_ms: number` (default `2_000`, hard-capped at `10_000`), and `spa.mode: "bundled" | "dev"` (default `"bundled"`). Unknown top-level keys SHALL be preserved on the merged value (forward compatibility) but SHALL NOT be passed to `runServer`.

The CLI flags SHALL override the merged config: `--port <n>` collapses the port range to `[n, n]`; `--port-range <start>-<end>` replaces the merged range; `--host <hostname>` replaces the merged host; `--spa-dev-url <url>` forces `spa.mode = "dev"` and threads the URL into the dev-mode runbook (no static route group is mounted; the dev URL is logged so the user can pre-flight the proxy target).

#### Scenario: Project file wins over global file per top-level key

- **WHEN** `~/.keni/config.yaml` declares `server: { port_range: { start: 9000, end: 9010 } }`
- **AND** `<projectDir>/.keni/project.yaml` declares `server: { port_range: { start: 7777, end: 7787 } }`
- **THEN** the merged `KeniStartConfig.server.port_range` is `{ start: 7777, end: 7787 }` (project wins)
- **AND** neither file is written

#### Scenario: Global value applies when project does not specify the key

- **WHEN** `~/.keni/config.yaml` declares `server: { host: "::1" }`
- **AND** `<projectDir>/.keni/project.yaml` does not have a `server.host` entry
- **THEN** the merged `KeniStartConfig.server.host` is `"::1"`

#### Scenario: Built-in defaults apply when neither file specifies a key

- **WHEN** neither `~/.keni/config.yaml` nor `<projectDir>/.keni/project.yaml` declares `server.shutdown_grace_ms`
- **THEN** the merged `KeniStartConfig.server.shutdown_grace_ms` is `2_000`

#### Scenario: `--port <n>` collapses the merged range to a single port

- **WHEN** the merged config declares `port_range: { start: 7777, end: 7787 }`
- **AND** the user runs `keni start --port 8080`
- **THEN** the resolved port range is `[8080, 8080]`
- **AND** an `EADDRINUSE` on `8080` returns exit code 1 (no fallback)

#### Scenario: `--port-range <start>-<end>` replaces the merged range

- **WHEN** the user runs `keni start --port-range 9000-9005`
- **THEN** the resolved port range is `[9000..9005]` (six ports)
- **AND** the merged config's `port_range` is overridden

#### Scenario: Top-level keys are replaced, not merged

- **WHEN** `~/.keni/config.yaml` declares `agents: [{ id: "alice", role: "engineer" }, { id: "bob", role: "po" }]`
- **AND** `<projectDir>/.keni/project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]`
- **THEN** the merged roster is `[{ id: "alice", role: "engineer" }]` (project wins; `bob` is NOT element-merged)

#### Scenario: `~/.keni/config.yaml` absent is treated as `{}`

- **WHEN** the file `~/.keni/config.yaml` does not exist
- **AND** `keni start` is invoked
- **THEN** the merged config is the project file's content layered over the built-in defaults
- **AND** the global file is not created

### Requirement: `runStart` overlays `<projectDir>/.env` onto `Deno.env`, with the calling shell winning

`runStart` SHALL parse `<projectDir>/.env` (when present) via the helper `loadEnvFile({ projectDir })`. The parser SHALL accept lines matching `^([A-Za-z_][A-Za-z0-9_]*)=(.*)$`, SHALL strip surrounding double quotes from the value (single-character `"` on both ends), SHALL ignore blank lines and lines whose first non-whitespace character is `#`, and SHALL log a single `warn`-level line via the existing `LogSink` for each line that does not match the regex (and SHALL continue parsing). The parser SHALL NOT support multiline values, command substitution, variable interpolation, single-quoted values, or escape sequences; those are step 27's concern.

For every `(key, value)` returned by the parser, `runStart` SHALL call `Deno.env.set(key, value)` only when `Deno.env.get(key)` returns `undefined` (the calling shell wins). The application SHALL happen **before** `runServer` constructs any store, so the orchestration server, the scheduler, and every engineer-runtime invocation see the merged environment.

#### Scenario: `.env` provides defaults the calling shell does not override

- **WHEN** `<projectDir>/.env` contains the line `OPENAI_API_KEY=sk-fixture`
- **AND** `Deno.env.get("OPENAI_API_KEY")` was `undefined` before `runStart` was called
- **THEN** `Deno.env.get("OPENAI_API_KEY") === "sk-fixture"` after the loader runs
- **AND** the application happens before any store is constructed

#### Scenario: Calling shell wins over `.env`

- **WHEN** the calling shell sets `OPENAI_API_KEY=sk-shell` before invoking `keni start`
- **AND** `<projectDir>/.env` contains `OPENAI_API_KEY=sk-fixture`
- **THEN** `Deno.env.get("OPENAI_API_KEY") === "sk-shell"` after the loader runs

#### Scenario: Comments and blank lines are ignored

- **WHEN** `<projectDir>/.env` contains the lines `# header comment`, `\n`, `KEY=value`, and `   # indented comment`
- **THEN** the parsed map is `{ "KEY": "value" }`
- **AND** no warn-level log line was emitted

#### Scenario: Double-quoted values have the surrounding quotes stripped

- **WHEN** `<projectDir>/.env` contains `KEY="value with spaces"`
- **THEN** the parsed map is `{ "KEY": "value with spaces" }`

#### Scenario: Malformed lines are warned and skipped

- **WHEN** `<projectDir>/.env` contains the lines `VALID=ok`, `not-a-key=value`, and `KEY_2=ok2`
- **THEN** the parsed map is `{ "VALID": "ok", "KEY_2": "ok2" }`
- **AND** exactly one warn-level log line was emitted naming the malformed line content

#### Scenario: `.env` absent is a no-op (no warn, no error)

- **WHEN** `<projectDir>/.env` does not exist
- **AND** `keni start` is invoked
- **THEN** the parsed map is `{}`
- **AND** no warn-level log line is emitted

#### Scenario: Multiline / interpolated values are NOT supported in this step

- **WHEN** `<projectDir>/.env` contains the line `KEY=${HOME}/cache`
- **THEN** the parsed map is `{ "KEY": "${HOME}/cache" }` (the literal value is preserved; no interpolation runs)
- **AND** no warn-level log line is emitted (the line matches the parser's regex)

### Requirement: `runStart` walks the resolved port range deterministically on `EADDRINUSE`, exit 1 when exhausted

`runStart` SHALL attempt to bind the resolved port range in order from `start` to `end` (inclusive). On `EADDRINUSE` for a given port, `runStart` SHALL log a warn-level line naming the busy port and the next port to try, then attempt the next port. After the last port in the range fails with `EADDRINUSE`, `runStart` SHALL return exit code 1 with a stderr message that names the exhausted range and instructs the user to choose a different range via `--port-range` or to free a port.

When `--port <n>` is supplied (collapsing the range to `[n, n]`), an `EADDRINUSE` on `n` SHALL return exit code 1 immediately with no warn-level retry log line (the user explicitly pinned a single port).

The chosen bound port SHALL be the value passed to `runServer` (as `--port=<n>` or via the existing `RunServerDeps` extension). Errors other than `EADDRINUSE` SHALL be propagated unchanged (e.g., a permission denial on a low port surfaces as exit 1 with the OS error in stderr).

#### Scenario: Default range walks past a busy first port

- **WHEN** the resolved port range is `[7777..7787]`
- **AND** port `7777` is busy and port `7778` is free
- **THEN** the server binds `7778`
- **AND** stdout's startup line names `http://127.0.0.1:7778`
- **AND** exactly one warn-level log line was emitted naming the busy `7777` and the next attempt `7778`

#### Scenario: Range exhaustion returns exit 1

- **WHEN** the resolved port range is `[7777..7779]` (three ports)
- **AND** every port in the range is busy
- **THEN** `runStart` returns exit code 1
- **AND** stderr names the exhausted range and the `--port-range` override

#### Scenario: `--port <n>` does not retry on `EADDRINUSE`

- **WHEN** the user runs `keni start --port 8080`
- **AND** port `8080` is busy
- **THEN** `runStart` returns exit code 1
- **AND** no warn-level retry log line is emitted
- **AND** stderr names port `8080` and suggests `--port-range`

#### Scenario: Non-`EADDRINUSE` bind errors do not retry

- **WHEN** the resolved port range is `[80..82]` (low ports requiring privilege)
- **AND** the bind fails with `EACCES` (permission denied) on the first port
- **THEN** `runStart` returns exit code 1
- **AND** stderr names the OS error verbatim
- **AND** no fallback port is tried (the failure is not `EADDRINUSE`)

### Requirement: `runStart` resolves the SPA-bundle path in production mode and passes it to the server

When `KeniStartConfig.spa.mode === "bundled"` (the default), `runStart` SHALL resolve the SPA bundle's `dist/` directory and pass it to `runServer` as `RunServerDeps.staticAssetsRoot`. The resolution order SHALL be: (1) an explicit `--spa-bundle <path>` flag (when present); (2) the workspace-relative path `<repoRoot>/packages/spa/dist/` (resolved via `import.meta.resolve("@keni/spa")` plus `..` traversal); (3) future binary-packaged paths (post-MVP — out of scope). When the resolved `dist/` directory does not exist, `runStart` SHALL return exit code 1 with a stderr message naming the expected path and the `deno task build` invocation that produces it.

When `--spa-dev-url <url>` is supplied (forcing `spa.mode = "dev"`), `runStart` SHALL NOT pass `staticAssetsRoot` to `runServer` (the static route group is not mounted). The startup log SHALL include an info-level line naming the dev URL so the user can pre-flight the SPA's `KENI_SERVER_URL` proxy.

#### Scenario: Production mode resolves `<repoRoot>/packages/spa/dist/`

- **WHEN** `keni start` is invoked without `--spa-dev-url`
- **AND** `<repoRoot>/packages/spa/dist/index.html` exists
- **THEN** `runServer` receives `staticAssetsRoot: "<absolute>/packages/spa/dist"` via `RunServerDeps`
- **AND** the orchestration server's static route group is mounted (per the `orchestration-server` capability's delta)

#### Scenario: Production mode without a built bundle fails fast

- **WHEN** `keni start` is invoked without `--spa-dev-url`
- **AND** the SPA bundle's `dist/index.html` does not exist
- **THEN** `runStart` returns exit code 1
- **AND** stderr names the missing path and instructs the user to run `deno task build`
- **AND** `runServer` is not invoked

#### Scenario: `--spa-dev-url` skips the static route group

- **WHEN** the user runs `keni start --spa-dev-url http://127.0.0.1:5173`
- **THEN** `runServer` is invoked WITHOUT `staticAssetsRoot` set on `RunServerDeps`
- **AND** stdout's startup banner includes a line naming the dev URL `http://127.0.0.1:5173`

#### Scenario: `--spa-bundle <path>` overrides the workspace-relative resolution

- **WHEN** the user runs `keni start --spa-bundle /custom/dist`
- **AND** `/custom/dist/index.html` exists
- **THEN** `runServer` receives `staticAssetsRoot: "/custom/dist"` via `RunServerDeps`

### Requirement: `runStart` honours `state.json`'s `paused_agents` array on boot

`runStart` SHALL read `<projectDir>/.keni/state.json` after parsing the layered config. When the parsed JSON contains an OPTIONAL `paused_agents: string[]` array, `runStart` SHALL pass the array to `runServer` via a new `RunServerDeps.initiallyPausedAgents` field. The orchestration-server's `runServer` SHALL seed the `agentRuntimeStateStore` so that every agent named in the array has `paused: true` (every other agent retains the default `paused: false`). When `paused_agents` is absent, missing, malformed (not a `string[]`), or contains an agent id that is not in the roster, `runStart` SHALL log a single warn-level line per problem and continue (the bad ids are silently dropped; a malformed array is treated as `[]`).

`POST /agents/:id/pause` and `POST /agents/:id/resume` SHALL persist the post-call set of paused agent ids back to `<projectDir>/.keni/state.json` after the existing `agent.state_changed` emit (fire-and-forget; a write failure logs at warn level and does NOT fail the request). The persistence SHALL preserve the file's existing top-level keys (`watermarks` and any future siblings) — only the `paused_agents` key SHALL be rewritten.

#### Scenario: `paused_agents` seeds the runtime store at boot

- **WHEN** `<projectDir>/.keni/state.json` contains `{ "watermarks": {}, "paused_agents": ["alice"] }`
- **AND** `keni start` boots against a project whose roster is `[{ id: "alice", role: "engineer" }, { id: "bob", role: "po" }]`
- **THEN** the runtime store seeds `alice` with `paused: true` and `bob` with `paused: false`
- **AND** `GET /agents` returns `data` whose `alice` entry has `paused: true`

#### Scenario: Absence of `paused_agents` is the existing behaviour

- **WHEN** `<projectDir>/.keni/state.json` is the post-`keni init` content `{ "watermarks": {} }`
- **AND** `keni start` boots
- **THEN** every agent in the roster boots with `paused: false`
- **AND** no warn-level log line is emitted

#### Scenario: Unknown agent ids in `paused_agents` are dropped with a warn

- **WHEN** `<projectDir>/.keni/state.json` contains `{ "paused_agents": ["alice", "ghost"] }`
- **AND** the roster is `[{ id: "alice", role: "engineer" }]`
- **THEN** the runtime store seeds `alice` with `paused: true`
- **AND** `ghost` is silently dropped
- **AND** exactly one warn-level log line names `ghost` as not in the roster

#### Scenario: Malformed `paused_agents` is treated as `[]`

- **WHEN** `<projectDir>/.keni/state.json` contains `{ "paused_agents": "alice" }` (a string, not an array)
- **AND** `keni start` boots
- **THEN** every agent boots with `paused: false`
- **AND** exactly one warn-level log line names the malformed value and the expected shape

#### Scenario: `POST /agents/:id/pause` persists the change to `state.json`

- **WHEN** `keni start` is running against a project with `state.json` containing `{ "watermarks": {} }`
- **AND** `POST /agents/alice/pause` is called with `X-Keni-Role: user`
- **THEN** the response is 200
- **AND** `<projectDir>/.keni/state.json` now contains `{ "watermarks": {}, "paused_agents": ["alice"] }`
- **AND** the `watermarks` key is preserved verbatim

#### Scenario: A `state.json` write failure does not fail the pause request

- **WHEN** `<projectDir>/.keni/state.json` is read-only (write fails with `EACCES`)
- **AND** `POST /agents/alice/pause` is called with `X-Keni-Role: user`
- **THEN** the response is still 200
- **AND** the in-memory `paused: true` flag is set
- **AND** exactly one warn-level log line names the persistence failure and the file path

### Requirement: `runStart` prints the bound URL to stdout in the documented format

After `runServer` resolves and `Deno.serve`'s `onListen` fires, `runStart` SHALL print exactly one line to stdout in the documented format: `Keni server running at http://<host>:<port>` followed by a newline. The format SHALL be byte-for-byte stable so scripts and the smoke-test runbook can grep for it. When `--spa-dev-url <url>` is in effect, `runStart` SHALL also print one additional line: `SPA dev mode — proxy your Vite dev server to <url>`. No other startup banner content SHALL be printed in this step (the future "richer startup banner" change is out of scope).

#### Scenario: Production-mode startup prints exactly one URL line

- **WHEN** `keni start` boots successfully against `127.0.0.1:7777`
- **AND** `--spa-dev-url` is not supplied
- **THEN** stdout contains exactly one line matching `Keni server running at http://127.0.0.1:7777\n`
- **AND** no additional banner content is printed

#### Scenario: Dev-mode startup prints the SPA dev URL line

- **WHEN** `keni start --spa-dev-url http://127.0.0.1:5173` boots successfully against `127.0.0.1:7777`
- **THEN** stdout contains, in order, the line `Keni server running at http://127.0.0.1:7777` and the line `SPA dev mode — proxy your Vite dev server to http://127.0.0.1:5173`

#### Scenario: A non-default bound port is reflected in the printed URL

- **WHEN** the resolved port range walks from `7777` (busy) to `7778` (free)
- **THEN** stdout's URL line is `Keni server running at http://127.0.0.1:7778`

### Requirement: SIGINT and SIGTERM run the documented graceful-shutdown sequence; second signal exits 130

`runStart` SHALL install one SIGINT and one SIGTERM listener after `runServer` resolves with the started server handle. On the FIRST signal of either kind, `runStart` SHALL execute, in this exact order, via the helper `runShutdownSequence({ scheduler, runtimeStore, serverHandle, graceMs, secondSignal })`: (1) `await scheduler.stop()`; (2) iterate `runtimeStore.list()` and `await scheduler.interrupt(id)` IN SERIES for every entry whose `status === "running"` (the series ordering prevents a hung agent from starving others); (3) await the configured `KeniStartConfig.server.shutdown_grace_ms` (default `2_000`, hard cap `10_000`) — the wait is `Promise.race(setTimeout(graceMs), secondSignal.aborted)` so a second signal short-circuits it; (4) `await serverHandle.abort()`; (5) return exit code 0. A SECOND SIGINT or SIGTERM during steps 1–4 SHALL fire the `secondSignal` `AbortController`, short-circuiting the wait in step 3 and skipping any remaining work in steps 1–2; the function SHALL return exit code 130 (the conventional SIGINT exit code).

The signal handlers SHALL be removed before `runStart` returns (no leaked global handlers). Tests SHALL drive the same path via an injected `AbortSignal` in `RunStartDeps`.

#### Scenario: First signal runs the full sequence and exits 0

- **WHEN** `runStart` is running with two engineers, `alice` (`status: "running"`) and `bob` (`status: "idle"`)
- **AND** the test fires SIGINT
- **THEN** `scheduler.stop()` is called exactly once
- **AND** `scheduler.interrupt("alice")` is called exactly once (and resolves before any subsequent step)
- **AND** `scheduler.interrupt("bob")` is NOT called (`bob` is idle)
- **AND** the wait of `shutdown_grace_ms` elapses (or the test's stub clock advances past it)
- **AND** `serverHandle.abort()` is called exactly once
- **AND** `runStart` returns exit code 0

#### Scenario: Series interrupt — the second agent's interrupt waits for the first to resolve

- **WHEN** `runStart` is running with `alice` and `bob` both `status: "running"`
- **AND** the test fires SIGINT
- **AND** instrumented `scheduler.interrupt` records the start and end timestamps of each call
- **THEN** the captured timestamps show `interrupt("alice")` resolves before `interrupt("bob")` starts (no overlap)
- **AND** both calls happen before the grace wait

#### Scenario: Second signal short-circuits to exit 130

- **WHEN** `runStart` is mid-shutdown (the grace wait of `2_000` ms is in flight)
- **AND** the test fires a SECOND SIGINT
- **THEN** the grace wait resolves immediately (the `secondSignal.aborted` arm of `Promise.race` wins)
- **AND** `serverHandle.abort()` is NOT called (the second signal's escape hatch skips the orderly path)
- **AND** `runStart` returns exit code 130

#### Scenario: SIGTERM fires the same sequence as SIGINT

- **WHEN** `runStart` is running and the test fires SIGTERM (instead of SIGINT)
- **THEN** the documented graceful-shutdown sequence runs identically
- **AND** `runStart` returns exit code 0

#### Scenario: `shutdown_grace_ms` is hard-capped at `10_000`

- **WHEN** the merged config declares `server.shutdown_grace_ms: 100_000`
- **AND** the test fires SIGINT
- **THEN** the grace wait is at most `10_000` ms
- **AND** a warn-level log line names the configured value, the cap, and the clamped value

#### Scenario: A scheduler.interrupt rejection does not block the next agent's interrupt

- **WHEN** `runStart` is running with `alice` (`running`) and `bob` (`running`)
- **AND** `scheduler.interrupt("alice")` rejects with `Error("subprocess unresponsive")`
- **AND** SIGINT is fired
- **THEN** the rejection is caught and logged at warn level (naming `alice` and the error)
- **AND** `scheduler.interrupt("bob")` is still called
- **AND** the sequence proceeds to the grace wait and `serverHandle.abort()`
- **AND** the exit code is still 0 (the rejection is non-fatal — the operator can retry shutdown if needed)

#### Scenario: Signal listeners are removed on resolve

- **WHEN** `runStart` resolves (any exit code)
- **THEN** the SIGINT and SIGTERM listeners installed by `runStart` are no longer registered
- **AND** subsequent test code can install its own SIGINT listener without conflict

### Requirement: `runStart` returns exit codes per the documented table

`runStart` SHALL return one of exactly four exit codes:

| Exit | Meaning |
| ---- | ------- |
| `0` | Server started, ran, and shut down cleanly on first SIGINT/SIGTERM. |
| `1` | Filesystem / git / project-state failure (missing `.keni/project.yaml`, malformed YAML, missing SPA bundle in production mode, port-range exhausted, OS bind error other than `EADDRINUSE`). |
| `2` | Usage error (unknown subcommand flag, malformed `--port` / `--port-range` / `--spa-dev-url` value). |
| `130` | Second SIGINT/SIGTERM during graceful shutdown (forced shutdown). |

The dispatcher (`packages/cli/src/main.ts`) SHALL surface these codes verbatim from `runStart`. No other exit code SHALL be returned by `runStart` (an unexpected internal error SHALL be caught by the dispatcher's existing `try/catch` and surfaced as exit 1 with the error class name in stderr — same behaviour the existing `runInit` arm has).

#### Scenario: Clean shutdown on first signal returns 0

- **WHEN** `runStart` boots successfully and the test fires one SIGINT
- **THEN** the resolved exit code is 0

#### Scenario: Missing `project.yaml` returns 1

- **WHEN** `runStart` is invoked against a directory without `.keni/project.yaml`
- **THEN** the resolved exit code is 1

#### Scenario: Malformed `--port-range` returns 2

- **WHEN** the user runs `keni start --port-range 7777`  (missing the `-end`)
- **THEN** the resolved exit code is 2
- **AND** stderr names the malformed flag and the expected `<start>-<end>` shape

#### Scenario: Forced shutdown via second signal returns 130

- **WHEN** `runStart` is mid-shutdown and the test fires a second SIGINT
- **THEN** the resolved exit code is 130

### Requirement: An automated end-to-end smoke test boots `keni start`, exercises `/health`, and asserts the documented shutdown sequence

The repository SHALL contain `packages/cli/src/start/start_e2e_test.ts` that boots `runStart` against a fixture project (a temporary directory pre-populated by an in-test `runInit` plus a stub SPA bundle directory containing `index.html` with the documented mount node). The test SHALL: (1) inject a `makeEngineerRunner` stub returning a runner whose `precheck` is `{ kind: "skip", reason: "no_ticket_to_pick_up" }` (so no real coding-agent subprocess runs); (2) wait for the printed startup line via the captured `out` writer; (3) HTTP-`GET /health` against the printed URL and assert `200` + the documented `{ data: { status: "ok", project_id, uptime_ms, version }, project_id }` shape; (4) HTTP-`GET /` and assert the response body contains the SPA bundle's mount-node selector; (5) fire the injected `AbortSignal` (via `RunStartDeps.shutdownSignal`); (6) assert instrumented `scheduler.stop` and `serverHandle.abort` were called in the documented order; (7) assert `runStart` resolves to exit code 0.

The test SHALL NOT require network access beyond `127.0.0.1`. The test SHALL clean up the temporary directory on resolve (success or failure).

#### Scenario: `start_e2e_test` runs as part of `deno task test`

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** `packages/cli/src/start/start_e2e_test.ts` executes at least once
- **AND** the test passes
- **AND** the test does not require network access beyond `127.0.0.1`

#### Scenario: The smoke test asserts `/health` is reachable without `X-Keni-Role`

- **WHEN** the smoke test issues `GET /health` with no role header against the booted server
- **THEN** the response status is 200
- **AND** the body parses as `{ data: { status: "ok", project_id, uptime_ms, version }, project_id }`

#### Scenario: The smoke test asserts the SPA bundle is served at `/`

- **WHEN** the smoke test issues `GET /` against the booted server
- **THEN** the response status is 200
- **AND** the body's `Content-Type` is `text/html`
- **AND** the body contains the SPA's documented mount-node selector (e.g., `id="root"`)

#### Scenario: The smoke test asserts the documented shutdown sequence

- **WHEN** the smoke test fires the injected `AbortSignal`
- **AND** the instrumented deps record each `scheduler.stop` / `scheduler.interrupt` / `serverHandle.abort` call's order and timestamp
- **THEN** the captured order is `scheduler.stop` → `scheduler.interrupt` (zero or more, depending on the fixture's running agents) → `serverHandle.abort`
- **AND** `runStart` resolves to exit code 0

