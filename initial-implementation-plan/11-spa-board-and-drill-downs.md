# Step 11 — spa-board-and-drill-downs

**Phase:** Prototype
**Suggested change name:** `spa-board-and-drill-downs`
**Depends on:** 10

## Goal

Build the central kanban board and the three drill-down views — ticket detail, PR detail, activity log — so the user can see, navigate, and edit everything the prototype produces. After this step, the SPA covers all prototype-required views from §7.2 and §7.3.

## Scope

- Kanban board (center region):
  - Columns map to ticket statuses from §4.1 (`open`, `in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, `ready_for_test`, `in_testing`, `tested`, `test_failed`, `done`).
  - Cards show ticket id, title, assignee, priority.
  - Live updates via `ticket.created`, `ticket.updated` from step 05.
  - Click a card → ticket detail.
  - "Create ticket" button (prototype: user creates tickets directly per §4.3).
- Ticket detail view:
  - Full content (title, body, status, assignee, priority, comments, implementation plan, linked PR, link to parent CR if present — empty in prototype).
  - Status history sourced from the activity log (filter by ticket id).
  - Edit controls per §7.4 row "Ticket title/body" (yes), "Ticket status" (override, but the confirmation flow is in step 25; in prototype, expose the raw transition endpoint with a clear UX caveat).
- PR detail view:
  - Source / target branches, intent, linked ticket, status.
  - Edit controls per §7.4 row "PR intent" (yes), "PR status" (override caveat as above).
- Activity log view:
  - Filterable by agent, role, date range, ticket, PR.
  - References to tickets, PRs, and (in MVP) CRs render as links.
  - Streams new entries live via `activity.appended`.

## Out of scope

- Interrupt and timeout controls — step 12 (separate UX surface).
- Manual override confirmation flow — step 25 (MVP). Prototype reaches the underlying API directly with a UX caveat.
- Chat panel — step 23 (MVP).
- Spec viewer and CR list — step 24 (MVP).

## Spec references

- §4.1 — Ticket lifecycle drives the column set.
- §4.2 — Owning-role rule; the UI must communicate why some transitions require an override (and step 25 finishes that flow).
- §4.3 — User creates tickets directly in the prototype.
- §7.2 — Center-region kanban, cards composition.
- §7.3 — Activity log, ticket detail, PR detail views.
- §7.4 — Editability matrix.

## Open decisions for the proposer

- **Drag-and-drop on the board.** Useful for user-driven status changes in prototype (no PO, user is the driver). Pick a library or use HTML5 DnD; document.
- **Optimistic vs. server-confirmed updates.** Optimistic feels great but complicates conflict handling; for prototype, server-confirmed is simplest. Document.
- **Comment thread storage.** §7.3 mentions "comment thread" on tickets. The simplest option in the prototype is to store comments as activity log entries tagged with the ticket id (so query is straightforward). Document the decision.

## Notes for /opsx:propose

- `proposal.md` should frame this as the user's primary control surface for the prototype.
- `design.md` should cover: column layout, card composition, drill-down navigation, edit affordances, comment storage, optimistic-update policy.
- `tasks.md` should cover: board view, ticket detail, PR detail, activity log view, "create ticket" flow, edit forms, link rendering for cross-references.
- Capability spec(s) for the board, ticket detail, PR detail, activity log views (or one combined `spa-dashboard-views` spec) — pick what reads cleaner.
