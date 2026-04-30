# Step 04 — orchestration-server-and-rest-apis

**Phase:** Prototype
**Suggested change name:** `orchestration-server-and-rest-apis`
**Depends on:** 03

## Goal

Stand up Keni's HTTP orchestration server and the REST endpoints for tickets, PRs, and the activity log — the surface every Keni consumer (SPA, MCP, role runtimes, the user via curl) ultimately calls. Status-machine enforcement (§4.2) lives here so it cannot be bypassed.

## Scope

- HTTP server skeleton: routing, JSON request/response, structured error responses, request logging.
- Wires the server to the storage interfaces from step 02.
- REST endpoints for tickets:
  - `GET /tickets`, `GET /tickets/:id`, `POST /tickets` (user-driven in prototype), `PATCH /tickets/:id` (body/title/priority).
  - `POST /tickets/:id/transition` — enforces the state machine. **Only the owning role can transition into its own statuses** (§4.2). Engineers cannot set `tested`; QA cannot set `merged`; the user can override but the override path lives in step 25 (logged as `manual_override`). For the prototype, wire the role guard but leave a clearly-marked TODO for the override flow.
- REST endpoints for PRs: list, read, create, update intent, update status — same role-guarded transition rule.
- REST endpoints for activity log: append entry, query (filter by agent / role / date range / ticket / PR).
- All entities carry `project_id` so a future multi-project server is purely additive (§7.1).
- Structured request/response types shared with the SPA (via the `shared` package from step 01).

## Out of scope

- WebSocket events and the `/agents` endpoint (step 05).
- MCP tools (step 06).
- Chat endpoints (step 15).
- Manual-override confirmation flow and `manual_override` event logging (step 25).
- Auth — local-only server in prototype, no auth.

## Spec references

- §2#1 — Environment as communication bus; the server is that bus.
- §2#3 — "Status drives behaviour." Transitions are the only legitimate state changes.
- §4.1 — Ticket lifecycle (every status the transitions endpoint must support).
- §4.2 — Owning-role rule, `test_failed` as an explicit status, no `rejected` status, priority is PO-owned integer.
- §4.3 — Who creates tickets (in prototype: the user creates directly; the API must accept user-authored tickets).
- §5.3 — Server is the gatekeeper for `.keni/` writes; the API is the only legitimate writer for tickets/PRs/activity log on `main`.
- §7.1 — `keni start` will boot this server (handled in step 13); plan for one-server-one-project.

## Open decisions for the proposer

- **Server framework.** Pick one (Hono, Fastify, Express, native http/Node, Bun's `serve`, etc.). Justify against principle §2#4 (thin) and the team's language choice from step 01.
- **Role authorisation model.** The "owning role" check is the central constraint. Decide how role identity arrives at the endpoint — for the prototype, a header or query parameter supplied by the role runtime is acceptable; the SPA acts as "user" role; document the model and call out the override-flow gap.
- **Validation strategy.** zod / typebox / json-schema / etc. — pick one and apply consistently.

## Notes for /opsx:propose

- `proposal.md` should explain that this step turns the file-backed storage into a proper service, with the status machine enforced.
- `design.md` should include: endpoint table (method, path, request, response, owning-role guard), error response format, request logging shape, the role identity contract.
- `tasks.md` should cover: server scaffold, ticket endpoints + tests, PR endpoints + tests, activity log endpoints + tests, status-machine guard with role-based gating, error/logging middleware.
- A capability spec for `orchestration-server` documenting the API contract is highly useful for downstream steps and `/opsx:verify`.
