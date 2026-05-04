## Context

Step 10 (`spa-shell-and-agent-roster`) landed the SPA's scaffold and its left pane (the live agent roster). Every documented route except the agent-roster panel still mounts a placeholder: `/` renders `<BoardPlaceholder />`, and `/tickets/:id`, `/prs/:id`, `/activity` share a single `<RoutePlaceholder title="…" stepRef="step 11" />` component. The orchestration server (steps 04–05, 09) already exposes every endpoint and WebSocket frame the four views need — `GET/POST/PATCH /tickets`, `POST /tickets/:id/transition`, `GET/PATCH /prs`, `POST /prs/:id/{transition,merge}`, `GET /activity`, `POST /activity`, and an `EventFrame` stream covering `ticket.created`, `ticket.updated`, `pr.created`, `pr.updated`, `activity.appended`, `agent.state_changed` — and the SPA's transport seam (`apiClient`, `eventsClient`) is in place. This step's job is to ship the four views, extend `apiClient` with the nine additional methods they need, and wire live updates through the existing `eventsClient`.

What this step has to settle:

- **The board's visual layout** (twelve columns, one per `TicketStatus`, horizontally scrollable when the viewport is narrower than the combined minimum widths).
- **The board's update protocol** (which events move which cards, when to refetch a single ticket vs. the whole list, how to reconcile after a reconnect).
- **The drag-and-drop affordance** (library vs. HTML5 native; how a failed drop is surfaced; what the "raw transition" UX caveat reads like).
- **The "Create ticket" flow** (inline form vs. modal; what fields are required; where navigation lands on success).
- **The ticket detail view's layout** (header + body + status history + comments + linked PR + edit panels, all on a single route with no sub-routing).
- **The comment thread's storage model** (activity log with `event: "ticket_comment"` and `refs.ticket`; no new storage type).
- **The "Advanced: transition" panel** (what the UX caveat says; what fields drive the dropdowns; how the response updates the view).
- **The PR detail view's layout** (similar to ticket detail but with a merge button gated on `status === "approved"`).
- **The activity log view's filter form and live-stream protocol** (which frames prepend to the list, which are ignored, how the filter maps to `ActivityFilter`).
- **The scope of client-side vs. server-side activity filtering** for the ticket / PR refs use case.

Constraints and givens:

- Runtime / framework / tooling unchanged from step 10: React 18, Vite 5, `@deno/vite-plugin`, `react-router-dom` v6, `@testing-library/react` over `happy-dom`, Deno 2.7+. No new top-level dependencies.
- Transport seam unchanged: `apiClient` (REST) and `eventsClient` (WS) are the only places `fetch` / `new WebSocket` are called. The additions in this step are new methods on the same interfaces and adhere to the same role-header / error-envelope / type-alignment rules.
- Wire types unchanged: every new `apiClient` method's return type comes from `@keni/shared/wire/…` (`TicketEnvelope`, `PREnvelope`, `MergePrEnvelope`, `ActivityEnvelope`). No new types are added to `@keni/shared`.
- The server's trust model (local-only, `X-Keni-Role` trusted, `user` role gets `USER_OVERRIDE_ALLOWED` on every transition) is unchanged. Every new endpoint call presents `X-Keni-Role: user`.
- The reconnect tier is unchanged: on every `eventsClient` `"connected"` transition, visible views refetch their canonical state via REST. This step's views follow the same contract the roster panel already establishes.
- Every frame carries a minimal payload (`ticket_id` + `status`, `pr_id` + `status`, `entry_id` + `agent`/`role`/`event`, etc.); the canonical record always lives behind a REST call. This keeps the update protocol simple: frames trigger targeted refetches or field-level patches; nothing assumes the payload is the canonical record.
- The activity log is not paginated in the prototype (`ActivityQueryResponse.data` is the full materialised result of `ActivityLogStore.query(filter)`). The UI is designed around a bounded list; pagination lands when the prototype outgrows it.
- The `developer-setup` capability's "every package contributes at least one test" floor is already satisfied by the existing SPA test files; this step adds ~40 more.
- `spec.md` §7.4 classifies the edit affordances: title / body / intent are user-editable directly; status / assignee / PR status are user-override-possible but "confirmation flow" lives in step 25. In the prototype we ship a raw "Advanced: transition" panel with a prominent UX caveat, matching the source note's explicit guidance.

Non-constraints (free to pick lightly):

