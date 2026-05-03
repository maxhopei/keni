## Context

Step 07 shipped `startCycle(params)` — a deterministic, single-cycle role runtime that takes a precheck, a prompt resolver, and a coding-agent invoker, runs one cycle end-to-end, and returns a discriminated `RoleCycleResult`. It is pure with respect to its inputs, holds no state across invocations, and does not read or write `.keni/` directly. Step 05 shipped the agents API + WebSocket, including an in-memory `AgentRuntimeStateStore` that exposes `paused`, `status`, `last_activity`, `last_active_at` per agent and a working `agent.state_changed` event channel on the bus.

Neither of those steps drives the cycle on a schedule. There is no tick loop, no precheck-before-spawn enforcement, no interrupt path, no timeout path. The implementation plan (`initial-implementation-plan/08-cron-scheduler-with-pause.md`) calls for the deterministic glue that turns the runtime into a running team while preserving every invariant `spec.md` declares: §6.1 (cadence + pause + deterministic precheck + "chat is event-driven, not scheduled"), §6.2 (precheck contract, one concern per session), §7.5 (interrupt + timeout, no auto-revert), §11#7 (one ticket per session — reinforced by no stacked cycles per agent).

The scheduler is the first component that genuinely lives "across" packages: it consumes types from `@keni/role-runtimes` (`startCycle`, `RoleCycleParams`), state from `@keni/server` (`AgentRuntimeStateStore`, `EventBus`, `LogSink`, `ConfigStore`), and configuration from `@keni/shared` (`ProjectConfig`). Where the scheduler *lives* and how it composes with `runServer` is the load-bearing decision below.

Important constraints:

- The role runtime must remain engineer / QA / PO -agnostic. The scheduler is the seam where role specifics plug in, but the scheduler itself must also remain role-agnostic — it cannot ship `if (role === "engineer")` branches. Every role-shaped concern is a registered `AgentRunner`.
- `params.signal` is the cycle's only seam to the outside. Interrupt and timeout must both fire through it.
- The runtime emits `session_end` (with `terminated_by`) on graceful termination — *not* `session_interrupted` or `session_timeout`. The scheduler is the layer that knows *why* abort fired and is therefore responsible for the human-readable activity-log labels.
- No auto-revert of ticket status on interrupt or timeout. The runtime never decides ticket state; this step preserves that invariant.

## Goals / Non-Goals

**Goals:**

- Tick each enabled agent on its configured cadence (per-role default + per-agent override); skip every paused agent silently.
- Enforce precheck-before-spawn: a "skip" precheck means zero subprocess, zero activity-log entry, zero LLM token cost.
- Per-agent concurrency lock: one active cycle per agent at any time. Cross-agent parallelism allowed.
- Provide an interrupt API that fires the active cycle's `AbortSignal` and appends `session_interrupted`. Provide a timeout enforcer that fires the same signal on wall-clock expiry and appends `session_timeout`.
- Wire pause/resume to the existing in-memory `paused` flag (no new persistence).
- Plug-in surface for role specifics (`AgentRunnerRegistry`) so steps 09 / 17 register their roles without modifying the scheduler.
- Lifecycle integration with `runServer`: start at bootstrap, stop on abort, drain in-flight cycles via `AbortController.abort()` during shutdown.
- No new external dependencies; no `cron` parser; no `@std` additions beyond what `deno.json` already lists.

**Non-Goals:**

- Engineer / QA / PO precheck *content* — owned by steps 09 and 17.
- Event-driven triggers for engineer / QA — post-MVP (chat is the only event-driven path; that is owned by step 19).
- REST endpoint for interrupt — owned by step 12. (This change exposes the method; step 12 wires it.)
- UI affordances — owned by step 12.
- Status auto-revert on interrupt / timeout — explicitly out of scope (`spec.md` §7.5).
- A real cron expression parser. The prototype's `schedules:` value vocabulary is a simple subset (described in Decision 4); a future change can swap in a full parser additively.
- Persistent scheduling state. Tick watermarks and per-agent "last tick at" live in memory; a server restart resumes ticking from "now" with no replay. This matches step 05's in-memory state choice.
- A cross-process scheduler. The scheduler is in-process, single-instance, single-server-per-project — same model as `runServer`.

