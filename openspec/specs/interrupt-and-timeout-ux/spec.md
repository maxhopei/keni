# interrupt-and-timeout-ux Specification

## Purpose
TBD - created by archiving change spa-interrupt-and-timeout-controls. Update Purpose after archive.
## Requirements
### Requirement: `Interrupt` is the user-facing abort verb; `Pause` is a scheduling preference

The dashboard SHALL surface two distinct verbs against an agent: `Pause` / `Resume` (the existing pre-cycle scheduling flag, per `spa-agent-roster`) and `Interrupt` (the new mid-cycle abort introduced by this capability). The capability SHALL document — in this spec, in the SPA's roster card UX, and in the README's "Run the SPA" subsection — that:

- `Pause` skips the **next** scheduled tick; an in-flight cycle continues to completion. The button label is `Pause` / `Resume`.
- `Interrupt` aborts the **current** in-flight cycle by firing the runtime's `AbortSignal` (which the scheduler propagates to the subprocess via SIGTERM, then SIGKILL after the configured grace period). The button label is `Interrupt`.
- The two verbs SHALL be visually distinguishable on the roster card: `Pause` / `Resume` is rendered with the neutral palette, while `Interrupt` is rendered with `var(--keni-color-danger)`.
- The SPA SHALL NOT collapse the two affordances into a single toggle; `Interrupt` is the dedicated safety-valve verb and SHALL have its own button.

#### Scenario: A `running` agent's card renders both verbs side by side

- **WHEN** the roster contains one agent with `status: "running"` and `paused: false`
- **THEN** the rendered card contains exactly one button labelled `Pause` and exactly one button labelled `Interrupt`
- **AND** the two buttons are siblings under a single action region inside the card

#### Scenario: An `idle` agent's card renders only the `Pause` verb

- **WHEN** the roster contains one agent with `status: "idle"` and `paused: false`
- **THEN** the rendered card contains exactly one button labelled `Pause`
- **AND** no button labelled `Interrupt` is in the rendered tree (Interrupt is gated on `status === "running"`)

#### Scenario: README documents the verb separation

- **WHEN** the root `README.md`'s "Run the SPA" subsection is read
- **THEN** the documentation explicitly names `Pause` as a scheduling preference (skips the next tick) and `Interrupt` as the abort verb (aborts the current cycle)
- **AND** the documentation names that the two verbs are not interchangeable

### Requirement: Interrupt SHALL be confirmed before the network call; the confirmation dialog names the non-revert rule

The Interrupt button click SHALL open a confirmation dialog before any `apiClient.interruptAgent(...)` call is issued. The dialog SHALL:

- Render as an in-DOM `<dialog>` element with `role="dialog"` and `aria-modal="true"` (or a functionally equivalent React-rendered modal that matches these accessibility attributes).
- Initial focus SHALL land on the destructive `Interrupt` button (so a confident user can `Enter` through it) — but `Esc` and clicking outside the modal SHALL close it without firing.
- Carry a heading `Interrupt <agent-id>?` (where `<agent-id>` is the literal agent id, monospace).
- Carry a body paragraph explaining the consequences in plain English, naming both the SIGTERM-then-SIGKILL termination path and the explicit non-revert rule. The body SHALL include the literal substring `is not changed` (or `is not reverted`) referring to the ticket's status.
- Render two action buttons: `Cancel` (secondary palette) and `Interrupt` (danger palette).
- Pressing `Cancel`, pressing `Esc`, or clicking outside the dialog SHALL close the dialog without firing `apiClient.interruptAgent(...)`.
- Pressing `Interrupt` SHALL close the dialog and fire `apiClient.interruptAgent(<agent-id>)`.

#### Scenario: The dialog opens with the documented heading and copy

- **WHEN** the user clicks `Interrupt` on `alice`'s running card
- **THEN** the rendered tree contains exactly one element with `role="dialog"` and `aria-modal="true"`
- **AND** the dialog's heading text contains `Interrupt alice?`
- **AND** the dialog's body text contains the substring `is not changed` (or `is not reverted`) qualifying the ticket's status
- **AND** the dialog renders one button labelled `Cancel` and one button labelled `Interrupt`
- **AND** focus is on the `Interrupt` button

