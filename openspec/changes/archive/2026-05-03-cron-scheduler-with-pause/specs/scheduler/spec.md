## ADDED Requirements

### Requirement: `@keni/server` exposes a `Scheduler` whose `start()` / `stop()` are owned by `runServer`

The `@keni/server` package SHALL export a `createScheduler(deps, opts)` factory whose return value (the `Scheduler` handle) carries exactly four methods: `start(): void`, `stop(): Promise<void>`, `interrupt(agentId: string): { interrupted: true; sessionId: string } | { interrupted: false; reason: "no_active_cycle" | "unknown_agent" }`, and `registerRunner(runner: AgentRunner): void`. `start()` SHALL be idempotent for the no-runners case (calling it twice is allowed; the second call is a no-op with a warn-level "scheduler already started" log line). `stop()` SHALL be idempotent unconditionally; subsequent calls SHALL resolve immediately with no further side effects. `runServer` SHALL instantiate the scheduler exactly once after constructing the bus and the runtime-state store, SHALL pass the project config's `agents` and `schedules` (and optional `timeouts`) into the factory, SHALL call `start()` exactly once before `Deno.serve` accepts connections, and SHALL call `stop()` from the abort handler before resolving the server's exit code. The `Scheduler` SHALL NOT be re-creatable after `stop()` — the contract is single-use per server lifecycle.

#### Scenario: `runServer` instantiates and starts the scheduler exactly once at bootstrap

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a `keni init`-produced temp dir whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]`
- **AND** an instrumented `createScheduler` records each call
- **THEN** `createScheduler` is called exactly once during bootstrap
- **AND** the returned scheduler's `start()` method is called exactly once before the server begins accepting connections

#### Scenario: `runServer`'s abort handler calls `scheduler.stop()` before resolving

- **WHEN** the test fires the server's abort signal during a normal shutdown
- **THEN** `scheduler.stop()` is invoked exactly once
- **AND** the function returns 0 only after `stop()` has resolved
- **AND** the server's resolved promise's resolution does not race ahead of `stop()`

#### Scenario: `start()` is idempotent

- **WHEN** `scheduler.start()` is called twice in succession
- **THEN** both calls return without throwing
- **AND** the captured log shows exactly one warn-level line naming "scheduler already started"
- **AND** at most one per-agent timer is armed for each agent

#### Scenario: `stop()` is idempotent and resolves immediately on the second call

- **WHEN** `scheduler.stop()` is called twice
- **THEN** the first call resolves after every per-agent timer is cleared and every active cycle's abort signal has fired
- **AND** the second call resolves on the next microtask without further side effects

### Requirement: Per-agent ticks fire at the configured cadence using a self-rescheduling `setTimeout`

The scheduler SHALL maintain one per-agent `setTimeout` handle and SHALL re-arm it at the **end of each tick's work-fn** with the next-tick interval computed as `Math.max(0, lastTickStartedAt + cadenceMs - Date.now())`. The scheduler SHALL NOT use `setInterval`. The cadence SHALL be resolved in this order: `projectConfig.schedules?[agentId]` ⇒ `projectConfig.schedules?[role]` ⇒ `defaultCadenceForRole(role)`. The role defaults SHALL be: `engineer = 60_000`, `qa = 60_000`, `po = 5_000`. An unknown role SHALL fall back to `60_000` with a one-line warn log on `start()`. Cadence SHALL be parsed by an in-house helper that accepts: a duration shorthand matching `/^(\d+)(ms|s|m|h)$/`, a cron-style `"*/N * * * *"` pattern (resolved as `N * 60_000`), and a bare positive integer (interpreted as milliseconds). Unparseable values SHALL warn once at `start()` and fall back to the role default; the scheduler SHALL NOT throw on an unparseable schedule.

#### Scenario: Engineer default cadence is 60 seconds when `schedules` is empty

- **WHEN** the scheduler is started against a project whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]` and no `schedules`
- **AND** the test advances a fake clock by 59_000 ms
- **THEN** the engineer's tick has not yet fired
- **AND** advancing by an additional 1_000 ms fires exactly one tick

