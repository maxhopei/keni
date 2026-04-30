# Step 13 — cli-start-and-end-to-end-wiring

**Phase:** Prototype
**Suggested change name:** `cli-start-and-end-to-end-wiring`
**Depends on:** 09, 11, 12

## Goal

Ship `keni start` and prove the prototype loop works end-to-end. After this step, the user can `keni init` a folder, `keni start` the server, open the printed URL, create a ticket, and watch the engineer drive it through `in_progress → … → ready_for_test`. This is the prototype's exit criterion (§8).

## Scope

- `keni start [project-path]` command:
  - Loads `.keni/project.yaml` and `~/.keni/config.yaml` (layered) and merges configuration.
  - Loads `.env` from the project root (the heavy `.env` lifting is step 27, but a minimal loader is acceptable here so the prototype works without that step). Document the seam.
  - Boots the orchestration server (step 04 + 05), the MCP server (step 06), and the scheduler (step 08).
  - Provisions workspaces for any engineer in the roster that doesn't yet have one (step 09 owns the provisioning code; this step calls it).
  - Picks a port from the configured range; prints `http://localhost:<port>` to stdout.
  - Serves the SPA bundle from a known path (or proxies to the dev server in dev mode).
  - Honours pause state from `project.yaml` and `state.json` on boot.
  - Graceful shutdown on SIGINT/SIGTERM: pause the scheduler, terminate any active subprocess via the interrupt path (step 12), flush activity log, close the server.
- One server, one project (§7.1). All API responses include `project_id` so a future multi-project server is purely additive.
- End-to-end smoke test (manual or scripted):
  - `keni init` an empty folder.
  - Add a default engineer (`alice`) — already present in the seed `project.yaml`.
  - `keni start`.
  - Open the URL.
  - Create a ticket via the UI.
  - Observe the engineer self-assign, write code, submit a PR record, self-review (next cycle), merge, and land in `ready_for_test`.
  - Verify the activity log shows every cycle and that interrupts work.

## Out of scope

- `.env` UX polish — step 27.
- Multi-project — out of MVP.
- Authentication — local-only.

## Spec references

- §7.1 — Getting started flow (`keni init` then `keni start`); one server per project; `project_id` future-proofing.
- §8 — Prototype "Included" list (this step closes the list out).
- §11#12 — Prototype is intentionally bare: validate the user-engineer loop before adding anything else.

## Open decisions for the proposer

- **Default port and port-conflict handling.** Pick a default (e.g., 7777) and a fallback policy (next available in the range from config).
- **SPA serving in dev vs. prod.** Two modes — bundled static and dev-server proxy — or one. Document.
- **Health endpoint.** Useful for the smoke test and future MVP; light touch is fine.

## Notes for /opsx:propose

- `proposal.md` should describe this as the step that gives Keni an end-to-end loop a user can drive.
- `design.md` should: pin the `keni start` contract, the boot sequence, port handling, SPA serving, graceful shutdown, the smoke-test runbook.
- `tasks.md` should cover: `keni start` implementation, layered config wiring, workspace bootstrap call, SPA serving, graceful shutdown, scripted smoke test (or detailed manual runbook), update root README with the runbook.
- Capability spec for `cli-start` documents the boot contract.