#### Scenario: Cancel closes the dialog without firing the network call

- **WHEN** the dialog is open
- **AND** the user clicks `Cancel`
- **THEN** the dialog is removed from the rendered tree
- **AND** `apiClient.interruptAgent` was not called
- **AND** focus returns to the `Interrupt` button on the card

#### Scenario: Esc closes the dialog without firing the network call

- **WHEN** the dialog is open
- **AND** the user presses `Esc`
- **THEN** the dialog is removed from the rendered tree
- **AND** `apiClient.interruptAgent` was not called

#### Scenario: Confirming fires `apiClient.interruptAgent`

- **WHEN** the dialog is open and `apiClient.interruptAgent` is instrumented
- **AND** the user clicks `Interrupt`
- **THEN** the dialog is removed from the rendered tree
- **AND** `apiClient.interruptAgent("alice")` was called exactly once

### Requirement: The terminal-event badge surfaces the most recent cycle outcome on the roster card

Every `<AgentRosterCard>` SHALL render at most one **terminal-event badge** derived from the agent's `last_activity` field (per `AgentResponse`, kept current by the orchestration server's runtime-state store via `applyActivityEvent`). The mapping SHALL be:

- `last_activity === "session_interrupted"` → red badge with text `Interrupted` (CSS class `keni-terminal-badge--interrupted`).
- `last_activity === "session_timeout"` → amber badge with text `Timed out` (CSS class `keni-terminal-badge--timeout`).
- `last_activity === "idle"` → neutral badge with text `Idle (no work)` (CSS class `keni-terminal-badge--idle`).
- Any other value (including `null`, `"session_start"`, `"session_end"`, `"subprocess_stdout"`, `"subprocess_stderr"`, `"subprocess_output_truncated"`) → no badge rendered.

The badge SHALL persist as long as `last_activity` retains a badge-rendering value; the next `session_start` for the agent (which flips `last_activity` to `"session_start"`) SHALL clear the badge. The badge SHALL NOT be dismissible client-side; it SHALL NOT have a separate runtime field; it SHALL NOT be persisted to localStorage.

#### Scenario: A `session_interrupted` last-activity renders the red Interrupted badge

- **WHEN** an `<AgentRosterCard>` is rendered with `agent.last_activity === "session_interrupted"`
- **THEN** the rendered card contains exactly one element with class `keni-terminal-badge--interrupted` and text `Interrupted`
- **AND** no element with class `keni-terminal-badge--timeout` or `keni-terminal-badge--idle` is rendered

#### Scenario: A `session_timeout` last-activity renders the amber Timed out badge

- **WHEN** the card is rendered with `agent.last_activity === "session_timeout"`
- **THEN** the rendered card contains exactly one element with class `keni-terminal-badge--timeout` and text `Timed out`

#### Scenario: An `idle` last-activity renders the neutral Idle (no work) badge

- **WHEN** the card is rendered with `agent.last_activity === "idle"`
- **THEN** the rendered card contains exactly one element with class `keni-terminal-badge--idle` and text `Idle (no work)`

#### Scenario: A `session_start` last-activity clears the badge

- **WHEN** the card is rendered with `agent.last_activity === "session_interrupted"` and the badge is visible
- **AND** an `agent.state_changed` frame followed by an `activity.appended` frame trigger a `listAgents()` refetch resolving with the same agent now carrying `last_activity === "session_start"`
- **THEN** no element with any `keni-terminal-badge--*` class is rendered for that card

#### Scenario: A `null` last-activity renders no badge

- **WHEN** the card is rendered with `agent.last_activity === null`
- **THEN** no element with any `keni-terminal-badge--*` class is rendered for that card

#### Scenario: A `session_end` last-activity renders no badge

- **WHEN** the card is rendered with `agent.last_activity === "session_end"`
- **THEN** no element with any `keni-terminal-badge--*` class is rendered for that card

### Requirement: The dashboard SHALL communicate the explicit non-revert rule on every terminal-event surface

When the SPA renders a terminal-event signal (the badge on the roster card, a `session_interrupted` / `session_timeout` row in the activity log), the rendering SHALL communicate that the ticket's status was not auto-reverted:

- **In the confirmation dialog (before interrupt fires):** the dialog body text SHALL include the substring `is not changed` (or `is not reverted`) qualifying the ticket's status.
- **In the activity log (after the event has happened):** terminal-event rows whose `entry.refs.ticket` is non-empty SHALL render an inline caption (an `<small>` or equivalent micro-text element with class `keni-activity-row__non-revert-note`) containing the literal text `Ticket status was not auto-reverted.`. When `entry.refs.ticket` is absent, the caption SHALL NOT be rendered (there is no ticket to refer to).
- **In the badge:** the badge itself does not need to repeat the rule — its existence next to the card's existing ticket affordance is the affordance — but a `title` (tooltip) attribute on the badge SHALL include the substring `ticket status not auto-reverted` for accessibility.

#### Scenario: The activity log's terminal-event row carries the non-revert caption when a ticket is referenced

- **WHEN** `<ActivityLogView />` renders an `ActivityEntryResponse` with `event === "session_interrupted"` and `refs: { ticket: "ticket-0001" }`
- **THEN** the rendered row contains a `<Link to="/tickets/ticket-0001">` (per `spa-activity-log`'s `<ActivityRefs>` requirement)
- **AND** the rendered row contains a sibling element with class `keni-activity-row__non-revert-note` whose text is `Ticket status was not auto-reverted.`

#### Scenario: A terminal-event row without a ticket ref does not render the caption

- **WHEN** the activity-log row's `entry.event === "session_timeout"` and `entry.refs` does not contain a `ticket` key
- **THEN** no element with class `keni-activity-row__non-revert-note` is rendered for that row

#### Scenario: The badge's tooltip names the non-revert rule

- **WHEN** an `<AgentRosterCard>` renders an interrupted or timeout terminal-event badge
- **THEN** the badge element's `title` attribute is a non-empty string containing the substring `ticket status not auto-reverted`

### Requirement: A subscriber error in any handler SHALL NOT prevent the activity-log row's terminal-event styling

The SPA's terminal-event row styling SHALL be a pure function of the rendered `ActivityEntryResponse.event`; it SHALL NOT depend on any side effect (no subscriber, no global flag). The CSS classes `keni-activity-row--terminal-interrupted` and `keni-activity-row--terminal-timeout` SHALL be applied at render time based on `entry.event`. A bug in any unrelated subscriber, lifecycle handler, or other component SHALL NOT cause the terminal-event styling to disappear.

#### Scenario: A throwing unrelated subscriber does not strip the row's CSS classes

- **WHEN** `<ActivityLogView />` is mounted with an `eventsClient` whose subscribers include one that throws on every frame
- **AND** the `apiClient.listActivity({})` resolution contains one entry with `event === "session_interrupted"`
- **THEN** the rendered row carries the class `keni-activity-row--terminal-interrupted`
- **AND** the test's captured `console.warn` may contain a subscriber-failure log line, but the rendered DOM is unaffected

### Requirement: Capability documentation pins the verb invariants and references the upstream specs

This capability SHALL document, in this spec file, that:

- (a) The user-facing **Interrupt** verb is implemented by a single REST endpoint, `POST /agents/:id/interrupt`, owned by the `orchestration-server` capability — the SPA does not interact with the scheduler directly.
- (b) The orchestration server's interrupt route delegates to `Scheduler.interrupt(agentId)` (specced in the `scheduler` capability) — the route SHALL NOT introduce new abort logic.
- (c) The `session_interrupted` / `session_timeout` activity-log events are emitted by the `scheduler` capability (already specced), not by this capability — this capability is a *consumer* of those events.
- (d) The `AgentResponse.last_activity` field is the single source of truth for the badge's state — there is no parallel runtime field for terminal events.
- (e) The "ticket status is not auto-reverted" rule is `spec.md` §7.5; this capability is the SPA-side enactment, not the rule's source of authority.

Any future change that adds a third terminal-event kind, alters the badge's persistence rule, introduces a new `Interrupt`-shaped verb, or relaxes the confirmation-before-fire rule SHALL land as a delta against this capability.

#### Scenario: Documentation names the cross-capability boundaries

- **WHEN** this spec file is read
- **THEN** the Purpose / Requirements explicitly name (a)-(e) above (the route owner, the abort delegate, the activity-event emitter, the badge's source of truth, and the spec.md §7.5 reference)