#### Scenario: PO default cadence is 5 seconds when `schedules` is empty

- **WHEN** the scheduler is started against a project whose `project.yaml` declares an agent `{ id: "po", role: "po" }` and no `schedules`
- **AND** the test advances a fake clock by 5_000 ms
- **THEN** the PO's tick fires exactly once

#### Scenario: Per-agent override wins over per-role override

- **WHEN** `schedules` is `{ alice: "10s", engineer: "30s" }` and `agents` declares `alice` as an engineer
- **AND** the fake clock advances by 10_000 ms
- **THEN** the alice tick fires exactly once
- **AND** advancing by an additional 10_000 ms fires the next tick (cadence remains 10 s, not 30 s)

#### Scenario: Duration shorthand parses correctly

- **WHEN** the parser is asked to resolve `"5m"`
- **THEN** the resolved cadence is `300_000` ms

#### Scenario: Cron `*/2 * * * *` parses to 120 000 ms

- **WHEN** the parser is asked to resolve `"*/2 * * * *"`
- **THEN** the resolved cadence is `120_000` ms

#### Scenario: Unparseable schedule falls back to the role default

- **WHEN** `schedules` is `{ alice: "totally-bogus" }` and alice is an engineer
- **AND** the scheduler is started
- **THEN** the captured log contains exactly one warn-level line naming `"alice"`, `"totally-bogus"`, and the fallback default of `60_000`
- **AND** alice's resolved cadence is `60_000`

#### Scenario: A 70-second cycle on a 60-second cadence does not stretch the schedule

- **WHEN** the engineer's cadence is `60_000` and a tick's cycle takes 70 000 ms (verified via fake clock)
- **THEN** the next tick fires immediately after the previous cycle ends (the rearm computes a non-positive delay and clamps to `0`)
- **AND** subsequent ticks return to the 60_000-ms cadence relative to their respective `lastTickStartedAt` values

### Requirement: Every tick consults `paused` and skips silently when set

At the top of every tick's work-fn, the scheduler SHALL call `runtimeStore.read(agentId).paused`. When the value is `true`, the work-fn SHALL return immediately without calling precheck, without spawning a subprocess, without appending an activity-log entry, and without emitting any bus frame. The tick SHALL still re-arm the next `setTimeout` at the agent's normal cadence so a subsequent unpause picks up on the next scheduled tick. A pause flip during an in-flight cycle SHALL NOT abort the cycle (`pause` is a scheduling preference; `interrupt` is the abort verb).

#### Scenario: Paused tick is silent

- **WHEN** alice's `paused` flag is `true`
- **AND** the fake clock advances enough to fire alice's tick
- **THEN** the captured activity-log gained zero entries for `agent: "alice"` for this tick
- **AND** the captured bus gained zero frames for `agent_id: "alice"` for this tick
- **AND** the next per-agent timer is armed for the same cadence

#### Scenario: Resume picks up on the next scheduled tick

- **WHEN** alice is paused, then unpaused at `t = 0`
- **AND** alice's cadence is `60_000`
- **AND** the fake clock advances by `60_000` ms from the pause-point
- **THEN** alice's tick fires exactly once after the unpause
- **AND** the precheck is invoked

#### Scenario: Pausing during an in-flight cycle does not abort

- **WHEN** alice's cycle is in flight (a fake `codingAgentInvoker` resolves after `30_000` ms)
- **AND** `runtimeStore.setPaused("alice", true)` is called `5_000` ms into the cycle
- **AND** the fake clock advances another `25_000` ms (cycle resolves)
- **THEN** the cycle resolved with `outcome: "completed"` (the abort signal did not fire)
- **AND** the next tick — which fires after resolution — observes `paused: true` and skips silently

### Requirement: Each tick calls the registered `AgentRunner.precheck` before any subprocess spawn

