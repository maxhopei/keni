## ADDED Requirements

### Requirement: `TicketDetailView` mounts at `/tickets/:id` and owns the ticket's data lifecycle

`packages/spa/src/features/ticketDetail/TicketDetailView.tsx` SHALL export a default `<TicketDetailView />` React component. The router SHALL mount it at `/tickets/:id` inside `<AppShell />`'s `<Outlet />`. The component SHALL: (1) read the route param `id` via `useParams()`; (2) read `apiClient` and `eventsClient` via the documented React contexts; (3) on mount (and on every change of the `id` param), call `apiClient.getTicket(id)` and store the resolved `TicketResponse` in local state; (4) on mount, call `apiClient.listActivity({})` once and store the resolved `ActivityEntryResponse[]` (the full list — client-side filtering runs on the render path); (5) subscribe to `eventsClient` via `onEvent(...)` for `ticket.updated` and `activity.appended` frames and via `onLifecycle(...)` for lifecycle events; (6) on every `"connected"` lifecycle transition, refetch both `getTicket(id)` and `listActivity({})`; (7) on unmount, unsubscribe. The component SHALL NOT issue REST calls from any source other than `apiClient`; SHALL NOT open a WebSocket from any source other than `eventsClient`.

#### Scenario: Mount fetches the ticket and the activity list

- **WHEN** the router navigates to `/tickets/ticket-0001` and `<TicketDetailView />` mounts
- **AND** `apiClient.getTicket` and `apiClient.listActivity` are instrumented
- **THEN** `getTicket("ticket-0001")` was called exactly once
- **AND** `listActivity({})` was called exactly once
- **AND** the rendered tree reflects both resolutions

#### Scenario: Navigating to a different ticket id refetches

- **WHEN** the view is mounted at `/tickets/ticket-0001` and subsequently the router navigates to `/tickets/ticket-0002`
- **THEN** `getTicket("ticket-0002")` is called
- **AND** the rendered tree reflects the second ticket's fields

#### Scenario: `connected` lifecycle transition refetches both resources

- **WHEN** the view is mounted at `/tickets/ticket-0001` and the events client emits `"connected"` after the initial resolutions
- **THEN** `getTicket("ticket-0001")` was called exactly twice (mount + lifecycle)
- **AND** `listActivity({})` was called exactly twice (mount + lifecycle)

#### Scenario: Unmount unsubscribes cleanly

- **WHEN** the view is mounted and subsequently unmounted
- **THEN** the in-memory `eventsClient` reports zero subscribers and zero lifecycle listeners attributable to the view after unmount

### Requirement: The view renders every field on `TicketResponse` in a documented layout

The view SHALL render: (1) the `ticket.id` as a prominent monospace header label; (2) the `ticket.title` as the main heading; (3) a status pill displaying `ticket.status` (Title Case); (4) a metadata row showing `assignee` (or `—` when null), `priority`, and `change_request` (rendered as a plain monospace string in this step — step 24 wires the `<Link>`); (5) the `created_at` and `updated_at` ISO timestamps as human-readable labels (e.g., relative time via the existing `formatRelativeTime` helper for `updated_at`); (6) the `ticket.body` as the main content block, rendered as plain text (no markdown parsing in this step). Every field SHALL be sourced verbatim from `TicketResponse`.

#### Scenario: A fully-populated ticket renders every field

- **WHEN** the view is mounted and `getTicket` resolves with `{ id: "ticket-0001", title: "Add login page", status: "in_progress", assignee: "alice", priority: 100, change_request: "cr-0003", body: "Users should be able to log in", created_at: "...", updated_at: "2026-05-04T07:00:00Z" }`
- **THEN** the rendered tree contains `ticket-0001` (monospace), `Add login page`, `In progress`, `alice`, `100`, `cr-0003`, and `Users should be able to log in`

#### Scenario: Null assignee renders as `—`

- **WHEN** the resolved ticket has `assignee: null`
- **THEN** the assignee slot's text is exactly `—`

