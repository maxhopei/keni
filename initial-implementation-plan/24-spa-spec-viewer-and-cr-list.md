# Step 24 — spa-spec-viewer-and-cr-list

**Phase:** MVP
**Suggested change name:** `spa-spec-viewer-and-cr-list`
**Depends on:** 11, 14

## Goal

Give the user read-only views into `.keni/de-facto-spec/` and `.keni/changes/` so they can see what the PO believes the system already does and what changes are in flight or archived. After this step, the dashboard surfaces the PO's two key artefacts without offering UI editing (which is post-MVP).

## Scope

- Spec viewer (read-only):
  - Browses `.keni/de-facto-spec/` as a multi-file markdown tree.
  - Left nav lists files; main area renders the selected file as markdown.
  - Updates when the PO writes new spec content (after a verify-and-fold cycle). Reload hint or live update via a new event (`spec.updated`) is acceptable; document.
- CR list view:
  - Lists CRs grouped by status: `proposed`, `decomposed`, archived.
  - Each row shows: id, title (first heading or YAML title), status, created/updated timestamp.
  - Click a CR → CR detail page showing the full file contents, plus a list of linked tickets (resolved by the `change_request:` YAML link from step 21). For archived CRs, also shows the archive path.
- Server-side support: REST endpoints for listing and reading spec files (`GET /spec/files`, `GET /spec/files/:path`) and for listing/reading CRs (`GET /changes`, `GET /changes/:id`). Read-only.
- Optional: a small `spec.updated` and `change.updated` WS event so the viewer refreshes naturally without polling. If not implemented, document a manual-reload UX.

## Out of scope

- UI editing of the de-facto spec — post-MVP per §10.
- UI editing of decomposed CRs — post-MVP per §9.
- File-watcher reactivity for direct user edits on disk — post-MVP per §10.
- User-authored CR via UI — post-MVP per §10 (a power user can still drop a markdown file into `.keni/changes/` by hand and the next CR-to-tickets cycle will pick it up; see §7.4 footnote).

## Spec references

- §5.1 — Multi-file spec under `.keni/de-facto-spec/`; CR files under `.keni/changes/`; archive under `.keni/changes/archive/`.
- §7.3 — Spec viewer (read-only) and CR list view (proposed / decomposed / archived) with click-through.
- §9 — MVP includes "Ticket detail and PR detail views; spec viewer (read-only); CR list view."
- §10 — UI editing of spec and decomposed CRs is post-MVP.

## Open decisions for the proposer

- **Markdown rendering.** Pick a renderer (mdast-based, remark, micromark, etc.) that respects the structure the PO produces. Document.
- **`change_request:` link resolution.** Server-side (CRs include their linked ticket ids in the response) vs. client-side (SPA queries tickets and filters). Server-side is one round trip and avoids N+1; document.
- **Live update events.** Worth adding `spec.updated` / `change.updated` events? They are cheap if the storage layer can emit them on write. Recommended; document if you skip.

## Notes for /opsx:propose

- `proposal.md` should explain that this step gives the user transparency into PO artefacts without inviting editing.
- `design.md` should pin: REST endpoints, viewer layout, CR list/detail layout, event additions if any, the "read-only in MVP" boundary and the deferred items from §10.
- `tasks.md` should cover: REST endpoints + tests, viewer SPA component, CR list + detail components, link resolution, live-update wiring (if chosen).
- Capability specs for `spa-spec-viewer` and `spa-cr-list-view` (or one combined) document the contracts.
