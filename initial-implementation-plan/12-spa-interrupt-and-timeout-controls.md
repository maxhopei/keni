# Step 12 — spa-interrupt-and-timeout-controls

**Phase:** Prototype
**Suggested change name:** `spa-interrupt-and-timeout-controls`
**Depends on:** 05, 10

## Goal

Give the user an interrupt button per agent, surface session timeouts visibly, and make the rule "ticket status is **not** auto-reverted" obvious in the UI. After this step, when an agent is misbehaving the user has a single click to stop it; when a timeout fires the dashboard shows it instead of pretending nothing happened.

## Scope

- Server-side interrupt endpoint: `POST /agents/:id/interrupt` — sends SIGTERM via the scheduler (step 08), waits the grace period, SIGKILL if still alive. Records `session_interrupted` in the activity log.
- The scheduler's existing per-role timeout (step 08) emits `session_timeout` events. This step ensures those events flow through `agent.state_changed` so the SPA reacts.
- SPA affordances:
  - On the agent roster card (step 10), an "Interrupt" button appears when the agent is `running`. Click → confirmation dialog → calls the interrupt endpoint.
  - A small badge on the card surfaces the most recent terminal event for the current/last cycle: `interrupted`, `timeout`, or `idle`. Persists until the next cycle starts.
  - Activity log view (step 11) renders `session_interrupted` and `session_timeout` events with distinctive styling and link back to the ticket the agent was working on.
- UX copy clarifies that the ticket status was **not** auto-reverted (per §7.5). Suggests a manual review path; the actual override flow (step 25, MVP) is referenced but not built here.

## Out of scope

- Auto-revert of ticket status — explicitly NOT done.
- `manual_override` flow — step 25 (MVP).
- Cancellation of the entire scheduler / "pause everyone" big-red-button — handled by per-agent pause from step 05; consider only if §10 grows a dedicated UX.

## Spec references

- §6.1 — Pause/resume context (this step's interrupt is a stronger action than pause).
- §7.5 — Interrupt and timeouts: SIGTERM → grace → SIGKILL; events recorded; ticket status not auto-reverted.

## Open decisions for the proposer

- **Confirmation copy.** The interrupt is destructive enough to warrant a confirmation. Pick the wording.
- **Badge persistence.** Until the next cycle starts? Until the user dismisses it? "Until next cycle" is closer to spec ("a human reviews if something looks stuck"). Document.

## Notes for /opsx:propose

- `proposal.md` should describe interrupt as a safety valve and the timeout surface as a "no silent failures" guarantee.
- `design.md` should pin the interrupt endpoint contract, the badge state machine on the roster card, the activity log rendering of these events, and the explicit non-revert rule.
- `tasks.md` should cover: interrupt endpoint, scheduler hook for the interrupt path, SPA interrupt button + confirmation, badge component, activity log rendering tweaks, e2e test of interrupt flow.
- A capability spec for `interrupt-and-timeout-ux` documents the contract.
