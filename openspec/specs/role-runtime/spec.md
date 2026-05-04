# role-runtime Specification

## Purpose
TBD - created by archiving change role-runtime-common. Update Purpose after archive.
## Requirements
### Requirement: `@keni/role-runtimes` exposes a `startCycle(params)` function that runs one role cycle end-to-end

The `@keni/role-runtimes` package SHALL export, from `packages/role-runtimes/src/main.ts`, a function `startCycle(params: RoleCycleParams): Promise<RoleCycleResult>` that runs exactly one role cycle (per `spec.md` §11#7 "one ticket per session" and §11#2 "fresh session per run") and returns a discriminated `RoleCycleResult` covering every outcome. The function SHALL be pure with respect to its inputs (it MUST NOT mutate `params`), MUST NOT read or write any file under `.keni/` or `~/.keni/`, MUST NOT read process environment variables (the cycle's only seam to the environment is the role-supplied env-var allowlist threaded through the subprocess utility), MUST NOT loop (each invocation runs one cycle and returns), and MUST NOT retry on failure (callers — typically step 08's scheduler — own retry policy). The function SHALL accept an optional `AbortSignal` via `params.signal` that, when fired, terminates the active subprocess (if any) via the documented graceful-termination procedure. The `@keni/role-runtimes` package's main barrel SHALL also re-export the public types (`RoleCycleParams`, `RoleCycleResult`, `CodingAgentInvocation`, `CodingAgentLifecycle`, `CodingAgentOutcome`, `CodingAgentInvoker`, `BundledPrompt`), the default invoker factory (`createSubprocessCodingAgentInvoker`), the prompt-resolver helper (`resolveBundledPrompt`), and the typed error class (`RoleRuntimeHttpError`) so downstream consumers (steps 08, 09, 13, 17, 19) can `import { … } from "@keni/role-runtimes"` without reaching into internal subdirectories.

#### Scenario: `startCycle` runs the full happy-path cycle end-to-end

- **WHEN** `startCycle` is invoked with a valid `RoleCycleParams` whose `precheck` returns `{ kind: "proceed", roleContext: { summary: "ticket-0001" } }`, whose `promptResolver` returns a non-empty `BundledPrompt`, and whose `codingAgentInvoker` is a fake that emits five stdout lines (the last being `"summary line"`) and exits with code 0
- **THEN** the function resolves with `{ outcome: "completed", sessionId: <uuidv7>, exitCode: 0, summary: "summary line" }`
- **AND** the activity log on disk gained exactly seven entries for this `session_id` in arrival order: `session_start`, five `subprocess_stdout`, `session_end`
- **AND** every entry's `agent` equals `params.agentId` and `role` equals `params.role`

#### Scenario: `startCycle` does not mutate the params bag

- **WHEN** `startCycle` is invoked with a `RoleCycleParams` value
- **AND** the same value is passed to a second `startCycle` invocation immediately after the first resolves
- **THEN** every field on the value is identical between the two invocations (the cycle did not assign back into the bag)

#### Scenario: `startCycle` returns one of the five documented outcomes — no others

- **WHEN** any `startCycle` invocation completes
- **THEN** the resolved `RoleCycleResult.outcome` is one of `"completed"`, `"idle"`, `"precheck_skipped"`, `"terminated"`, or `"spawn_failed"`
- **AND** an exhaustive `switch` over the five outcomes type-checks under `verbatimModuleSyntax`

#### Scenario: Public surface is reachable through `@keni/role-runtimes`'s main barrel

- **WHEN** a downstream module imports `startCycle`, `RoleCycleParams`, `RoleCycleResult`, `CodingAgentInvoker`, `createSubprocessCodingAgentInvoker`, `BundledPrompt`, `resolveBundledPrompt`, and `RoleRuntimeHttpError` from `@keni/role-runtimes`
- **THEN** every import resolves without error
- **AND** no internal path (`@keni/role-runtimes/common/...`) needs to be referenced

### Requirement: The cycle algorithm follows `spec.md` §6.2 step-for-step, with precheck as the first step and idle-detection short-circuiting `session_end`

The `startCycle` function SHALL execute these seven steps in this order, and SHALL NOT execute any later step when an earlier step resolves to a short-circuit outcome:

1. **Precheck.** Call `params.precheck(prepCtx)` where `prepCtx` is `{ role, agentId, projectName, workspacePath, serverUrl }`. If the result is `{ kind: "skip", reason }`, return `{ outcome: "precheck_skipped", reason }` immediately. No `POST /activity` call SHALL be made on this path. The cycle SHALL NOT generate a `session_id` on this path.
2. **Generate the session id and log session start.** Generate a uuidv7 `session_id` (via `@std/uuid/v7`). Call `activityClient.appendSessionStart({ sessionId, summary, refs })` where `summary` is `precheck.roleContext.summary ?? null` and `refs` includes `resume_session_id` when `params.resumeSessionId` is present.
3. **Resolve the role's bundled prompt.** Call `resolveBundledPrompt(params.promptResolver(prepCtx), params.expectedPromptName)`. The helper SHALL throw if the body is empty or (when `expectedPromptName` is supplied) if the name does not match. A throw at this step SHALL be caught by the cycle, which SHALL emit a final `session_end` with `refs.spawn_failed: true` and `exitCode: -1`, and SHALL return `{ outcome: "spawn_failed", sessionId, error }`.
4. **Build the invocation.** Construct `CodingAgentInvocation = { promptBody, role, agentId, projectName, workspacePath: params.workspacePath ?? null, mcpServerConfig: params.mcpServerConfig, resumeSessionId: params.resumeSessionId ?? null, envAllowlist: params.envAllowlist ?? [] }`.
5. **Spawn and stream.** Call `params.codingAgentInvoker.invoke(invocation, lifecycle)` where `lifecycle` is a `CodingAgentLifecycle` whose `onStdoutLine` and `onStderrLine` callbacks (a) push the line into an in-memory buffer used for summary extraction and (b) call `activityClient.appendSubprocessOutput(...)`. The lifecycle's `abortSignal` is `params.signal`. The invoker's resolved `CodingAgentOutcome` SHALL be `{ kind: "completed", exitCode } | { kind: "terminated", exitCode, terminatedBy }`. A throw from `invoke` SHALL be caught and surfaced as `{ outcome: "spawn_failed", sessionId, error }` with a final `session_end` entry as in step 3.
6. **Idle detection.** When the invoker resolves with `{ kind: "completed", exitCode: 0 }` AND the cycle's recorded subprocess wall time is less than `params.idleThresholdMs ?? 250` AND the stdout buffer contains zero non-empty lines, the cycle SHALL emit `activityClient.appendIdle({ sessionId })` and return `{ outcome: "idle", sessionId }`. The `session_end` event SHALL NOT be emitted on the idle path. (`subprocess_stdout` is necessarily zero on this path; an `idle` cycle has no streamed output.)
7. **Capture summary and emit session end.** When the cycle did not short-circuit to idle, extract the summary via `extractSummaryLine(stdoutBuffer)` (last non-empty trimmed line, or `null`). Call `activityClient.appendSessionEnd({ sessionId, exitCode, summary, terminatedBy })` where `terminatedBy` is `outcome.terminatedBy` for `kind: "terminated"` and unset otherwise. Return `{ outcome: "completed" | "terminated", sessionId, exitCode, summary | terminatedBy }` per the outcome.

The cycle SHALL NOT introduce any other steps. The cycle SHALL NOT call any `.keni/` storage interface directly. The cycle SHALL NOT read `Deno.env`. The cycle SHALL NOT subscribe to the orchestration server's `/events` WebSocket.

#### Scenario: Precheck returns `skip` and the cycle short-circuits without any side effects

- **WHEN** `startCycle` is invoked with `params.precheck` returning `{ kind: "skip", reason: "no_ticket_to_pick_up" }`
- **THEN** the function resolves with `{ outcome: "precheck_skipped", reason: "no_ticket_to_pick_up" }`
- **AND** no `POST /activity` request was issued
- **AND** no subprocess was spawned
- **AND** the agents-API runtime-state for `params.agentId` is unchanged (still `idle`)

#### Scenario: Idle cycle emits `session_start` and `idle` only — no `session_end`, no `subprocess_stdout`

- **WHEN** `startCycle` runs against a fake invoker that emits zero stdout lines, exits 0 within 50 ms (well under the 250 ms idle threshold), and the cycle's `idleThresholdMs` is the default
- **THEN** the function resolves with `{ outcome: "idle", sessionId: <uuidv7> }`
- **AND** the activity log gained exactly two entries for this `session_id`: a `session_start` and an `idle`
- **AND** no entry with `event: "session_end"` was written for this `session_id`

#### Scenario: Completed cycle emits `session_start` + N `subprocess_stdout` + `session_end` in arrival order

- **WHEN** `startCycle` runs against a fake invoker that emits three stdout lines (`"line 1"`, `"line 2"`, `"summary line"`) over 500 ms and exits 0
- **THEN** the function resolves with `{ outcome: "completed", sessionId, exitCode: 0, summary: "summary line" }`
- **AND** the activity log's entries for this `session_id`, in arrival order, are: `session_start`, `subprocess_stdout` (`summary: "line 1"`), `subprocess_stdout` (`summary: "line 2"`), `subprocess_stdout` (`summary: "summary line"`), `session_end` (`summary: "summary line"`)

#### Scenario: Terminated cycle emits `session_end` with `terminated_by: "sigterm"`

- **WHEN** `startCycle` is invoked with a `params.signal` that fires 100 ms after the cycle starts
- **AND** the fake invoker resolves with `{ kind: "terminated", exitCode: 143, terminatedBy: "sigterm" }`
- **THEN** the function resolves with `{ outcome: "terminated", sessionId, terminatedBy: "sigterm", exitCode: 143 }`
- **AND** the activity log's `session_end` entry for this `session_id` carries `refs.terminated_by: "sigterm"` and `refs.exit_code: 143`

#### Scenario: Spawn failure produces a final `session_end` and `outcome: "spawn_failed"`

- **WHEN** `startCycle` runs against a fake invoker whose `invoke` throws synchronously with `new Error("binary not found: claude")`
- **THEN** the function resolves with `{ outcome: "spawn_failed", sessionId, error: <Error("binary not found: claude")> }`
- **AND** the activity log gained a `session_start` and a `session_end` for this `session_id`
- **AND** the `session_end` entry carries `refs.spawn_failed: true` and `refs.exit_code: -1`

### Requirement: The role's `promptResolver` returns a TS-constant `BundledPrompt`; the helper validates name and non-empty body

The role's `promptResolver` SHALL return a `BundledPrompt = { name: string, body: string }` whose `body` is a TypeScript string constant compiled into the binary. The `resolveBundledPrompt(prompt, expectedName?)` helper SHALL: (a) throw `RoleRuntimeError("empty_prompt_body", ...)` when `prompt.body.length === 0`; (b) when `expectedName` is supplied and `prompt.name !== expectedName`, throw `RoleRuntimeError("prompt_name_mismatch", ...)` whose message names both the expected and the received name; (c) on success, return the validated `BundledPrompt` verbatim. The package's source code under `packages/role-runtimes/src/common/` SHALL NOT contain any path-based prompt-loading function (no `loadPromptFromPath`, no `import.meta.resolve` resolving a `.keni/`-prefixed path) — every prompt is reachable only as a TS constant. A structural test SHALL assert this by walking source files and rejecting any path literal beginning with `.keni/` / `~/.keni/`. Filesystem read primitives (`Deno.readTextFile`, `Deno.readFile`) and write primitives (`Deno.writeTextFile`, `Deno.writeFile`) SHALL be forbidden in every file under `common/` EXCEPT the explicitly-sanctioned strategy-executor file `codingAgentInvoker.ts`, which materialises the keni MCP-server config per the entry's `mcpConfigStrategy` (per the requirement "The default invoker materialises the MCP-config per the entry's `mcpConfigStrategy` discriminated union"). Even in the sanctioned file, no `.keni/`-prefixed path literal is permitted; workspace paths are computed via `joinPath(invocation.workspacePath, relativePath)` from the strategy.

#### Scenario: Empty prompt body is rejected

- **WHEN** `resolveBundledPrompt({ name: "engineer", body: "" })` is invoked
- **THEN** the helper throws `RoleRuntimeError`
- **AND** the error's `code` is `"empty_prompt_body"`
- **AND** the error's `message` names the prompt's `name` field

#### Scenario: Name mismatch is rejected when `expectedName` is supplied

- **WHEN** `resolveBundledPrompt({ name: "po-chat", body: "..." }, "engineer")` is invoked
- **THEN** the helper throws `RoleRuntimeError`
- **AND** the error's `code` is `"prompt_name_mismatch"`
- **AND** the error's `message` names both `"engineer"` (expected) and `"po-chat"` (received)

#### Scenario: Validated prompt is returned verbatim

- **WHEN** `resolveBundledPrompt({ name: "engineer", body: "ENGINEER PROMPT BODY" }, "engineer")` is invoked
- **THEN** the helper returns the same object with `name: "engineer"` and `body: "ENGINEER PROMPT BODY"`

#### Scenario: Source code under `packages/role-runtimes/src/common/` contains no path-based prompt loader

- **WHEN** the source files under `packages/role-runtimes/src/common/` (excluding `*_test.ts` and `tests/fixtures/`) are scanned
- **THEN** no occurrence of `import.meta.resolve("./prompts/` followed by a `.txt` / `.md` extension is found in any production file
- **AND** no path literal beginning with `.keni/` or `~/.keni/` appears in any production file
- **AND** every prompt body in the package is a TS string constant exported from a file under `packages/role-runtimes/src/common/prompts/` (or, post-step-09, under `packages/role-runtimes/src/engineer/`, `qa/`, `po/`)
- **AND** `Deno.readTextFile` / `Deno.readFile` appears only in the explicitly-sanctioned strategy-executor file `codingAgentInvoker.ts`

### Requirement: The cycle reaches the activity log only through `POST /activity`; no direct `.keni/` read or write

The cycle SHALL emit every activity entry by issuing `POST /activity` against `params.serverUrl`, carrying `Content-Type: application/json`, `X-Keni-Role: <params.role>`, and `X-Keni-Agent: <params.agentId>` on every request. The cycle SHALL NOT call any storage interface from `@keni/shared` directly, SHALL NOT read or write any path under `.keni/` or `~/.keni/`, and SHALL NOT bypass the orchestration server's role-identity middleware (the headers are stamped by the activity-log adapter, not by tool input). On a 2xx response, the adapter SHALL discard the response body (the cycle does not need the persisted entry's id). On a non-2xx response, the adapter SHALL parse the documented `{ error: { code, message, details? } }` envelope and throw `new RoleRuntimeHttpError(code, message, details, status)`. On a network-level failure (`fetch` rejects), the adapter SHALL throw `new RoleRuntimeHttpError("internal_error", `Network error talking to ${url}: ${cause.message}`, ..., 0)`. A throw from any activity-log call inside the cycle SHALL abort the cycle and surface as `{ outcome: "spawn_failed", sessionId, error }` with no further `POST` attempts (the server is unreachable; further calls would also fail).