- **DnD library vs. HTML5 native**: picked HTML5 native (Decision 3). Zero new dependencies, bounded complexity, easy to swap later.
- **Optimistic vs. server-confirmed transitions**: picked server-confirmed (Decision 4). Simpler, consistent across every mutation in this step, matches the existing roster panel's "in-flight → success / rollback" shape without adding in-flight state to every card.
- **Column layout (grid vs. horizontal scroll)**: picked a flexbox row with a minimum column width and `overflow-x: auto` (Decision 5). Twelve columns at ~240px each need horizontal scroll on anything narrower than ~3000px — which is every practical monitor. CSS grid would fix every column's width relative to the container; flexbox + min-width keeps each column's width stable regardless of viewport.
- **Live-update granularity on the board**: picked per-event targeted refetch via `apiClient.getTicket(id)` (Decision 6) rather than a full `listTickets()` refetch on every frame. Keeps the board responsive without hammering the server; the reconnect-tier `listTickets()` is the reconciliation pass.
- **Comment storage**: picked activity-log entries with `event: "ticket_comment"` and `refs.ticket: id` (Decision 7). No new storage type; the activity log already streams live and supports date-range filters; the "Post comment" call is a regular `POST /activity`.
- **Client-side vs. server-side activity filtering by ticket / PR**: picked client-side (Decision 8). The prototype's activity log is bounded; a server filter is a clean additive change a later step picks up when the log grows.
- **Create-ticket UX**: picked an inline form above the board (Decision 9). Modal is out of scope; inline keeps the demo loop short (click "Create ticket", fill in title + priority, submit, navigate to detail).

## Goals / Non-Goals

**Goals:**

- The `/` route renders a real kanban board with twelve columns keyed off `TicketStatus`, one `<BoardCard>` per ticket, the documented card shape (id, title, assignee, priority), a working "Create ticket" inline form, drag-and-drop between columns that invokes `apiClient.transitionTicket(...)` with a UX caveat on failure, and live updates via `ticket.created` / `ticket.updated` frames.
- The `/tickets/:id` route renders the full `TicketResponse` with edit affordances for title / body, an "Advanced: transition" panel that surfaces the raw transition endpoint with a UX caveat, a status-history list and comment thread sourced from the activity log (client-side filtered by `refs.ticket === id`), a "Linked PR" section, and live updates via `ticket.updated` and `activity.appended` frames.
- The `/prs/:id` route renders the full `PRResponse` with an intent-edit affordance, an "Advanced: transition" panel with a UX caveat, a `POST /prs/:id/merge` button gated on `status === "approved"` that handles the `merge_conflict` error shape, a "Linked ticket" section, and live updates via `pr.updated` frames.
- The `/activity` route renders the full activity log in reverse-chronological order, a filter form that maps agent / role / date-range inputs onto `ActivityFilter`, cross-reference link rendering for `refs.ticket` / `refs.pr` / `refs.change_request`, and live-prepend behaviour for `activity.appended` frames matching the current filter.
- `apiClient` gains nine new methods (`getTicket`, `createTicket`, `patchTicket`, `transitionTicket`, `getPr`, `patchPrIntent`, `transitionPr`, `mergePr`, `appendActivity`) each bound to the matching `@keni/shared/wire/…` type; every new method issues the `X-Keni-Role: user` header and maps non-2xx responses to `KeniApiError` the same way the existing methods do.
- The `spa-shell` capability's routing scenarios re-pin to the real view components; `<BoardPlaceholder />` and `<RoutePlaceholder />` are retired.
- Every new capability's behaviour is covered by at least one `Deno.test` in `packages/spa/src/features/<view>/<View>_test.tsx` that mounts the view against in-memory `apiClient` + `eventsClient` fakes, drives the documented flows, and asserts on the rendered DOM via `@testing-library/react`.

**Non-Goals:**