#### Scenario: Null `change_request` renders as `—`

- **WHEN** the resolved ticket has `change_request: null`
- **THEN** the change_request slot's text is exactly `—`

### Requirement: Title and body are user-editable via `patchTicket`

The view SHALL render two editable fields: the **title** (inline editable — click-to-edit, Enter / blur commits, Escape cancels) and the **body** (a textarea with Save / Cancel buttons). Committing a change SHALL call `apiClient.patchTicket(id, patch)` where `patch` contains only the field that changed. While the request is in flight, the affected input SHALL be disabled. On success, the view SHALL apply the returned `TicketEnvelope.data` to its local state. On failure (`KeniApiError`), the view SHALL re-enable the input and render a one-line inline error near the input containing the error's `code`. `patch` SHALL NOT include the `status` field (the server rejects with `400 status_in_patch` / `validation_failed`); status changes flow through the transition panel.

#### Scenario: Title edit commits on Enter

- **WHEN** the user clicks the title, edits it to `New title`, and presses Enter
- **AND** `apiClient.patchTicket("ticket-0001", { title: "New title" })` resolves with the updated envelope
- **THEN** the rendered title is `New title`
- **AND** `apiClient.patchTicket` was called with exactly `{ title: "New title" }` (no other fields)

#### Scenario: Body edit commits on Save

- **WHEN** the user clicks the body's Edit button, types into the textarea, and clicks Save
- **AND** `apiClient.patchTicket("ticket-0001", { body: "Updated body" })` resolves with the updated envelope
- **THEN** the rendered body is `Updated body`

#### Scenario: A rejected title edit re-enables the input and surfaces an error

- **WHEN** the user commits a title edit and `patchTicket` rejects with `new KeniApiError(422, "invalid_artifact", { reason: "size_exceeded" })`
- **THEN** the title input is re-enabled
- **AND** a one-line inline error near the title contains `invalid_artifact`

#### Scenario: Escape cancels a pending title edit

- **WHEN** the user clicks the title, types new text, and presses Escape before committing
- **AND** `apiClient.patchTicket` was not called
- **THEN** the rendered title is unchanged from its pre-edit value

### Requirement: The "Advanced: transition" panel surfaces the raw transition endpoint with a UX caveat

The view SHALL render a collapsed `<details>` element labelled `Advanced: transition (prototype only)`. When expanded it SHALL show: (1) a read-only `from` display showing the ticket's current status; (2) a `to` dropdown populated with every status in `SPA_TICKET_STATUS_TRANSITIONS[ticket.status]` (from `packages/spa/src/features/shared/statusGraph.ts`); (3) a `Transition` button; (4) a visible caveat text: `This is the raw override path. It does not confirm the transition or record a manual_override activity entry. Step 25 will replace this panel with a confirmation flow.`. Clicking `Transition` SHALL call `apiClient.transitionTicket(id, { from: ticket.status, to: <selected> })`; on success the envelope's `data` SHALL replace the local ticket state; on failure the error's `code` SHALL render below the button (with the same resilience rules as other edit panels). When `SPA_TICKET_STATUS_TRANSITIONS[ticket.status]` is empty (the terminal `done` status), the dropdown SHALL render a disabled single option `— no transitions —` and the Transition button SHALL be disabled.

#### Scenario: The panel is collapsed by default

- **WHEN** `<TicketDetailView />` is first rendered
- **THEN** the `<details>` element exists but its content (beyond the `<summary>` label) is not visible in the DOM (i.e., the `open` attribute is absent)

#### Scenario: The `to` dropdown lists only reachable statuses

- **WHEN** the ticket's status is `open`
- **THEN** the dropdown's options are exactly `in_progress` (per `spec.md` §4.1)
- **WHEN** the ticket's status is `in_review`
- **THEN** the dropdown's options are exactly `has_comments` and `approved`

#### Scenario: The caveat text is rendered

- **WHEN** the panel is expanded
- **THEN** the rendered tree contains the text `raw override path`
- **AND** the rendered tree references `Step 25`