#### Scenario: Every `POST /activity` carries the role and agent headers

- **WHEN** the cycle issues any `POST /activity` request
- **AND** the orchestration server captures inbound request headers
- **THEN** every captured request carries `X-Keni-Role` equal to `params.role`
- **AND** every captured request carries `X-Keni-Agent` equal to `params.agentId`

#### Scenario: Source code under `packages/role-runtimes/src/common/` contains no `.keni/` reads or writes

- **WHEN** the source files under `packages/role-runtimes/src/common/` (excluding `*_test.ts` and integration-test fixtures) are scanned for any path literal beginning with `.keni/` or `~/.keni/`
- **THEN** no occurrence is found
- **AND** in every file other than the sanctioned strategy-executor file `codingAgentInvoker.ts`, no occurrence of `Deno.readTextFile` or `Deno.readFile` is found
- **AND** in every file other than `codingAgentInvoker.ts`, the only filesystem-write primitive that may appear is `Deno.writeTextFile` against a `Deno.makeTempFile`-derived path
- **AND** `codingAgentInvoker.ts` itself MAY use `Deno.readTextFile`, `Deno.writeTextFile`, and `Deno.mkdir` to materialise the entry's `mcpConfigStrategy` against `joinPath(invocation.workspacePath, <relativePath>)` — never against a `.keni/`-prefixed literal

