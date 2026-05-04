# spa-pr-detail Specification

## Purpose

Defines the contract for the **pull-request detail** route (`/prs/:id`) in the SPA's shared shell (`spa-shell`) and beside the roster (`spa-agent-roster`), linked from boards and ticket detail (`spa-board`, `spa-ticket-detail`). Pins authoritative `PRResponse` rendering including ticket cross-link navigation, intent editing through `patchPrIntent`, PR status transitions gated by `SPA_PR_STATUS_TRANSITIONS` behind the same raw-override caveat as tickets, gated merge with native confirm and typed `merge_conflict` handling, `pr.updated`-driven refetch, reconnect-tier `getPr` refreshes, and documented loading / error / not-found / disconnected states with `PRDetailView_test.tsx` asserting behaviour including stubbed `window.confirm`. Keeps PR-specific workflows separate so merge safety and reviewer UX can deepen without rewriting board or ticket specs.

## Requirements

### Requirement: `PRDetailView` mounts at `/prs/:id` and owns the PR's data lifecycle

`packages/spa/src/features/prDetail/PRDetailView.tsx` SHALL export a default `<PRDetailView />` React component. The router SHALL mount it at `/prs/:id` inside `<AppShell />`'s `<Outlet />`. The component SHALL: (1) read the route param `id` via `useParams()`; (2) read `apiClient` and `eventsClient` via the documented React contexts; (3) on mount (and on every change of the `id` param), call `apiClient.getPr(id)` and store the resolved `PRResponse` in local state; (4) subscribe to `eventsClient` via `onEvent(...)` for `pr.updated` frames and via `onLifecycle(...)` for lifecycle events; (5) on every `"connected"` lifecycle transition, refetch via `getPr(id)`; (6) on unmount, unsubscribe. The component SHALL NOT issue REST calls from any source other than `apiClient`; SHALL NOT open a WebSocket from any source other than `eventsClient`.

#### Scenario: Mount fetches the PR

- **WHEN** the router navigates to `/prs/pr-0001` and `<PRDetailView />` mounts
- **AND** `apiClient.getPr` is instrumented
- **THEN** `getPr("pr-0001")` was called exactly once
- **AND** the rendered tree reflects the resolution

#### Scenario: Navigating to a different PR id refetches

- **WHEN** the view is mounted at `/prs/pr-0001` and subsequently the router navigates to `/prs/pr-0002`
- **THEN** `getPr("pr-0002")` is called
- **AND** the rendered tree reflects the second PR's fields

#### Scenario: `connected` lifecycle transition refetches

- **WHEN** the view is mounted at `/prs/pr-0001` and the events client emits `"connected"` after the initial resolution
- **THEN** `getPr("pr-0001")` was called exactly twice (mount + lifecycle)

#### Scenario: Unmount unsubscribes cleanly

- **WHEN** the view is mounted and subsequently unmounted
- **THEN** the in-memory `eventsClient` reports zero subscribers and zero lifecycle listeners attributable to the view after unmount

### Requirement: The view renders every field on `PRResponse` in a documented layout

The view SHALL render: (1) the `pr.id` as a prominent monospace header label; (2) the `pr.title` as the main heading; (3) a status pill displaying `pr.status` (Title Case); (4) a metadata row showing `ticket` (as a `<Link to={\`/tickets/${pr.ticket}\`}>`), `branch` (monospace), and `author`; (5) the `created_at` and `updated_at` ISO timestamps as human-readable labels; (6) the `pr.body` as the main content block, labelled `Intent`, rendered as plain text. Every field SHALL be sourced verbatim from `PRResponse`.

#### Scenario: A fully-populated PR renders every field

- **WHEN** the view is mounted and `getPr` resolves with `{ id: "pr-0001", title: "Login form", status: "approved", ticket: "ticket-0001", branch: "ticket-0001", author: "alice", body: "Implements the login page", created_at: "...", updated_at: "2026-05-04T07:00:00Z" }`
- **THEN** the rendered tree contains `pr-0001` (monospace), `Login form`, `Approved`, `ticket-0001` (as a link), `alice`, `Implements the login page`
- **AND** the ticket link's `href` is `/tickets/ticket-0001`

#### Scenario: The "Linked ticket" link navigates

- **WHEN** the user clicks the `ticket-0001` link inside `<MemoryRouter initialEntries={["/prs/pr-0001"]}>`
- **THEN** the router's location becomes `/tickets/ticket-0001`