#### Scenario: A successful transition updates the view

- **WHEN** the ticket's status is `open`, the user selects `in_progress` and clicks Transition
- **AND** `apiClient.transitionTicket("ticket-0001", { from: "open", to: "in_progress" })` resolves with the updated envelope
- **THEN** the rendered status pill is `In progress`

#### Scenario: A terminal status disables the control

- **WHEN** the ticket's status is `done`
- **THEN** the dropdown's single option text is `— no transitions —`
- **AND** the Transition button's `disabled` attribute is `true`

### Requirement: Status history is sourced from the activity log filtered by `refs.ticket === id`

The view SHALL render a `Status history` section whose rows are derived from the local `ActivityEntryResponse[]` state by filtering on `refs.ticket === id`. Rows SHALL render in increasing-id order (chronological) and display: the entry's `timestamp` (as a short relative time via `formatRelativeTime`), the entry's `agent`, the entry's `role`, the entry's `event`, and the entry's `summary` (or `—` when null). The section SHALL explicitly render an empty state `data-testid="history-empty"` with the text `No activity yet.` when the filtered list is empty.

#### Scenario: Matching entries render in increasing-id order

- **WHEN** the activity list contains two entries with `refs.ticket === "ticket-0001"` (ids `A` < `B`) and one with `refs.ticket === "ticket-0002"`
- **THEN** the status history section renders exactly two rows
- **AND** the first row's entry id is `A`
- **AND** the second row's entry id is `B`

#### Scenario: No matching entries renders the empty state

- **WHEN** the activity list contains only entries whose `refs.ticket !== id`
- **THEN** the status history section contains `data-testid="history-empty"`
- **AND** the rendered text includes `No activity yet.`

### Requirement: The comment thread materialises activity entries with `event === "ticket_comment"`

The view SHALL render a `Comments` section whose rows are derived from the local `ActivityEntryResponse[]` state by filtering on `refs.ticket === id && event === "ticket_comment"`. Each comment row SHALL render: the `agent` (author) in a prominent label; the `role` in a smaller muted label; the `timestamp` (via `formatRelativeTime`); and the `summary` as the comment body. Comments SHALL render in increasing-id order (chronological — oldest first, consistent with standard comment-thread conventions). An empty filter result SHALL render a `data-testid="comments-empty"` element with text `No comments yet.`.

#### Scenario: A matching entry renders as a comment

- **WHEN** the activity list contains one entry with `refs.ticket === "ticket-0001"`, `event === "ticket_comment"`, `agent === "user"`, `role === "user"`, `summary === "Please add a forgot-password link"`
- **THEN** the comments section contains one row
- **AND** the row's text includes `user`, `Please add a forgot-password link`

#### Scenario: Non-comment activity entries are excluded

- **WHEN** the activity list contains one `ticket_comment` entry and one `session_start` entry, both with `refs.ticket === "ticket-0001"`
- **THEN** the comments section renders exactly one row (the comment)
- **AND** the status history section renders both rows (comment + session_start)

### Requirement: The "Post comment" form calls `apiClient.appendActivity` with the documented payload

The view SHALL render a "Post comment" textarea below the comments section with: (1) a character counter showing `<used>/3800`; (2) a Post button that is disabled while the textarea is empty or while the input length exceeds 3800 characters. Submitting SHALL call `apiClient.appendActivity({ session_id: "ui", agent: "user", role: "user", event: "ticket_comment", summary: <typed text>, refs: { ticket: id } })`. On success the textarea SHALL clear and the Post button SHALL re-enable; the comment will appear either via the subsequent `activity.appended` frame or via the next `listActivity` refetch (no immediate optimistic insertion in this step). On failure the Post button SHALL re-enable and a one-line inline error SHALL render below the textarea containing the error's `code`. While the request is in flight, the Post button SHALL be disabled.

#### Scenario: A valid comment is posted