#### Scenario: A non-2xx response surfaces as `RoleRuntimeHttpError`

- **WHEN** the activity-log adapter issues a `POST /activity` and the server responds with `400 missing_role`
- **THEN** the adapter throws `new RoleRuntimeHttpError("missing_role", <message>, <details>, 400)`
- **AND** the cycle catches the throw and returns `{ outcome: "spawn_failed", sessionId, error }`

#### Scenario: A network-level failure surfaces as `internal_error` naming the URL

- **WHEN** the activity-log adapter issues a `POST /activity` and `fetch` rejects with `ECONNREFUSED`
- **THEN** the adapter throws `new RoleRuntimeHttpError("internal_error", <message naming the URL>, ..., 0)`
- **AND** the cycle catches the throw and returns `{ outcome: "spawn_failed", sessionId, error }`

### Requirement: Subprocess stdout / stderr is streamed to the activity log per line, with hard size and count caps

The cycle SHALL emit one `subprocess_stdout` activity entry per non-empty line of the subprocess's stdout, in arrival order. The cycle SHALL emit one `subprocess_stderr` activity entry per non-empty line of the subprocess's stderr, in arrival order. Lines SHALL be split on `"\n"` (Unix line ending); a trailing partial line at stream close SHALL be emitted as a final line. Empty lines (zero-length after right-trim of whitespace) SHALL be skipped. Each emitted line's `summary` field SHALL be truncated client-side to a documented ceiling of 3 KB; truncation SHALL append the marker `... [truncated <N> bytes]` so a parser can detect it (the orchestration server's storage layer enforces a 4 KB cap on the full entry; the 3 KB ceiling on `summary` is a safety margin). The cycle SHALL emit at most `params.maxLinesPerStream ?? 1000` lines per stream per cycle; on overflow, the cycle SHALL stop emitting further lines for that stream and SHALL emit one `subprocess_output_truncated` entry naming the truncated count and the stream kind, then SHALL continue capturing lines for summary-extraction purposes. The summary-extraction buffer SHALL NOT be subject to the per-line emission cap (a 1500-line cycle that emits the first 1000 still extracts its summary from the genuine last non-empty line).

#### Scenario: Two stdout lines produce two `subprocess_stdout` entries in arrival order

- **WHEN** the cycle's invoker emits `"line 1"\n"line 2"\n` on stdout over time
- **THEN** the activity log gained exactly two `subprocess_stdout` entries for this `session_id`
- **AND** the entries' `summary` fields are `"line 1"` and `"line 2"` respectively, in that order

