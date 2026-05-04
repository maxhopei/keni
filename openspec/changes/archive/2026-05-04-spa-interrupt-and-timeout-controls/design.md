## Context

The orchestration server already has both halves of the abort verb specced and implemented:

- **Scheduler** (`scheduler` capability): `Scheduler.interrupt(agentId)` exists, fires `active.abortController.abort("interrupt")`, and posts `session_interrupted` to `/activity` (with the documented headers). The wall-clock timeout is also already wired (`session_timeout`, configurable per role / agent).
- **Activity log + bus**: `session_interrupted` and `session_timeout` are members of the `EventName` union (per the orchestration server's `EventName` requirement); a successful `POST /activity` already calls `agentRuntimeStateStore.applyActivityEvent(entry)` and emits `agent.state_changed` when the entry's event flips `status` (the decision table in the runtime-state store includes `session_interrupted` and `session_timeout` → `status: "idle"`). The wire shapes do not need to grow.

What is missing is the seam between **the human dashboard** and the scheduler:

1. There is no REST surface a SPA can call to invoke `Scheduler.interrupt(agentId)`. The scheduler is in-process; the SPA cannot call it directly.
2. The `<AgentRosterCard>` shows `status` and `paused`, but pause is not the abort verb (per the `scheduler` requirement: "pause is a scheduling preference; interrupt is the abort verb"). Without an explicit Interrupt button, the user has no way to fire the verb.
3. When the scheduler fires a timeout (or the user fires an interrupt), the `agent.state_changed` frame flips the card from `running` to `idle` — but a user looking away for 10 seconds sees nothing different from a happy-path session end. The "no silent failures" guarantee in `spec.md` §7.5 needs a visible affordance on the card.
4. The non-revert rule (`spec.md` §7.5: "ticket status is NOT auto-reverted") is invisible to the user today. After an interrupt/timeout, a ticket can be left in `in_progress` with no agent working on it; the SPA must communicate this so the user knows to manually review.

This change wires the seam.

The change name and scope come from `initial-implementation-plan/12-spa-interrupt-and-timeout-controls.md`.

## Goals / Non-Goals

**Goals:**

- A user can abort a running cycle with a single click on the agent's roster card, after a confirmation that names the consequences (cycle aborted; ticket status NOT auto-reverted; manual review path).
- A user looking at the roster after a timeout / interrupt can see at a glance which terminal event ended the most recent cycle, without opening the activity log.
- A user reading the activity log sees `session_interrupted` and `session_timeout` rows distinctively (warning style, named cause), with a one-click navigation back to the ticket the agent was working on (when the activity entry's `refs.ticket` is present).
- The SPA's typed transport surface stays the only place `fetch` is called for orchestration endpoints; the new method follows the existing `KeniApiError`-on-non-2xx convention.
- The orchestration server's `POST /agents/:id/interrupt` route reuses the existing `Scheduler.interrupt(agentId)` contract verbatim (no scheduler-side change needed; this change is purely additive).

**Non-Goals:**

- Auto-revert of ticket status. Explicitly NOT done; the proposal pins this as the prototype's published behaviour.
- The MVP `manual_override` flow (step 25) — the confirmation dialog references it conceptually ("after interrupt, you can manually review and override the ticket's status") but does not link or implement it.
- A "pause everyone" / "stop the world" affordance. The user can pause individual agents (per the existing `spa-agent-roster` capability); a global pause is not in scope.
- A new event kind on the wire. Both `session_interrupted` and `session_timeout` already exist; this change consumes them.
- Streaming the per-cycle terminal event over the bus as a dedicated payload field on `agent.state_changed`. The badge derives its state from the existing `last_activity` field on `AgentResponse` (which reflects the latest `event` name applied by `applyActivityEvent`); no wire-shape change is needed.

## Decisions

### Decision 1 — `POST /agents/:id/interrupt` is the SPA's seam to the scheduler

The orchestration server SHALL expose `POST /agents/:id/interrupt` (role-guarded `user`, empty body, response shape `200 { data: AgentResponse, project_id }`) that invokes `scheduler.interrupt(id)` and returns the post-call `AgentRuntimeState` the same way `pause` / `resume` already do.

- The handler maps `Scheduler.interrupt`'s discriminated return:
  - `{ interrupted: true, sessionId }` → `200` with the post-call `AgentResponse` (the runtime state has been flipped to `status: "idle"` by the runtime's eventual `session_end`; the `session_interrupted` activity post the scheduler issues fires *during* the call, so the runtime-state store's `applyActivityEvent` path runs synchronously inside the same server process before the response returns — `last_activity` will already be `session_interrupted` in the response body).
  - `{ interrupted: false, reason: "no_active_cycle" }` → `200` (idempotent — there's nothing to interrupt; the request is treated as a no-op success). The body's `data.status` is `"idle"`. This matches the pause/resume idempotency convention.
  - `{ interrupted: false, reason: "unknown_agent" }` → `404 store_not_found`.
- A non-`user` `X-Keni-Role` returns `403 role_not_owner`, matching pause/resume.
- The handler emits no additional bus frame of its own; the `session_interrupted` activity post (issued by the scheduler) already produces both `activity.appended` and `agent.state_changed`. **No double emission.**

**Alternatives considered:** A `DELETE /agents/:id/active-cycle` REST verb. Rejected — the spec consistently uses `POST /agents/:id/<verb>` for state mutations (pause, resume); a verb name is more descriptive than a resource model that doesn't really exist client-side.

### Decision 2 — `interrupted: false, reason: "no_active_cycle"` is a 200 success, not a 409

This is a UX safety net: a user clicks Interrupt; in the milliseconds before the request lands, the cycle naturally ends. We do not want to surface this as an error in the UI. The response body still carries the canonical `AgentResponse`, so the client's optimistic state self-corrects via the standard `pauseAgent`/`resumeAgent` reconciliation path.

**Alternatives considered:** `409 stale_state` for "no active cycle". Rejected — semantically there is no conflict; the desired post-condition (no active cycle for this agent) is already met. Returning 200 keeps the client code simple.

### Decision 3 — The Interrupt button is only rendered when `status === "running"`

When the agent is `idle`, there is nothing to interrupt; rendering a disabled button adds noise. The button appears only on a `running` card. Pause/resume continue to render unconditionally.

**Alternatives considered:** Always render, disabled when idle. Rejected — the visual noise on a roster of 5+ idle agents is significant; the button is a destructive action and should be visible only when relevant.

### Decision 4 — A confirmation modal stands between the click and the network call

The button click opens a modal dialog (an in-DOM `<dialog>` element with `role="dialog"`, `aria-modal="true"`, focus trap on the confirm button). The dialog text:

> Interrupt **&lt;agent-id&gt;**?
>
> The current cycle's subprocess will be aborted (SIGTERM, then SIGKILL after a grace period). The ticket's status **is not changed** — you may want to review it manually after the agent stops.
>
> [Cancel] [Interrupt]

The destructive button (`Interrupt`) is styled with the warning palette (`var(--keni-color-warning)` — added to the design tokens by this change). Pressing `Esc` or clicking `Cancel` closes the modal without firing the request. Pressing `Enter` while focus is on `Interrupt` fires the request.

**Alternatives considered:** A toast-confirm pattern ("undo within 5s"). Rejected — interrupt is irreversible (the subprocess will already be terminated by the time the toast appears); a pre-action confirmation is the right shape.

### Decision 5 — The terminal-event badge is derived from `agent.last_activity`, not a separate runtime field

The badge reads the existing `AgentResponse.last_activity` field (already populated by the runtime-state store's `applyActivityEvent`). The badge SHALL render:

- `last_activity === "session_interrupted"` → red "Interrupted" badge.
- `last_activity === "session_timeout"` → amber "Timed out" badge.
- `last_activity === "idle"` → grey "Idle (no work)" badge.
- `last_activity === "session_start"` (a new cycle has begun) → no badge (the running indicator + spinner is the affordance).
- `last_activity === "session_end"` → no badge (a successful completion needs no warning).
- Any other value (or `null`) → no badge.

Persistence rule: the badge stays visible until the next `session_start` for that agent, which flips `last_activity` to `session_start` and clears the badge per the rule above. This satisfies the source-plan's "until next cycle starts" decision verbatim. **No client-side timer, no localStorage, no separate runtime-state field.** A re-render driven by `agent.state_changed` (which flips `last_activity`) is the only mechanism.

**Alternatives considered:**

- *Add `last_terminal_event: TerminalEventName | null` to `AgentRuntimeState`.* Rejected — `last_activity` already carries this signal; adding a parallel field is denormalisation that drifts.
- *Persist the badge until the user dismisses it.* Rejected — the source plan calls out "until next cycle starts" as closer to the spec's "a human reviews if something looks stuck"; manual dismissal is more state for the user to track.

### Decision 6 — Activity-log row styling is a CSS variant keyed on `entry.event`

`<ActivityLogView>` already renders rows with the entry's `event` rendered as a bold label. This change adds CSS classes `keni-activity-row--terminal-interrupted` and `keni-activity-row--terminal-timeout` on the row's container element when `event === "session_interrupted"` or `event === "session_timeout"` respectively. The styling palette is the same warning / danger tokens introduced by Decision 4.

The ticket back-link is rendered through the existing `<ActivityRefs>` helper (per the `spa-activity-log` capability) — `refs.ticket` already produces a `<Link to="/tickets/...">`. The change adds, on terminal-event rows, a small explanatory line ("Ticket status was not auto-reverted") below the row's standard content, when `refs.ticket` is present. This is a static caption — no new component, no new test fixture beyond a couple of cases.

### Decision 7 — No new `EventName` member; no new payload field on `agent.state_changed`

This change is intentionally additive only on the *route* and *UI* layers. The existing `EventName` union already includes `session_interrupted`, `session_timeout`, and `agent.state_changed`. The existing payload of `agent.state_changed` (`{ agent_id, paused, status }`) is sufficient because the badge derives from `last_activity`, which the SPA refetches via `apiClient.listAgents()` on the existing `activity.appended` debounce path (per the `spa-agent-roster` requirement). The roster card already re-renders on a `last_activity` change.

**Alternatives considered:** Add a `last_terminal_event` field to `agent.state_changed`'s payload. Rejected — every "what just happened" signal we already need is in the activity log; the `agent.state_changed` frame is the lightweight running/paused signal that should not grow.

### Decision 8 — Optimistic UI on Interrupt is *not* the right pattern; show a brief inline progress

Unlike pause/resume (which optimistically flip the local `paused` flag because the answer is binary and recoverable), interrupt is a destructive, slow-ish operation (SIGTERM → grace → SIGKILL → activity post → `applyActivityEvent` → `agent.state_changed` frame). The card SHALL:

1. On confirm-click, close the modal and disable the Interrupt button (rendered with `aria-busy="true"` and the label "Interrupting…").
2. Wait for `apiClient.interruptAgent(id)` to resolve.
3. On success, re-enable the card's affordances (the response body's `AgentResponse.status` will already be `idle`, and the badge will have updated via the standard `agent.state_changed` flow).
4. On `KeniApiError`, render the existing `data-testid="card-error"` element with the error's `code` (same surface used by pause/resume's rollback path); the button re-enables.

There is no optimistic flip of `status` — the card waits for the canonical state.

**Alternatives considered:** Optimistically set `status: "idle"` immediately on click. Rejected — until the scheduler actually aborts, the cycle is still running; lying to the user about the post-state is a worse failure mode than waiting 200–800 ms for the canonical answer.

### Decision 9 — A `--keni-color-warning` design token is added; no new color libraries

`packages/spa/src/theme/tokens.css` already declares the documented `--keni-*` palette (per `spa-shell`'s "Design tokens" requirement). This change adds two tokens: `--keni-color-warning` (used for the timeout badge and the row variant) and `--keni-color-danger` (used for the interrupt badge, the modal's destructive button, and the row variant). Both tokens are added to both the `:root` and the `@media (prefers-color-scheme: dark) :root` blocks, matching the existing convention.

**Alternatives considered:** Reuse `--keni-color-status-running` (red-orange) for warning. Rejected — overloading a status-meaning token with a warning-meaning token is a future maintenance bug.

## Risks / Trade-offs

- **[Risk] The SPA shows a stale terminal-event badge if the user opens the page mid-restart of the orchestration server (the in-memory runtime state is lost and `last_activity` resets to `null`).** → Mitigation: the existing reconnect-tier behaviour (refetch via `listAgents()` on `connected` lifecycle, per `spa-agent-roster`) brings the SPA back to canonical state. A briefly-empty badge after a server bounce is acceptable for the prototype.
- **[Risk] A user clicks Interrupt and the orchestration server is unreachable; the modal closes but no abort fires.** → Mitigation: the `KeniApiError` surfaces in `data-testid="card-error"` with the typed `code` (`internal_error` for network failures); the user can retry. Already the pattern for pause/resume.
- **[Risk] The "Ticket status was not auto-reverted" caption is rendered on every terminal-event row, possibly duplicating noise when a single ticket has back-to-back interruptions.** → Mitigation: the caption is small (`<small>` style) and is only rendered when `refs.ticket` is present. A future change can collapse adjacent terminal-event rows into a single grouped affordance; out of scope here.
- **[Trade-off] The badge has only three states (`Interrupted`, `Timed out`, `Idle (no work)`). A spawn-failed cycle (`session_end` with `refs.spawn_failed: true`) is not surfaced as a distinctive badge.** → Acceptable: spawn-failed is a setup/config issue rather than a runtime safety-valve concern; the activity log already differentiates it. A future change can extend the badge state machine if operators report it as a usability gap.
- **[Trade-off] The confirmation modal blocks the click until dismissed.** → Acceptable: interrupt is destructive enough to warrant the friction; the source plan explicitly calls for a confirmation dialog.

## Migration Plan

This change is purely additive: a new REST route, a new `apiClient` method, new UI elements on the roster card, an extended row variant in the activity log, and two new design tokens. Existing endpoints, wire shapes, and tests are unchanged. There is no database / on-disk schema migration.

Rollout:

1. Land the orchestration-server route + test (server is independently deployable).
2. Land the SPA changes — clients without the new server route would 404, so the `apiClient.interruptAgent` test asserts the `KeniApiError({ status: 404, code: "store_not_found" })` path is gracefully surfaced. After the server lands, the SPA's tests against the in-memory `apiClient` exercise the happy path.
3. README updates document the new behaviour and the explicit non-revert rule.

Rollback: revert the route handler + UI; no on-disk artefact remains.

## Open Questions

- **Confirmation copy.** The exact wording of the modal and the "ticket status was not auto-reverted" caption is encoded in the spec deltas. The wording is intentionally plain-English; if a future copy review surfaces a clearer phrasing, that lands as a small follow-up change.
- **Keyboard shortcut.** Should `Cmd+.` (the `Esc` cousin) trigger Interrupt on the focused card? Deferred — every keyboard shortcut is a discoverability + accessibility cost; a button is enough for the prototype.
- **Tracking the interrupt actor.** The interrupt is currently anonymous (the `X-Keni-Role: user` header is the only identity). When the SPA grows multi-user support (post-MVP), the activity-log entry for `session_interrupted` will need an `interrupted_by` ref. Out of scope here.
