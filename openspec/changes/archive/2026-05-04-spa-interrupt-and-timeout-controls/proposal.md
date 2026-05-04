## Why

When an agent misbehaves the user today has only one tool — `Pause`, which lets the in-flight cycle finish (`scheduler` requirement: pause is a scheduling preference, not an abort verb). That gap means a runaway 30-minute engineer cycle has no escape hatch short of `Ctrl-C` on the orchestration server. Symmetrically, when the scheduler's per-role wall-clock timeout fires (`scheduler` requirement: 30 min engineer / 5 min PO defaults), the dashboard pretends nothing happened: the activity log carries the `session_timeout` entry, but the roster card stays in its last-seen `running` state until the runtime's `session_end` flips it back to `idle` with no visible explanation. This change closes both gaps with a single safety-valve UX: a per-agent **Interrupt** button on the roster (one click, confirm, abort), a small **terminal-event badge** on the card surfacing the most recent cycle outcome (`interrupted`, `timeout`, or `idle`), and distinctive rendering of `session_interrupted` / `session_timeout` rows in the activity log linked back to the ticket the agent was working on. The change also pins the hard rule the SPA must communicate explicitly: **the ticket's status is not auto-reverted on interrupt or timeout** (`spec.md` §7.5) — surfacing the event without lying about its consequences is the prototype's "no silent failures" guarantee.

## What Changes

- New REST endpoint `POST /agents/:id/interrupt` on the orchestration server, role-guarded to `user`, that wraps the existing `Scheduler.interrupt(agentId)` (already specced) and returns `{ data: AgentResponse, project_id }` with the post-call runtime state.
- New `apiClient.interruptAgent(id)` method on the SPA's typed transport client (the only place `fetch` is allowed for this endpoint).
- New **Interrupt** button on `<AgentRosterCard>` rendered when `status === "running"`, with a confirmation dialog (modal) explaining the abort + the explicit non-revert rule. Click → confirm → `apiClient.interruptAgent(id)`; rollback on `KeniApiError`.
- New **terminal-event badge** on `<AgentRosterCard>` reflecting the most recent terminal event for the current/last cycle (`interrupted`, `timeout`, or `idle`). Persists until the next `session_start` for that agent flips it back to none.
- Distinctive rendering of `session_interrupted` and `session_timeout` rows in `<ActivityLogView>` (a status-warning row style) plus a back-link to the ticket via `payload.refs.ticket` when present.
- Documentation: README's SPA subsection names interrupt as the abort verb (separate from pause), the badge's "until next cycle" persistence rule, and the explicit non-revert rule.
- Out of scope (deferred to MVP): `manual_override` flow (step 25), pause-everyone "big red button", auto-revert of ticket status.

## Capabilities

### New Capabilities
- `interrupt-and-timeout-ux`: Cross-cutting user-facing contract that pins the interrupt verb's semantics across server / SPA, the terminal-event badge's state machine, and the explicit "ticket status is not auto-reverted" UX rule. Lives separately from `scheduler` (server-internal abort mechanics) and `spa-agent-roster` (panel layout) so any future change to the safety-valve UX touches one spec.

### Modified Capabilities
- `orchestration-server`: Adds the `POST /agents/:id/interrupt` route (wraps `Scheduler.interrupt(agentId)`, role-guarded `user`, idempotent on no-active-cycle).
- `spa-shell`: Adds `interruptAgent(id)` to the documented `apiClient` interface so the roster card has a typed entry point.
- `spa-agent-roster`: Adds the **Interrupt** button (gated on `status === "running"`), the confirmation dialog (with the explicit non-revert copy), and the terminal-event badge on `<AgentRosterCard>`; documents the `agent.state_changed` and `activity.appended` flow that drives the badge.
- `spa-activity-log`: Adds the distinctive row rendering for `session_interrupted` and `session_timeout` and the ticket back-link rule.

## Impact

- Code:
  - `packages/server/src/api/agents/interrupt.ts` (new route handler) and registration in the existing agents router.
  - `packages/spa/src/transport/apiClient.ts` (new method).
  - `packages/spa/src/features/agentRoster/AgentRosterCard.tsx` (Interrupt button, badge, confirmation dialog), plus a co-located `ConfirmInterruptDialog.tsx` and `TerminalEventBadge.tsx` and matching `*_test.tsx`.
  - `packages/spa/src/features/activityLog/ActivityLogView.tsx` and `ActivityLogView.css` (terminal-event row rendering + ticket back-link).
- Wire shapes: No new `EventName` member; the `session_interrupted` and `session_timeout` activity events already exist (per the scheduler capability). The `agent.state_changed` frame already carries the new runtime state after the activity-event applier toggles `status` to `idle`.
- Dependencies: No new npm / jsr packages.
- Documentation: README's SPA subsection adds an "Interrupt and timeouts" paragraph naming the verb separation, the badge persistence rule, and the explicit non-revert rule.
- Tests: Three new component tests (button gating, confirm dialog, badge state machine), one extended activity-log test (terminal-event styling + back-link), one extended apiClient test (`interruptAgent` happy-path + error envelope), one new orchestration-server route test (happy / no-active-cycle / unknown / wrong-role).