#### Scenario: An empty line is skipped

- **WHEN** the cycle's invoker emits `"line 1"\n"\n"line 2"\n`
- **THEN** the activity log gained exactly two `subprocess_stdout` entries (the empty middle line is dropped)

#### Scenario: A 5 KB single line is truncated to ~3 KB plus a truncation marker

- **WHEN** the cycle's invoker emits a single stdout line whose length is 5120 characters
- **THEN** the corresponding `subprocess_stdout` entry's `summary` is at most 3 KB plus the documented truncation marker
- **AND** the entry was accepted by the orchestration server (HTTP 201)
- **AND** the truncation marker contains the substring `[truncated`

#### Scenario: A 1500-line stdout cycle truncates emission to 1000 plus a `subprocess_output_truncated` entry

- **WHEN** the cycle's invoker emits 1500 stdout lines
- **AND** `params.maxLinesPerStream` is the default 1000
- **THEN** the activity log gained exactly 1000 `subprocess_stdout` entries (the first 1000 in arrival order) followed by exactly one `subprocess_output_truncated` entry naming the truncated count (500) and `stream_kind: "stdout"`
- **AND** the cycle's `session_end.summary` equals the actual 1500th line (the genuine last line), not the 1000th

#### Scenario: stderr lines emit `subprocess_stderr` entries — independent of stdout

- **WHEN** the cycle's invoker emits two stdout lines and three stderr lines interleaved
- **THEN** the activity log gained exactly two `subprocess_stdout` entries and three `subprocess_stderr` entries
- **AND** the relative order of entries within each stream matches arrival order

### Requirement: The summary line is the last non-empty trimmed stdout line; absence yields `null`

The cycle SHALL extract the session's one-line summary from the captured stdout buffer at session-end time using the rule: the last entry of the buffer whose right-trimmed value is non-empty (`String.prototype.trimEnd`). When the buffer is empty or every entry trims to empty, the summary SHALL be `null`. Stderr lines SHALL NEVER contribute to the summary. The cycle SHALL NOT require the agent's prompt to use any structured output convention (no JSON envelope, no `SUMMARY:` prefix); the summary is whatever the last non-empty stdout line happens to be.

#### Scenario: Last non-empty line wins

- **WHEN** the stdout buffer contains `["line 1", "line 2", "summary"]`
- **THEN** `extractSummaryLine` returns `"summary"`

#### Scenario: Trailing whitespace lines are skipped

- **WHEN** the stdout buffer contains `["work in progress", "summary line", "  ", ""]`
- **THEN** `extractSummaryLine` returns `"summary line"` (the trailing blank lines are skipped)

#### Scenario: All-empty buffer returns `null`

- **WHEN** the stdout buffer contains `["", "  ", "\t"]`
- **THEN** `extractSummaryLine` returns `null`
- **AND** the corresponding `session_end` entry's `summary` field is `null`

#### Scenario: Stderr lines do not contribute to summary

- **WHEN** the cycle's invoker emits no stdout lines and three stderr lines
- **AND** the cycle's wall time exceeds the idle threshold so the cycle does not short-circuit to `idle`
- **THEN** the `session_end` entry's `summary` is `null`

### Requirement: The subprocess utility provides graceful termination — SIGTERM, then SIGKILL after a configurable grace period

The package SHALL expose a `terminate(child, opts)` utility that: (a) sends SIGTERM to the child process; (b) waits up to `opts.graceMs ?? 5000` for the child's `status` promise to resolve; (c) on grace-period expiry, sends SIGKILL and waits up to a documented kill-timeout (1000 ms) for the child to exit; (d) returns `{ exitCode, terminatedBy: "exit" | "sigterm" | "sigkill" }`. On Windows, the utility SHALL skip the SIGTERM phase and go directly to a hard kill (`Deno.Command.kill()` is not signal-aware on Windows); a one-line warning SHALL be emitted to stderr the first time the utility runs on Windows. The utility SHALL NOT throw under normal operation; it SHALL throw `Error("subprocess refused to die after SIGKILL")` only when the child does not exit within the kill-timeout (a kernel pathology). The cycle SHALL plumb `params.terminationGraceMs` to the invoker's `terminate` calls; the default 5 000 ms covers the common case (a `claude` agent flushing its final stdout line).

#### Scenario: SIGTERM exit before grace expires returns `terminatedBy: "sigterm"`

- **WHEN** `terminate(child, { graceMs: 5000 })` is invoked against a child that exits cleanly on SIGTERM within 1 second
- **THEN** the function resolves with `{ exitCode: <child's actual exit code>, terminatedBy: "sigterm" }`
- **AND** SIGKILL was not sent

#### Scenario: SIGTERM ignored, SIGKILL after grace, returns `terminatedBy: "sigkill"`

- **WHEN** `terminate(child, { graceMs: 200 })` is invoked against a child that ignores SIGTERM (e.g., a `sleep infinity`-equivalent shell)
- **AND** the child exits within the 1000 ms post-SIGKILL window
- **THEN** the function resolves with `{ exitCode: <typically 137 / -9>, terminatedBy: "sigkill" }`

#### Scenario: Already-exited child returns `terminatedBy: "exit"`

- **WHEN** `terminate(child, { graceMs: 5000 })` is invoked against a child that has already exited (its `status` is resolved before the call)
- **THEN** the function resolves with `{ exitCode: <exit code>, terminatedBy: "exit" }`
- **AND** no signal was sent

#### Scenario: Windows path emits the documented warning and goes direct to kill

- **WHEN** `terminate` is invoked on Windows for the first time in the process
- **THEN** stderr gains one warning line naming Windows-platform graceful-termination limitations
- **AND** the function resolves with `terminatedBy: "sigkill"` (the Windows hard-kill path)

### Requirement: The subprocess utility's environment-variable forwarding is allowlist-only

The default subprocess invoker SHALL build the child process's `env` from: (a) the runtime-mandated variables (`KENI_MCP_AGENT`, `KENI_MCP_SERVER_URL`, `KENI_MCP_WORKSPACE` when `workspacePath` is set), and (b) every name in `params.envAllowlist` (or `RoleCycleParams.envAllowlist`) whose value is set in the host process's environment (read via `Deno.env.get(name)`). The utility SHALL NEVER call `Deno.env.toObject()`, SHALL NEVER pass the host environment wholesale, and SHALL NEVER pass an unset allowlisted variable as `""`. Names not in the allowlist SHALL be absent from the child's env.

