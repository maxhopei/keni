## ADDED Requirements

### Requirement: Activity-log rows for `session_interrupted` and `session_timeout` carry a distinctive CSS variant

Each rendered activity-log row SHALL apply a terminal-event CSS class on its container element when the row's `entry.event` matches one of the documented terminal-event names:

- `entry.event === "session_interrupted"` → the row's container element SHALL carry the class `keni-activity-row--terminal-interrupted` (in addition to whatever base class the row already carries). The styling SHALL use `var(--keni-color-danger)` for an emphasised left border or row tint.
- `entry.event === "session_timeout"` → the row's container element SHALL carry the class `keni-activity-row--terminal-timeout`. The styling SHALL use `var(--keni-color-warning)` for an emphasised left border or row tint.
- Any other `entry.event` → no `keni-activity-row--terminal-*` class SHALL be applied.

The class SHALL be applied at render time as a pure function of `entry.event`. The row SHALL NOT depend on any side effect, subscriber, or global flag for its terminal-event styling. The row's existing field rendering (`timestamp`, `agent`, `role`, `event`, `summary`, `<ActivityRefs>`) SHALL be preserved verbatim — the terminal-event variant adds a class, not a different layout.

#### Scenario: A `session_interrupted` row carries the `--terminal-interrupted` class

- **WHEN** `<ActivityLogView />` renders an `ActivityEntryResponse` with `event === "session_interrupted"`, `agent: "alice"`, `role: "engineer"`, `summary: null`, `refs: { reason: "interrupt" }`
- **THEN** the rendered row's container element carries the class `keni-activity-row--terminal-interrupted`
- **AND** the same row continues to render `alice`, `engineer`, `session_interrupted` per the standard row shape

#### Scenario: A `session_timeout` row carries the `--terminal-timeout` class

- **WHEN** the rendered entry's `event === "session_timeout"`
- **THEN** the rendered row's container element carries the class `keni-activity-row--terminal-timeout`

#### Scenario: A non-terminal-event row does not carry any terminal-event class

- **WHEN** the rendered entry's `event === "session_start"` (or any non-terminal-event value)
- **THEN** the rendered row's container element does not carry `keni-activity-row--terminal-interrupted` or `keni-activity-row--terminal-timeout`

### Requirement: Terminal-event rows render the ticket back-link via `<ActivityRefs>` and carry the explicit non-revert caption

When a terminal-event row's `entry.refs` contains a `ticket` key, the row SHALL: (1) render the existing `<ActivityRefs>`-driven `<Link to="/tickets/<value>">` (already required by the existing `spa-activity-log` requirement); (2) additionally render an inline caption — a small text element with class `keni-activity-row__non-revert-note` whose visible text is exactly `Ticket status was not auto-reverted.`. The caption SHALL be a sibling of the row's standard content (rendered as the row's last child) so it visually anchors below the ticket link.

When the row's `entry.refs` does NOT contain a `ticket` key, the caption SHALL NOT be rendered. The non-revert rule applies only to ticket-bound work; an activity entry without a ticket reference has no ticket to caption.

The caption SHALL only be rendered for terminal-event rows (`session_interrupted` and `session_timeout`). The caption SHALL NOT be rendered for non-terminal-event rows even when those rows reference a ticket.

#### Scenario: A `session_interrupted` row with a ticket ref renders both the link and the caption

- **WHEN** the rendered entry is `{ event: "session_interrupted", refs: { ticket: "ticket-0001", reason: "interrupt" }, ... }`
- **THEN** the rendered row contains a `<Link to="/tickets/ticket-0001">` (per the existing `<ActivityRefs>` requirement)
- **AND** the rendered row also contains an element with class `keni-activity-row__non-revert-note` whose text is `Ticket status was not auto-reverted.`

#### Scenario: A `session_timeout` row with a ticket ref renders both the link and the caption

- **WHEN** the rendered entry is `{ event: "session_timeout", refs: { ticket: "ticket-0042", reason: "timeout" }, ... }`
- **THEN** the rendered row contains a `<Link to="/tickets/ticket-0042">` and one element with class `keni-activity-row__non-revert-note` whose text is `Ticket status was not auto-reverted.`

#### Scenario: A terminal-event row without a ticket ref does NOT render the caption

- **WHEN** the rendered entry is `{ event: "session_interrupted", refs: { reason: "interrupt" }, ... }` (no `ticket` key)
- **THEN** the rendered row carries the `keni-activity-row--terminal-interrupted` class
- **AND** no element with class `keni-activity-row__non-revert-note` is rendered for that row

#### Scenario: A non-terminal-event row with a ticket ref does NOT render the caption

- **WHEN** the rendered entry is `{ event: "session_start", refs: { ticket: "ticket-0001" }, ... }`
- **THEN** the rendered row contains the standard `<Link to="/tickets/ticket-0001">`
- **AND** no element with class `keni-activity-row__non-revert-note` is rendered (the caption is gated on terminal-event rows)

### Requirement: The component test file covers the terminal-event variant and the non-revert caption

`packages/spa/src/features/activityLog/ActivityLogView_test.tsx` SHALL contain additional `Deno.test` cases that, at minimum, assert: (1) a `session_interrupted` row carries the class `keni-activity-row--terminal-interrupted` and (when its refs include a `ticket`) the non-revert caption; (2) a `session_timeout` row carries the class `keni-activity-row--terminal-timeout` and (when its refs include a `ticket`) the non-revert caption; (3) a terminal-event row without a `ticket` ref does NOT render the caption; (4) a non-terminal-event row (e.g., `session_start`) does NOT render any terminal-event class or caption regardless of its refs.

#### Scenario: The four new test cases are present and pass

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** `packages/spa/src/features/activityLog/ActivityLogView_test.tsx` contains and passes test cases covering the four documented assertions above