For an enabled, unpaused agent, the work-fn SHALL look up `registry.get(role)` to find the registered `AgentRunner`. When no runner is registered for the role, the work-fn SHALL log a warn-level "runner.missing" line and skip the tick (no precheck, no subprocess, no activity-log entry). When a runner is registered, the work-fn SHALL call `runner.precheck(prepCtx)` and SHALL pass through `runner` (precheck, promptResolver, expectedPromptName, codingAgentInvoker, envAllowlist, mcpServerConfig, idleThresholdMs, terminationGraceMs) into a single `RoleCycleParams` value handed to `startCycle`. When `precheck` resolves to `{ kind: "skip", reason }`, the scheduler SHALL NOT call `startCycle`; it SHALL emit a debug-level log line naming the agent and the reason and SHALL NOT append any activity-log entry. When `precheck` resolves to `{ kind: "proceed", … }`, the scheduler SHALL call `startCycle(params)`. The scheduler SHALL NOT inspect `precheck`'s `roleContext` field; it forwards the value verbatim into `RoleCycleParams.precheck` so `startCycle` is the sole reader.

#### Scenario: A registered runner's precheck is invoked exactly once per tick

- **WHEN** alice is registered as `engineer` with a precheck that records its calls
- **AND** the fake clock fires three engineer ticks in succession
- **THEN** the precheck is called exactly three times
- **AND** each call's `prepCtx` carries `{ role: "engineer", agentId: "alice", projectName: <project>, workspacePath: <or null>, serverUrl: <bound url> }`

#### Scenario: A `skip` precheck does not call `startCycle`

- **WHEN** alice's precheck returns `{ kind: "skip", reason: "no_ticket_to_pick_up" }`
- **AND** the tick fires
- **THEN** the captured `startCycle` mock has zero calls
- **AND** the activity log gained zero new entries

#### Scenario: A `proceed` precheck invokes `startCycle` with the registered runner's fields

- **WHEN** alice's precheck returns `{ kind: "proceed", roleContext: { summary: "ticket-0001" } }`
- **AND** the tick fires
- **THEN** `startCycle` is called exactly once
- **AND** the call's `params.precheck` is the registered runner's precheck (verbatim reference)
- **AND** the call's `params.promptResolver`, `params.codingAgentInvoker`, `params.expectedPromptName`, `params.envAllowlist`, `params.mcpServerConfig` match the registered runner's fields (verbatim references)

#### Scenario: An unregistered role logs once and skips

- **WHEN** `project.yaml` declares an agent `{ id: "ghost", role: "writer" }` and no `writer` runner is registered
- **AND** ghost's tick fires
- **THEN** the captured log contains a warn-level "runner.missing" line naming `"writer"`
- **AND** the activity log gained zero new entries
- **AND** subsequent ticks for ghost continue to fire (the missing-runner condition is non-fatal)

### Requirement: A given agent never has two cycles running at once; cross-agent parallelism is allowed

Per-agent state SHALL hold an `active: ActiveCycle | null` field. When the work-fn fires and `active !== null`, the work-fn SHALL emit a warn-level "tick.coalesced" log line naming the agent and SHALL return without calling precheck, spawning a subprocess, or appending an activity-log entry. The work-fn SHALL re-arm the next tick at the normal cadence; the next tick will observe `active === null` (the in-flight cycle has resolved by then) or coalesce again. Cross-agent parallelism SHALL be allowed: when alice's cycle is in flight, bob's tick (in a different `AgentState`) SHALL fire normally and may run a cycle simultaneously.

#### Scenario: A second tick for the same agent coalesces while the first is in flight

- **WHEN** alice's cycle is in flight (an invoker that resolves after `120_000` ms is registered)
- **AND** the cadence is `60_000` ms
- **AND** the fake clock advances by `60_000` ms (firing the second tick)
- **THEN** the second tick is coalesced
- **AND** the captured log contains a warn-level "tick.coalesced" line naming `"alice"`
- **AND** zero new activity-log entries are appended for this tick

#### Scenario: Bob's tick runs while alice's cycle is in flight

- **WHEN** alice's cycle is in flight
- **AND** bob (a separately registered engineer agent) is unpaused with a `60_000`-ms cadence
- **AND** the fake clock advances enough for both to tick
- **THEN** bob's `startCycle` is invoked while alice's cycle remains in flight
- **AND** the activity log records bob's `session_start` independently of alice's outstanding session

