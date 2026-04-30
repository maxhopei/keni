# Step 05 — agents-api-and-websocket

**Phase:** Prototype
**Suggested change name:** `agents-api-and-websocket`
**Depends on:** 04

## Goal

Add the agents endpoint (list, pause, resume) and the WebSocket event stream the SPA uses to render the dashboard live. After this step, the SPA has a real-time pipe for board changes, agent state, and activity events; pause/resume from the UI affects the scheduler (introduced in step 08).

## Scope

- REST endpoints for agents:
  - `GET /agents` — returns roster with each agent's role, current status (idle / running), last activity summary, last active timestamp, paused flag. Sourced from project config (§5.1) plus runtime state.
  - `POST /agents/:id/pause`, `POST /agents/:id/resume` — flip the `paused` flag. The scheduler in step 08 reads this flag.
- WebSocket endpoint:
  - One topic-style stream broadcasting events: `ticket.created`, `ticket.updated`, `pr.created`, `pr.updated`, `activity.appended`, `agent.state_changed`. Payloads are minimal references; clients refetch detail via REST.
  - Connection lifecycle: handshake, heartbeat/ping, reconnect-friendly (clients should be able to resume by replaying recent events on reconnect — minimal "since" support is fine).
- Server-side event emitter: REST endpoints from step 04 and the agents endpoints in this step emit the corresponding events.
- All payloads include `project_id` (forward compatibility for multi-project).

## Out of scope

- Scheduler that consumes the `paused` flag — step 08.
- Chat REST/WS — step 15.
- Manual-override events — step 25.

## Spec references

- §7.2 — Dashboard regions: agent roster (left) shows status / last activity / pause/resume; kanban (center) updates live as agents move tickets.
- §6.1 — User can pause or resume any individual agent from the UI; paused agents are skipped by the scheduler.
- §6.3 — Agent's one-line summary is the headline shown in roster ("last activity" label).
- §7.5 — Interrupt UX — handled in step 12, but `agent.state_changed` events from this step also carry `interrupted` / `timeout` flags; design accordingly.

## Open decisions for the proposer

- **Where roster comes from.** Static roster lives in `.keni/project.yaml` (agents and schedules); runtime state (paused, last activity, last active timestamp) is dynamic. Decide whether dynamic state is held in process memory or persisted (e.g., to `.keni/state.json` or a small status store). For prototype, in-memory is acceptable but the API contract should not leak the choice.
- **WebSocket library / pattern.** Plain WS, server-sent events, or a small abstraction — pick one. Justify in `design.md`.
- **Reconnect semantics.** "Since" replay is nice-to-have; minimum viable is "client refetches via REST on reconnect." Pick a tier.

## Notes for /opsx:propose

- `proposal.md` should explain that this step makes the dashboard reactive and gives the user a control affordance over agents.
- `design.md` should pin the event taxonomy (every event type, when emitted, payload shape), pause/resume semantics, and reconnect behaviour.
- `tasks.md` should cover: agents endpoint + tests, pause/resume endpoint + tests, WS server + tests, event emitter wiring across step 04 endpoints, sample client snippet.
- Update or extend the `orchestration-server` capability spec from step 04 to cover events and agents.
