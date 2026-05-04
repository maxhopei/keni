## ADDED Requirements

### Requirement: `BoardView` mounts at the index route and owns the board's data lifecycle

`packages/spa/src/features/board/BoardView.tsx` SHALL export a default `<BoardView />` React component. The `<AppShell />`'s index route (per the `spa-shell` capability's routing scaffold) SHALL render `<BoardView />` as the `<Outlet />`'s content. The component SHALL: (1) read the `apiClient` and `eventsClient` via the documented React contexts; (2) on mount, call `apiClient.listTickets()` exactly once and store the resolved `TicketListResponse.data` array in local state; (3) subscribe to `eventsClient` via `onEvent(...)` for per-frame events (`ticket.created`, `ticket.updated`) and via `onLifecycle(...)` for lifecycle events (`connecting` / `connected` / `disconnected`); (4) on every transition to `"connected"` (initial and every reconnect), refetch via `apiClient.listTickets()` and replace the local state (the reconnect tier); (5) on unmount, call the unsubscribe closures returned by `onEvent(...)` and `onLifecycle(...)`. The component SHALL NOT issue REST calls from any source other than `apiClient`; it SHALL NOT open a WebSocket from any source other than `eventsClient`.

#### Scenario: `<BoardView />` mounts at the `/` route

- **WHEN** the router renders at path `/` inside `<AppShell />`'s `<Outlet />`
- **THEN** the rendered tree contains exactly one `<BoardView />` instance
- **AND** no `<BoardPlaceholder />` is rendered (that component is retired in this change)

#### Scenario: Initial mount calls `listTickets()` exactly once

- **WHEN** `<BoardView />` is mounted against an in-memory `apiClient` whose `listTickets()` is instrumented
- **AND** the component's first effect runs
- **THEN** `listTickets()` was called exactly once
- **AND** the resolved list's rows are reflected in the rendered columns

#### Scenario: `connected` lifecycle transition triggers an unconditional refetch

- **WHEN** the view is mounted and the `eventsClient` emits `"connected"` after the initial `listTickets()` resolution
- **THEN** `apiClient.listTickets()` was called exactly twice (once from the mount effect, once from the lifecycle handler)
- **AND** the rendered columns reflect the most recent resolution

#### Scenario: Unmount cleans up subscriptions

- **WHEN** the view mounts (registering one subscriber and one lifecycle listener) and then unmounts
- **THEN** the in-memory `eventsClient` reports zero subscribers and zero lifecycle listeners attributable to the view after unmount

### Requirement: The board renders twelve columns keyed off `TicketStatus` in the documented order

