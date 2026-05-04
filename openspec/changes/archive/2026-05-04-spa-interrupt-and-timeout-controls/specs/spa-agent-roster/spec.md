## ADDED Requirements

### Requirement: A `running` agent's card renders an Interrupt button alongside Pause / Resume

Every `<AgentRosterCard>` whose `agent.status === "running"` SHALL render exactly one additional `<button type="button">` whose visible label is `Interrupt` (or whose `aria-label` is `Interrupt` if the visible content is iconographic — but the prototype SHALL use the visible text). The button SHALL be a sibling of the existing pause/resume toggle inside the card's action region. The button SHALL be styled with `var(--keni-color-danger)` so its destructive intent is visually obvious. When `agent.status === "idle"`, the Interrupt button SHALL NOT be rendered (the affordance is gated on the running state, not merely visually disabled). The button SHALL be a real `<button type="button">` (not a `<div>` with a click handler) and SHALL be keyboard-activatable via `Enter` and `Space`.

#### Scenario: A running agent's card renders the Interrupt button

- **WHEN** `<AgentRosterCard agent={{ id: "alice", role: "engineer", status: "running", last_activity: "session_start", last_active_at: "2026-05-04T07:00:00Z", paused: false }} />` is rendered
- **THEN** the rendered tree contains exactly one `<button type="button">` whose accessible name is `Interrupt`
- **AND** the rendered tree also contains exactly one `<button type="button">` whose accessible name is `Pause`

#### Scenario: An idle agent's card does not render the Interrupt button

- **WHEN** `<AgentRosterCard agent={{ id: "alice", role: "engineer", status: "idle", last_activity: null, last_active_at: null, paused: false }} />` is rendered
- **THEN** no `<button>` whose accessible name is `Interrupt` is present in the rendered tree
- **AND** the existing `<button>` whose accessible name is `Pause` is still rendered

#### Scenario: A running-then-idle transition removes the Interrupt button

- **WHEN** the card initially renders with `agent.status === "running"` (Interrupt button present)
- **AND** an `agent.state_changed` frame followed by a `listAgents()` refetch resolves with the same agent now carrying `status: "idle"`
- **THEN** after the re-render, no button whose accessible name is `Interrupt` is present in the rendered tree

### Requirement: Clicking Interrupt opens the confirmation dialog instead of firing the network call

The Interrupt button's `onClick` handler SHALL open the `<ConfirmInterruptDialog>` modal (per the `interrupt-and-timeout-ux` capability). The handler SHALL NOT call `apiClient.interruptAgent(...)` directly. The dialog's confirm action — and only the dialog's confirm action — SHALL fire `apiClient.interruptAgent(<agent.id>)`. While the dialog is open, the underlying card SHALL remain rendered (the dialog is overlaid, not a replacement).

#### Scenario: Clicking Interrupt opens the dialog without calling the API

- **WHEN** the user clicks the `Interrupt` button on `alice`'s running card
- **AND** `apiClient.interruptAgent` is instrumented
- **THEN** `apiClient.interruptAgent` was not called (the dialog is open but the request has not been issued)
- **AND** the rendered tree contains exactly one `role="dialog"` element

#### Scenario: Cancelling the dialog leaves the card unchanged

- **WHEN** the dialog is open after clicking `Interrupt`
- **AND** the user clicks `Cancel`
- **THEN** the dialog is removed from the rendered tree
- **AND** `apiClient.interruptAgent` was not called
- **AND** `alice`'s card is still rendered with the same `status: "running"` and the Interrupt button visible

#### Scenario: Confirming the dialog issues `apiClient.interruptAgent`

- **WHEN** the dialog is open after clicking `Interrupt` and `apiClient.interruptAgent` is set up to resolve with the post-interrupt envelope
- **AND** the user clicks the dialog's destructive `Interrupt` button
- **THEN** `apiClient.interruptAgent("alice")` was called exactly once
- **AND** the dialog is removed from the rendered tree

### Requirement: While Interrupt is in flight, the card disables the button and surfaces a busy indicator

After the dialog's confirm fires `apiClient.interruptAgent(...)`, the card SHALL: (1) disable the Interrupt button (the rendered button has the `disabled` attribute and `aria-busy="true"`); (2) update the button's visible label to `Interrupting…`; (3) on resolution, restore the button to its baseline (the canonical `agent.state_changed` flow will flip `status` to `idle`, at which point the button is no longer rendered per the gating requirement above); (4) on `KeniApiError`, restore the button to its baseline label and render the existing `data-testid="card-error"` element with the error's `code` (the same surface used by pause/resume's rollback path).

The card SHALL NOT optimistically flip `status` to `idle`; the post-call canonical state is sourced from the resolved `AgentEnvelope.data` (and the bus-driven re-render from the `agent.state_changed` frame).

#### Scenario: A successful interrupt shows the busy state then transitions away