## Decisions

### Decision 1 — Where the scheduler lives: `@keni/server/scheduler/`

Three candidates were on the table:

- (a) `@keni/role-runtimes` (close to `startCycle`).
- (b) A new package, e.g., `@keni/scheduler`.
- (c) `@keni/server` as a sibling subdirectory to `routes/` and `middleware/`.

Choose (c). The scheduler depends on the bus, the runtime-state store, the log sink, and the config store — all already in `@keni/server`. It is owned by `runServer`'s lifecycle and shuts down with the server. Putting it in `@keni/role-runtimes` would force `@keni/role-runtimes` to import `@keni/server` (a cycle). A new package costs one more workspace entry, two more imports, a new `@keni/scheduler` JSR identifier — for code that has exactly one consumer (`runServer`).

The folder layout: `packages/server/src/scheduler/` with `tick.ts` (the per-agent loop), `registry.ts` (the `AgentRunnerRegistry`), `schedule.ts` (cadence parsing), `timeout.ts` (per-role timeout resolution), `interrupt.ts` (the `interrupt(agentId)` method's logic), and a single barrel `mod.ts` that re-exports the public surface to `runServer` and (in step 12) to a future `routes/agents.ts` interrupt endpoint.

### Decision 2 — Tick algorithm: self-rescheduling `setTimeout`, not `setInterval`

Two options:

- (a) One global `setInterval(min(cadences), …)` driving every agent.
- (b) Per-agent `setTimeout(...)` re-armed at the end of each tick.

Choose (b). `setInterval` drifts under event-loop pressure (a slow tick "catches up" by firing back-to-back) and couples cadences (a 5-second PO tick forces the engineer to evaluate every 5 seconds even though it should only run every 60). Per-agent `setTimeout` recomputed after each tick gives stable cadence (`expected_next_tick = last_tick_started_at + cadence_ms`, with a `Math.max(0, …)` clamp so a slow tick still fires the next one promptly), trivially clean per-agent stop (`clearTimeout(handle)`), and natural pause: when paused, we still arm the next tick, but its work-fn skips precheck and skips startCycle.

The `nextTickAt` value is derived from `lastTickStartedAt + cadenceMs`, not `lastTickEndedAt + cadenceMs`. Driving from start time means a 70-second cycle on a 60-second cadence does not stretch the schedule into a 130-second period; the next tick fires immediately when the previous one ends (the per-agent concurrency lock ensures we still don't spawn two cycles for the same agent).

### Decision 3 — Concurrency model: one in-flight cycle per agent

Per-agent state held by the scheduler (in-memory, lost on restart):

```ts
type ActiveCycle = {
  readonly sessionId: string;       // mirrors the runtime's session id once allocated
  readonly startedAt: number;       // ms since epoch
  readonly abortController: AbortController;
  readonly timeoutHandle: number;   // setTimeout handle for the wall-clock timeout
};
type AgentState = {
  readonly agentId: string;
  readonly role: string;
  readonly cadenceMs: number;
  readonly tickHandle: number | null; // setTimeout handle for the next tick
  active: ActiveCycle | null;
};
```

Per-agent concurrency invariant: when `active !== null`, the next tick fires the work-fn, which observes `active !== null` and **skips** (logs a warn-level "tick coalesced for `<agentId>`, previous cycle still running"). This caps blast radius: a slow cycle does not stack new spawns; a hung cycle eventually trips the timeout and clears `active`.

Cross-agent parallelism is allowed: each agent has its own `AgentState`. Step 26 (multi-engineer) consumes this directly — registering two engineer runners produces two independent ticks.

### Decision 4 — Schedule parsing: shorthand subset, no cron library

`projectConfig.schedules?[key]` accepts:

- A duration shorthand: `"5s"`, `"60s"`, `"5m"`, `"1h"`. Parsed by a small regex (`/^(\d+)(ms|s|m|h)$/`).
- A cron-style every-N-minutes: `"*/N * * * *"` → `N * 60_000` ms. Anything else of cron shape is rejected.
- A bare integer (interpreted as milliseconds — useful for tests).

The keys: agent id wins over role. Resolution order: `schedules[agentId] ?? schedules[role] ?? defaultCadenceForRole(role)`. Defaults: `engineer = 60_000`, `qa = 60_000`, `po = 5_000`, anything else = `60_000` (with a one-line warning naming the role).

A cron parser is rejected for now: the prototype's only documented values are the two defaults, and the surface area of "real cron" is not worth the dependency or the in-house code. A future change can swap in a parser additively without changing the registry or the tick algorithm.

### Decision 5 — Timeout enforcement: scheduler-owned wall-clock + abort-via-signal

Two options for "where the timeout fires":

- (a) Inside `startCycle` (a new `params.timeoutMs` field).
- (b) In the scheduler — set a `setTimeout` at cycle start, fire `abortController.abort()` on expiry.

Choose (b). The runtime is the wrong place to own a wall-clock deadline: the runtime is supposed to be pure with respect to its inputs (it currently reads no clock except for the idle threshold), and a timeout is a scheduling concern (per-role policy, configurable). The scheduler is the authoritative timeout source and uses `params.signal` to fire it. The cycle resolves with `{ outcome: "terminated", terminatedBy: "sigterm", … }`; the scheduler then appends a `session_timeout` activity entry (with the same `session_id`) to label the human-readable cause.

Default per-role timeout: `engineer = 30 * 60 * 1000`, `qa = 30 * 60 * 1000`, `po = 5 * 60 * 1000`. Configurable via `projectConfig.timeouts[role]` (or `timeouts[agentId]`) using the same shorthand parser as Decision 4. A timeout shorter than the cycle's idle threshold is allowed but logs a warn.

### Decision 6 — Interrupt: scheduler exposes `interrupt(agentId)`; step 12 wires the route

`SchedulerHandle.interrupt(agentId)` returns `{ interrupted: true, sessionId } | { interrupted: false, reason: "no_active_cycle" | "unknown_agent" }`. Implementation: look up the agent state; if `active === null`, return the false case; otherwise, call `active.abortController.abort("interrupt")`, append `session_interrupted` with the active session id, and return the true case. The append happens *before* the `await` of the cycle's promise resolves so the activity log records the interrupt cause near in time to the user click; the runtime's own `session_end` follows shortly after.

This separation matters: the scheduler knows *why* abort fired (interrupt vs. timeout); the runtime does not. The activity log gains two entries with the same `session_id`: `session_interrupted` (or `session_timeout`) and `session_end` with `refs.terminated_by: "sigterm"`. Both map `→ idle` in the runtime-state store; ordering does not matter for the state machine.

### Decision 7 — Pause: read every tick from `AgentRuntimeStateStore`, no separate field

The agents API (step 05) already owns `paused` in the in-memory store. The scheduler reads it via `runtimeStore.read(agentId).paused` at the top of every tick. Two consequences worth pinning:

- A pause flip *during* an in-flight cycle is **not** observed by the scheduler until the next tick. The cycle is not aborted by `pause`. (Documented; reinforces "pause is a scheduling preference, interrupt is the abort verb.")
- A paused tick is silent: no `session_start`, no `session_skipped` event, no log line beyond a debug-level "skipping tick for `<agentId>` — paused". This matches `spec.md` §6.1 ("Paused agents are skipped by the scheduler") — *skipped*, not *recorded*.

Resume: the next scheduled tick will pick up the agent. No queue / no missed-tick replay.

### Decision 8 — `AgentRunnerRegistry` is the role plug-in surface

The scheduler does not import any role-specific code. It accepts an `AgentRunnerRegistry` whose entries shape:

```ts
interface AgentRunner {
  readonly role: Role;
  readonly precheck: (ctx: CyclePrepCtx) => Promise<PrecheckResult> | PrecheckResult;
  readonly promptResolver: (ctx: CyclePrepCtx) => BundledPrompt;
  readonly expectedPromptName?: string;
  readonly codingAgentInvoker: CodingAgentInvoker;
  readonly envAllowlist?: readonly string[];
  readonly mcpServerConfig: McpServerConfig;
  /** Optional per-runner overrides, fall back to the per-role/per-agent timeout. */
  readonly idleThresholdMs?: number;
  readonly terminationGraceMs?: number;
}
```

Registration happens once at bootstrap. Step 09 (engineer) constructs an `AgentRunner` whose `precheck` reads tickets and selects one. Step 17 (PO) constructs four runners (one per mode) — though that may turn out to be one runner with mode-aware precheck; step 17 makes the call. The scheduler does not care.

When a tick fires for `agentId`, the scheduler looks up `registry.get(role)` (where `role` is the agent's role from the runtime-state store / project config). If no runner is registered, the tick is a no-op with a warn-level log. This decouples step 08 from step 09: the prototype passes its CI even before step 09 lands, by registering a no-op runner in tests.

### Decision 9 — Lifecycle: `start()` / `stop()` driven by `runServer`

`runServer` instantiates the scheduler after the bus and the runtime-state store, calls `scheduler.start()` exactly once, and registers `scheduler.stop()` in the abort handler. `stop()` is idempotent: it clears every per-agent timer, fires every active `abortController.abort("server_shutdown")`, and `await`s every in-flight cycle's promise (with a hard 30-second timeout that escalates to no-op — by which point the runtime has already been signalled). Clean shutdown is the prototype's only behaviour; crash-safety is not a goal.

`start()` reads the project config's `agents` and `schedules`, computes per-agent cadence, and arms the first per-agent `setTimeout`. Subsequent ticks self-arm.

### Decision 10 — Not emitting `agent.state_changed` directly

Two indirect channels already update `agent.state_changed` via the bus:

- The agents-API pause / resume handlers emit it on flag flip.
- The activity-log handler emits it after `applyActivityEvent` reports `changed: true` (a `session_start` flips status to `running`; `session_end` / `session_interrupted` / `session_timeout` / `idle` flip back to `idle`).

The scheduler's only contributions are appending `session_interrupted` / `session_timeout` activity entries (via the orchestration server's `POST /activity`, *not* via direct store calls — same rule as step 07's role runtime). The bus emission is then the existing handler's responsibility.

This keeps the emission rule single-sourced and avoids duplicate frames per state change.

### Decision 11 — Logging and observability

Three log levels in the scheduler, all via the existing `LogSink`:

- `info`: `scheduler.started`, `scheduler.stopped`, `runner.registered{role}`.
- `warn`: `tick.coalesced{agentId}` (previous cycle still running), `runner.missing{role}`, `schedule.invalid{key,value,fallback}`, `timeout.shorter_than_idle{role}`, `cycle.spawn_failed{agentId,error}`.
- `debug`: `tick.skipped_paused{agentId}`, `tick.precheck_skipped{agentId,reason}`.

No new metrics surface in this step; the activity log remains the durable trace and step 12's UI / future Datadog hookup reads from it.

### Decision 12 — Test surface

Three test layers, all using existing primitives:

- Unit tests for `schedule.parse` (every shorthand, every fallback, every warning), `timeout.resolve`, and `registry` (registration / dedup / unknown-role lookup).
- Integration tests for the tick loop with a fake clock (`@std/testing/time`) and a fake `AgentRunner` whose `codingAgentInvoker` is the same `fakeCodingAgentInvoker` introduced in step 07. Three driving scenarios: (a) precheck skip → no entries; (b) proceed → completed cycle → `session_start`+`session_end`; (c) timeout fires → `session_end{terminated_by:"sigterm"}` + `session_timeout` entry, both same session id; (d) interrupt fires → `session_end{terminated_by:"sigterm"}` + `session_interrupted` entry, both same session id; (e) pause flip → next tick skips silently.
- One end-to-end test (`packages/server/src/scheduler/integration_test.ts`) that boots `runServer` against a temp `keni init` project, registers the same fake runner used in step 07's E2E, advances the fake clock, and asserts on the on-disk activity-log file.

All three layers reuse step 07's fixtures (`fakeCodingAgentInvoker`, `tests/fixtures/fake-coding-agent.ts`). No new fixtures are needed.

## Risks / Trade-offs

- **Risk:** The fake-clock pattern for `setTimeout` ordering can mask real-world drift. **Mitigation:** the integration_test.ts (real clock) covers cadence stability for one full cycle of each role; the fake-clock unit tests cover correctness of the rearm math.

- **Risk:** A runner whose `precheck` is itself slow (e.g., long `GET /tickets` round-trip) eats the per-agent tick budget. **Mitigation:** the precheck has its own timeout — the same `terminationGraceMs` applies to the precheck phase; if precheck exceeds it, the tick is recorded as `precheck_timeout` (debug-level only, no activity-log entry). This is documented in the capability spec.

- **Risk:** A role registered for an agent whose role doesn't match the registry is a silent no-op. **Mitigation:** at `start()` time, the scheduler checks each agent's role against the registered runners and warns once per unknown role. A test asserts this.

- **Risk:** A pause flip during an in-flight cycle creates the impression that "pause should also abort" — surprising for the user. **Mitigation:** documented in the capability spec ("`pause` is a scheduling preference; `interrupt` is the abort verb"); the README's UI section will mirror the language; step 12's UI offers both buttons distinctly.

- **Risk:** `session_interrupted` and `session_end` arriving out of order in the activity log. **Mitigation:** both carry the same `session_id`; queries that group by `session_id` are unaffected. The spec records the ordering as undefined and explicitly tests both orderings.

- **Trade-off:** Per-agent `setTimeout` instead of a single `setInterval` means N timers for N agents. For a prototype with 1–5 agents this is invisible; for a future 100-agent project it remains negligible. If we ever hit thousands of agents, swap to a single priority-queue-driven loop additively.

- **Trade-off:** No persistent tick watermark. If the server restarts mid-cycle, the active subprocess (via the runtime) is the only state the new server inherits — and that subprocess will exit and its activity-log entry will be appended next time `POST /activity` succeeds. Acceptable for the prototype: server restarts are rare and the ticket the agent was working on remains in `in_progress` (`spec.md` §7.5: "no auto-revert").

## Migration Plan

This is greenfield code; there is nothing to migrate. Deployment is `runServer` instantiating one new module. Rollback is reverting the change — the server boots and runs identically, but no agent ticks (the scheduler is the only driver). No data migration; no schema change beyond the optional `timeouts?` field on `ProjectConfig` (additive, round-tripped today).

## Open Questions

- **Per-agent vs. per-role timeout key precedence.** Decision 5 picks `timeouts[agentId] ?? timeouts[role] ?? defaultForRole(role)`. Open: should the agent-id key be deprecated in favour of role-only? Fine for the prototype to support both; the spec scenario records that both keys are valid and the per-agent one wins.

- **`session_interrupted` and `session_timeout` ordering relative to `session_end`.** The scheduler appends its own entry *before* the runtime's `session_end` resolves to give the user a near-real-time signal in the UI. But the runtime's call may complete in either order with the scheduler's append, depending on event-loop scheduling. Acceptable for now (both rows point at the same `session_id`); a stricter ordering can be enforced later by waiting on the runtime's promise before the scheduler appends — at the cost of a UI delay.

- **Should `start()` reload the agent roster on a `project.yaml` change?** No — same as the orchestration server (`runServer` reads project config once at bootstrap; runtime edits require restart). Documented; out of scope for this change.

- **Should the scheduler honour `idleThresholdMs` when no runner is registered?** Moot: an unregistered runner means `tick` returns immediately without spawning — no idle threshold applies.
