# Step 10 — spa-shell-and-agent-roster

**Phase:** Prototype
**Suggested change name:** `spa-shell-and-agent-roster`
**Depends on:** 04, 05

## Goal

Stand up the SPA — the browser app the user opens after `keni start` — with its build pipeline, routing skeleton, REST and WebSocket clients, and the **left-panel agent roster** with pause/resume toggles. After this step, the user has a live view of the team that updates as agents change state.

## Scope

- SPA package built and bundled by the monorepo tool (step 01).
- Build pipeline producing a static bundle the orchestration server can serve (step 13 wires `keni start` to host it; for development a dev server is fine).
- Routing scaffold for the dashboard, ticket detail, PR detail, and activity log views (the views themselves are in step 11; this step ships placeholders/stubs for navigation).
- Typed REST client generated from the shared types in step 04. WebSocket client wired to the events from step 05. Reconnect handling.
- Agent roster panel (left region, per §7.2):
  - Cards per agent: name, role, current status (idle / running), last activity summary, last active timestamp.
  - Pause/resume toggle wired to `POST /agents/:id/pause` and `/resume`.
  - Live state updates on `agent.state_changed` events.
- Visual layout: three-region shell (left = roster, center = board placeholder, right = chat placeholder hidden in prototype). Keeps step 11 and step 23 simple.

## Out of scope

- Kanban board, ticket detail, PR detail, activity log views — step 11.
- Interrupt and timeout controls UX — step 12.
- Chat panel — step 23 (MVP).
- Spec viewer and CR list — step 24 (MVP).
- Manual override confirmation — step 25 (MVP).
- Project settings UI — post-MVP per §10.

## Spec references

- §7.2 — Three-region dashboard, exact composition of the agent roster card.
- §6.3 — Last activity summary surfaced on the roster.
- §6.1 — Pause/resume affordance on each agent.

## Open decisions for the proposer

- **SPA framework.** React is implied by the engineer prompt's TS/Deno/React focus (§8) but is not strictly mandated for Keni's own UI. React + Vite is the obvious default; document the choice.
- **State management.** A small store (Zustand, Redux Toolkit, Jotai, signals, etc.) or local React state — pick lightly and document.
- **Typed-client generation.** Hand-write client based on shared types vs. generate from an OpenAPI / equivalent spec. Pick one consistent with step 04's validation/types decision.

## Notes for /opsx:propose

- `proposal.md` should explain that this step turns the dashboard from "nothing on screen" to a live shell with the roster working.
- `design.md` should cover: framework + tooling, three-region layout, REST + WS client architecture, reconnect strategy, the roster card spec.
- `tasks.md` should cover: SPA scaffold + build, routing stubs, REST client, WS client + reconnect, roster panel + pause/resume + live state, theming basics.
- Capability spec for `spa-shell` is appropriate; the roster contract can live there or in a dedicated `spa-agent-roster` capability spec.