### Requirement: Per-role wall-clock timeout fires `params.signal.abort()` and appends a `session_timeout` entry

For every cycle whose precheck proceeds, the scheduler SHALL set a `setTimeout` whose duration is the resolved per-role timeout (in order: `projectConfig.timeouts?[agentId]` ⇒ `projectConfig.timeouts?[role]` ⇒ `defaultTimeoutForRole(role)`). The defaults SHALL be: `engineer = 30 * 60 * 1_000`, `qa = 30 * 60 * 1_000`, `po = 5 * 60 * 1_000`. The timeout value SHALL be parsed with the same shorthand parser used for cadence (Decision 4 in design.md). On expiry the scheduler SHALL call `active.abortController.abort("timeout")` and SHALL append one activity-log entry via `POST /activity` with `event: "session_timeout"`, `session_id: active.sessionId`, `agent: agentId`, `role: role`, `summary: null`, and `refs: { reason: "timeout" }`. The runtime's `startCycle` will then resolve with `outcome: "terminated"` and the runtime's own `session_end` (carrying `terminated_by: "sigterm"` or `"sigkill"`) is emitted on its usual path. When the cycle resolves before the timeout fires, the scheduler SHALL `clearTimeout(active.timeoutHandle)` so the no-op-after-completion case never fires the timer. A timeout shorter than the cycle's `idleThresholdMs` SHALL be allowed but SHALL emit one warn-level "timeout.shorter_than_idle" log line at `start()`.

#### Scenario: A 30-minute engineer cycle fires the timeout

- **WHEN** alice's runner is registered with a fake invoker that sleeps for `40 * 60 * 1_000` ms
- **AND** the engineer timeout default is `30 * 60 * 1_000`
- **AND** the fake clock advances 30 minutes after the cycle starts
- **THEN** `active.abortController.abort("timeout")` has been called
- **AND** the activity log contains exactly one entry with `event: "session_timeout"` whose `session_id` equals the cycle's runtime session id
- **AND** the runtime resolves with `outcome: "terminated"` and emits `session_end` with `refs.terminated_by: "sigterm"` for the same `session_id`

#### Scenario: A cycle that resolves before the timeout clears the timer

- **WHEN** alice's runner is registered with a fake invoker that resolves in `5_000` ms
- **AND** the engineer timeout default is `30 * 60 * 1_000`
- **AND** the cycle resolves at `t = 5_000`
- **AND** the fake clock advances 35 minutes
- **THEN** the activity log contains zero `session_timeout` entries
- **AND** the timeout's `setTimeout` handle was cleared

#### Scenario: A `timeouts[role]` override beats the default

- **WHEN** `projectConfig.timeouts` is `{ engineer: "10m" }`
- **AND** alice's cycle starts at `t = 0`
- **AND** the fake clock advances 10 minutes
- **THEN** the timeout fires
- **AND** the activity log contains exactly one `session_timeout` entry

#### Scenario: A timeout shorter than the idle threshold logs a warning

- **WHEN** `projectConfig.timeouts` is `{ engineer: "100ms" }` and the engineer runner's `idleThresholdMs` is `250`
- **AND** the scheduler is started
- **THEN** the captured log contains exactly one warn-level "timeout.shorter_than_idle" line naming `"engineer"`, `100`, and `250`

### Requirement: `interrupt(agentId)` aborts the active cycle and appends a `session_interrupted` entry

`Scheduler.interrupt(agentId)` SHALL: (a) when no agent with that id exists in the registered roster, return `{ interrupted: false, reason: "unknown_agent" }`; (b) when the agent exists but `active === null`, return `{ interrupted: false, reason: "no_active_cycle" }`; (c) when `active !== null`, call `active.abortController.abort("interrupt")`, append one activity-log entry via `POST /activity` with `event: "session_interrupted"`, `session_id: active.sessionId`, `agent: agentId`, `role: role`, `summary: null`, and `refs: { reason: "interrupt" }`, and return `{ interrupted: true, sessionId: active.sessionId }`. The `POST /activity` call SHALL happen synchronously after the `abort()` call and SHALL NOT block on the runtime's `startCycle` promise; the runtime's own `session_end` is emitted on its usual path. The method SHALL be safe to call concurrently for two different agents. The method SHALL NOT auto-revert the ticket's status (`spec.md` §7.5).

