# Step 25 — spa-manual-override-flow

**Phase:** MVP
**Suggested change name:** `spa-manual-override-flow`
**Depends on:** 11, 5

## Goal

Make user-driven status overrides safe and auditable. After this step, when the user changes a ticket or PR status from the UI to a status they don't normally own, the SPA shows a confirmation dialog and the server records the action as a `manual_override` event in the activity log.

## Scope

- Server-side override endpoint:
  - `POST /tickets/:id/override-status { status, reason? }` — bypasses the owning-role rule from step 04 specifically for the user role; emits a `manual_override` activity log entry; emits the standard `ticket.updated` event.
  - `POST /prs/:id/override-status { status, reason? }` — same treatment for PRs.
  - These endpoints REPLACE the unguarded transition path the SPA used as a stopgap in step 11; the prototype-era caveat is now closed.
- SPA UX changes:
  - Ticket detail (step 11) status picker: when the chosen status is one the user doesn't own per §4.2, show a confirmation dialog explaining what they're about to do, asking for an optional reason, requiring an explicit confirm. On confirm, calls the override endpoint.
  - PR detail (step 11) status picker: same treatment.
  - Edit affordances on body / title / intent (which the user fully owns per §7.4) remain unconfirmed.
- Activity log rendering (step 11): `manual_override` events render distinctly with the actor (user), the target (ticket/PR), the from-status → to-status pair, and the optional reason.

## Out of scope

- User-authored CR support (already enabled by §7.4 — drop a file in `.keni/changes/` by hand) — no UI flow in MVP per §10.
- Override of spec or decomposed-CR contents — UI editing of these is post-MVP per §10.
- Permission elevation / multi-user — local single-user.

## Spec references

- §4.2 — Owning-role rule and "User overrides are allowed and logged."
- §7.4 — Editability matrix; status overrides require confirmation and are logged.
- §7.5 — Note that interrupt/timeout do NOT auto-revert ticket status; this step is the user's explicit recovery surface for those cases.
- §9 — MVP includes "`manual_override` event logging for user-triggered status changes."
- §11#6 — No `rejected` status; explicit failure paths only. The override endpoint must not invent statuses outside §4.1.

## Open decisions for the proposer

- **Confirmation copy.** Tailor it to the context (e.g., "Move ticket from `in_review` to `merged`? Engineers normally own this transition. This will be recorded as a manual override."). Pick wording.
- **Required reason vs. optional.** Optional is friendlier; required is more auditable. The spec says "logged" but does not require a reason. Document.
- **Self-override of PO-owned statuses.** The PO owns `done` (via verify-and-fold). Should the user be able to skip directly to `done`? Per §4.2 the user CAN override any status. Allow it but be loud in the activity log.

## Notes for /opsx:propose

- `proposal.md` should describe this step as the closing of a deliberate "loud safety valve" so the user's escape hatch is auditable.
- `design.md` should pin: endpoint contracts, owning-role bypass logic, confirmation UX, activity log rendering, what gets logged in the `manual_override` payload.
- `tasks.md` should cover: server endpoints + tests, SPA confirmation dialog, status pickers updated to use override path on owning-role mismatch, activity log renderer for `manual_override`, integration test covering an override end-to-end.
- Capability spec for `manual-override-flow` documents the contract.
