# spa-activity-log Specification

## Purpose

Defines the contract for the **activity log** view at `/activity` — the chronological audit surface occupying the shell's primary content region alongside the board and entity drill-downs (`spa-shell`). Pins debounced mapping of UI filters onto `ActivityFilter` for server-backed `listActivity`, reverse-chronological presentation of `ActivityEntryResponse` rows with relative timestamps, cross-reference rendering through `formatActivityRefs` (`ticket` / `pr` as links, `change_request` deferred to step 24), reconnect-tier refetches, debounced merges after `activity.appended` frames that match filters, explicit loading/error/empty/disconnected UX, and co-located `ActivityLogView_test.tsx` plus `formatActivityRefs_test.tsx` coverage with in-memory clients. Keeps observability/read-model concerns out of roster and drill-down specs so paging, export, or server-side ref filters can land here alone.

## Requirements

### Requirement: `ActivityLogView` mounts at `/activity` and owns the activity list lifecycle

`packages/spa/src/features/activityLog/ActivityLogView.tsx` SHALL export a default `<ActivityLogView />` React component. The router SHALL mount it at `/activity` inside `<AppShell />`'s `<Outlet />`. The component SHALL: (1) read `apiClient` and `eventsClient` via the documented React contexts; (2) hold a local `filter: ActivityFilter` state whose default is `{}` (no agent, no role, no date range); (3) on mount and on every change of the `filter` state, call `apiClient.listActivity(filter)` and store the resolved `ActivityEntryResponse[]` in local state; (4) subscribe to `eventsClient` via `onEvent(...)` for `activity.appended` frames and via `onLifecycle(...)` for lifecycle events; (5) on every `"connected"` lifecycle transition, refetch via `listActivity(filter)`; (6) on unmount, unsubscribe.

#### Scenario: Mount calls `listActivity({})` exactly once with the default filter

- **WHEN** `<ActivityLogView />` is mounted and `apiClient.listActivity` is instrumented
- **THEN** `listActivity({})` was called exactly once
- **AND** the rendered tree reflects the resolution

#### Scenario: Changing a filter re-issues the call

- **WHEN** the view is mounted and the user changes the agent filter to `alice`
- **THEN** `listActivity({ agent: "alice" })` is called
- **AND** the rendered list reflects the second resolution

#### Scenario: `connected` lifecycle transition refetches with the current filter

- **WHEN** the view is mounted with `filter: { role: "engineer" }` and the events client emits `"connected"`
- **THEN** `listActivity({ role: "engineer" })` was called as a result of the lifecycle handler

### Requirement: The filter form maps agent / role / date-range inputs onto `ActivityFilter`

The view SHALL render a filter form with: (1) an `agent` text input (empty string is treated as "no filter"); (2) a `role` dropdown with the options `<any>`, `user`, `engineer`, `qa`, `po`, `writer` (the `<any>` default is treated as "no filter"); (3) a `from` `datetime-local` input; (4) a `to` `datetime-local` input. Form controls SHALL be debounced (250 ms trailing) so typing into the agent input does not issue one REST call per keystroke. The debounce window SHALL be expressed as a single named constant `ACTIVITY_FILTER_DEBOUNCE_MS = 250`. The form SHALL also render a "Clear filters" button that resets every input to its default and re-issues `listActivity({})`.

#### Scenario: Default filters issue no extra parameters

- **WHEN** the form's inputs are all at their defaults
- **THEN** the call to `listActivity` carries the `ActivityFilter` value `{}`

#### Scenario: Filling in `agent` issues `{ agent: "<value>" }`

- **WHEN** the user types `alice` into the agent input and pauses beyond the debounce window
- **THEN** `listActivity({ agent: "alice" })` is called

#### Scenario: Selecting a role issues `{ role: "<value>" }`

- **WHEN** the user selects `engineer` in the role dropdown
- **THEN** `listActivity({ role: "engineer" })` is called

#### Scenario: Selecting a date range issues `{ from, to }`

- **WHEN** the user picks `2026-05-01T00:00` in the `from` input and `2026-05-04T23:59` in the `to` input
- **THEN** `listActivity({ from: "2026-05-01T00:00:00.000Z", to: "2026-05-04T23:59:00.000Z" })` is called (the ISO conversion normalises the datetime-local input to UTC)

#### Scenario: Clear filters resets every input

- **WHEN** the user has filled in every filter and clicks `Clear filters`
- **THEN** every input returns to its default value
- **AND** `listActivity({})` is called