#### Scenario: `interrupt` against a running cycle aborts and appends `session_interrupted`

- **WHEN** alice's cycle is in flight (the fake invoker sleeps for `30_000` ms)
- **AND** `scheduler.interrupt("alice")` is called
- **THEN** the return value is `{ interrupted: true, sessionId: <alice's runtime session id> }`
- **AND** the activity log contains exactly one new entry with `event: "session_interrupted"` whose `session_id` equals the returned id
- **AND** the runtime resolves with `outcome: "terminated"` and emits `session_end` with `refs.terminated_by: "sigterm"` for the same `session_id`

#### Scenario: `interrupt` against an idle agent reports `no_active_cycle`

- **WHEN** alice is in the roster but has no active cycle (`active === null`)
- **AND** `scheduler.interrupt("alice")` is called
- **THEN** the return value is `{ interrupted: false, reason: "no_active_cycle" }`
- **AND** the activity log contains zero new entries
- **AND** no abort signal fires

#### Scenario: `interrupt` against an unknown agent reports `unknown_agent`

- **WHEN** `scheduler.interrupt("ghost")` is called and `"ghost"` is not in the roster
- **THEN** the return value is `{ interrupted: false, reason: "unknown_agent" }`
- **AND** the activity log contains zero new entries

#### Scenario: `interrupt` does not auto-revert the ticket status

- **WHEN** alice's cycle is in flight and the on-disk ticket-0001 status is `in_progress`
- **AND** `scheduler.interrupt("alice")` is called
- **THEN** the on-disk ticket-0001 status is still `in_progress` (the scheduler does not write to `TicketStore`)
- **AND** the runtime's resolution does not change the ticket either

### Requirement: `AgentRunnerRegistry` is the role plug-in surface; the scheduler imports zero role-specific code

The scheduler SHALL accept and own an `AgentRunnerRegistry`. The registry SHALL expose `register(runner: AgentRunner): void` (idempotent for the same `runner.role`; a second `register` for the same role replaces the first and emits an info-level "runner.replaced" log line), `get(role: string): AgentRunner | null`, and `roles(): readonly Role[]`. The scheduler's source files under `packages/server/src/scheduler/` SHALL contain zero `=== "engineer"`, `=== "qa"`, `=== "po"`, or `=== "writer"` literal comparisons. Every role-shaped concern (precheck content, prompt resolution, invoker selection, allowlist, MCP config) is supplied by the registered runner. Step 09 (engineer), step 17 (PO), and any future role land their specifics by `register(...)`-ing a runner; the scheduler's tests use a `fakeAgentRunner` factory that wraps step 07's `fakeCodingAgentInvoker`.

#### Scenario: Registry replaces a previously-registered runner for the same role

- **WHEN** `register({ role: "engineer", … })` is called twice with different runner instances
- **AND** afterwards `registry.get("engineer")` is called
- **THEN** the second runner is returned
- **AND** the captured log contains exactly one info-level "runner.replaced" line naming `"engineer"`

#### Scenario: Source code under `packages/server/src/scheduler/` contains no role-keyed conditional logic

- **WHEN** the production source files under `packages/server/src/scheduler/` (excluding `*_test.ts`) are scanned for `=== "engineer"`, `=== "qa"`, `=== "po"`, `=== "writer"`, `=== "user"`
- **THEN** no occurrence is found

#### Scenario: A test wires a fake runner without modifying scheduler source

- **WHEN** an integration test constructs a `fakeAgentRunner({ role: "engineer", precheck, codingAgentInvoker })` and calls `scheduler.registerRunner(runner)`
- **AND** the scheduler is started
- **AND** the fake clock fires a tick
- **THEN** the registered runner's precheck and invoker are called as documented
- **AND** the scheduler source contains no special-case for the test fixture

