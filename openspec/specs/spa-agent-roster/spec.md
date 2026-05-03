# spa-agent-roster Specification

## Purpose

Defines the contract for the **agent roster panel** — the left region of the SPA's three-region shell (`spec.md` §7.2 / `spa-shell` capability). Pins the roster's data flow (initial load via `apiClient.listAgents()`, live updates via `eventsClient` subscriptions to `agent.state_changed` and `activity.appended`), the per-card render shape (every documented `AgentResponse` field rendered, in the documented order, with the documented `—` fallback for nulls), the pause/resume affordance (which endpoints it calls, the optimistic-update + REST-envelope rollback rule, the role assumption), the live-update protocol (frame-driven status flips for `agent.state_changed`, debounced REST refetches for `activity.appended`-driven `last_*` updates, unconditional refetch on the events client's `connected` lifecycle transition), and the documented loading / empty / error / disconnected UX. Lives in its own capability file so future changes (post-MVP card additions, alternative sort orders, multi-project switcher) modify exactly one spec without diffing the shell contract.

## Requirements

### Requirement: `AgentRosterPanel` mounts under the shell's left region and owns the roster lifecycle

`packages/spa/src/features/agentRoster/AgentRosterPanel.tsx` SHALL export a default `<AgentRosterPanel />` React component. The shell (`AppShell.tsx`) SHALL mount exactly one instance inside its left `<aside>` region. The panel SHALL: (1) read the `apiClient` and `eventsClient` from the documented React contexts; (2) on mount, call `apiClient.listAgents()` exactly once and store the resolved `AgentListResponse.data` array in local state; (3) subscribe to `eventsClient` for both per-frame events (`agent.state_changed`, `activity.appended`) and lifecycle events (`connecting` / `live` / `disconnected`); (4) on unmount, call the unsubscribe closures returned by both `subscribe(...)` and `onLifecycle(...)`. The panel SHALL NOT issue REST calls from any source other than `apiClient`; it SHALL NOT open a WebSocket from any source other than `eventsClient`.

#### Scenario: Single panel mounts inside the shell

- **WHEN** `<AppShell />` is rendered into a `happy-dom` document
- **THEN** the rendered tree contains exactly one `<AgentRosterPanel />` instance inside the left `<aside>`

#### Scenario: Initial roster load uses `apiClient.listAgents()` exactly once on mount

- **WHEN** `<AgentRosterPanel />` is mounted against an in-memory `apiClient` whose `listAgents()` is instrumented
- **AND** the component's first effect runs
- **THEN** `listAgents()` was called exactly once
- **AND** the resolved roster's rows are reflected in the rendered cards

#### Scenario: Unmount cleans up subscriptions

- **WHEN** the panel mounts (registering one subscriber and one lifecycle listener) and then unmounts
- **THEN** the in-memory `eventsClient` reports zero subscribers and zero lifecycle listeners attributable to the panel after unmount

### Requirement: One `<AgentRosterCard>` per agent renders the documented `AgentResponse` fields

`packages/spa/src/features/agentRoster/AgentRosterCard.tsx` SHALL export a default `<AgentRosterCard agent: AgentResponse />` component. Every card SHALL render: (1) the `agent.id` as a prominent monospace label; (2) the `agent.role` as a smaller muted label below the id; (3) the `agent.status` as a small dot with the documented colors (`--keni-color-status-running` for `"running"`, `--keni-color-status-idle` for `"idle"`) and the literal text `Running` / `Idle`; (4) the `agent.last_activity` event-name string when non-null, rendered as `—` when null; (5) the `agent.last_active_at` as a relative time (e.g., `2m ago`) computed via the pure helper `formatRelativeTime(iso, now)` when non-null, rendered as `—` when null; (6) a pause/resume toggle button whose visible label is `Pause` when `agent.paused === false` and `Resume` when `agent.paused === true`. Every field SHALL be sourced verbatim from `AgentResponse` (no client-side re-derivation). The card SHALL NOT render fields that are not in `AgentResponse`.

#### Scenario: A fully-populated row renders every documented field

- **WHEN** `<AgentRosterCard agent={{ id: "alice", role: "engineer", status: "running", last_activity: "session_start", last_active_at: "2026-05-03T15:00:00Z", paused: false }} />` is rendered
- **THEN** the rendered tree contains the text `alice` (monospace), `engineer`, `Running`, `session_start`, a relative time computed from `2026-05-03T15:00:00Z`, and a button labelled `Pause`

#### Scenario: Null `last_*` fields render as `—`

- **WHEN** `<AgentRosterCard agent={{ id: "alice", role: "engineer", status: "idle", last_activity: null, last_active_at: null, paused: false }} />` is rendered
- **THEN** the rendered tree contains exactly two `—` glyphs in the `last_activity` and `last_active_at` slots

#### Scenario: A paused agent shows the `Resume` label

- **WHEN** the same agent is rendered with `paused: true`
- **THEN** the toggle button's visible label is `Resume`

### Requirement: Pause/resume is an optimistic update with rollback on `KeniApiError`

The card's toggle button click handler SHALL: (1) compute the optimistic post-click state (`paused: !current.paused`); (2) update the local React state immediately (the rendered button label flips before any network call resolves); (3) call `apiClient.pauseAgent(agent.id)` when toggling to paused, or `apiClient.resumeAgent(agent.id)` when toggling to unpaused; (4) on success, apply the server-returned `AgentEnvelope.data` to the panel's roster state (idempotent on the happy path; in a concurrent-toggle race the server's response wins); (5) on `KeniApiError`, roll back the optimistic state and surface a one-line failure indicator inside the card (a small `data-testid="card-error"` element with the error's `code`). The toggle button SHALL NOT enter a "loading / disabled" state during the in-flight call (the optimistic update is the only visible response). The handler SHALL pass the `X-Keni-Role: user` header via the `apiClient` default; the SPA SHALL NOT expose a role-switcher on the roster.

#### Scenario: Successful pause flips the local state immediately

- **WHEN** an agent's card is rendered with `paused: false`
- **AND** the user clicks the `Pause` button
- **AND** `apiClient.pauseAgent` is set up to resolve after a 50 ms delay with the matching success envelope
- **THEN** the rendered button label changes to `Resume` synchronously with the click (before the promise resolves)
- **AND** after the promise resolves, the rendered state is unchanged (the optimistic state matches the server response)

#### Scenario: A failed pause rolls back

- **WHEN** an agent's card is rendered with `paused: false`
- **AND** the user clicks `Pause`
- **AND** `apiClient.pauseAgent` is set up to reject with a `KeniApiError({ status: 500, code: "internal_error" })`
- **THEN** the rendered button label briefly shows `Resume` (optimistic) then reverts to `Pause` after the rejection
- **AND** the card renders a small failure indicator with the text `internal_error` (or the documented format) inside `data-testid="card-error"`

#### Scenario: Concurrent toggle from another tab — server wins

- **WHEN** an agent's card is rendered with `paused: false` and the user clicks `Pause`
- **AND** before `pauseAgent` resolves, an `agent.state_changed` frame arrives with `paused: false` (a competing tab's resume)
- **THEN** the panel applies the frame's payload (the card briefly flips back to `paused: false`)
- **AND** when `pauseAgent` eventually resolves with the server's response (whichever the server saw last), the panel applies that response — both possible outcomes are documented as "the server is the tie-breaker"

### Requirement: `agent.state_changed` frames flip a single card synchronously; no REST refetch is issued

The panel's frame handler SHALL inspect every incoming `EventFrame` and, when the frame's `event === "agent.state_changed"`, locate the matching agent in the local roster by `payload.agent_id` and update only that row's `paused` and `status` fields with the payload's values. The handler SHALL NOT call `apiClient.listAgents()` for `agent.state_changed` frames (the payload contains every field the wire shape carries). When the payload's `agent_id` is not in the local roster (e.g., a future agent added to `project.yaml` after the panel mounted), the frame SHALL be ignored without error.

#### Scenario: One frame updates one card

- **WHEN** the panel is mounted with a roster `[{ id: "alice", paused: false, status: "idle", ... }, { id: "bob", paused: false, status: "idle", ... }]`
- **AND** an `agent.state_changed` frame arrives with `payload: { agent_id: "alice", paused: false, status: "running" }`
- **THEN** `alice`'s rendered card shows `Running`
- **AND** `bob`'s rendered card is unchanged
- **AND** `apiClient.listAgents()` was not called as a result of the frame

#### Scenario: Unknown `agent_id` is silently ignored

- **WHEN** the panel is mounted with a roster `[{ id: "alice", ... }]`
- **AND** an `agent.state_changed` frame arrives with `payload: { agent_id: "ghost", paused: true, status: "idle" }`
- **THEN** the rendered cards are unchanged
- **AND** no error is thrown
- **AND** `apiClient.listAgents()` is not called

### Requirement: `activity.appended` frames trigger a 250 ms trailing-debounce refetch of `apiClient.listAgents()` to refresh `last_*` fields

The panel's frame handler SHALL, when the frame's `event === "activity.appended"` and the frame's `payload.agent` matches one of the local roster's `id`s, schedule a refetch of `apiClient.listAgents()` on a 250 ms trailing debounce timer. A burst of `activity.appended` frames within the debounce window SHALL collapse into a single refetch. When the refetch resolves, the panel SHALL replace its roster state with the resolved `AgentListResponse.data` (overwriting any stale `last_activity` / `last_active_at` while preserving the values from any in-flight optimistic pause/resume not yet acknowledged — the merge rule is "server wins for `last_*`, optimistic wins for `paused`/`status` until the optimistic call resolves"). When the frame's `payload.agent` is not in the local roster, the frame SHALL be ignored. The debounce window SHALL be expressed as a single named constant `ROSTER_REFETCH_DEBOUNCE_MS = 250` in the panel module.

#### Scenario: A burst of activity entries collapses into one refetch

- **WHEN** the panel is mounted with a roster `[{ id: "alice", ... }]`
- **AND** five `activity.appended` frames for `alice` arrive within 100 ms of each other
- **AND** the fake-clock advances by 250 ms after the last frame
- **THEN** `apiClient.listAgents()` was called exactly once as a result

#### Scenario: A non-roster agent's frame does not trigger a refetch

- **WHEN** the panel is mounted with a roster `[{ id: "alice", ... }]`
- **AND** an `activity.appended` frame for `payload.agent = "ghost"` arrives
- **THEN** `apiClient.listAgents()` is not called
- **AND** the rendered cards are unchanged

#### Scenario: The debounce constant is the single source of truth

- **WHEN** the file `packages/spa/src/features/agentRoster/AgentRosterPanel.tsx` is read
- **THEN** the file declares `const ROSTER_REFETCH_DEBOUNCE_MS = 250` exactly once
- **AND** the debounce timer references that constant (no inline literal)

### Requirement: A `connected` lifecycle transition triggers an unconditional `apiClient.listAgents()` refetch

The panel's lifecycle listener SHALL, on every transition into `"live"` (the initial connect and every successful reconnect), call `apiClient.listAgents()` and replace the roster state with the resolved data. This is the SPA's enactment of the orchestration server's "client refetches via REST on (re)connect" reconnect tier. A transition into `"connecting"` SHALL set the panel's `disconnected` UX flag to `false` (the indicator will show in `<TopNav>`). A transition into `"disconnected"` SHALL set the flag to `true`; the cards SHALL continue to render their last-seen values until the next `live` transition refetches the canonical state.

#### Scenario: Initial `live` transition triggers the first refetch

- **WHEN** the panel mounts and the events client emits `live` shortly after
- **THEN** `apiClient.listAgents()` was called exactly twice (once from the initial mount effect; once from the lifecycle handler)
- **AND** the panel renders the roster from the most recent resolution

#### Scenario: Reconnect refetches once

- **WHEN** the events client transitions `live → disconnected → connecting → live` once
- **THEN** the lifecycle handler calls `apiClient.listAgents()` exactly once for the reconnect (the disconnect itself does not refetch)

#### Scenario: While disconnected, cards show the last-seen state

- **WHEN** the events client emits `disconnected`
- **THEN** the rendered roster state is unchanged
- **AND** the panel's `data-disconnected="true"` flag is set on the panel container so a downstream stylesheet rule can dim the cards if desired (the dim behaviour itself is not required by this spec)

### Requirement: The panel renders explicit loading, empty, error, and disconnected UX states

The panel SHALL render the following states explicitly: (1) **loading** — before `listAgents()` resolves the first time, the panel renders a single `data-testid="roster-loading"` indicator (a placeholder skeleton or spinner — the visual is implementation-defined, but the testid SHALL be present); (2) **empty** — once `listAgents()` resolves with `data: []`, the panel renders a `data-testid="roster-empty"` panel with the literal text `No agents configured.` and a one-line hint `Add one to .keni/project.yaml.`; (3) **error** — when `listAgents()` rejects with a `KeniApiError`, the panel renders a `data-testid="roster-error"` element with the error's `code` and a `Retry` button; clicking the button re-issues `listAgents()`; (4) **disconnected** — when the events client is in the `disconnected` state, the panel container has `data-disconnected="true"` (the cards still render their last-seen state per the previous requirement; no separate disconnected panel is rendered). The four states SHALL be mutually exclusive in the rendered DOM (e.g., the empty panel does not render alongside the loading indicator).

#### Scenario: Loading indicator renders before the first list resolves

- **WHEN** the panel is mounted against an `apiClient` whose `listAgents()` is pending
- **THEN** the rendered tree contains exactly one `data-testid="roster-loading"` element
- **AND** no `data-testid="roster-empty"`, `data-testid="roster-error"`, or `<AgentRosterCard>` elements are rendered

#### Scenario: Empty roster renders the documented panel

- **WHEN** the panel is mounted and `listAgents()` resolves with `{ data: [], project_id: "..." }`
- **THEN** the rendered tree contains exactly one `data-testid="roster-empty"` element whose text contains `No agents configured.` and `Add one to .keni/project.yaml.`
- **AND** no `<AgentRosterCard>` elements are rendered

#### Scenario: Error renders the retry surface and re-issues `listAgents` on click

- **WHEN** the panel is mounted and `listAgents()` rejects with `new KeniApiError(503, "internal_error", { ... })`
- **THEN** the rendered tree contains a `data-testid="roster-error"` element with text containing `internal_error`
- **AND** the rendered tree contains a button whose accessible name is `Retry`
- **WHEN** the user clicks `Retry` and `listAgents()` is then set up to resolve with one row
- **THEN** the error panel is removed from the rendered tree
- **AND** one `<AgentRosterCard>` is rendered

#### Scenario: Disconnected state stamps the panel container without removing cards

- **WHEN** the panel is mounted with a roster of two cards and the events client transitions to `disconnected`
- **THEN** the rendered panel container has `data-disconnected="true"`
- **AND** both `<AgentRosterCard>` elements remain in the rendered tree showing their last-seen state

### Requirement: `formatRelativeTime` is a pure helper unit-tested in isolation

`packages/spa/src/features/agentRoster/formatRelativeTime.ts` SHALL export a pure function `formatRelativeTime(iso: string, now: Date): string` that returns a short human-readable relative-time string (e.g., `now`, `5s ago`, `2m ago`, `3h ago`, `2d ago`). The function SHALL handle ISO 8601 UTC inputs and SHALL use `now` as the reference point so tests can pin the clock without monkey-patching `Date`. The function SHALL NOT mutate its inputs and SHALL NOT call `Date.now()` directly. The matching test file `formatRelativeTime_test.ts` SHALL cover at minimum the boundaries: 0 s (`now`), 1 s, 59 s, 60 s, 3599 s, 3600 s, 86400 s, and a timestamp in the future (which SHALL render as `now` — clock skew tolerance for the prototype).

#### Scenario: `0 s` ago renders as `now`

- **WHEN** `formatRelativeTime("2026-05-03T15:00:00Z", new Date("2026-05-03T15:00:00Z"))` is called
- **THEN** the return value is `now`

#### Scenario: `2 m` ago renders as `2m ago`

- **WHEN** `formatRelativeTime("2026-05-03T14:58:00Z", new Date("2026-05-03T15:00:00Z"))` is called
- **THEN** the return value is `2m ago`

#### Scenario: A future timestamp renders as `now` (clock-skew tolerance)

- **WHEN** `formatRelativeTime("2026-05-03T15:00:30Z", new Date("2026-05-03T15:00:00Z"))` is called
- **THEN** the return value is `now`
- **AND** the function does not throw

### Requirement: The component test file mounts the panel against in-memory clients and asserts the documented behaviours

`packages/spa/src/features/agentRoster/AgentRosterPanel_test.tsx` SHALL exist and SHALL contain `Deno.test` cases that, at minimum, assert: (1) the panel renders the seeded roster on initial mount; (2) an `agent.state_changed` frame flips the right card's `paused` flag; (3) the toggle calls the matching `apiClient.pauseAgent` / `resumeAgent` method; (4) the loading, empty, error, and disconnected states render the documented `data-testid`s and labels; (5) a `connected` lifecycle event triggers an unconditional refetch; (6) a burst of `activity.appended` frames collapses into a single debounced refetch under a fake clock. The tests SHALL build their `apiClient` and `eventsClient` as in-memory implementations of the documented interfaces (no global mocking framework). The tests SHALL import `../../test_setup.ts` first.

#### Scenario: Test file exists and is discovered by `deno task test`

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** `packages/spa/src/features/agentRoster/AgentRosterPanel_test.tsx` is discovered and its test cases are executed
- **AND** every documented test case (initial render, frame flip, toggle dispatch, four lifecycle states, debounced refetch) is present and passes

#### Scenario: Tests build clients in-memory (no global mocking framework)

- **WHEN** the file `packages/spa/src/features/agentRoster/AgentRosterPanel_test.tsx` is read
- **THEN** the file does not import any module from `npm:vitest`, `npm:jest`, `npm:sinon`, `npm:msw`, or any equivalent global mocking framework
- **AND** the test cases construct `apiClient`-shaped and `eventsClient`-shaped objects inline using the interfaces exported from `transport/`

### Requirement: The roster preserves `project.yaml` declaration order and does not sort client-side

The panel SHALL render cards in the order returned by `apiClient.listAgents()` (which the orchestration server guarantees is the `project.yaml` declaration order per the `orchestration-server` capability). The panel SHALL NOT sort, filter, or otherwise reorder the rows client-side. A future change that wants a different order SHALL update the server's contract or add an explicit sort affordance — neither is in scope for this step.

#### Scenario: Two-row roster renders in the documented order

- **WHEN** the panel is mounted and `listAgents()` resolves with `{ data: [{ id: "alice", ... }, { id: "bob", ... }], project_id: "..." }`
- **THEN** the rendered tree's two `<AgentRosterCard>` elements appear in document order with `alice` first, then `bob`
- **AND** the order matches the resolved `data` array's order verbatim

#### Scenario: A frame for the second-row agent does not change the order

- **WHEN** the same panel receives an `agent.state_changed` frame for `bob`
- **THEN** `bob`'s card updates in place
- **AND** the rendered order remains `alice` then `bob`

### Requirement: The toggle is a real `<button>` with a stable accessible name

The pause/resume toggle SHALL be rendered as a `<button type="button">` element (not a `<div>` with a click handler). The button's accessible name (its visible text content; or its `aria-label` if the visible content is iconographic) SHALL be exactly `Pause` when the agent is unpaused and exactly `Resume` when paused. The button SHALL be keyboard-activatable (Enter / Space activate it via the browser default). No additional ARIA attributes (`aria-pressed`, `role="switch"`, etc.) SHALL be set in this step — the simple "the label flips" pattern is the prototype's accessibility floor; promoting to a switch role is post-MVP.

#### Scenario: The toggle is a real button with the documented label

- **WHEN** an agent's card with `paused: false` is rendered
- **THEN** the rendered tree contains exactly one `<button>` whose `type === "button"` and whose accessible name is `Pause`

#### Scenario: The toggle activates on Enter

- **WHEN** the user focuses the button and presses Enter
- **THEN** the click handler is invoked exactly once (the optimistic state flips, the matching `apiClient` call is dispatched per the previous requirement)
