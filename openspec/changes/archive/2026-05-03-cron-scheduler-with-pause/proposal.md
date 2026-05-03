## Why

Step 07 gave us a deterministic role runtime — `startCycle(params)` runs one role cycle end-to-end and returns. But nothing actually *calls* it on a schedule yet. Without a scheduler, the engineer (step 09), QA, and PO (step 17) are libraries with no driver: there is no tick loop, no precheck integration, no honouring of `paused`, no per-role timeouts, and no way to interrupt a runaway session from the UI.

This change builds the deterministic layer that turns role runtimes into a running team. It is the spine the entire prototype hangs on: once it lands, plugging in a new role becomes a pure registration step (precheck + prompt + invoker), not a wiring exercise.

The scheduler is also where `spec.md` §6.1's central efficiency claim lands — "deterministic precheck so a 5-second tick burns no LLM tokens when there is no work." That property only exists if the scheduler enforces precheck-before-spawn. Building scheduling and precheck enforcement together (rather than retrofitting) is cheaper and keeps the loop honest.

## What Changes

- New in-process scheduler (`@keni/server/scheduler`) that ticks each enabled agent on its configured cadence, calls the role's deterministic precheck, and invokes `startCycle` only when precheck says proceed (`spec.md` §6.1, §6.2). When precheck skips, no subprocess is spawned and no activity-log entry is written — the cycle is a true no-op.
- Per-agent concurrency lock: a given agent never has two cycles running at once. Cross-agent parallelism is allowed (relevant in step 26 for multi-engineer).
- Per-role cadence pulled from `projectConfig.schedules` (already in `ProjectConfig.schedules`), with documented defaults: 60 s for `engineer` and `qa`, 5 s for `po` (`spec.md` §6.1). Cron-style strings parse to fixed-interval ms; non-cron-shaped strings (e.g., a literal `"5s"`) are accepted as a shorthand. Unknown / unparseable schedules fall back to the role default with a one-line warning.
- Per-role session-timeout config (`projectConfig.timeouts` — additive optional field) plumbed to the cycle's `terminationGraceMs` and to a scheduler-owned wall-clock deadline. Timed-out cycles abort the runtime via its `AbortSignal` and append a `session_timeout` activity entry stamped with the same `session_id` as the runtime's `session_end`.
- Interrupt API surface in the scheduler: `interrupt(agentId)` aborts the active cycle (if any) and appends a `session_interrupted` activity entry with the active `session_id`. Step 12 wires this to a REST endpoint; step 08 ships the method and an integration test that drives it directly.
- Pause/resume integration: every tick consults `agentRuntimeStateStore.read(agentId).paused` *before* calling precheck. A paused agent's tick is skipped silently (no activity-log entry, no precheck call). Pause flips taken mid-cycle are honoured starting on the next tick — an in-flight cycle is **not** aborted by `pause`. The interrupt API is the only way to abort an in-flight cycle from the UI.
- A pluggable `AgentRunnerRegistry` so step 09 (engineer), step 17 (PO), and any future role can register their `precheck`, `promptResolver`, `codingAgentInvoker`, `expectedPromptName`, and `envAllowlist` against the role they implement. The scheduler does not import any role-specific code; it only knows about the registry surface (`spec.md` §11#3 — role specifics live with the role).
- Self-rescheduling tick loop (one `setTimeout` per agent, recomputed after each tick) rather than a global `setInterval`, to keep cadence stable under tick drift and to make per-agent stop trivially clean (clear the timer, drop the runner). Documented in `design.md`.
- Scheduler lifecycle wired into `runServer`: `start()` is called after the bus and runtime-state store are constructed; `stop()` is called from the abort handler so server shutdown drains in-flight cycles via `AbortController.abort()` and resolves cleanly.
- No new runtime dependencies. The scheduler uses `setTimeout` / `clearTimeout`, `AbortController`, `crypto.randomUUID` for per-cycle id correlation, and the existing `LogSink` for warnings. No cron library is added; the prototype's "cron-like" strings are parsed by a small in-house helper that supports the documented subset.

### `agent.state_changed` clarification

Pause flips already emit `agent.state_changed` from the agents-API handler (step 05) and `session_start` / `session_end` already drive `status: "running" | "idle"` transitions via the activity-log handler (existing behaviour). The scheduler does **not** emit `agent.state_changed` directly. It contributes to the same channel by appending the right activity-log entries (`session_interrupted`, `session_timeout`) which the existing pipeline maps to `status: "idle"`. The implementation-plan bullet that mentions the scheduler "emitting `agent.state_changed`" is satisfied through this existing pipeline.

## Capabilities

### New Capabilities

- `scheduler`: the deterministic tick loop, precheck-before-spawn rule, per-agent concurrency invariant, pause-skip rule, interrupt + timeout behaviour, and the `AgentRunnerRegistry` plug-in surface.

### Modified Capabilities

- `orchestration-server`: `runServer` SHALL instantiate the scheduler at bootstrap and stop it on shutdown; the in-memory `AgentRuntimeStateStore`'s `paused` flag SHALL be consumed by the scheduler (an obligation that is declared inert in the current spec — step 05 explicitly defers it to step 08). Adds a small additive contract on the bootstrap composition. No other orchestration-server requirement changes.

## Impact

- **New code:** `packages/server/src/scheduler/{tick.ts, registry.ts, schedule.ts, timeout.ts, interrupt.ts}` plus contracts and tests.
- **Modified code:** `packages/server/src/runServer.ts` (instantiate scheduler at bootstrap, stop it on shutdown); `packages/server/src/createServer.ts` (extend `ServerDeps` with the scheduler instance for future route handlers in step 12); `packages/shared/src/storage/config/interface.ts` (additive optional `timeouts?` field on `ProjectConfig`, parsed by the scheduler — the scheduler capability spec, not the storage capability spec, governs its semantics).
- **No new dependencies.** Every primitive is a Deno built-in or an existing `@std/*` import.
- **Activity log:** two new event names — `session_interrupted` and `session_timeout` — appended by the scheduler. The activity-log storage layer already accepts arbitrary event names; the additions are documented in the scheduler capability and referenced in the orchestration-server capability's runtime-state decision table (existing spec already lists both as `→ idle`).
- **Downstream unblockers:** step 09 (engineer) registers `engineer` against the scheduler; step 12 (interrupt UI) adds a REST endpoint that calls `scheduler.interrupt(agentId)`; step 17 (PO) registers `po` against the scheduler.
- **Out of scope here:** the engineer's precheck content (step 09); the PO's mode-selecting precheck (step 17); event-driven triggers for engineer/QA (post-MVP); UI affordances for interrupt and pause (step 12); status auto-revert on interrupt/timeout (explicitly NOT done — `spec.md` §7.5).