#### Scenario: Empty allowlist gives the child only the runtime-mandated variables

- **WHEN** the cycle is invoked with `envAllowlist: []` and `workspacePath: "/tmp/ws"`
- **AND** the host has `OPENAI_API_KEY=secret`, `PATH=/usr/bin`, `HOME=/home/alice`
- **THEN** the spawned child's environment contains exactly `KENI_MCP_AGENT`, `KENI_MCP_SERVER_URL`, `KENI_MCP_WORKSPACE`
- **AND** `OPENAI_API_KEY`, `PATH`, `HOME` are absent from the child's environment

#### Scenario: Allowlisted variable is forwarded when set on the host

- **WHEN** the cycle is invoked with `envAllowlist: ["PATH"]` and `Deno.env.get("PATH")` returns `/usr/bin`
- **THEN** the spawned child's environment contains `PATH=/usr/bin` plus the runtime-mandated variables

#### Scenario: Allowlisted-but-unset variable is omitted

- **WHEN** the cycle is invoked with `envAllowlist: ["NEVER_SET_VAR"]` and `Deno.env.get("NEVER_SET_VAR")` returns `undefined`
- **THEN** the spawned child's environment does not contain `NEVER_SET_VAR` (not even as an empty string)

### Requirement: `CodingAgentInvoker` decouples spawn-mechanics from the cycle; the default factory drives `Deno.Command` with documented opts

The package SHALL export a `CodingAgentInvoker` interface whose only method is `invoke(invocation: CodingAgentInvocation, lifecycle: CodingAgentLifecycle): Promise<CodingAgentOutcome>`. The cycle SHALL call exactly this method exactly once per cycle (after `session_start` is logged). The package SHALL also export a default factory `createSubprocessCodingAgentInvoker(opts)` whose options bag is `{ cliBinary: string, buildArgs: (invocation, mcpConfigPath) => readonly string[], promptInjection: "stdin" | "arg", mcpConfigStrategy: McpConfigStrategy, graceMs?: number, envAllowlist?: readonly string[], resumeFlag?: string, killTimeoutMs?: number }`.

The factory SHALL produce an invoker that: (a) invokes the strategy executor for `opts.mcpConfigStrategy` to obtain `{ path: string; cleanup: () => Promise<void> }` and registers the cleanup in a `try`/`finally`; (b) constructs `Deno.Command(cliBinary, { args: buildArgs(invocation, path), env, stdin, stdout: "piped", stderr: "piped", cwd: invocation.workspacePath ?? undefined })`; (c) writes the prompt to stdin (when `promptInjection === "stdin"`) and closes stdin once written, or relies on the args constructed by `buildArgs` (when `promptInjection === "arg"`); (d) reads stdout / stderr line-by-line and calls `lifecycle.onStdoutLine` / `onStderrLine`; (e) honours `lifecycle.abortSignal` by calling the subprocess utility's `terminate` with the configured `graceMs`; (f) resolves with `{ kind: "completed", exitCode } | { kind: "terminated", exitCode, terminatedBy }`. The invoker SHALL throw on synchronous spawn failures (e.g., binary not found, strategy executor errors); the cycle catches and surfaces as `spawn_failed`.

The options bag's `mcpConfigStrategy` field SHALL be required (no default). A test seam `setTempfileJsonOverrideForTesting(builder | null)` MAY be exported by the strategy executor (not by the factory's opts bag) so `tempfile-json`-strategy unit tests can route the temp path to a controlled location without polluting production opts.

#### Scenario: Default factory produces an invoker that runs an actual subprocess and emits stdout lines

- **WHEN** `createSubprocessCodingAgentInvoker({ cliBinary: <path to a Deno-script fixture>, buildArgs: () => [], promptInjection: "stdin", mcpConfigStrategy: { kind: "tempfile-json" } })` is invoked
- **AND** the cycle runs against a Deno-script fixture that prints `"line 1"\n"line 2"\n` and exits 0
- **THEN** the cycle's lifecycle bag observed exactly two `onStdoutLine` calls (`"line 1"` then `"line 2"`)
- **AND** the cycle resolved with `{ kind: "completed", exitCode: 0 }`

#### Scenario: Invoker throws on missing binary; cycle surfaces as `spawn_failed`

- **WHEN** the default factory is invoked with `cliBinary: "/no/such/binary"` and `mcpConfigStrategy: { kind: "tempfile-json" }`
- **AND** the cycle calls the invoker
- **THEN** the invoker throws `Error` whose message names the missing binary
- **AND** the cycle catches the throw and returns `{ outcome: "spawn_failed", sessionId, error }`

#### Scenario: AbortSignal during spawn triggers graceful termination

- **WHEN** the cycle is invoked with `params.signal` from an `AbortController` and the fixture sleeps for 30 s
- **AND** the test fires `controller.abort()` 100 ms into the cycle
- **THEN** the invoker calls the subprocess utility's `terminate` with the configured grace ms
- **AND** the cycle resolves with `{ outcome: "terminated", sessionId, terminatedBy: "sigterm", exitCode: <signal exit code> }`

#### Scenario: MCP-config temp file is cleaned up on cycle exit (tempfile-json strategy only)

- **WHEN** the default factory writes an `mcpServers` JSON to a temp file at cycle start (`mcpConfigStrategy.kind === "tempfile-json"`)
- **AND** the cycle resolves (success, idle, terminated, or spawn_failed)
- **THEN** the temp file does not exist on disk after the cycle resolves
- **AND** no orphan temp files remain in the configured temp dir for this cycle

#### Scenario: Workspace-strategy file persists after cycle exit (no cleanup)

- **WHEN** the default factory runs the `workspace-json` strategy against `<workspacePath>/.cursor/mcp.json`
- **AND** the cycle resolves (success, idle, terminated, or spawn_failed)
- **THEN** the file at `<workspacePath>/.cursor/mcp.json` continues to exist on disk after the cycle resolves
- **AND** the file's contents include the keni entry under `mcpServers.keni`

### Requirement: The default subprocess invoker spawns the CLI with `cwd` set to the per-agent workspace

