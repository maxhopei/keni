# Step 08 — cron-scheduler-with-pause

**Phase:** Prototype
**Suggested change name:** `cron-scheduler-with-pause`
**Depends on:** 05, 07

## Goal

Drive role runtimes on a tick. Per-role cadence comes from config; the scheduler skips paused agents, runs each role's precheck before invoking, and enforces interrupt + per-role timeout signals. After this step, the engineer (step 09) and the PO (step 17) just plug into the scheduler.

## Scope

- Tick loop with a configurable cadence per role. Defaults from `spec.md`: every minute for engineers and QA, every 5 seconds for the PO (§6.1).
- For each enabled (non-paused) agent on each tick:
  - Read `paused` from the agents API/store (step 05).
  - Call the role's precheck (provided by the role runtime from step 07). If precheck says no work, idle the cycle (no subprocess, no tokens spent — §6.2 deterministic precheck).
  - Otherwise, invoke `RoleRuntime.startCycle(...)`.
- Interrupt path: a UI/API request (wired by step 12) sends SIGTERM to the active subprocess, waits a short grace period, then SIGKILL if still alive. Records `session_interrupted` (§7.5).
- Timeout path: per-role session timeout (default tens of minutes, configurable). Same termination procedure; records `session_timeout`.
- Concurrency safety: a given agent never has two cycles running at once. Cross-agent parallelism is allowed (relevant in step 26 for multi-engineer).
- Emits `agent.state_changed` events (idle / running / interrupted / timeout) so the SPA reflects state live.

## Out of scope

- The PO's 5-second tick + mode selection — wired in step 17 (the precheck function from the PO runtime is what does mode selection).
- Event-driven triggers for engineer/QA roles (post-MVP; chat is the only event-driven path in MVP, owned by step 19).
- Status auto-revert on interrupt/timeout — explicitly NOT done; ticket state reflects whatever the agent last committed (§7.5).
- UI for interrupt/timeout — step 12.

## Spec references

- §6.1 — Scheduler cadence, pause/resume, deterministic precheck, "chat is event-driven, not scheduled."
- §6.2 — Precheck contract; runtime never decides which ticket; one concern per session.
- §7.5 — Interrupt and timeout behaviour, no auto-revert.
- §11#7 — One ticket per session; reinforced by the scheduler not stacking cycles.

## Open decisions for the proposer

- **Tick implementation.** A simple `setInterval`-style loop is enough; if Node's timer drift is problematic, swap for a self-rescheduling loop. Document.
- **Where `paused` is sourced.** Could be in-memory in the agents service (step 05) or persisted. Decide and align with step 05's choice.
- **Per-role timeout configuration.** Add to `project.yaml` and/or global `config.yaml` per step 03's layered model.

## Notes for /opsx:propose

- `proposal.md` should explain the scheduler as the deterministic layer that turns role runtimes into a running team.
- `design.md` should pin: tick algorithm, precheck contract, pause check, interrupt and timeout signal flow, agent-state event emission, concurrency invariants.
- `tasks.md` should cover: tick loop implementation, precheck invocation, pause integration, interrupt API (server-side), timeout enforcement, event emission, tests with fake role runtimes proving cadence and precheck behaviour.
- Capability spec for `scheduler` documents the cadence and lifecycle contract.