- **WHEN** the user types `Nice work` and clicks Post
- **AND** `apiClient.appendActivity` resolves
- **THEN** `apiClient.appendActivity` was called exactly once with the arguments `{ session_id: "ui", agent: "user", role: "user", event: "ticket_comment", summary: "Nice work", refs: { ticket: "ticket-0001" } }`
- **AND** the textarea's value is the empty string after the promise resolves

#### Scenario: The character counter blocks submission above 3800

- **WHEN** the user types a 3801-character string
- **THEN** the character counter shows `3801/3800`
- **AND** the Post button's `disabled` attribute is `true`

#### Scenario: An empty textarea disables the Post button

- **WHEN** the textarea's value is the empty string
- **THEN** the Post button's `disabled` attribute is `true`

#### Scenario: A rejected post surfaces an inline error

- **WHEN** the user posts a comment and `appendActivity` rejects with `new KeniApiError(422, "invalid_artifact", { reason: "size_exceeded" })`
- **THEN** the Post button is re-enabled
- **AND** the rendered tree contains a one-line error containing `invalid_artifact`
- **AND** the textarea's value is unchanged (the user can edit and retry)

### Requirement: `ticket.updated` frames for this ticket update the local ticket state

The frame handler SHALL, for every incoming `EventFrame` whose `event === "ticket.updated"` and `payload.ticket_id === id`: call `apiClient.getTicket(id)` and replace the local ticket state with the resolved envelope's `data`. Frames for other ticket ids SHALL be ignored. Frames for unrelated events (`ticket.created`, `pr.updated`, etc.) SHALL be ignored.

#### Scenario: A `ticket.updated` frame for this ticket refetches

- **WHEN** the view is mounted at `/tickets/ticket-0001`
- **AND** a `ticket.updated` frame arrives with `payload: { ticket_id: "ticket-0001", status: "in_review", kind: "transition" }`
- **AND** `apiClient.getTicket("ticket-0001")` resolves with the updated envelope
- **THEN** the rendered status pill shows `In review`

#### Scenario: A `ticket.updated` frame for another ticket is ignored

- **WHEN** the view is mounted at `/tickets/ticket-0001`
- **AND** a `ticket.updated` frame arrives with `payload: { ticket_id: "ticket-0002", status: "...", kind: "transition" }`
- **THEN** `apiClient.getTicket` was not called as a result of the frame

### Requirement: `activity.appended` frames matching the ticket prepend to the local activity state

The frame handler SHALL, for every incoming `EventFrame` whose `event === "activity.appended"`: if the frame's `payload` is insufficient to determine ticket membership (`payload` carries `entry_id`, `agent`, `role`, `event` but not `refs`), the handler SHALL call `apiClient.listActivity({})` once to refetch (debounced to avoid a refetch storm during a burst of appends — a 250 ms trailing debounce). The debounce window SHALL be expressed as a single named constant `TICKET_ACTIVITY_REFETCH_DEBOUNCE_MS = 250` in the component module. Frames whose `payload.event === "ticket_comment"` SHALL be processed the same way as other events (no special handling in this step — the `refs` check runs during the subsequent filter-on-render).

#### Scenario: A burst of `activity.appended` frames collapses into one refetch

- **WHEN** five `activity.appended` frames arrive within 100 ms of each other
- **AND** the fake clock advances by 250 ms after the last frame
- **THEN** `apiClient.listActivity({})` was called exactly once as a result

#### Scenario: The debounce constant is the single source of truth

- **WHEN** the file `packages/spa/src/features/ticketDetail/TicketDetailView.tsx` is read
- **THEN** the file declares `const TICKET_ACTIVITY_REFETCH_DEBOUNCE_MS = 250` exactly once
- **AND** the debounce timer references that constant (no inline literal)

### Requirement: The "Linked PR" section renders one card per PR whose `ticket === id`