The default subprocess invoker SHALL pass `cwd: invocation.workspacePath` to `new Deno.Command(...)` when `invocation.workspacePath !== null`. When `invocation.workspacePath === null`, the invoker SHALL omit the `cwd` option (the spawned child inherits the parent process's cwd — today's behaviour).

This requirement matches the existing semantics of the `KENI_MCP_WORKSPACE` env-var mandate (only set when `workspacePath !== null`) and gives file-discovery-based CLIs (e.g. `cursor-agent`'s `<cwd>/.cursor/mcp.json` discovery, `codex`'s `<cwd>/.codex/config.toml` discovery) a stable, per-agent root.

#### Scenario: Production engineer cycle spawns with `cwd` set to the workspace

- **WHEN** the cycle is invoked with `workspacePath: "/Users/alice/.keni/workspaces/p1/alice"` and a fake binary that prints `Deno.cwd()` to stdout and exits
- **THEN** the captured stdout line is `"/Users/alice/.keni/workspaces/p1/alice"`

#### Scenario: Test path with `workspacePath: null` falls through to the parent's cwd

- **WHEN** the cycle is invoked with `workspacePath: null` (the test-only path)
- **AND** the parent process's `Deno.cwd()` is `"/tmp/parent-cwd"`
- **THEN** the spawned child's `cwd` is `"/tmp/parent-cwd"` (no override)

### Requirement: The default invoker materialises the MCP-config per the entry's `mcpConfigStrategy` discriminated union

The default invoker SHALL accept `opts.mcpConfigStrategy: McpConfigStrategy` and execute the strategy before spawn. The closed set of strategies and their semantics:

- `{ kind: "tempfile-json" }`: Create a temp file via `Deno.makeTempFile({ prefix: "keni-mcp-", suffix: ".json" })`. Write `JSON.stringify({ mcpServers: { keni: invocation.mcpServerConfig } })`. Pass the path to `buildArgs` as `mcpConfigPath`. Register a `try`/`finally` cleanup so the file is removed on cycle exit (success, idle, terminated, or spawn_failed).

- `{ kind: "workspace-json", relativePath, mergeKey, entryName }`: Compute `path = joinPath(invocation.workspacePath, relativePath)`. The invoker SHALL throw `RoleRuntimeError("workspace_required_for_strategy", { kind: "workspace-json" })` when `invocation.workspacePath === null`. Read the existing file (treat `Deno.errors.NotFound` as `{}`), parse via `JSON.parse`. The parsed value SHALL be a plain object (not `null`, not an array, not a primitive); otherwise throw `RoleRuntimeError("mcp_config_corrupt", { path, kind })`. Ensure `parsed[mergeKey]` is a plain object (create it if absent; throw `mcp_config_corrupt` if it exists with a non-object type). Set `parsed[mergeKey][entryName] = invocation.mcpServerConfig`. Ensure the parent directory exists via `Deno.mkdir(dirname(path), { recursive: true })`. Write the file back via `Deno.writeTextFile(path, JSON.stringify(parsed, null, 2))`. Pass `path` to `buildArgs` as `mcpConfigPath` (the per-CLI `buildArgs` may ignore it — `cursor-agent` does). No cleanup is registered.

- `{ kind: "workspace-toml", relativePath, tableHeader, entryName }`: Compute `path = joinPath(invocation.workspacePath, relativePath)`. The invoker SHALL throw `RoleRuntimeError("workspace_required_for_strategy", { kind: "workspace-toml" })` when `invocation.workspacePath === null`. Read the existing file (treat `Deno.errors.NotFound` as `""`), parse via `@std/toml`'s `parse`. The parsed value SHALL be a plain object; otherwise throw `RoleRuntimeError("mcp_config_corrupt", { path, kind })`. Ensure `parsed[tableHeader]` is a plain object. Set `parsed[tableHeader][entryName] = invocation.mcpServerConfig`. Ensure the parent directory exists. Write the file back via `Deno.writeTextFile(path, stringify(parsed))`. Pass `path` to `buildArgs` as `mcpConfigPath`. No cleanup is registered.

The strategy executor SHALL be a pure function over `(invocation, strategy)` returning `Promise<{ path: string; cleanup: () => Promise<void> }>`. The factory SHALL invoke the executor exactly once per cycle, before constructing `Deno.Command`, and SHALL `await cleanup()` in a `try`/`finally` after `child.status` resolves.

#### Scenario: `tempfile-json` writes to `${TMPDIR}` and removes on cycle exit

- **WHEN** the factory is invoked with `mcpConfigStrategy: { kind: "tempfile-json" }`
- **AND** the cycle resolves (success, idle, terminated, or spawn_failed)
- **THEN** the file passed to `buildArgs` does not exist on disk after the cycle resolves
- **AND** no orphan temp files remain in the configured temp dir for this cycle

#### Scenario: `workspace-json` merges into existing file under `mergeKey.entryName`

- **WHEN** `<workspacePath>/.cursor/mcp.json` exists and contains `{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp"] } } }`
- **AND** the factory is invoked with `mcpConfigStrategy: { kind: "workspace-json", relativePath: ".cursor/mcp.json", mergeKey: "mcpServers", entryName: "keni" }` and an `invocation.mcpServerConfig` with `command: "deno"`
- **THEN** after the executor runs, `<workspacePath>/.cursor/mcp.json` contains both keys: `mcpServers.playwright` (verbatim) and `mcpServers.keni` (the new config)
- **AND** the file is well-formed JSON with `JSON.stringify(_, null, 2)` formatting
- **AND** no cleanup runs at cycle exit (the file persists)

#### Scenario: `workspace-json` creates the parent directory and the file when both are absent

- **WHEN** `<workspacePath>/.cursor/` does not exist and the strategy is `workspace-json` with `relativePath: ".cursor/mcp.json"`
- **THEN** the executor creates the directory recursively
- **AND** writes the file with content `{ "mcpServers": { "keni": <config> } }`

#### Scenario: `workspace-toml` merges into existing file under `tableHeader.entryName`

- **WHEN** `<workspacePath>/.codex/config.toml` exists with `[mcp_servers.playwright]\ncommand = "npx"\n`
- **AND** the factory is invoked with `mcpConfigStrategy: { kind: "workspace-toml", relativePath: ".codex/config.toml", tableHeader: "mcp_servers", entryName: "keni" }`
- **THEN** the file after executor execution contains both `[mcp_servers.playwright]` (verbatim) and `[mcp_servers.keni]` (the new config)
- **AND** no cleanup runs at cycle exit