### Requirement: The intent (PR body) is editable via `patchPrIntent`

The view SHALL render the intent (PR body) with a Save / Cancel affordance: an Edit button expands the intent into a textarea; Save calls `apiClient.patchPrIntent(id, { intent: <typed text> })`; Cancel reverts the textarea to the current intent and collapses. While the request is in flight, Save SHALL be disabled. On success, the view SHALL apply the returned `PREnvelope.data.body` to its local state and collapse the editor. On failure (`KeniApiError`), the editor SHALL re-enable and render a one-line inline error containing the error's `code`.

#### Scenario: A successful intent edit updates the view

- **WHEN** the user clicks Edit, types `Updated intent`, and clicks Save
- **AND** `apiClient.patchPrIntent("pr-0001", { intent: "Updated intent" })` resolves with the updated envelope
- **THEN** the rendered intent is `Updated intent`
- **AND** the editor is collapsed (the Edit button is visible again)

#### Scenario: Cancel reverts the textarea

- **WHEN** the user clicks Edit, types new text, and clicks Cancel
- **AND** `apiClient.patchPrIntent` was not called
- **THEN** the rendered intent is unchanged

#### Scenario: A rejected intent edit re-enables Save and surfaces an error

- **WHEN** the user saves an edit and `patchPrIntent` rejects with `new KeniApiError(422, "invalid_artifact", { … })`
- **THEN** the Save button is re-enabled
- **AND** the rendered tree contains a one-line error containing `invalid_artifact`

### Requirement: The "Advanced: transition" panel surfaces the raw PR transition endpoint with a UX caveat

The view SHALL render a collapsed `<details>` element labelled `Advanced: transition (prototype only)`. When expanded it SHALL show: (1) a read-only `from` display showing the PR's current status; (2) a `to` dropdown populated with every status in `SPA_PR_STATUS_TRANSITIONS[pr.status]`; (3) a `Transition` button; (4) a visible caveat text: `This is the raw override path. It does not confirm the transition or record a manual_override activity entry. Step 25 will replace this panel with a confirmation flow.`. Clicking `Transition` SHALL call `apiClient.transitionPr(id, { from: pr.status, to: <selected> })`; on success the envelope's `data` SHALL replace the local PR state; on failure the error's `code` SHALL render below the button. When `SPA_PR_STATUS_TRANSITIONS[pr.status]` is empty, the dropdown SHALL render `— no transitions —` and the Transition button SHALL be disabled.

#### Scenario: The panel is collapsed by default

- **WHEN** `<PRDetailView />` is first rendered
- **THEN** the `<details>` element exists but its content (beyond the `<summary>` label) is not visible in the DOM (i.e., the `open` attribute is absent)

#### Scenario: The caveat text is rendered

- **WHEN** the panel is expanded
- **THEN** the rendered tree contains the text `raw override path`
- **AND** the rendered tree references `Step 25`

#### Scenario: A successful transition updates the view

- **WHEN** the PR's status is `in_review`, the user selects `approved` and clicks Transition
- **AND** `apiClient.transitionPr("pr-0001", { from: "in_review", to: "approved" })` resolves with the updated envelope
- **THEN** the rendered status pill is `Approved`

### Requirement: The Merge button is rendered only when `pr.status === "approved"` and calls `apiClient.mergePr`

The view SHALL render a `Merge` button immediately below the header when (and only when) `pr.status === "approved"`. Clicking the button SHALL first show a native `window.confirm("Merge pr-NNNN? This will fast-forward the PR branch onto main.")` prompt; if the user cancels, no call is made. If the user confirms, the button SHALL be disabled and `apiClient.mergePr(id)` SHALL be called. On success, the view SHALL refetch via `getPr(id)` (the PR status transitions from `approved` to `merged` as a side-effect of the merge endpoint); the Merge button disappears when the refetch resolves. On failure with `KeniApiError` of code `merge_conflict`, the view SHALL render a prominent error panel below the header with text derived from `error.message` and `error.details` and SHALL re-enable the Merge button. Other error codes SHALL render a one-line inline error and re-enable the button.

#### Scenario: The Merge button is hidden for non-approved statuses

- **WHEN** the PR's status is `open`, `in_review`, `has_comments`, `merged`, or any other non-approved value
- **THEN** the rendered tree does not contain any button labelled `Merge`