On mount, the view SHALL call `apiClient.listPrs({ ticket: id })` and render each resolved `PRSummaryResponse` as a `<Link to={\`/prs/${pr.id}\`}>` card showing `pr.id` (monospace), `pr.title`, `pr.status`, `pr.author`. An empty result SHALL render a `data-testid="no-linked-pr"` element with text `No pull requests yet.`. A `pr.created` frame whose `payload.ticket === id` OR a `pr.updated` frame whose referenced PR's ticket is `id` SHALL trigger a refetch of `listPrs({ ticket: id })`. (The ticket-side `pr.updated` match runs on the `pr_id` via a local cache: if the current state contains a PR whose id matches `payload.pr_id`, refetch.)

#### Scenario: A linked PR renders with a navigating link

- **WHEN** `apiClient.listPrs({ ticket: "ticket-0001" })` resolves with `{ data: [{ id: "pr-0001", title: "Login form", status: "open", ticket: "ticket-0001", author: "alice", branch: "...", created_at: "...", updated_at: "..." }], project_id: "..." }`
- **THEN** the Linked PR section contains one link
- **AND** the link's text includes `pr-0001`, `Login form`, `Open`, `alice`
- **WHEN** the user clicks the link
- **THEN** the router's location becomes `/prs/pr-0001`

#### Scenario: An empty result renders the empty state

- **WHEN** `listPrs({ ticket: id })` resolves with `{ data: [], project_id: "..." }`
- **THEN** the Linked PR section contains `data-testid="no-linked-pr"`

#### Scenario: A `pr.created` frame for this ticket triggers a refetch

- **WHEN** the view is mounted at `/tickets/ticket-0001` with no linked PRs
- **AND** a `pr.created` frame arrives with `payload: { pr_id: "pr-0002", status: "open", ticket: "ticket-0001" }`
- **THEN** `apiClient.listPrs({ ticket: "ticket-0001" })` was called a second time as a result

### Requirement: The view renders loading, error, and disconnected UX states

The view SHALL render: (1) **loading** — before `getTicket` resolves the first time, a single `data-testid="ticket-loading"` element; (2) **error** — when `getTicket` rejects with `KeniApiError`, a `data-testid="ticket-error"` element with the error's `code` and a `Retry` button; (3) **not-found** — when the error's `code === "store_not_found"`, a `data-testid="ticket-not-found"` element with text `Ticket <id> does not exist.` instead of the generic error; (4) **disconnected** — when the events client is in `"disconnected"`, the view container has `data-disconnected="true"`.

#### Scenario: Not-found is distinguished from generic errors

- **WHEN** `getTicket("ticket-9999")` rejects with `new KeniApiError(404, "store_not_found", { … })`
- **THEN** the rendered tree contains `data-testid="ticket-not-found"`
- **AND** the rendered text includes `ticket-9999 does not exist`
- **AND** no `data-testid="ticket-error"` element is rendered

### Requirement: The component test file asserts the documented behaviours

`packages/spa/src/features/ticketDetail/TicketDetailView_test.tsx` SHALL exist and SHALL contain `Deno.test` cases that, at minimum, assert: (1) the loading / error / not-found / disconnected states; (2) every field of `TicketResponse` is rendered with the documented fallbacks; (3) title / body edits call `patchTicket` with the right patch and surface errors inline; (4) the transition panel is collapsed by default, the `to` dropdown contains only reachable statuses, and a successful transition updates the view; (5) the comment thread renders `ticket_comment` activity entries and the status history renders all matching activity entries; (6) posting a comment calls `appendActivity` with the documented payload and clears the textarea on success; (7) a `ticket.updated` frame for this ticket refetches via `getTicket`; (8) a burst of `activity.appended` frames collapses into one debounced `listActivity` refetch; (9) the Linked PR section renders a navigating link and refetches on `pr.created`. Tests SHALL import `../../test_setup.ts` first and SHALL build inline `apiClient` / `eventsClient` fakes.

#### Scenario: Test file is discovered by `deno task test`

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** `packages/spa/src/features/ticketDetail/TicketDetailView_test.tsx` is discovered and its test cases are executed
- **AND** every documented test case (nine cases) is present and passes