#### Scenario: `workspace-json` rejects null `workspacePath`

- **WHEN** the factory is invoked with `mcpConfigStrategy: { kind: "workspace-json", ... }` and `invocation.workspacePath: null`
- **THEN** the executor throws `RoleRuntimeError("workspace_required_for_strategy", { kind: "workspace-json" })`
- **AND** the cycle catches the throw and returns `{ outcome: "spawn_failed", sessionId, error }`

#### Scenario: `workspace-json` rejects a corrupt existing file

- **WHEN** `<workspacePath>/.cursor/mcp.json` contains `[1, 2, 3]` (a JSON array, not a plain object)
- **AND** the factory runs the `workspace-json` strategy against that path
- **THEN** the executor throws `RoleRuntimeError("mcp_config_corrupt", { path, kind: "workspace-json" })`

### Requirement: `resumeSessionId` is plumbed through `RoleCycleParams` → `CodingAgentInvocation` → invoker; default flag `--resume`

When `params.resumeSessionId` is supplied, the cycle SHALL: (a) include it in `session_start.refs.resume_session_id`; (b) set `CodingAgentInvocation.resumeSessionId` to the supplied string (verbatim, no transformation); (c) the default invoker's `buildArgs` SHALL inject `[<resumeFlag>, <id>]` into the args (default `--resume`) when the invocation's `resumeSessionId` is non-null; (d) when `params.resumeSessionId` is absent, the invocation's field SHALL be `null` and no resume flag SHALL be injected. The cycle SHALL NOT validate the format of `resumeSessionId` beyond requiring a non-empty string when present (the coding-agent CLI fails loudly on a stale or malformed id, which the cycle surfaces via the resulting `exitCode`).

#### Scenario: Resume flag is injected when `resumeSessionId` is present

- **WHEN** the cycle is invoked with `resumeSessionId: "session-abc-123"`
- **AND** the default invoker's `resumeFlag` is the default `--resume`
- **THEN** the spawned subprocess's args contain the consecutive pair `["--resume", "session-abc-123"]`

#### Scenario: Resume id appears in the `session_start` activity entry's refs

- **WHEN** the cycle is invoked with `resumeSessionId: "session-abc-123"`
- **THEN** the `session_start` entry for this cycle's `session_id` carries `refs.resume_session_id: "session-abc-123"`

#### Scenario: No resume id ⇒ no flag and no ref

- **WHEN** the cycle is invoked without `resumeSessionId`
- **THEN** the spawned subprocess's args do not contain `--resume`
- **AND** the `session_start` entry for this cycle's `session_id` has no `refs.resume_session_id` field (or the field is absent / `undefined`)

#### Scenario: Empty-string resume id is rejected at the cycle boundary

- **WHEN** the cycle is invoked with `resumeSessionId: ""`
- **THEN** the cycle returns `{ outcome: "spawn_failed", sessionId, error }`
- **AND** the error's message names the validation rule (`resumeSessionId must be a non-empty string when provided`)

### Requirement: `RoleCycleResult` is a discriminated union with five outcomes; every callsite type-narrows by `outcome`

The package SHALL export `type RoleCycleResult = | { outcome: "completed", sessionId: string, exitCode: number, summary: string | null } | { outcome: "idle", sessionId: string } | { outcome: "precheck_skipped", reason: string } | { outcome: "terminated", sessionId: string, terminatedBy: "sigterm" | "sigkill", exitCode: number } | { outcome: "spawn_failed", sessionId: string, error: Error };`. Every cycle invocation SHALL resolve with exactly one of these five shapes. An exhaustive `switch` over `result.outcome` SHALL type-check under `verbatimModuleSyntax` and `strict: true`. A `precheck_skipped` outcome SHALL NOT include a `sessionId` field (the cycle did not generate one); a `spawn_failed` outcome SHALL include a `sessionId` (the cycle generated one before the spawn attempt and emitted `session_start`).

#### Scenario: Completed shape is exhaustive

- **WHEN** a `completed` result is observed
- **THEN** it has exactly the fields `outcome`, `sessionId`, `exitCode`, `summary` (no extras)

#### Scenario: Idle shape carries `sessionId` but no `exitCode`

- **WHEN** an `idle` result is observed
- **THEN** it has exactly the fields `outcome`, `sessionId` (no `exitCode`, no `summary`)

#### Scenario: `precheck_skipped` carries no session id

- **WHEN** a `precheck_skipped` result is observed
- **THEN** it has exactly the fields `outcome`, `reason`
- **AND** no `sessionId` field is present

#### Scenario: Exhaustive switch type-checks

- **WHEN** a consumer writes a `switch (result.outcome)` over the five outcomes returning a value of `T` per branch
- **AND** the consumer omits any branch
- **THEN** `deno task check` fails with a TypeScript error naming the missing case

### Requirement: An end-to-end integration test exercises the cycle against a real orchestration server and a Deno-script "coding agent"

`packages/role-runtimes/src/common/integration_test.ts` SHALL: (a) provision a temp directory via `Deno.makeTempDir()`, run the existing `keni init` helper to produce a `.keni/` project with a roster of one engineer (`alice`), start the orchestration server via `startServer({ port: 0 })`; (b) construct a `CodingAgentInvoker` using the default factory whose `cliBinary` points at `Deno.execPath()` running a tiny fixture script under `packages/role-runtimes/tests/fixtures/fake-coding-agent.ts`; the fixture is parameterised by env vars (`KENI_FAKE_AGENT_LINES`, `KENI_FAKE_AGENT_SUMMARY`, `KENI_FAKE_AGENT_EXIT_CODE`, `KENI_FAKE_AGENT_SLEEP_MS`); (c) invoke `startCycle(...)` with the constructed invoker, a no-op precheck (`{ kind: "proceed", roleContext: {} }`), and a placeholder prompt resolver; (d) assert on the returned `RoleCycleResult` and on the on-disk activity-log file `.keni/activity/<UTC date>.jsonl`. The test SHALL run three scenarios: a happy-path completion (`KENI_FAKE_AGENT_LINES=5`), an idle cycle (`KENI_FAKE_AGENT_LINES=0`, `KENI_FAKE_AGENT_SLEEP_MS=0`), and a graceful termination (`KENI_FAKE_AGENT_SLEEP_MS=30000` plus an `AbortController.abort()` from the test). Teardown SHALL stop the orchestration server (`abort()`) and remove the temp dir in every code path, including failures.