#### Scenario: A successful merge refetches and hides the button

- **WHEN** the PR's status is `approved` and the user clicks Merge
- **AND** the `window.confirm` prompt resolves to `true`
- **AND** `apiClient.mergePr("pr-0001")` resolves with a `MergePrEnvelope`
- **AND** the subsequent `getPr("pr-0001")` resolves with status `merged`
- **THEN** the rendered status pill becomes `Merged`
- **AND** no button labelled `Merge` is rendered

#### Scenario: A cancelled confirm skips the merge

- **WHEN** the PR's status is `approved` and the user clicks Merge
- **AND** the `window.confirm` prompt resolves to `false`
- **THEN** `apiClient.mergePr` was not called
- **AND** the rendered state is unchanged

#### Scenario: A `merge_conflict` error renders a prominent panel

- **WHEN** the PR's status is `approved`, the user confirms the merge, and `apiClient.mergePr` rejects with `new KeniApiError(409, "merge_conflict", { reason: "non_fast_forward" })`
- **THEN** the rendered tree contains a prominent error panel with text including `merge_conflict`
- **AND** the Merge button is re-enabled

### Requirement: `pr.updated` frames for this PR refetch via `getPr`

The frame handler SHALL, for every incoming `EventFrame` whose `event === "pr.updated"` and `payload.pr_id === id`: call `apiClient.getPr(id)` and replace the local PR state. Frames for other PR ids SHALL be ignored. Frames for unrelated events SHALL be ignored.

#### Scenario: A `pr.updated` frame for this PR refetches

- **WHEN** the view is mounted at `/prs/pr-0001`
- **AND** a `pr.updated` frame arrives with `payload: { pr_id: "pr-0001", status: "merged", kind: "transition" }`
- **AND** `apiClient.getPr("pr-0001")` resolves with the updated envelope
- **THEN** the rendered status pill shows `Merged`

#### Scenario: A `pr.updated` frame for another PR is ignored

- **WHEN** the view is mounted at `/prs/pr-0001`
- **AND** a `pr.updated` frame arrives with `payload: { pr_id: "pr-0002", … }`
- **THEN** `apiClient.getPr` was not called as a result of the frame

### Requirement: The view renders loading, error, not-found, and disconnected UX states

The view SHALL render: (1) **loading** — before `getPr` resolves the first time, a single `data-testid="pr-loading"` element; (2) **error** — when `getPr` rejects with `KeniApiError`, a `data-testid="pr-error"` element with the error's `code` and a `Retry` button; (3) **not-found** — when the error's `code === "store_not_found"`, a `data-testid="pr-not-found"` element with text `PR <id> does not exist.`; (4) **disconnected** — when the events client is in `"disconnected"`, the view container has `data-disconnected="true"`.

#### Scenario: Not-found is distinguished from generic errors

- **WHEN** `getPr("pr-9999")` rejects with `new KeniApiError(404, "store_not_found", { … })`
- **THEN** the rendered tree contains `data-testid="pr-not-found"`
- **AND** the rendered text includes `pr-9999 does not exist`

### Requirement: The component test file asserts the documented behaviours

`packages/spa/src/features/prDetail/PRDetailView_test.tsx` SHALL exist and SHALL contain `Deno.test` cases that, at minimum, assert: (1) the loading / error / not-found / disconnected states; (2) every field of `PRResponse` is rendered and the Linked ticket link navigates; (3) an intent edit calls `patchPrIntent` with the right payload and surfaces errors inline; (4) the transition panel is collapsed by default, the `to` dropdown contains only reachable statuses, and a successful transition updates the view; (5) the Merge button renders only when `pr.status === "approved"`; a cancelled `window.confirm` skips the call; a successful merge refetches and hides the button; a `merge_conflict` renders a prominent error; (6) a `pr.updated` frame for this PR refetches via `getPr`. Tests SHALL import `../../test_setup.ts` first and SHALL build inline `apiClient` / `eventsClient` fakes. Tests that involve `window.confirm` SHALL stub it on `globalThis` at the start of the test case and restore it afterwards.

#### Scenario: Test file is discovered by `deno task test`

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** `packages/spa/src/features/prDetail/PRDetailView_test.tsx` is discovered and its test cases are executed
- **AND** every documented test case (six cases) is present and passes