#### Scenario: Debounce collapses a burst of keystrokes into one call

- **WHEN** the user types five characters into the agent input in rapid succession (all within the debounce window)
- **AND** the fake clock advances by 250 ms after the last keystroke
- **THEN** `listActivity` was called exactly once with the final input value
- **WHEN** the file `packages/spa/src/features/activityLog/ActivityLogView.tsx` is read
- **THEN** the file declares `const ACTIVITY_FILTER_DEBOUNCE_MS = 250` exactly once
- **AND** the debounce timer references that constant (no inline literal)

### Requirement: The activity list renders in reverse-chronological order with the documented row shape

The view SHALL render the local `ActivityEntryResponse[]` state as a list in **reverse-chronological** order (newest first — the client reverses the increasing-id order the server returns for readability). Each row SHALL render: (1) the entry's `timestamp` as a short relative time via `formatRelativeTime` (the exact ISO SHALL be available as a `title` attribute for hover tooltip); (2) the entry's `agent` (monospace); (3) the entry's `role` (small label); (4) the entry's `event` (bold label); (5) the entry's `summary` (or `—` when null); (6) a refs row rendering every key in `entry.refs` — `ticket` / `pr` / `change_request` / arbitrary keys. An empty list SHALL render a `data-testid="activity-empty"` element with text `No activity.`.

#### Scenario: Rows render newest-first

- **WHEN** the resolved list contains three entries with ids (and thus chronological order) `A` < `B` < `C`
- **THEN** the rendered rows are in order `C`, `B`, `A`
- **AND** row `C` is the topmost visible row

#### Scenario: A row renders every documented field

- **WHEN** the resolved list contains one entry `{ id: "01HW…", timestamp: "2026-05-04T07:00:00Z", session_id: "s1", agent: "alice", role: "engineer", event: "session_start", summary: "Started session", refs: { ticket: "ticket-0001" } }`
- **THEN** the rendered row contains `alice`, `engineer`, `session_start`, `Started session`
- **AND** the row renders the `ticket: ticket-0001` ref as a `<Link to="/tickets/ticket-0001">`

#### Scenario: An empty list renders the empty state

- **WHEN** the resolved list is `[]`
- **THEN** the rendered tree contains `data-testid="activity-empty"`

### Requirement: Cross-reference refs (`ticket`, `pr`, `change_request`) render as navigating links

`packages/spa/src/features/activityLog/formatActivityRefs.tsx` SHALL export a pure component `<ActivityRefs refs={Record<string, string>} />` that renders every key/value pair in `refs`. For the documented keys the render SHALL be:

- `ticket` — `<Link to={\`/tickets/${value}\`}>ticket: <value></Link>` (clickable)
- `pr` — `<Link to={\`/prs/${value}\`}>pr: <value></Link>` (clickable)
- `change_request` — `<span>change_request: <value></span>` (plain text in the prototype; step 24 wires the link)

Any other key SHALL render as `<span><key>: <value></span>` (plain text). A companion unit test file SHALL cover each of the three documented keys plus a non-documented key.

#### Scenario: `ticket` ref renders a navigating link

- **WHEN** `<ActivityRefs refs={{ ticket: "ticket-0001" }} />` is rendered inside a `<MemoryRouter>`
- **THEN** the rendered tree contains a `<Link>` whose `href` is `/tickets/ticket-0001`
- **AND** the link's text contains `ticket: ticket-0001`

#### Scenario: `pr` ref renders a navigating link

- **WHEN** `<ActivityRefs refs={{ pr: "pr-0001" }} />` is rendered
- **THEN** the rendered tree contains a `<Link>` whose `href` is `/prs/pr-0001`

#### Scenario: `change_request` ref renders as plain text

- **WHEN** `<ActivityRefs refs={{ change_request: "cr-0003" }} />` is rendered
- **THEN** the rendered tree contains the text `change_request: cr-0003` but NO `<Link>` or `<a href>` element for this ref

#### Scenario: An unknown ref key renders as plain text

- **WHEN** `<ActivityRefs refs={{ branch: "main" }} />` is rendered
- **THEN** the rendered tree contains the text `branch: main` but NO `<Link>` or `<a href>` for this ref

### Requirement: `activity.appended` frames matching the current filter prepend to the local list