- **WHEN** the dialog is confirmed and `apiClient.interruptAgent` is set up to resolve after a 100 ms delay with `data.status === "idle"`, `data.last_activity === "session_interrupted"`
- **THEN** between the click and the promise resolution, the Interrupt button is in the rendered tree, has `disabled` set, has `aria-busy="true"`, and its visible label is `Interrupting…`
- **AND** after the promise resolves, the rendered card no longer contains an Interrupt button (the agent's `status` is now `idle`)
- **AND** the rendered card now contains the `Interrupted` terminal-event badge (per the `interrupt-and-timeout-ux` capability)

#### Scenario: A failed interrupt restores the button and surfaces the error code

- **WHEN** the dialog is confirmed and `apiClient.interruptAgent` is set up to reject with `new KeniApiError(503, "internal_error", { ... })`
- **THEN** between the click and the rejection, the Interrupt button has `disabled` and `aria-busy="true"`
- **AND** after the rejection, the Interrupt button is re-enabled (no `disabled`) and its visible label is `Interrupt`
- **AND** the rendered card contains a `data-testid="card-error"` element whose text contains `internal_error`

### Requirement: The card renders at most one terminal-event badge derived from `agent.last_activity`

`<AgentRosterCard>` SHALL render at most one element with a `keni-terminal-badge--*` class, derived purely from the rendered `agent.last_activity` field, per the mapping documented in the `interrupt-and-timeout-ux` capability:

- `last_activity === "session_interrupted"` → one element with class `keni-terminal-badge--interrupted` and visible text `Interrupted`.
- `last_activity === "session_timeout"` → one element with class `keni-terminal-badge--timeout` and visible text `Timed out`.
- `last_activity === "idle"` → one element with class `keni-terminal-badge--idle` and visible text `Idle (no work)`.
- Any other value (including `null`, `"session_start"`, `"session_end"`, etc.) → no badge element rendered.

The badge SHALL be sourced verbatim from `AgentResponse.last_activity`. The card SHALL NOT introduce a parallel runtime field. The badge's `title` attribute SHALL include the substring `ticket status not auto-reverted` for the interrupted and timeout variants (per the `interrupt-and-timeout-ux` capability); the `Idle (no work)` variant's `title` is implementation-defined (a short explanatory tooltip is appropriate but not required by this spec).

#### Scenario: An interrupted agent's card renders the Interrupted badge

- **WHEN** `<AgentRosterCard agent={{ id: "alice", role: "engineer", status: "idle", last_activity: "session_interrupted", last_active_at: "2026-05-04T07:00:00Z", paused: false }} />` is rendered
- **THEN** the rendered card contains exactly one element with class `keni-terminal-badge--interrupted` and visible text `Interrupted`
- **AND** the element's `title` attribute contains the substring `ticket status not auto-reverted`

#### Scenario: A timed-out agent's card renders the Timed out badge

- **WHEN** the card is rendered with `agent.last_activity === "session_timeout"`
- **THEN** the rendered card contains exactly one element with class `keni-terminal-badge--timeout` and visible text `Timed out`
- **AND** the element's `title` attribute contains the substring `ticket status not auto-reverted`

#### Scenario: An idle (no-work) agent's card renders the neutral badge

- **WHEN** the card is rendered with `agent.last_activity === "idle"`
- **THEN** the rendered card contains exactly one element with class `keni-terminal-badge--idle` and visible text `Idle (no work)`

#### Scenario: A `session_start` last-activity removes any prior badge

- **WHEN** the card initially renders with `last_activity === "session_interrupted"` (badge visible)
- **AND** the same agent's `last_activity` is updated to `"session_start"` via the standard `listAgents()` refetch flow
- **THEN** after the re-render, no element with any `keni-terminal-badge--*` class is rendered for that card

### Requirement: The component test file covers the Interrupt button gating, the dialog flow, and the badge state machine

`packages/spa/src/features/agentRoster/AgentRosterCard_test.tsx` SHALL exist and SHALL contain `Deno.test` cases that, at minimum, assert: (1) the Interrupt button renders when `status === "running"` and is absent when `status === "idle"`; (2) clicking Interrupt opens the dialog without firing `apiClient.interruptAgent`; (3) Cancelling the dialog leaves the card unchanged; (4) Confirming the dialog calls `apiClient.interruptAgent("<id>")` exactly once; (5) the in-flight state shows `Interrupting…` with `disabled` and `aria-busy="true"`; (6) a `KeniApiError` from `interruptAgent` re-enables the button and renders `data-testid="card-error"`; (7) the four documented `last_activity` values produce the documented badge variants (`session_interrupted` → Interrupted; `session_timeout` → Timed out; `idle` → Idle (no work); `session_start` → no badge); (8) the badge's `title` includes the documented substring for the interrupted and timeout variants. The tests SHALL build their `apiClient` and `eventsClient` as in-memory implementations of the documented interfaces (no global mocking framework). The tests SHALL import `../../test_setup.ts` first.

#### Scenario: Test file exists and is discovered by `deno task test`

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** `packages/spa/src/features/agentRoster/AgentRosterCard_test.tsx` is discovered and its test cases are executed
- **AND** every documented test case (eight cases) is present and passes

#### Scenario: Tests build clients in-memory (no global mocking framework)

- **WHEN** the file `packages/spa/src/features/agentRoster/AgentRosterCard_test.tsx` is read
- **THEN** the file does not import any module from `npm:vitest`, `npm:jest`, `npm:sinon`, `npm:msw`, or any equivalent global mocking framework
- **AND** the test cases construct `apiClient`-shaped objects inline using the interfaces exported from `transport/`
