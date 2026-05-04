## Why

Step 10 (`spa-shell-and-agent-roster`) landed a runnable React + Vite SPA whose left pane now renders the configured roster live, whose top nav shows the WebSocket lifecycle, and whose routing scaffold already registers `/`, `/tickets/:id`, `/prs/:id`, and `/activity`. Every one of those four routes still mounts a placeholder component — `<BoardPlaceholder>` at `/` and a shared `<RoutePlaceholder>` at the three drill-downs — so the user can watch the roster but cannot see, navigate to, or edit any ticket, PR, or activity entry. `spec.md` §7.2 ("kanban board updates live as agents move tickets"), §7.3 (ticket / PR / activity-log views as the user's primary read surface), §7.4 (the editability matrix: title/body/intent yes, status / assignee via override), and §4.3 (the user creates tickets directly in the prototype) are all structurally blocked on the same missing piece: four real views plugged into the routing slots step 10 left behind.

Step 11 ships those four views. After this change the SPA covers every prototype-required surface from `spec.md` §7.2 and §7.3 (board, ticket detail, PR detail, activity log) and the user can do the two things the prototype's demo loop requires — create a ticket, watch the engineer move it across the board — entirely from the browser. Step 12 (interrupt / timeout UX) and step 25 (manual-override confirmation flow) then layer on top of the transition affordances this step exposes as raw endpoints-with-caveats.

## What Changes

- Replace the center-region `<BoardPlaceholder />` with a real **kanban board** (`/` route):
  - Twelve columns, one per `TicketStatus` from `spec.md` §4.1 (`open`, `in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, `ready_for_test`, `in_testing`, `tested`, `test_failed`, `done`) rendered in the documented order.
  - Each card shows `ticket.id`, `ticket.title`, `ticket.assignee` (or `—` when null), and `ticket.priority`.
  - The board subscribes to `eventsClient` for `ticket.created` and `ticket.updated` frames and updates the affected column(s) without a full refetch (it refetches via `apiClient.listTickets()` on `eventsClient` `live` transitions — the reconnect tier already shipped).
  - Clicking a card navigates to `/tickets/:id`.
  - A "Create ticket" button opens a small inline form (prototype: `§4.3` the user drives ticket creation) that calls `apiClient.createTicket(input)` and navigates to the created ticket's detail page on success.
  - Cards are **drag-and-droppable between columns** via the native HTML5 DnD API (no new dependency); a drop calls the underlying transition endpoint with a documented UX caveat (`spec.md` §4.2 confirmation is step 25's concern). Invalid drops (the §4.1 status graph forbids the edge, or the server returns `403 status_graph_violation` / `role_not_owner`) surface a one-line inline error on the card and the card snaps back to its origin column.
- Replace `<RoutePlaceholder title="Ticket detail" …>` at `/tickets/:id` with a real **ticket detail** view:
  - Renders every field on `TicketResponse` (id, title, status, assignee, priority, change_request link, created_at, updated_at, body).
  - Status history is sourced from the activity log (`apiClient.listActivity()` filtered client-side by `refs.ticket === id`) — the prototype does not paginate the activity log, and the client-side filter is a documented prototype trade-off.
  - **Comment thread** is materialised from the same activity-log query: every entry whose `event === "ticket_comment"` and `refs.ticket === id` renders as a comment (author = `entry.agent`, role = `entry.role`, body = `entry.summary`, timestamp). A "Post comment" form calls a new `apiClient.appendActivity(...)` that posts a `POST /activity` with `event: "ticket_comment"`, `refs: { ticket: id }`, and the typed `summary`. Comments stream in live via the existing `activity.appended` frame when `payload.entry_id` resolves to a `ticket_comment` entry.
  - Edit controls per `spec.md` §7.4:
    - **Title / body**: inline edit forms that call `apiClient.patchTicket(id, patch)`; the server enforces `status_in_patch` rejection and the UX surfaces the resulting `KeniApiError`.
    - **Status / assignee**: a single "Advanced: transition" panel documents the owning-role rule (`spec.md` §4.2) and surfaces a raw `apiClient.transitionTicket(id, from, to)` affordance with a prominent caveat — "this is the raw override path; step 25 will add the confirmation flow". The panel is visible only in the prototype; step 25 will replace it with the confirmation modal.
  - A "Linked PR" section calls `apiClient.listPrs({ ticket: id })` and renders each PR as a `<Link to="/prs/:id">` card (a ticket has at most one PR per `spec.md` §4.2; the UI handles zero/one/many generically).
- Replace `<RoutePlaceholder title="PR detail" …>` at `/prs/:id` with a real **PR detail** view:
  - Renders every field on `PRResponse` (id, title, ticket link, branch, author, status, created_at, updated_at, body = the "intent").
  - Edit controls per `spec.md` §7.4:
    - **Intent** (the PR body): inline edit form calling `apiClient.patchPrIntent(id, intent)`.
    - **Status**: same "Advanced: transition" raw-override panel as the ticket view, with its own UX caveat. The `POST /prs/:id/merge` endpoint (separate from `transition`) is surfaced only when the engineer's PR is `approved` — the button calls `apiClient.mergePr(id)` and handles the `merge_conflict` error by showing the `details` payload.
  - A "Linked ticket" section renders a `<Link to="/tickets/:id">` card with the ticket's title and status.
  - The view subscribes to `eventsClient` for `pr.updated` frames whose `payload.pr_id === id` and re-renders the corresponding fields.
- Replace `<RoutePlaceholder title="Activity log" …>` at `/activity` with a real **activity log** view:
  - Renders the full `ActivityEntryResponse[]` returned by `apiClient.listActivity(filter)` as a reverse-chronological list (newest first — the client reverses the id-ordered array for readability).
  - Filter controls: agent (free-text dropdown populated from the resolved roster), role (fixed enum from `@keni/shared`), date range (two ISO-8601 datetime-local inputs). The filters are combined into a single `ActivityFilter` and passed to `apiClient.listActivity(filter)`.
  - New entries stream in live via `eventsClient` — every `activity.appended` frame whose `payload` matches the current filter is prepended to the list (optimistically; a subsequent refetch on reconnect reconciles). Frames that don't match are ignored.
  - **Cross-reference rendering**: every entry's `refs.ticket`, `refs.pr`, and (MVP-forward) `refs.change_request` render as `<Link>`s to the corresponding detail route. `refs.change_request` is always rendered as a plain string in the prototype (the CR list view lands in step 24).
- Extend `apiClient` (additive — the existing `spa-shell` requirement permits "at minimum" the listed methods):
  - `getTicket(id): Promise<TicketEnvelope>`, `createTicket(input: TicketCreateRequest): Promise<TicketEnvelope>`, `patchTicket(id, patch: TicketHeaderPatchRequest): Promise<TicketEnvelope>`, `transitionTicket(id, req: TicketTransitionRequest): Promise<TicketEnvelope>`.
  - `getPr(id): Promise<PREnvelope>`, `patchPrIntent(id, req: PRIntentPatchRequest): Promise<PREnvelope>`, `transitionPr(id, req: PRTransitionRequest): Promise<PREnvelope>`, `mergePr(id): Promise<MergePrEnvelope>`.
  - `appendActivity(input: ActivityAppendRequest): Promise<ActivityEnvelope>`.
  - Every addition binds directly to the matching `@keni/shared/wire/…` type; no new types are introduced in `@keni/shared` or in the server.
- Update the `spa-shell` capability's routing scenarios to reflect the real components at `/`, `/tickets/:id`, `/prs/:id`, and `/activity` (the placeholder scenarios move to the "before step 11" state and are replaced with scenarios naming the real view components). The routing requirement itself is unchanged; only its scenarios are re-pinned.
- No changes to the orchestration server, no new endpoints, no new wire types, no new `EventName` variants. The prototype's activity-log query filter stays `agent` / `role` / `from` / `to`; the per-ticket / per-PR filtering for the comment thread and status history runs client-side (documented trade-off; a `ticket` / `pr` filter on `GET /activity` is an additive change a later step can land if the activity log outgrows the prototype's scale).

## Capabilities

### New Capabilities

- `spa-board`: the kanban board view — the twelve-column layout keyed off `TicketStatus`, the card shape (id / title / assignee / priority), the live-update protocol for `ticket.created` and `ticket.updated`, the drag-and-drop transition affordance with the documented UX caveat, the "Create ticket" form flow, and the explicit loading / empty / error / disconnected states.
- `spa-ticket-detail`: the ticket detail view — the full `TicketResponse` render, the title / body edit affordances, the status / assignee override panel with the documented UX caveat, the status-history and comment-thread materialisation from the activity log, the "Post comment" flow, the linked-PR section, and the live-update protocol for `ticket.updated` and `activity.appended` frames whose refs match the ticket.
- `spa-pr-detail`: the PR detail view — the full `PRResponse` render, the intent-edit affordance, the status override panel with the documented UX caveat, the `POST /prs/:id/merge` button gating on `approved`, the linked-ticket section, and the live-update protocol for `pr.updated` frames.
- `spa-activity-log`: the activity log view — the filter form (agent / role / date range), the reverse-chronological list render, the cross-reference link rendering for `refs.ticket` / `refs.pr` / `refs.change_request`, and the live-prepend protocol for `activity.appended` frames matching the current filter.

### Modified Capabilities

- `spa-shell`: the "The routing scaffold registers the four documented routes plus a catch-all" requirement's scenarios re-pin to the real view components (the board at `/`, the ticket detail at `/tickets/:id`, the PR detail at `/prs/:id`, the activity log at `/activity`), and the `<BoardPlaceholder />` / `<RoutePlaceholder />` references are removed. The requirement text itself is unchanged; only the scenarios update.

## Impact

- **Affected code** — SPA package (the bulk of the diff):
  - `packages/spa/src/transport/apiClient.ts` + `apiClient_test.ts` (modified) — nine new methods (`getTicket`, `createTicket`, `patchTicket`, `transitionTicket`, `getPr`, `patchPrIntent`, `transitionPr`, `mergePr`, `appendActivity`) plus test cases covering the happy path, the `KeniApiError` mapping for each endpoint's documented error codes (`status_in_patch`, `stale_state`, `status_graph_violation`, `role_not_owner`, `merge_conflict`, `validation_failed`), and the role-header default.
  - `packages/spa/src/features/board/` (new) — `BoardView.tsx`, `BoardColumn.tsx`, `BoardCard.tsx`, `CreateTicketForm.tsx`, `BoardView.css`, `BoardView_test.tsx`, plus the DnD helpers (`dragHelpers.ts` — a tiny pure module wrapping the HTML5 DnD events so tests drive drops without a real browser).
  - `packages/spa/src/features/ticketDetail/` (new) — `TicketDetailView.tsx`, `TicketHeaderEdit.tsx`, `TicketBodyEdit.tsx`, `TicketTransitionPanel.tsx`, `TicketCommentThread.tsx`, `TicketDetailView.css`, `TicketDetailView_test.tsx`, plus a small `useTicketActivity.ts` hook that fetches and subscribes to the activity stream filtered by `refs.ticket === id`.
  - `packages/spa/src/features/prDetail/` (new) — `PRDetailView.tsx`, `PRIntentEdit.tsx`, `PRTransitionPanel.tsx`, `PRMergeButton.tsx`, `PRDetailView.css`, `PRDetailView_test.tsx`.
  - `packages/spa/src/features/activityLog/` (new) — `ActivityLogView.tsx`, `ActivityFilters.tsx`, `ActivityEntryRow.tsx`, `ActivityLogView.css`, `ActivityLogView_test.tsx`, plus `formatActivityRefs.tsx` (the cross-reference link renderer) and a unit test for it.
  - `packages/spa/src/App.tsx` (modified) — replace the four placeholder routes with the real view components. The catch-all stays as `<NotFound />`. `<BoardPlaceholder />` and `<RoutePlaceholder />` are retired (the files are deleted, not just unused).
  - `packages/spa/src/shell/BoardPlaceholder.tsx` (removed), `packages/spa/src/routes/RoutePlaceholder.tsx` (removed). The corresponding test assertions in `AppShell_test.tsx` / `App_test.tsx` are updated to assert on the real view components.
  - `packages/spa/src/theme/tokens.css` (modified, additive) — add a handful of board-specific tokens (`--keni-color-status-*` for each status's accent; `--keni-board-card-padding`; `--keni-board-column-min-width`) and keep the existing tokens unchanged.
- **Affected code** — outside the SPA:
  - **None.** No orchestration-server change, no storage change, no shared-wire type change, no role-runtime change. Every new behaviour is a client-side consumer of endpoints and wire types already shipped by step 04, step 05, step 07, and step 09.
- **Affected capability specs**:
  - `openspec/changes/spa-board-and-drill-downs/specs/spa-board/spec.md` (new).
  - `openspec/changes/spa-board-and-drill-downs/specs/spa-ticket-detail/spec.md` (new).
  - `openspec/changes/spa-board-and-drill-downs/specs/spa-pr-detail/spec.md` (new).
  - `openspec/changes/spa-board-and-drill-downs/specs/spa-activity-log/spec.md` (new).
  - `openspec/changes/spa-board-and-drill-downs/specs/spa-shell/spec.md` (new — delta) — re-pins the routing scenarios to the real components.
- **Affected dependencies**:
  - **None new**. The HTML5 DnD API is built into the browser; `react-router-dom`'s `useParams` / `useNavigate` / `<Link>` are already in the imports map; `@testing-library/react`'s `fireEvent` covers DnD event simulation in tests. No library choice (`react-dnd`, `@dnd-kit`, etc.) is introduced — if a later step needs multi-select or touch-aware dragging, a capability change can pull one in.
- **Affected tests**:
  - **New (SPA package)**: per-feature `*_test.tsx` files (estimated ~40 new `Deno.test` cases) covering the card-level contracts (render every field on a populated row; handle null assignee; handle disconnected UX), the column-level contracts (one column per status, correct status ordering, count reflects active cards), the DnD transition (successful drop → transition call → card moves; failed drop → snap-back + inline error), the "Create ticket" flow (form validation, successful create navigates to `/tickets/:id`, server error renders inline), the ticket / PR edit affordances (optimistic vs. server-confirmed — server-confirmed per Decision X), the comment thread (render from activity entries, post a new comment, live-stream new comments), the activity log filter round-trip (filter form → `listActivity(filter)` → rendered list), the live-prepend behaviour for `activity.appended`, and the cross-reference link rendering.
  - **Removed**: the two placeholder-assertion cases in `AppShell_test.tsx` / `App_test.tsx` (the `<BoardPlaceholder />` assertion and the three `<RoutePlaceholder />` assertions) — replaced with assertions on the real components.
  - **Unchanged**: every test in `cli`, `server`, `role-runtimes`, and `shared` continues to pass untouched (no server / wire / storage / runtime code changes).
- **Downstream steps unblocked**:
  - **Step 12 (interrupt / timeout controls)** layers an "Interrupt" affordance on each agent card (unchanged from this step) and a per-ticket "session timed out" indicator on the board and ticket-detail views; the `eventsClient` and activity-log filters this step ships are the seam.
  - **Step 13 (`keni start` end-to-end)** serves the real `dist/` bundle (which now contains the full four-view app) behind the orchestration server; nothing in step 13 needs to change based on this step.
  - **Step 23 (chat panel)** unhides the right region of `AppShell` and adds a chat view; this step's transport additions (`appendActivity`) are a reference for the chat-panel's `POST /chat` equivalent.
  - **Step 24 (spec viewer + CR list)** adds two more routes and, on the ticket-detail view, wires the `change_request` link from a plain string render to a real `<Link to="/changes/:id">`. The seam this step leaves is the one-line `formatActivityRefs` and the ticket header's change-request render.
  - **Step 25 (manual-override confirmation flow)** replaces the "Advanced: transition" raw-override panels on the ticket and PR detail views with a confirmation modal and wires the `manual_override` activity emission the server still needs to add in that step. The prototype's raw panels are explicitly documented as the seam step 25 replaces.
- **Non-impact (deliberate)**:
  - **No interrupt / timeout UX.** Step 12.
  - **No chat panel.** Step 23.
  - **No spec viewer or CR list.** Step 24.
  - **No manual-override confirmation modal.** Step 25 — raw override panels with UX caveats are the prototype's floor.
  - **No pagination on the activity log.** The prototype renders the full result set; `apiClient.listActivity` already leaves room for a future `next_cursor` (`ActivityQueryResponse` is an envelope). Pagination lands when the activity log outgrows the prototype's scale.
  - **No server-side filter for activity by ticket / PR.** Client-side filtering on `refs.ticket` / `refs.pr` is the prototype's approach; a server-side filter is an additive change a later step can pick up.
  - **No new library for drag-and-drop.** HTML5 DnD ships with the browser; a future change can adopt `@dnd-kit` or similar if multi-select / touch / keyboard DnD become requirements.
  - **No client-side cache beyond local React state.** The reconnect tier remains "refetch via REST on `live`" (already the contract from `spa-shell`); mounting a view triggers a fresh fetch, unmounting discards local state.
  - **No analytics, no telemetry, no error reporting.** A local dev tool; `console.warn` on uncaught transport errors is the prototype's floor.
  - **No accessibility audit beyond sensible defaults** (semantic HTML, keyboard-navigable buttons, focus outlines). A formal a11y pass is post-MVP.
  - **No internationalisation.** English strings are inline; i18n is post-MVP.
  - **No CI workflow change.** `deno task test` grows by ~40 cases but `.github/workflows/ci.yml` is unchanged.