- **No interrupt / timeout UX.** Step 12. The roster card's pause toggle is unchanged; no "Interrupt" button lands here.
- **No chat panel.** Step 23. The right region of `AppShell` stays hidden behind `chatPanelEnabled: false`.
- **No spec viewer or CR list.** Step 24. The ticket detail's `change_request` render is a plain monospace string, not a `<Link>`; step 24 wires the link.
- **No manual-override confirmation modal.** Step 25. The "Advanced: transition" panels are the prototype's raw override affordance; their UX caveat explicitly says step 25 replaces them.
- **No project-settings UI.** Post-MVP.
- **No board filtering** (by assignee / priority / change_request). The board renders every ticket; filters are a future additive view.
- **No pagination on the activity log.** The envelope leaves room for a `next_cursor`; the UI renders the whole materialised list for the prototype.
- **No server-side filter for activity by ticket / PR.** Client-side filtering on `refs.ticket` / `refs.pr` is the prototype's approach; a server-side filter is an additive change a later step can land.
- **No drag-and-drop library.** HTML5 DnD is the chosen affordance. Multi-select / touch-aware DnD is out of scope.
- **No keyboard-driven DnD.** Semantic HTML keeps the "Advanced: transition" panel as the keyboard-accessible transition path; mouse users get drag-and-drop. A keyboard DnD shim is post-MVP.
- **No client-side caching beyond local React state.** No `@tanstack/react-query`, no SWR, no Zustand. The reconnect tier is "refetch from REST"; mounting / unmounting a view triggers fresh REST calls.
- **No new orchestration-server endpoints, no new wire types, no new `EventName` variants, no new error codes.** Pure consumer of the existing surface.
- **No CI workflow change.** `deno task test` grows but `.github/workflows/ci.yml` is unchanged.

## Decisions

### Decision 1: Four capabilities, not one

**Picked:** split the views into four new capabilities — `spa-board`, `spa-ticket-detail`, `spa-pr-detail`, `spa-activity-log` — plus a delta on `spa-shell` for the routing scenarios.

**Why:** mirrors the existing pattern established by step 10 (`spa-shell` + `spa-agent-roster` as two capabilities, not a combined `spa-dashboard`). Each of the four views has its own update protocol, edit affordances, error UX, and future-change vector (e.g., "add board filters" touches only `spa-board`; "add CR list link on the ticket header" touches only `spa-ticket-detail`). The alternative — one combined `spa-dashboard-views` capability — would conflate unrelated requirements and make surgical future changes harder to review.