### Requirement: The scheduler reaches the activity log only through `POST /activity`; no direct `.keni/` read or write

The scheduler SHALL append `session_interrupted` and `session_timeout` entries by issuing `POST /activity` against the orchestration server's bound URL, carrying `Content-Type: application/json`, `X-Keni-Role: <agent's role>`, and `X-Keni-Agent: <agent id>` on every request. The scheduler SHALL NOT call any storage interface from `@keni/shared` directly, SHALL NOT read or write any path under `.keni/` or `~/.keni/`, and SHALL NOT bypass the orchestration server's role-identity middleware. On a non-2xx response, the scheduler SHALL log the failure at warn level (`scheduler.activity_post_failed`) and continue; the in-flight cycle's resolution path is unaffected. The scheduler SHALL NOT throw out of `interrupt()` or out of the timeout's expiry handler on an activity-post failure (the user-facing operation succeeded; the missing log entry is recorded as a warning).

#### Scenario: `session_interrupted` carries the documented headers

- **WHEN** `scheduler.interrupt("alice")` issues its `POST /activity` request
- **AND** the orchestration server captures inbound request headers
- **THEN** the captured request carries `X-Keni-Role: "engineer"`, `X-Keni-Agent: "alice"`, and `Content-Type: application/json`

#### Scenario: An activity-post failure does not crash the scheduler

- **WHEN** the orchestration server returns `500 internal_error` for the `session_interrupted` POST
- **AND** `scheduler.interrupt("alice")` was the caller
- **THEN** the call still returned `{ interrupted: true, sessionId: <…> }`
- **AND** the captured log has a warn-level "scheduler.activity_post_failed" line naming the agent and the response code
- **AND** the scheduler keeps ticking after the failure

#### Scenario: Source code under `packages/server/src/scheduler/` contains no `.keni/` reads or writes

- **WHEN** the production source files under `packages/server/src/scheduler/` (excluding `*_test.ts`) are scanned for `Deno.readTextFile`, `Deno.readFile`, `Deno.writeTextFile`, `Deno.writeFile`, or any path literal beginning with `.keni/` or `~/.keni/`
- **THEN** no occurrence is found
- **AND** the only filesystem-shaped primitives the scheduler uses are `setTimeout`, `clearTimeout`, `AbortController`, and `crypto.randomUUID`

### Requirement: `stop()` drains in-flight cycles via abort; per-agent timers are cleared first

`stop()` SHALL execute these steps in order: (1) flip an internal `stopped: true` flag so any in-flight tick's work-fn returning concurrently sees it and exits early without re-arming; (2) call `clearTimeout` on every per-agent tick handle; (3) for every agent whose `active !== null`, call `active.abortController.abort("server_shutdown")` and `clearTimeout(active.timeoutHandle)`; (4) `await Promise.allSettled([...activeCyclePromises])` with a hard 30-second outer timeout — once the outer timeout fires, `stop()` resolves regardless of whether the runtime has finished its `session_end` POST. `stop()` SHALL emit one info-level "scheduler.stopped" log line naming the count of drained cycles and the count of any cycles that exceeded the 30-second drain timeout. `stop()` SHALL NOT emit any new `session_interrupted` or `session_timeout` activity entries — server-shutdown abort is a separate cause that the runtime's own `session_end` (with `terminated_by: "sigterm"` and `refs.shutdown: true`) records.

#### Scenario: `stop()` clears every per-agent timer before aborting

- **WHEN** the scheduler is running with three agents (one in-flight, two idle)
- **AND** `stop()` is invoked
- **THEN** every per-agent `setTimeout` handle has been cleared before any `abortController.abort()` fires
- **AND** the two idle agents' timers are cleared even though they had no active cycle

#### Scenario: `stop()` drains an in-flight cycle within the grace window

- **WHEN** alice's cycle is in flight (a fake invoker that takes `2_000` ms after abort to resolve cleanly)
- **AND** `stop()` is invoked
- **THEN** `stop()` resolves within ~2_500 ms (well under the 30-second hard timeout)
- **AND** the runtime's `startCycle` promise had resolved before `stop()` returned

#### Scenario: `stop()` resolves on the hard 30-second timeout when a cycle does not drain

- **WHEN** alice's cycle is in flight against a fake invoker that ignores `abort()` for 60 seconds
- **AND** `stop()` is invoked at `t = 0`
- **AND** the fake clock advances 30_000 ms
- **THEN** `stop()` has resolved
- **AND** the captured log contains an info-level "scheduler.stopped" line naming `drained: 0` and `exceeded_timeout: 1`

#### Scenario: `stop()` does not append `session_interrupted` for shutdown-aborted cycles

- **WHEN** the scheduler aborts an in-flight cycle as part of `stop()`
- **THEN** the activity log contains zero new `session_interrupted` entries for this `session_id`
- **AND** zero new `session_timeout` entries for this `session_id`
- **AND** the runtime's own `session_end` entry (when it eventually posts) carries `refs.terminated_by: "sigterm"` and the cycle is recorded as terminated by the runtime's normal path

### Requirement: The scheduler accepts an injectable clock for deterministic testing

The `createScheduler(deps, opts)` factory SHALL accept an optional `clock: { setTimeout, clearTimeout, now }` injection in `deps`. The default value SHALL bind to the global `setTimeout`, `clearTimeout`, and `Date.now`. Tests SHALL inject `@std/testing/time`'s `FakeTime` (or equivalent) so cadence, timeout, and tick coalescing scenarios are deterministic without `await new Promise(r => setTimeout(r, …))` patterns. The injected clock SHALL be the only seam through which the scheduler reads time; production source files SHALL NOT call the global `setTimeout`, `clearTimeout`, or `Date.now` directly under `packages/server/src/scheduler/`.

#### Scenario: Production source uses the injected clock

- **WHEN** the production files under `packages/server/src/scheduler/` (excluding `*_test.ts`) are scanned for direct calls to `setTimeout(`, `clearTimeout(`, or `Date.now(`
- **THEN** no direct call appears outside of `clock.ts` (or whichever module wraps the global timer)

#### Scenario: A fake clock produces deterministic cadence

- **WHEN** the scheduler is started with `FakeTime` injected and one engineer agent at the default cadence
- **AND** the test calls `time.tick(60_000)`
- **THEN** exactly one tick has fired (no race with the real clock)

### Requirement: Capability documentation names the in-process / single-server / no-replay invariants

This capability SHALL document, in this spec file and in the `@keni/server` `README` (forwarded from the root README's "Run the orchestration server" subsection): (a) the scheduler is in-process, single-instance, and tied to one `runServer` invocation; (b) tick state is in-memory only — a server restart resumes ticking from "now" with no replay of missed ticks (consistent with step 05's in-memory choice); (c) `pause` is a scheduling preference (skipped on the next tick), `interrupt` is the abort verb (fires the active cycle's `AbortSignal` immediately); (d) the scheduler is the canonical caller of `startCycle` and uses `params.signal` exclusively to fire interrupt and timeout; (e) the runtime emits `session_end` (with `terminated_by`); the scheduler emits `session_interrupted` and `session_timeout` to label the human-readable cause; (f) the scheduler does not auto-revert ticket status on interrupt or timeout. Any change that adds a tick path, alters cadence resolution, introduces a new event kind on the scheduler-owned activity-log entries, relaxes the precheck-before-spawn rule, or removes the per-agent concurrency invariant lands as a delta spec against this capability.

#### Scenario: Documentation names the in-process / single-server / no-replay invariants

- **WHEN** the root `README.md`'s scheduler subsection is read
- **THEN** the documentation explicitly names invariants (a) through (f) above

#### Scenario: `pause` and `interrupt` are documented as distinct verbs

- **WHEN** the capability spec and the README both describe pause and interrupt
- **THEN** both surfaces describe `pause` as "skipped on the next tick, no effect on an in-flight cycle"
- **AND** both surfaces describe `interrupt` as "fires the active cycle's `AbortSignal` immediately and appends `session_interrupted`"