#### Scenario: Happy-path cycle gains the documented activity entries on disk

- **WHEN** `startCycle` runs against the fixture configured for 5 stdout lines, summary `"happy summary"`, exit 0
- **THEN** the function resolves with `{ outcome: "completed", sessionId, exitCode: 0, summary: "happy summary" }`
- **AND** the on-disk activity log file `.keni/activity/<UTC date>.jsonl` gained exactly seven lines for this `session_id`: `session_start`, five `subprocess_stdout`, `session_end`
- **AND** every line's `agent` is `"alice"` and `role` is `"engineer"`
- **AND** the `session_end` line's `summary` field is `"happy summary"`

#### Scenario: Idle cycle gains exactly two activity entries

- **WHEN** `startCycle` runs against the fixture configured for 0 stdout lines, exit 0, sleep 0 ms
- **THEN** the function resolves with `{ outcome: "idle", sessionId }`
- **AND** the on-disk activity log file gained exactly two lines for this `session_id`: `session_start`, `idle`
- **AND** no `session_end` line for this `session_id` exists

#### Scenario: Graceful termination produces a `session_end` with `terminated_by: "sigterm"`

- **WHEN** `startCycle` runs against the fixture configured to sleep 30 000 ms
- **AND** the test fires `controller.abort()` 100 ms into the cycle
- **THEN** the function resolves with `{ outcome: "terminated", sessionId, terminatedBy: "sigterm", exitCode: <signal code> }`
- **AND** the on-disk activity log file's `session_end` line for this `session_id` carries `refs.terminated_by: "sigterm"`

#### Scenario: Test cleanup is deterministic

- **WHEN** any single integration test fails partway through
- **THEN** the orchestration server's `abort()` is called within the test's teardown
- **AND** the temp dir is removed within the test's teardown
- **AND** no orphan temp files (e.g., the invoker's `mcpServers` JSON) persist after the test run completes

### Requirement: The package introduces no new runtime dependencies; every primitive is built-in or already in `deno.json`

The `role-runtime-common` change SHALL NOT add any entry to the workspace `deno.json` `imports` map. Every primitive used by the new code SHALL be either: (a) a Deno built-in (`Deno.Command`, `fetch`, `crypto.randomUUID`, `TextDecoderStream`); (b) an existing `@std/*` module already in `deno.json` (`@std/uuid` for v7 generation, `@std/path` for path joining); (c) an existing `@keni/shared` wire type. The package SHALL NOT import the MCP SDK (`@modelcontextprotocol/sdk`); MCP-server processes are spawned by the coding-agent CLI from its own `mcpServers` config — the runtime writes the config but does not speak MCP itself.

#### Scenario: `deno.json` is unchanged by this change

- **WHEN** the diff of the workspace `deno.json` against the post-step-06 baseline is inspected
- **THEN** the `imports` map is unchanged
- **AND** `deno.lock` is unchanged

#### Scenario: The package does not import the MCP SDK

- **WHEN** the source files under `packages/role-runtimes/src/` are scanned for `@modelcontextprotocol/sdk`
- **THEN** no occurrence is found in any production file or test file

### Requirement: The runtime is engineer / QA / PO -agnostic; role specifics live in downstream changes

The cycle SHALL NOT contain any conditional logic keyed on `params.role` (no `if (role === "engineer")` branches, no role-specific event names, no role-specific timeout values). Every role-shaped concern (which prompt to load, what the precheck inspects, which CLI binary to spawn, which env vars to allow) SHALL be passed in via `RoleCycleParams`. The cycle SHALL behave identically when invoked with `role: "engineer"`, `role: "qa"`, or `role: "po"` given equivalent params; only the activity-log entries' `role` field will differ. Downstream changes (step 09 for engineer, step 17 for PO) plug their specifics into the params bag without changing the cycle.

#### Scenario: Source contains no role-keyed conditional logic

- **WHEN** the source files under `packages/role-runtimes/src/common/` are scanned for `=== "engineer"`, `=== "qa"`, `=== "po"`, `=== "writer"`, `=== "user"`
- **THEN** no occurrence is found in any production file (test files MAY contain such comparisons in fixture setup)

#### Scenario: Same cycle code path runs for any role

- **WHEN** the cycle is invoked once with `role: "engineer"` and once with `role: "po"` against the same fake invoker and same precheck / prompt resolver
- **THEN** both invocations follow the identical sequence of steps
- **AND** the only difference between the two cycles' emitted activity entries is the `role` field

### Requirement: The capability spec documents the in-process / stateless / single-cycle invariants

This capability SHALL document, in this spec file and in the `@keni/role-runtimes` package's `README` (forwarded from the root README), that: (a) `startCycle` runs *one* cycle per invocation — no looping, no scheduling, no retry; (b) the cycle holds no state across invocations beyond what is explicitly passed in via `RoleCycleParams`; (c) the cycle reaches the activity log only via `POST /activity` — no `.keni/` direct writes, no in-process storage interface use; (d) the cycle is engineer / QA / PO -agnostic — the role is a parameter, not a code path; (e) `resume_session_id` is forwarded verbatim to the coding-agent CLI; the runtime does not interpret it; (f) the runtime's `session_id` (uuidv7, generated per cycle) is distinct from the coding-agent CLI's session id (whatever the CLI uses internally). Any change that adds a step to the cycle, alters an outcome shape, introduces a new event kind on the activity log, relaxes the prompt-resolution rule, or adds a new role-keyed code path lands as a delta spec against this capability.

#### Scenario: Documentation names the in-process / stateless / single-cycle invariants

- **WHEN** the root `README.md`'s role-runtime subsection is read
- **THEN** the documentation explicitly names the four invariants above

#### Scenario: The runtime's `session_id` is distinct from the resumed CLI session id

- **WHEN** the cycle is invoked with `resumeSessionId: "cli-id-A"`
- **AND** the cycle's resolved `RoleCycleResult.sessionId` is observed as `<some uuidv7>`
- **THEN** the runtime's `sessionId` does not equal `"cli-id-A"`
- **AND** the activity log's `session_start` entry's `session_id` field equals the runtime's `sessionId` (not `"cli-id-A"`)
- **AND** the same entry's `refs.resume_session_id` field equals `"cli-id-A"`