**Trade-off:** four specs is more files to land in this one change, but each spec is small (one view's worth of requirements). The archive directory grows by three extra spec files relative to the combined alternative — acceptable.

**Alternatives considered:**

- **One combined `spa-dashboard-views` capability** with four top-level sections. Rejected: conflates the four views' contracts; future changes diff the whole file.
- **Three capabilities** (board, drill-downs combined, activity log). Rejected: the three drill-downs have genuinely different concerns (transitions vs. intent vs. cross-references); combining them is arbitrary.

### Decision 2: The `spa-shell` routing requirement is the only modified capability

**Picked:** the `spa-shell` capability's "The routing scaffold registers the four documented routes plus a catch-all" requirement gets a delta that updates its two scenarios. The requirement text itself (route names, component-mount rule, layout-route behaviour) is unchanged.

**Why:** the routing scenarios currently assert on the placeholder components (`<BoardPlaceholder />` at `/`; `data-testid="route-placeholder"` at the three drill-downs). After this step those placeholders are retired, so the scenarios must assert on the real view components. No other `spa-shell` requirement changes — the REST client, WS client, shell grid, top nav, design tokens, test harness, and wire-import rules all stay pinned as step 10 shipped them.

**Alternative considered:**

- **Add requirements to `spa-shell` instead of delta.** Rejected: the existing requirement's scenarios explicitly reference the placeholders; leaving them in place would document a contradiction ("the routing scenarios assert the old placeholders, but the real views are what ships"). A delta is the cleanest way to keep the requirement's scenarios aligned with reality.

### Decision 3: Drag-and-drop uses the HTML5 DnD API natively, not a library

**Picked:** the `BoardCard` component's drag-out / drag-over / drop handling uses the browser's native HTML5 DnD event model (`dragstart`, `dragover` with `preventDefault`, `drop`). A small pure helper module `dragHelpers.ts` encapsulates the `dataTransfer` read/write so the component tree stays declarative and the tests can drive drops without a real browser.

**Why:** no new top-level dependency, no library-specific vocabulary to learn, no risk of a library's API diverging from browser defaults. The HTML5 DnD affordance is good enough for a twelve-column prototype board with mouse-only users; touch and keyboard DnD are deferred (see Non-Goals).

**Test seam:** `@testing-library/react`'s `fireEvent.dragStart(source)`, `fireEvent.dragOver(target, { dataTransfer: … })`, `fireEvent.drop(target, { dataTransfer: … })` drive drops in `happy-dom` deterministically; no drag-image rendering is involved (the test asserts on the post-drop DOM).

**Alternatives considered:**

- **`react-dnd`**: mature, widely used. Rejected for the prototype because it introduces a context provider requirement, backend selection (`HTML5Backend`), and a distinct hook vocabulary (`useDrag`, `useDrop`). The complexity payback is multi-select and touch — neither of which is in scope.
- **`@dnd-kit/core`**: modern, lighter than `react-dnd`. Same rejection rationale: not worth a new dependency until multi-select or touch is required.
- **Pure-click transition (no DnD)**: the "Advanced: transition" panel already covers this. Drag-and-drop is the §7.2 "the user moves tickets" affordance the prototype advertises; leaving it out would force every transition through the advanced panel, which conflicts with the kanban UX the spec commits to.

### Decision 4: Mutations are server-confirmed, not optimistic

**Picked:** every mutation this step ships — ticket title/body edit, ticket transition (drag-drop or "Advanced" panel), ticket creation, PR intent edit, PR transition, PR merge, comment post — disables the affected input or button while the request is in flight and applies the server-returned envelope on success. A failed request re-enables the input and renders a one-line error near it (the error's `KeniApiError.code`, or the raw message for `internal_error`). No mid-flight state is shown to the user other than the disabled control.

**Why:** the existing roster panel ships optimistic pause/resume (`spa-agent-roster` Requirement "Pause/resume is an optimistic update with rollback on `KeniApiError`"), so the pattern is proven — but the roster's optimistic model has one state bit (`paused`) with a clear inverse. Ticket transitions have twelve states and the `§4.1` graph; a wrong-guess optimistic move on drag-drop would show the card in an invalid column for the round-trip and then animate back on rejection. Server-confirmed dispatch keeps the UI honest and avoids the "card flickers between columns" UX.

**Trade-off:** a successful transition has a visible latency (one round-trip to `127.0.0.1:8000`; typically < 20 ms on localhost, so the delay is barely perceptible). The card is in a "transitioning" visual state (reduced opacity, cursor: wait) during the round-trip so the user sees the mutation is in flight. A future step can upgrade individual affordances (e.g., comment post) to optimistic if the round-trip UX becomes a problem.

**Alternatives considered:**

- **Optimistic everywhere.** Rejected for the flicker risk on drag-drop and the code cost of rollback logic for every mutation type (title, body, status, intent, comment).
- **Mixed: optimistic for comments, server-confirmed for transitions.** Viable — comments are low-risk (append-only, no state machine) — but ships two patterns in one step for marginal benefit. Deferred.

### Decision 5: Board layout — flexbox row with `overflow-x: auto`, fixed minimum column width

**Picked:** the twelve columns render in a horizontal flex row with `gap: var(--keni-space-3)`, each column has `min-width: 240px` and `flex: 0 0 auto`, and the container has `overflow-x: auto` so the user scrolls horizontally when the viewport is narrower than the combined width.

**Why:** CSS grid with `grid-auto-flow: column` would fix every column to the same fraction of the viewport — on a 1440px monitor that gives 120px per column, which is too narrow for `ticket-0001 / Add login page / alice / priority 100`. Flexbox with a minimum width keeps each column stable regardless of viewport and lets the user scroll horizontally on anything narrower than ~3000px (the natural width of twelve 240px columns plus gaps). The board row is the natural place for the horizontal scrollbar — it does not fight with the app's vertical scroll.

**Layout shape:**

```
┌─────────────────────────────────────────────────────────── nav ───┐
│ header (TopNav from spa-shell)                                     │
├───┬───────────────────────────────────────────────────────────────┤
│ a │ main                                                           │
│ s │ ┌─ Create ticket  [inline form]  ┐                            │
│ i │ ├─────────────────────────────── ┤                            │
│ d │ │ ┌─ open ──┐ ┌─ in_progress ─┐ ┌─ ready_for_review ─┐ ...     │
│ e │ │ │  card   │ │  card         │ │  card              │ ...     │
│   │ │ │  card   │ │  card         │ │                    │ ...     │
│   │ │ └─────────┘ └───────────────┘ └────────────────────┘ ...     │
│   │ │  ← horizontal scroll →                                       │
│   │ └──────────────────────────────────────────────────────────── │
└───┴────────────────────────────────────────────────────────────────┘
```

**Alternatives considered:**

- **CSS grid with fractional columns.** Rejected: unreadable cards on realistic monitor widths.
- **Virtualised horizontal list** (e.g., `react-virtuoso`, `react-window`). Rejected: twelve columns is not a virtualisation scale; the overhead of a library + the accessibility trade-off is not worth it.
- **Vertical stacking with one column-group per row.** Rejected: breaks the kanban mental model; `spec.md` §7.2 commits to "columns map to ticket statuses", plural and horizontal.

### Decision 6: Board live-updates are per-event targeted refetches, not a full `listTickets()`

**Picked:** the board's frame handler processes each `ticket.created` / `ticket.updated` frame individually:

- `ticket.created` → call `apiClient.getTicket(payload.ticket_id)`, append the resolved record to the `open` column (the card's `status` field drives the column; `ticket.created` always arrives with `status: "open"`).
- `ticket.updated` with `kind: "transition"` → if the ticket is already in the local board state, remove it from its current column and insert into the column named by `payload.status`. If it is not in the local board state (e.g., the board mounted after the ticket was created), call `getTicket(payload.ticket_id)` and insert. The frame's `payload.status` is the source of truth for the destination column — no additional fetch is needed for the transition case.
- `ticket.updated` with `kind: "patch"` → call `getTicket(payload.ticket_id)` and replace the row in-place (the patch may have changed title / assignee / priority, which the frame does not carry).

On every `eventsClient` `"connected"` transition (initial + every reconnect), the board refetches the full `listTickets()` to reconcile any frames missed during the disconnect window.

**Why:** `ticket.updated` with `kind: "transition"` carries enough payload (`ticket_id`, `status`) to move the card without a refetch; the minimal-payload optimisation matters because a busy engineer can emit a handful of transitions per minute, and refetching the whole list on every frame would saturate the local HTTP loopback. `kind: "patch"` and `ticket.created` do need a refetch because the frame's payload is a minimal reference, not the canonical record.

**Alternatives considered:**

- **Full `listTickets()` on every frame.** Simpler to implement but wasteful: a hot board fires the frame storm. Rejected.
- **Payload carries the full `TicketSummaryResponse`.** Would eliminate the `getTicket` for patches. Rejected: design-level change to the wire contract (`EventFrame` payloads are documented as minimal references; upgrading them would cascade across every consumer). Not worth it for the prototype's scale.

### Decision 7: Comments are activity-log entries with `event: "ticket_comment"` and `refs.ticket: id`

**Picked:** "Post comment" on the ticket detail view calls `apiClient.appendActivity({ session_id: "ui", agent: "user", role: "user", event: "ticket_comment", summary: "<typed text>", refs: { ticket: id } })`. The comment thread reads from the same activity log: `apiClient.listActivity({})` (no filter — the server does not support a `ticket` filter yet), then client-side filtering on `refs.ticket === id && event === "ticket_comment"`. Live updates arrive via `activity.appended`; the handler filters the payload (`payload.event === "ticket_comment"` — the `refs` aren't on the payload, so the handler refetches the entry via `listActivity()` for the refs check, or accepts the frame and checks refs after a subsequent list refresh).

**Why:** no new storage type; the activity log is already the durable system-of-record for every cross-role event and already streams live. Comments fit the same shape (timestamped, author-attributed, appended). The `refs` map is the right place for the ticket link — it's exactly what `refs` is for (cross-artifact references that the UI renders as links).

**Trade-off:** activity entries are capped at 4 KB (storage limit from §storage capability "Oversized append produces 422"). Comments longer than ~3800 characters (accounting for the other fields' overhead) would be rejected. Document this in the "Post comment" form — a character counter warns at 3500 and blocks at 3800. Long comments are not a prototype concern.

**Frame-matching caveat:** `ActivityAppendedPayload` carries `entry_id`, `agent`, `role`, `event` but not `refs`. The ticket-detail's frame handler does a narrow refetch of the entry via `listActivity()` after a matching frame arrives (scoped by a small client-side cache keyed on `entry_id` so the refetch isn't repeated). A cleaner wire-level alternative would be to add `refs` to the `ActivityAppendedPayload`; that's an additive change a later step can land if the refetch-per-frame cost becomes real.

**Alternatives considered:**

- **New `CommentStore` and `/comments` endpoint.** Rejected: duplicates the activity log's append-only-with-refs shape; violates "files first, storage abstracted" (§2 #6) by introducing a new artifact type the prototype does not need.
- **Inline comments on the ticket body.** Rejected: mixes authored content and conversation, making it hard to render separately and query by author. The activity-log approach keeps them distinct.

### Decision 8: Activity filtering by `refs.ticket` / `refs.pr` is client-side in the prototype

**Picked:** the ticket-detail's comment thread and status history, and the PR-detail's history, filter the full `apiClient.listActivity({})` result client-side by `refs.ticket === id` / `refs.pr === id`. The `/activity` view's top-level filter (agent / role / date range) uses the existing server-side filter.

**Why:** the prototype's activity log is bounded (a fresh project has a handful of entries; a demo-session run ends with a few dozen). A server-side `ticket` / `pr` filter is a clean additive change (`GET /activity?ticket=<id>` → `ActivityLogStore.query({ ticket: <id> })`) that the `orchestration-server` capability can pick up in a later step when the log grows beyond what the client can reasonably filter. Shipping it here would expand this step's surface beyond the SPA.

**Trade-off:** the ticket-detail view fetches the whole activity list on mount (one REST call per view). For the prototype's scale this is fine; for a production-sized log it would be wasteful. The client-side filter is the clearly-documented temporary solution.

**Alternatives considered:**

- **Ship the server-side filter in this step.** Rejected: expands the server's scope and delays the SPA views for a performance concern the prototype does not have.
- **Cache the activity list at the transport layer and reuse across views.** Rejected: contradicts "no client-side cache beyond local React state" (step 10 Decision 5). Re-fetching on mount is acceptable at prototype scale.

### Decision 9: Create-ticket is an inline form above the board, not a modal

**Picked:** the board view renders a `<CreateTicketForm>` above the column row with two required fields (`title`, `priority: number`), two optional fields (`assignee: string | null`, `change_request: string | null`), and an inline `body` textarea. Submitting calls `apiClient.createTicket(input)`. On success the form clears and the user navigates to `/tickets/<new-id>` via `useNavigate()`. On failure an inline error renders below the submit button with the `KeniApiError.code`.

**Why:** the prototype's demo loop is "create a ticket and watch an engineer pick it up" — every extra click in that path is a demo-hostile UX. An inline form is one click (plus typing); a modal is two clicks (open, submit) plus focus-management complexity. The form is collapsed by default under a "New ticket" toggle so it doesn't dominate the board layout when not in use.

**Alternatives considered:**

- **Modal.** Rejected for the reasons above.
- **Dedicated `/tickets/new` route.** Rejected: adds a route and a navigation step for a three-field form.
- **Nothing — let the user create via a CLI or a direct `POST /tickets`.** Rejected: `spec.md` §4.3 commits the prototype to user-creates-tickets-in-the-UI.

### Decision 10: "Advanced: transition" panel is a plain `<details>` with a role/status selector and a UX caveat

**Picked:** the ticket and PR detail views each render a `<details>` block labelled "Advanced: transition (prototype only)". When expanded, it shows two dropdowns — `from` (pinned to the current status, read-only) and `to` (populated from the `TICKET_STATUS_TRANSITIONS[from]` / `PR_STATUS_TRANSITIONS[from]` list the server exposes, fetched once on mount via a new `apiClient.getStatusGraph()` — or, simpler, hardcoded in the SPA as a mirror of the server's constant) — plus a "Transition" button. The caveat text reads: "This is the raw override path. It does not confirm the transition or record a `manual_override` activity entry. Step 25 will replace this panel with a confirmation flow."

**Why:** `spec.md` §7.4 flags status transitions as "(override, confirmation)" — confirmation lives in step 25. The source note explicitly asks the prototype to surface the raw endpoint with a UX caveat. A `<details>` element keeps the panel unobtrusive on first load (collapsed), keyboard-accessible (browser default), and screen-reader-friendly ("disclosure triangle" pattern).

**Status graph source:** to avoid a round-trip on every detail-view mount, the SPA hardcodes `TICKET_STATUS_TRANSITIONS` and `PR_STATUS_TRANSITIONS` as TypeScript constants in `packages/spa/src/features/shared/statusGraph.ts`, imported from nowhere server-side. The file is a verbatim mirror of the server's constants and is linked by a comment pointing at the orchestration-server spec section that defines them. If the server's graph changes, a compile-time assertion (via a small `deno task check` fixture that imports both) catches drift. A future step can replace the mirror with a `GET /status-graph` endpoint; not worth it for the prototype.

**Alternatives considered:**

- **A `GET /status-graph` endpoint.** Rejected: server surface expansion for one consumer. A compile-time drift check is simpler.
- **Free-text `to` input.** Rejected: would let the user type an invalid status and see a server error — worse UX than a constrained dropdown.
- **Dropdown shows every status (not just reachable from `from`).** Rejected: would invite server rejections. The prototype caveats are about the _confirmation flow_, not the graph enforcement.

### Decision 11: `apiClient` additions mirror the existing method-per-endpoint shape

**Picked:** the nine new methods follow the same conventions as step 10's `listAgents` / `pauseAgent` / etc. — one method per HTTP endpoint, a filter object as an optional single parameter where applicable, the return type imported from `@keni/shared/wire/…`, the `X-Keni-Role` header stamped by default, non-2xx responses thrown as `KeniApiError`.

**Additions:**

```ts
// @keni/spa/src/transport/apiClient.ts (additive)
interface ApiClient {
  // ...existing methods...

  // tickets
  getTicket(id: TicketId): Promise<TicketEnvelope>;
  createTicket(input: TicketCreateRequest): Promise<TicketEnvelope>;
  patchTicket(id: TicketId, patch: TicketHeaderPatchRequest): Promise<TicketEnvelope>;
  transitionTicket(id: TicketId, req: TicketTransitionRequest): Promise<TicketEnvelope>;

  // prs
  getPr(id: PRId): Promise<PREnvelope>;
  patchPrIntent(id: PRId, req: PRIntentPatchRequest): Promise<PREnvelope>;
  transitionPr(id: PRId, req: PRTransitionRequest): Promise<PREnvelope>;
  mergePr(id: PRId): Promise<MergePrEnvelope>;

  // activity
  appendActivity(input: ActivityAppendRequest): Promise<ActivityEnvelope>;
}
```

**Why:** consistency with the existing surface. The tests for each method follow the same pattern established in `apiClient_test.ts` (spin up a `Deno.serve` mock orchestration server, drive the method, assert on the request shape and the parsed envelope). The role-header / error-envelope / type-alignment rules from `spa-shell` already pin the contract; adding a method is additive.

**No filter abstractions:** each `filter?: …` parameter is a plain interface matching the endpoint's query-string contract. No client-side `QueryBuilder` or `FilterDSL`. If filters grow complex, a later step can introduce an abstraction.

### Decision 12: Navigation — clicking a card navigates, clicking a PR link navigates

**Picked:** `<BoardCard>` is rendered as a `<Link to={\`/tickets/${id}\`}>` wrapping the card content. The ticket-detail's "Linked PR" section renders `<Link to={\`/prs/${pr.id}\`}>`. The PR-detail's "Linked ticket" section renders `<Link to={\`/tickets/${ticket.id}\`}>`. The activity log's `refs.ticket` / `refs.pr` link cells use the same `<Link>`. Every link is a real `<a href>` via `react-router-dom` so middle-click and `cmd+click` open in a new tab.

**Why:** keeps the browser's native affordances intact (back button, history, right-click menu). `react-router-dom` v6's `<Link>` is the canonical way to navigate within the SPA; it already handles `<AppShell />`'s layout-route-no-remount contract from step 10.

**Drag-and-drop interaction:** the card's drag handle is the card content itself. A `pointerdown` that resolves into `dragstart` does not fire `click` (the browser's default behaviour); a clean click (no drag distance) fires `click` and `<Link>` navigates. This means a user can grab a card and drop it in the same column to cancel the drag without accidentally navigating. `@testing-library/react`'s `fireEvent.click` on the card navigates; `fireEvent.dragStart` followed by `dragOver` + `drop` on a column triggers the transition.

## Risks / Trade-offs

**[Risk] The `ticket_comment` activity-log entry has a 4 KB size cap.** → The "Post comment" form includes a character counter that warns at 3500 characters and disables submit at 3800 (accounting for the JSON envelope overhead). Long-form discussions are not a prototype concern; the cap is documented in the form's placeholder text.

**[Risk] Client-side activity filtering for the ticket / PR detail views degrades as the activity log grows.** → For the prototype's scale (a handful of entries per demo session) the cost is negligible. The client fetches the full list once per detail-view mount; the filter runs in O(n) over the result. When the activity log outgrows this — e.g., hundreds of entries per ticket — a later step adds a server-side `ticket` / `pr` filter to `GET /activity`, and the client swaps its client-side filter for a server-side one (one-line change at the `apiClient.listActivity(filter)` call site).

**[Risk] HTML5 DnD drag images render inconsistently across OSes / browsers.** → The prototype accepts the default drag image (a semi-transparent render of the dragged card). If the visual is poor on a specific OS, a future change can set a custom drag image via `dataTransfer.setDragImage(…)`. Not a correctness risk — drag-drop works regardless of the visual.

**[Risk] A user drops a card onto an invalid column (e.g., `open → tested`).** → The client calls `transitionTicket({ from: "open", to: "tested" })`; the server rejects with `403 status_graph_violation`; the UI renders a one-line inline error on the card ("Invalid transition — open → tested not allowed") and snaps the card back to the origin column by reverting the local state. The error persists until the user clicks the card (dismissing the error and navigating to detail) or initiates a new drag.

**[Risk] A concurrent transition from another tab moves a card out from under a drag.** → `ticket.updated` frames are processed regardless of in-flight drag state. If a tab A is dragging `ticket-0001` and tab B completes a transition for the same ticket first, tab A's drop will fail on stale state (`409 stale_state`, the `from` no longer matches). The UI surfaces the error and refetches via `listTickets()` to reconcile. The "server is the tie-breaker" pattern from the roster panel's optimistic-pause scenario applies here too, with the distinction that we're already server-confirmed so there's no optimistic state to roll back — just a failed drop with an error message.

**[Risk] The status-graph mirror in the SPA drifts from the server's constants.** → A small compile-time assertion in `packages/spa/src/features/shared/statusGraph_test.ts` imports the server's `TICKET_STATUS_TRANSITIONS` / `PR_STATUS_TRANSITIONS` (via the workspace package `@keni/server`) and asserts deep equality with the SPA's mirror. `deno task check` catches any drift. The test does not run the server; it only type-imports the constants.

**[Risk] The status graph is hardcoded twice (server + SPA).** → Accepted for the prototype; the compile-time assertion above keeps them in sync. A future step can add a `GET /status-graph` endpoint and delete the mirror if the duplication becomes a problem.

**[Risk] `ActivityAppendedPayload` does not carry `refs`, so the ticket-detail's comment stream has to refetch the entry to confirm a frame belongs to the current ticket.** → The handler filters by `payload.event === "ticket_comment"` first (cheap), then calls a narrow `listActivity({ })` refetch with client-side `refs.ticket === id` filter. For the prototype's comment volume (a handful per ticket) the overhead is imperceptible. The cleaner fix is to add `refs` to `ActivityAppendedPayload` — additive wire change, landed in a later step if the overhead becomes real.

**[Risk] The four views share a lot of boilerplate (fetch-on-mount + subscribe + refetch-on-live).** → Accepted: each view's fetch logic is 10–30 lines of `useEffect` + `useState` and inlining it keeps every view self-contained. A `useLiveResource(fetch, subscribe)` hook is tempting but premature; we revisit after step 12 / 23 / 24 land to see whether the abstraction pays off.

**[Trade-off] Server-confirmed mutations add a round-trip to every drag-drop.** → On localhost the round-trip is sub-millisecond; on a future remote-server deployment (out of scope) it would be more visible. The "transitioning" visual state (opacity, cursor: wait) communicates the in-flight call. A future optimistic upgrade is a per-affordance change.

**[Trade-off] No keyboard-accessible drag-and-drop.** → The "Advanced: transition" panel is the keyboard-accessible path for status changes. A formal a11y audit is post-MVP; the prototype's floor is "every button is focusable, `<Link>`s are real `<a>`s, forms use `<label>` for name association".

## Open Questions

**Q1. Should the board render the twelve columns in the source-note order (verbatim from `spec.md` §4.1) or group terminal / rare statuses into a collapsed "Archive" column?**

The source note specifies the twelve columns verbatim. The design ships all twelve. An "Archive" view for `done` + `tested` could collapse the right-hand side of the board in a future step, but is out of scope here. **Decision deferred to a later step.**

**Q2. Should comments support markdown rendering, or only plain text?**

The `ActivityEntryResponse.summary` is a plain string. The UI could render it through a markdown library (`marked`, `markdown-it`) for a richer comment experience. **Decision: plain text only in this step.** Markdown is a dependency decision that deserves its own change.

**Q3. Should the "Create ticket" form validate `priority` as an integer, and what's the default?**

The server accepts any number (`priority: number` in `TicketCreateRequest`). `spec.md` §4.2 says "Priority is a PO-owned integer. Lower is higher priority." The form enforces integer input (HTML5 `type="number" step="1"`) and defaults the value to `100` (middle-of-the-pack, matching the server's tests). Documented in the `spa-board` capability.

**Q4. Does the drag-and-drop affordance need a visual "drop zone active" highlight on the target column during `dragover`?**

Yes — without it, the user can't tell which column the drop will land on. The target column's `data-drop-target="true"` attribute is set during `dragover` and cleared on `dragleave` / `drop`. CSS rules up the border / background to communicate the active state. Documented in the `spa-board` capability.

**Q5. Should the PR-detail merge button show a confirmation before dispatching?**

The server's `POST /prs/:id/merge` does a real git fast-forward merge. Accidental clicks would be bad. **Decision:** the merge button shows a native `window.confirm("Merge this PR?")` modal before dispatching. Native `confirm` is ugly but zero-dependency and keyboard-accessible. A pretty confirmation lands in step 25 alongside the status-transition confirmation flow.