The frame handler SHALL, for every incoming `EventFrame` whose `event === "activity.appended"`: check whether the frame's `payload` matches the current filter — `agent` matches if the filter's `agent` is absent or equals `payload.agent`; `role` matches if the filter's `role` is absent or equals `payload.role`; `from` / `to` matches if the frame's `id`-encoded timestamp (the frame envelope's `timestamp`) falls within the range. If the frame matches, the handler SHALL immediately call `apiClient.listActivity(filter)` (to fetch the newly-appended entry's full record including `refs` and `summary`, which the frame payload does not carry) and merge the resolved list into local state. A burst of `activity.appended` frames within 250 ms SHALL collapse into a single debounced refetch. Frames that don't match SHALL be ignored. The debounce window SHALL be the same `ACTIVITY_FILTER_DEBOUNCE_MS = 250` constant.

#### Scenario: A matching frame triggers a debounced refetch

- **WHEN** the view is mounted with filter `{}`
- **AND** an `activity.appended` frame arrives
- **AND** the fake clock advances by 250 ms
- **THEN** `apiClient.listActivity({})` was called a second time (once on mount, once from the frame)

#### Scenario: A non-matching frame is ignored

- **WHEN** the view is mounted with filter `{ agent: "alice" }`
- **AND** an `activity.appended` frame arrives with `payload.agent === "bob"`
- **THEN** `apiClient.listActivity` was not called as a result of the frame
- **AND** the rendered list is unchanged

#### Scenario: A burst collapses into one debounced refetch

- **WHEN** the view is mounted with filter `{}`
- **AND** five `activity.appended` frames arrive within 100 ms of each other
- **AND** the fake clock advances by 250 ms after the last frame
- **THEN** `apiClient.listActivity({})` was called exactly twice (once on mount, once from the debounced handler)

### Requirement: The view renders loading, error, empty, and disconnected UX states

The view SHALL render: (1) **loading** — before `listActivity` resolves the first time, a single `data-testid="activity-loading"` element; (2) **error** — when `listActivity` rejects with `KeniApiError`, a `data-testid="activity-error"` element with the error's `code` and a `Retry` button that re-issues `listActivity(filter)`; (3) **empty** — when `listActivity` resolves with `data: []`, a `data-testid="activity-empty"` element; (4) **disconnected** — when the events client is in `"disconnected"`, the view container has `data-disconnected="true"`.

#### Scenario: Loading indicator renders before the first list resolves

- **WHEN** `<ActivityLogView />` is mounted against an `apiClient` whose `listActivity` is pending
- **THEN** the rendered tree contains exactly one `data-testid="activity-loading"` element
- **AND** no row elements are rendered

#### Scenario: Error renders the retry surface

- **WHEN** `<ActivityLogView />` is mounted and `listActivity({})` rejects with `new KeniApiError(500, "internal_error", { … })`
- **THEN** the rendered tree contains a `data-testid="activity-error"` element containing `internal_error`
- **AND** a button whose accessible name is `Retry` is present
- **WHEN** the user clicks `Retry` and `listActivity({})` is then set up to resolve with one row
- **THEN** the error panel is removed and one row renders

### Requirement: The component test file asserts the documented behaviours

`packages/spa/src/features/activityLog/ActivityLogView_test.tsx` SHALL exist and SHALL contain `Deno.test` cases that, at minimum, assert: (1) the loading / error / empty / disconnected states; (2) the default filter is `{}` and changing the agent / role / date-range inputs re-issues `listActivity(filter)` after the debounce window; (3) the Clear filters button resets every input and re-issues `listActivity({})`; (4) rows render in reverse-chronological order with the documented field shape; (5) `<ActivityRefs>` renders `ticket` / `pr` as links and `change_request` / unknown keys as plain text; (6) a matching `activity.appended` frame triggers a debounced refetch; (7) a burst of frames collapses into one refetch. Tests SHALL import `../../test_setup.ts` first and SHALL build inline `apiClient` / `eventsClient` fakes. A companion unit test `formatActivityRefs_test.tsx` SHALL cover each of the three documented keys plus a non-documented key.

#### Scenario: Test file is discovered by `deno task test`

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** `packages/spa/src/features/activityLog/ActivityLogView_test.tsx` is discovered and its test cases are executed
- **AND** every documented test case (seven cases) is present and passes

#### Scenario: The unit test for `formatActivityRefs` covers every documented key

- **WHEN** `packages/spa/src/features/activityLog/formatActivityRefs_test.tsx` is read
- **THEN** the file contains at minimum four `Deno.test` cases: `ticket`, `pr`, `change_request`, and a non-documented key
