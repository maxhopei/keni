## MODIFIED Requirements

### Requirement: The routing scaffold registers the four documented routes plus a catch-all

`packages/spa/src/App.tsx` SHALL wrap the app in `<BrowserRouter>` (from `react-router-dom@^6`) and SHALL register exactly the following routes: `/` (the `index` route renders `<BoardView />` from the `spa-board` capability inside `<AppShell />`'s `<Outlet />`); `/tickets/:id` (renders `<TicketDetailView />` from the `spa-ticket-detail` capability); `/prs/:id` (renders `<PRDetailView />` from the `spa-pr-detail` capability); `/activity` (renders `<ActivityLogView />` from the `spa-activity-log` capability); and a catch-all `path="*"` that renders `<NotFound />`. The router SHALL render the `<AppShell />` as a layout route so navigation between the four documented routes never re-mounts the shell (the agent-roster panel's data does not refetch on navigation). The catch-all SHALL NOT mount inside the shell (a 404 page is its own layout). The files `packages/spa/src/shell/BoardPlaceholder.tsx` and `packages/spa/src/routes/RoutePlaceholder.tsx` — along with their corresponding test assertions in `AppShell_test.tsx` and any `App_test.tsx` — SHALL NOT exist (they are retired in the `spa-board-and-drill-downs` change).

#### Scenario: Each documented route mounts its real view component

- **WHEN** the router is constructed and `MemoryRouter` is set to each of `/`, `/tickets/ticket-0001`, `/prs/pr-0001`, `/activity`, and `/totally-unknown` in turn
- **THEN** at `/` the rendered tree contains exactly one `<BoardView />` element (verifiable via the board's documented column elements with `data-status` attributes per the `spa-board` capability)
- **AND** at `/tickets/ticket-0001` the rendered tree contains exactly one `<TicketDetailView />` element (verifiable via the ticket-detail's documented header label containing `ticket-0001`)
- **AND** at `/prs/pr-0001` the rendered tree contains exactly one `<PRDetailView />` element (verifiable via the PR-detail's documented header label containing `pr-0001`)
- **AND** at `/activity` the rendered tree contains exactly one `<ActivityLogView />` element (verifiable via the activity-log's documented filter form inputs per the `spa-activity-log` capability)
- **AND** at `/totally-unknown` the rendered tree contains `<NotFound />`
- **AND** no `<BoardPlaceholder />` or `<RoutePlaceholder />` element is rendered at any route (these components do not exist in the source tree)

#### Scenario: The shell does not unmount on navigation between top-level routes

- **WHEN** the user navigates from `/` to `/activity`
- **THEN** the `<AppShell />` instance remains mounted (the `<AgentRosterPanel />` does not refetch its initial roster)

#### Scenario: The placeholder components do not exist in the source tree

- **WHEN** the file system is inspected after this change lands
- **THEN** `packages/spa/src/shell/BoardPlaceholder.tsx` does not exist
- **AND** `packages/spa/src/routes/RoutePlaceholder.tsx` does not exist
- **AND** no file under `packages/spa/src/` references either component by name in an `import` statement
