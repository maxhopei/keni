## ADDED Requirements

### Requirement: `POST /agents/:id/interrupt` aborts the active cycle by delegating to `Scheduler.interrupt(agentId)`

The orchestration server SHALL expose `POST /agents/:id/interrupt`. The route SHALL:

- Accept an empty request body. Any non-empty body SHALL be ignored (no schema validation beyond `Content-Type` parsing).
- Be role-guarded to `X-Keni-Role: user`; other roles SHALL be rejected with `403 role_not_owner`. Missing or empty `X-Keni-Role` SHALL be rejected with `400 missing_role` per the existing role-identity middleware.
- Validate that the agent id (`:id`) is in the roster. An unknown id SHALL be rejected with `404 store_not_found`. The route SHALL NOT call `scheduler.interrupt` for an unknown id (the scheduler also returns `unknown_agent` for this case, but the route SHALL pre-check via the runtime-state store so the response carries the canonical `404` error envelope rather than relying on the scheduler's discriminated return).
- For a roster member, call `scheduler.interrupt(id)` exactly once and map the discriminated return to the HTTP response:
  - `{ interrupted: true, sessionId }` → `200 { data: AgentResponse, project_id }`. The `AgentResponse` body SHALL be the post-call runtime state, read via `agentRuntimeStateStore.read(id)` after the scheduler's synchronous `POST /activity` for `session_interrupted` has been processed (the scheduler's activity post runs in-process during the interrupt call; the route SHALL `await` `scheduler.interrupt(...)` so the response body reflects the post-update state).
  - `{ interrupted: false, reason: "no_active_cycle" }` → `200 { data: AgentResponse, project_id }`. The body SHALL be the unmodified runtime state. This case is treated as an idempotent success — the desired post-condition (no active cycle for this agent) is already met. The route SHALL NOT return a 4xx error code for this case.
  - `{ interrupted: false, reason: "unknown_agent" }` → `404 store_not_found`. (This branch is reached only if the route's pre-check above missed the case — e.g., a race where the agent was removed from the roster between the pre-check and the `interrupt` call. The handler SHALL still surface the canonical 404 envelope.)

The route SHALL NOT emit any additional `EventFrame` of its own. The scheduler's `POST /activity` for `session_interrupted` already produces the documented `activity.appended` and (transitively, via the runtime-state store's `applyActivityEvent`) the `agent.state_changed` frame. **No double emission.**

The route SHALL NOT auto-revert the on-disk ticket status. Tickets remain in whatever state they were in before the interrupt fired (per `spec.md` §7.5 and the matching `scheduler` requirement).

#### Scenario: User interrupts a running agent

- **WHEN** `POST /agents/alice/interrupt` is called with `X-Keni-Role: user` and an empty body
- **AND** `alice`'s scheduler-side `active` cycle is in flight (`scheduler.interrupt("alice")` returns `{ interrupted: true, sessionId: "s-abc" }`)
- **THEN** the response is 200
- **AND** the body shape is `{ data: AgentResponse, project_id }`
- **AND** the body's `data.id` is `"alice"`, `data.last_activity` is `"session_interrupted"`, and `data.status` is `"idle"`
- **AND** at least one `activity.appended` frame for `event: "session_interrupted"` was captured on the bus during the request
- **AND** at least one `agent.state_changed` frame whose payload's `agent_id` is `"alice"` and `status` is `"idle"` was captured on the bus during the request
- **AND** no `agent.state_changed` frame was emitted by the route itself in addition to the scheduler-driven frame (the bus-recorded count of `agent.state_changed` frames matches the activity-post path's documented single emission)

#### Scenario: Interrupting an idle agent is an idempotent 200

- **WHEN** `POST /agents/alice/interrupt` is called with `X-Keni-Role: user`
- **AND** `alice` is in the roster but `scheduler.interrupt("alice")` returns `{ interrupted: false, reason: "no_active_cycle" }`
- **THEN** the response is 200
- **AND** the body's `data.id` is `"alice"` and the runtime state matches the pre-call snapshot (no `last_activity` change attributable to this request)
- **AND** zero `activity.appended` frames for `event: "session_interrupted"` were emitted
- **AND** zero `agent.state_changed` frames were emitted

#### Scenario: Engineer cannot interrupt

- **WHEN** `POST /agents/alice/interrupt` is called with `X-Keni-Role: engineer`
- **THEN** the response is 403
- **AND** `error.code === "role_not_owner"`
- **AND** `scheduler.interrupt` was not called

#### Scenario: Interrupt on an unknown agent returns 404

- **WHEN** `POST /agents/ghost/interrupt` is called with `X-Keni-Role: user`
- **AND** `ghost` is not in the roster
- **THEN** the response is 404
- **AND** `error.code === "store_not_found"`
- **AND** `scheduler.interrupt` was not called (the route's pre-check short-circuits)

#### Scenario: Missing role header is 400

- **WHEN** `POST /agents/alice/interrupt` is called without `X-Keni-Role`
- **THEN** the response is 400
- **AND** `error.code === "missing_role"`

#### Scenario: A non-empty body is ignored

- **WHEN** `POST /agents/alice/interrupt` is called with `X-Keni-Role: user` and body `{ "reason": "ignored" }`
- **AND** `alice` has an active cycle
- **THEN** the response is 200 (the body shape is the same as for an empty body)
- **AND** `scheduler.interrupt("alice")` was called exactly once

#### Scenario: The route does not auto-revert the on-disk ticket

- **WHEN** `POST /agents/alice/interrupt` is called with `X-Keni-Role: user` against an `alice` whose active cycle is working `ticket-0001` whose on-disk status is `in_progress`
- **AND** the call resolves with HTTP 200
- **THEN** the on-disk `ticket-0001` status is still `in_progress` (the orchestration server did not call `TicketStore.transitionStatus` as part of the interrupt path)