The board SHALL render exactly twelve columns, one per `TicketStatus` from `spec.md` §4.1, in this order: `open`, `in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, `ready_for_test`, `in_testing`, `tested`, `test_failed`, `done`. The columns SHALL render in a horizontal flex row with `overflow-x: auto` on the container so narrower viewports scroll horizontally. Each column SHALL have `min-width: 240px` and `flex: 0 0 auto`. Every column SHALL render its status literal (in Title Case — e.g., `Ready for review`) as a header, the count of cards currently in that column in parentheses, and a vertical stack of `<BoardCard>` elements (one per ticket whose `status` equals the column's status).

#### Scenario: Twelve columns render in the documented order

- **WHEN** `<BoardView />` is mounted and `listTickets()` has resolved
- **THEN** the rendered tree contains exactly twelve column elements with `data-status` attributes equal to the twelve documented values in order

#### Scenario: Each column renders its cards

- **WHEN** `listTickets()` resolves with three tickets in `open`, two in `in_progress`, and none in any other status
- **THEN** the `data-status="open"` column contains three `<BoardCard>` elements
- **AND** the `data-status="in_progress"` column contains two `<BoardCard>` elements
- **AND** every other column contains zero `<BoardCard>` elements
- **AND** every column's header text includes the card count (e.g., `Open (3)`, `In progress (2)`, `Ready for review (0)`)

#### Scenario: The column layout is horizontally scrollable

- **WHEN** `<BoardView />` is rendered in a `happy-dom` viewport narrower than the combined minimum column widths
- **THEN** the board container has `overflow-x: auto` (or `scroll`)
- **AND** the column row's total width exceeds the viewport's width (verifiable via `scrollWidth > clientWidth`)

### Requirement: Each `<BoardCard>` renders the documented ticket fields and is wrapped in a `<Link>` to its detail route

`packages/spa/src/features/board/BoardCard.tsx` SHALL export a default `<BoardCard ticket: TicketSummaryResponse />` component. Every card SHALL render: (1) the `ticket.id` as a prominent monospace label; (2) the `ticket.title` as the card's main text; (3) the `ticket.assignee` (or the literal `—` when null) in a smaller muted line; (4) the `ticket.priority` as a small numeric badge. The card's outermost element SHALL be a `<Link to={\`/tickets/${ticket.id}\`}>` from `react-router-dom` so clicks navigate to the ticket detail view. The card SHALL NOT render fields that are not in `TicketSummaryResponse`.

#### Scenario: A populated card renders every documented field

- **WHEN** `<BoardCard ticket={{ id: "ticket-0001", title: "Add login page", status: "in_progress", assignee: "alice", priority: 100, change_request: null, created_at: "...", updated_at: "..." }} />` is rendered
- **THEN** the rendered tree contains the text `ticket-0001` (monospace), `Add login page`, `alice`, and a badge with `100`

#### Scenario: A null assignee renders as `—`

- **WHEN** the same card is rendered with `assignee: null`
- **THEN** the rendered tree contains exactly one `—` glyph in the assignee slot

#### Scenario: Clicking a card navigates to `/tickets/:id`

- **WHEN** the card is rendered inside a `<MemoryRouter initialEntries={["/"]}>` and the user clicks its outermost element
- **THEN** the router's location becomes `/tickets/ticket-0001`

### Requirement: Drag-and-drop between columns calls `apiClient.transitionTicket(...)` and surfaces failures inline

The `<BoardCard>` SHALL be draggable (HTML attribute `draggable="true"`) and SHALL set the `dataTransfer` payload on `dragstart` to a documented JSON string `{ ticketId, fromStatus }`. Each column SHALL be a drop target: on `dragover` it SHALL call `event.preventDefault()` (required for the drop to fire) and SHALL set a `data-drop-target="true"` attribute for the duration of the drag; on `dragleave` and `drop` the attribute SHALL be cleared. On `drop`, the board SHALL read the `dataTransfer` payload, compute `toStatus` from the target column's `data-status`, and — only when `fromStatus !== toStatus` — call `apiClient.transitionTicket(ticketId, { from: fromStatus, to: toStatus })`. On success, the view SHALL apply the returned `TicketEnvelope.data` to its local state (the card moves to the new column). On failure (`KeniApiError`), the view SHALL render a one-line inline error on the affected card containing the error's `code` (the card stays visible with `data-error` set; clicking the card navigates to its detail page and dismisses the error). The card SHALL NOT be removed from its origin column before the server confirms; the mutation is server-confirmed per design.md Decision 4.

#### Scenario: Successful drop calls `transitionTicket` and moves the card

- **WHEN** a card representing `ticket-0001` with `status: "open"` is dragged from the `open` column and dropped on the `in_progress` column
- **AND** `apiClient.transitionTicket("ticket-0001", { from: "open", to: "in_progress" })` resolves with the matching `TicketEnvelope`
- **THEN** the rendered tree shows `ticket-0001` inside the `in_progress` column
- **AND** the `open` column no longer contains `ticket-0001`
- **AND** no `data-error` attribute is set on the card

#### Scenario: A drop on the same column issues no call

- **WHEN** a card with `status: "open"` is dragged from the `open` column and dropped back on the `open` column
- **THEN** `apiClient.transitionTicket` was not called
- **AND** the card's DOM position is unchanged

#### Scenario: A graph violation surfaces as an inline card error

- **WHEN** a card with `status: "open"` is dragged and dropped on the `tested` column
- **AND** `apiClient.transitionTicket("ticket-0001", { from: "open", to: "tested" })` rejects with `new KeniApiError(403, "status_graph_violation", { … })`
- **THEN** the card remains in the `open` column
- **AND** the card has `data-error="status_graph_violation"`
- **AND** the rendered text on the card contains `status_graph_violation`

#### Scenario: A `data-drop-target="true"` attribute stamps the active target during dragover

- **WHEN** a drag is in progress over the `in_progress` column
- **THEN** the `in_progress` column's container has `data-drop-target="true"`
- **AND** no other column has `data-drop-target="true"`
- **WHEN** the drag leaves the `in_progress` column without dropping
- **THEN** the column's `data-drop-target` attribute is removed

### Requirement: `ticket.created` and `ticket.updated` frames drive targeted updates

The board's frame handler SHALL inspect every incoming `EventFrame` and act on the following variants:

- `ticket.created` — call `apiClient.getTicket(payload.ticket_id)`, append the resolved `TicketResponse` (summary fields only) to the column named by `payload.status`. Duplicate ids (the ticket is already in the local state) SHALL be ignored without a refetch.
- `ticket.updated` with `payload.kind === "transition"` — if the ticket is in the local state, move it to the column named by `payload.status` by updating its `status` field only; no REST call. If the ticket is not in the local state, call `apiClient.getTicket(payload.ticket_id)` and insert it in the column named by `payload.status`.
- `ticket.updated` with `payload.kind === "patch"` — call `apiClient.getTicket(payload.ticket_id)` and replace the matching row in-place (the patch may have changed title / assignee / priority, which the frame does not carry).

Frames whose `event` is not one of the above SHALL be ignored. Frames whose `payload.ticket_id` cannot be resolved (the server responds 404 to the follow-up `getTicket`) SHALL be dropped with a `console.warn` and SHALL NOT insert a placeholder row.

#### Scenario: `ticket.created` triggers a `getTicket` refetch and appends the card

- **WHEN** `<BoardView />` is mounted with an empty ticket list
- **AND** a `ticket.created` frame arrives with `payload: { ticket_id: "ticket-0001", status: "open" }`
- **AND** `apiClient.getTicket("ticket-0001")` resolves with the matching `TicketEnvelope`
- **THEN** the `open` column contains exactly one card for `ticket-0001`
- **AND** `apiClient.listTickets` was not called as a result of the frame

#### Scenario: `ticket.updated` kind `transition` moves the card without a refetch

- **WHEN** the board state contains `ticket-0001` in the `open` column
- **AND** a `ticket.updated` frame arrives with `payload: { ticket_id: "ticket-0001", status: "in_progress", kind: "transition" }`
- **THEN** the card moves to the `in_progress` column
- **AND** `apiClient.getTicket` was not called
- **AND** `apiClient.listTickets` was not called

#### Scenario: `ticket.updated` kind `patch` triggers a `getTicket` refetch

- **WHEN** the board state contains `ticket-0001` in the `open` column with `title: "Old title"`
- **AND** a `ticket.updated` frame arrives with `payload: { ticket_id: "ticket-0001", status: "open", kind: "patch" }`
- **AND** `apiClient.getTicket("ticket-0001")` resolves with a `TicketEnvelope` whose `data.title === "New title"`
- **THEN** the card in the `open` column renders `New title`
- **AND** `apiClient.listTickets` was not called

#### Scenario: An unknown event variant is silently ignored

- **WHEN** an `EventFrame` arrives whose `event` is not `ticket.created` or `ticket.updated` (e.g., `pr.updated`)
- **THEN** the board's local state is unchanged
- **AND** no error is thrown

### Requirement: The `<CreateTicketForm>` creates a ticket via `apiClient.createTicket` and navigates to its detail route

`packages/spa/src/features/board/CreateTicketForm.tsx` SHALL render a collapsible form (collapsed by default behind a "New ticket" toggle button) with the following inputs: (1) a required `title` text input (non-empty); (2) a required `priority` integer input (HTML5 `type="number" step="1"`) defaulting to `100`; (3) an optional `assignee` text input (empty string is treated as `null`); (4) an optional `change_request` text input (empty string is treated as `null`); (5) an optional `body` textarea. Submitting the form SHALL call `apiClient.createTicket({ title, priority, assignee: assignee || null, change_request: change_request || null, body })`; on success the form SHALL collapse, the submit button SHALL re-enable, the form inputs SHALL reset to their defaults, and the view SHALL navigate to `/tickets/<data.id>` via `react-router-dom`'s `useNavigate()`. On failure (`KeniApiError`), the form SHALL render a one-line inline error below the submit button containing the error's `code` and SHALL remain expanded so the user can retry. While the request is in flight, the submit button SHALL be disabled.

#### Scenario: A valid submission creates a ticket and navigates to its detail route

- **WHEN** the form is expanded, the user types `Add login page` into the title and `100` into priority, and clicks Submit
- **AND** `apiClient.createTicket({ title: "Add login page", priority: 100, assignee: null, change_request: null, body: "" })` resolves with a `TicketEnvelope` whose `data.id === "ticket-0001"`
- **THEN** the router's location becomes `/tickets/ticket-0001`
- **AND** the form is collapsed (the "New ticket" toggle is visible and the form inputs are not)

#### Scenario: Empty title prevents submission

- **WHEN** the user leaves the title blank and attempts to submit
- **THEN** `apiClient.createTicket` is not called
- **AND** the form renders a validation message on the title input

#### Scenario: A rejected submission surfaces an inline error

- **WHEN** the user submits a valid form
- **AND** `apiClient.createTicket(...)` rejects with `new KeniApiError(400, "validation_failed", { … })`
- **THEN** the form remains expanded
- **AND** the submit button is re-enabled
- **AND** the form renders a one-line inline error containing `validation_failed`
- **AND** the router's location is unchanged

#### Scenario: The submit button is disabled during an in-flight call

- **WHEN** the user submits a valid form
- **AND** `apiClient.createTicket(...)` is set up to resolve after a delay
- **THEN** the submit button's `disabled` attribute is `true` until the promise settles

### Requirement: The board renders explicit loading, empty, error, and disconnected UX states

The board SHALL render the following states explicitly:

- **loading** — before `listTickets()` resolves the first time, the board SHALL render a single `data-testid="board-loading"` indicator (the implementation-specific visual is unconstrained); columns SHALL NOT render.
- **error** — when `listTickets()` rejects with a `KeniApiError`, the board SHALL render a `data-testid="board-error"` element with the error's `code` and a `Retry` button; clicking `Retry` SHALL re-issue `listTickets()`.
- **empty** — when `listTickets()` resolves with `data: []`, the twelve columns SHALL render but each SHALL be empty; no separate `data-testid="board-empty"` panel is rendered. The `<CreateTicketForm>` SHALL remain visible so the user can create the first ticket.
- **disconnected** — when the events client is in the `"disconnected"` state, the board container SHALL have `data-disconnected="true"` (cards keep rendering their last-seen state per the roster-panel pattern).

#### Scenario: Loading indicator renders before the first list resolves

- **WHEN** `<BoardView />` is mounted against an `apiClient` whose `listTickets()` is pending
- **THEN** the rendered tree contains exactly one `data-testid="board-loading"` element
- **AND** no column elements are rendered

#### Scenario: Error renders the retry surface and re-issues `listTickets` on click

- **WHEN** `<BoardView />` is mounted and `listTickets()` rejects with `new KeniApiError(500, "internal_error", { … })`
- **THEN** the rendered tree contains a `data-testid="board-error"` element containing `internal_error`
- **AND** a button whose accessible name is `Retry` is present
- **WHEN** the user clicks `Retry` and `listTickets()` is then set up to resolve with one row
- **THEN** the error panel is removed from the rendered tree
- **AND** the twelve columns render

#### Scenario: Empty list renders all twelve columns empty

- **WHEN** `listTickets()` resolves with `{ data: [], project_id: "..." }`
- **THEN** every column has a card count of `0` in its header
- **AND** the `<CreateTicketForm>` remains visible

#### Scenario: Disconnected state stamps the container without removing cards

- **WHEN** the board is rendered with two cards and the events client transitions to `"disconnected"`
- **THEN** the board container has `data-disconnected="true"`
- **AND** both cards remain in the rendered tree

### Requirement: The status-graph mirror in the SPA matches the server's `TICKET_STATUS_TRANSITIONS` constant

`packages/spa/src/features/shared/statusGraph.ts` SHALL export two constants mirroring the orchestration server's graph: `SPA_TICKET_STATUS_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>>` and `SPA_PR_STATUS_TRANSITIONS: Readonly<Record<PRStatus, readonly PRStatus[]>>`. The edges in `SPA_TICKET_STATUS_TRANSITIONS` SHALL match `spec.md` §4.1 verbatim. A companion test file `statusGraph_test.ts` SHALL import the server's `TICKET_STATUS_TRANSITIONS` and `PR_STATUS_TRANSITIONS` from `@keni/server` (type-only import is sufficient) and SHALL assert deep equality with the SPA's mirror so `deno task check` catches drift. A comment at the top of `statusGraph.ts` SHALL cross-link the orchestration-server spec's "A status-graph constant encodes the §4.1 ticket lifecycle" requirement.

#### Scenario: The SPA mirror exports both maps

- **WHEN** the file `packages/spa/src/features/shared/statusGraph.ts` is read
- **THEN** it exports `SPA_TICKET_STATUS_TRANSITIONS` and `SPA_PR_STATUS_TRANSITIONS` as `Readonly<Record<...>>` frozen constants
- **AND** `SPA_TICKET_STATUS_TRANSITIONS` contains all twelve `TicketStatus` keys per `spec.md` §4.1

#### Scenario: The drift-check test asserts deep equality with the server's constants

- **WHEN** `deno task check` is invoked from the workspace root
- **AND** the server's `TICKET_STATUS_TRANSITIONS` is modified (e.g., a new edge is added) without updating the SPA mirror
- **THEN** `deno task test` fails with the drift-check test pointing at `statusGraph_test.ts`

### Requirement: The component test file mounts the board against in-memory clients and asserts documented behaviours

`packages/spa/src/features/board/BoardView_test.tsx` SHALL exist and SHALL contain `Deno.test` cases that, at minimum, assert: (1) the loading / empty / error / disconnected states render the documented elements; (2) twelve columns render in the documented order; (3) a `ticket.created` frame appends a card after a `getTicket` refetch; (4) a `ticket.updated` frame with `kind: "transition"` moves a card without a refetch; (5) a `ticket.updated` frame with `kind: "patch"` refetches and updates fields in place; (6) a successful drop calls `transitionTicket` and moves the card; (7) a failed drop leaves the card in its origin column with `data-error` set; (8) the `<CreateTicketForm>` submit navigates on success and surfaces an inline error on failure; (9) a `"connected"` lifecycle transition triggers an unconditional `listTickets()` refetch. The tests SHALL import `../../test_setup.ts` first and SHALL build inline `apiClient`-shaped and `eventsClient`-shaped fakes (no global mocking framework).

#### Scenario: Test file is discovered by `deno task test`

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** `packages/spa/src/features/board/BoardView_test.tsx` is discovered and its test cases are executed
- **AND** every documented test case (nine cases) is present and passes

#### Scenario: Tests build clients in-memory

- **WHEN** the file `packages/spa/src/features/board/BoardView_test.tsx` is read
- **THEN** the file does not import any module from `npm:vitest`, `npm:jest`, `npm:sinon`, `npm:msw`, or any equivalent global mocking framework
- **AND** the test cases construct `apiClient`-shaped and `eventsClient`-shaped objects inline using the interfaces exported from `transport/`
