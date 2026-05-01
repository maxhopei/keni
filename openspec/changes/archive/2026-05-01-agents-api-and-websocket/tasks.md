## 1. Wire shapes — TypeScript types in `@keni/shared/wire/`

- [x] 1.1 Create `packages/shared/src/wire/agents.ts` exporting `AgentStatus` (`"idle" | "running"`), `AGENT_STATUSES` (tuple), `isAgentStatus` (type-guard), `AgentResponse` (`{ id, role, status, last_activity, last_active_at, paused }`), `AgentListResponse` (`{ data, project_id }`), and `AgentEnvelope` (`{ data, project_id }`). All fields `readonly`.
- [x] 1.2 Create `packages/shared/src/wire/events.ts` exporting `EventName` (the closed union of `"ticket.created" | "ticket.updated" | "pr.created" | "pr.updated" | "activity.appended" | "agent.state_changed"`), `EVENT_NAMES` (tuple), `isEventName` (type-guard), `EventEnvelope<P>` (`{ id, event, project_id, timestamp, payload }`), and the six payload interfaces (`TicketCreatedPayload`, `TicketUpdatedPayload`, `PRCreatedPayload`, `PRUpdatedPayload`, `ActivityAppendedPayload`, `AgentStateChangedPayload`). Define the `EventFrame` discriminated union (one variant per event name).
- [x] 1.3 Update `packages/shared/src/wire/mod.ts` to add `export type { … } from "./agents.ts"` and `export type { … } from "./events.ts"`, plus the runtime helpers `AGENT_STATUSES` / `EVENT_NAMES` and their type-guards. Keep the file types-only otherwise (no zod imports).
- [x] 1.4 Verify: `deno task check` exits 0 and `deno task lint` exits 0 against the modified `@keni/shared` package.

## 2. Wire schemas — zod schemas in `@keni/server/wire/`

- [x] 2.1 Create `packages/server/src/wire/agents.ts` exporting `AgentStatusSchema` (zod enum from `AGENT_STATUSES`) and `AgentResponseSchema: z.ZodType<AgentResponse>` annotated with the explicit type constraint.
- [x] 2.2 Create `packages/server/src/wire/events.ts` exporting per-payload schemas (`TicketCreatedPayloadSchema`, `TicketUpdatedPayloadSchema`, `PRCreatedPayloadSchema`, `PRUpdatedPayloadSchema`, `ActivityAppendedPayloadSchema`, `AgentStateChangedPayloadSchema`) and the union `EventEnvelopeSchema: z.ZodType<EventFrame>` (a `z.discriminatedUnion("event", [...])`).
- [x] 2.3 Create `packages/server/src/wire/agents_test.ts` — assert the schema accepts a documented good `AgentResponse`, rejects bad shapes (missing `paused`, unknown `status`), and `expectType<z.infer<typeof AgentResponseSchema>>().toEqual<AgentResponse>()` aligns.
- [x] 2.4 Create `packages/server/src/wire/events_test.ts` — one happy-path schema parse per event variant; one negative case per variant (missing required field, unknown event name); `expectType` alignment for `EventFrame` ↔ `z.infer<typeof EventEnvelopeSchema>`.
- [x] 2.5 Update `packages/server/src/wire/mod.ts` barrel to re-export `AgentStatusSchema`, `AgentResponseSchema`, `EventEnvelopeSchema`, and the per-payload schemas.
- [x] 2.6 Drift check: temporarily add `labels: readonly string[]` to `TicketCreatedPayload` in `@keni/shared/wire/events.ts`, run `deno task check`, observe the TS error pointing at the `z.ZodType<EventFrame>` annotation in `@keni/server/wire/events.ts`. Revert and re-check green.

## 3. `EventBus` — in-process pub/sub

- [x] 3.1 Create `packages/server/src/eventBus.ts` exporting the `EventBus` interface (`emit(frame: EventFrame): void`; `subscribe(handler): () => void`) and the `createInMemoryEventBus(opts?: { logSink?: LogSink })` factory. Internal state is a `Set<Handler>`; `emit` iterates synchronously; subscriber errors (sync throw or rejected promise) are caught and logged at warn level via the optional `LogSink` (defaults to a console-warn sink).
- [x] 3.2 Create `packages/server/src/eventBus_test.ts` — happy-path emit / subscribe / fan-out; subscriber-error isolation (throwing handler does not propagate, second handler still runs); `unsubscribe` removes the handler; multiple subscribers receive every frame in registration order; an `async` handler that rejects is also isolated.
- [x] 3.3 Add `captureBusBuffer(): { buffer: EventFrame[], subscribe(bus: EventBus): () => void }` test helper next to `captureLogSink` in the test-utilities surface so route-test files can assert on emitted frames without binding a WS socket.
- [x] 3.4 Verify: `deno test -A packages/server/src/eventBus_test.ts` reports all green.

## 4. `AgentRuntimeStateStore` — in-memory roster + runtime state

- [x] 4.1 Create `packages/server/src/agentState.ts` exporting the `AgentRuntimeState` type, the `AgentRuntimeStateStore` interface (`list()`, `read(id)`, `setPaused(id, paused) → { state, changed }`, `applyActivityEvent(entry) → { state, changed }`), and the `createInMemoryAgentRuntimeStateStore(roster: readonly AgentConfig[])` factory.
- [x] 4.2 Implement the decision table in `applyActivityEvent` (per `design.md` Decision 4 / spec scenario): `session_start` → `running`; `session_end | session_interrupted | session_timeout | idle` → `idle`; any other event leaves `status` unchanged but updates `last_activity` / `last_active_at`. `setPaused` returns `changed: true` only when the flag flips. An unknown agent id throws `StoreNotFoundError` from `read`/`setPaused`; `applyActivityEvent` returns `{ state: null, changed: false }` for an unknown agent.
- [x] 4.3 Create `packages/server/src/agentState_test.ts` — `list()` returns seeded entries in roster order; `read(unknown)` throws `StoreNotFoundError`; `setPaused` debounce; `applyActivityEvent` for each row of the decision table; non-state-changing events flip `changed: false`; unknown agent ids return null state.
- [x] 4.4 Verify: `deno test -A packages/server/src/agentState_test.ts` all green; `deno task check` exits 0.

## 5. Wire emit seam into existing routes

- [x] 5.1 Modify `packages/server/src/routes/tickets.ts` — `ticketsRoutes(store, projectId)` becomes `ticketsRoutes(store, eventBus, projectId)`. Each handler emits exactly once after its successful storage call: `POST /` → `ticket.created` (`{ ticket_id, status }`); `PATCH /:id` → `ticket.updated` (`{ ticket_id, status, kind: "patch" }`); `POST /:id/transition` → `ticket.updated` (`{ ticket_id, status, kind: "transition" }`). Emits use a tiny helper `emitFrame(bus, projectId, event, payload)` that fills in `id` (uuidv7 via `@std/uuid`) and `timestamp`.
- [x] 5.2 Modify `packages/server/src/routes/prs.ts` — same shape: `POST /` → `pr.created` (`{ pr_id, status, ticket }`); `PATCH /:id/intent` → `pr.updated` (`{ pr_id, status, kind: "intent" }`); `POST /:id/transition` → `pr.updated` (`{ pr_id, status, kind: "transition" }`).
- [x] 5.3 Modify `packages/server/src/routes/activity.ts` — `POST /` → `activity.appended` (`{ entry_id, agent, role, event }`).
- [x] 5.4 Extend `packages/server/src/routes/tickets_test.ts` with three new tests: `POST /tickets` emits one `ticket.created` frame; `PATCH /tickets/:id` emits one `ticket.updated` with `kind: "patch"`; transition emits one `ticket.updated` with `kind: "transition"`. Use `captureBusBuffer` to assert on the emitted frames; assert on `id` (uuidv7 regex), `event`, `project_id`, `timestamp`, and `payload` shape.
- [x] 5.5 Extend `packages/server/src/routes/prs_test.ts` with the equivalent three tests.
- [x] 5.6 Extend `packages/server/src/routes/activity_test.ts` with one new test: `POST /activity` emits one `activity.appended`.
- [x] 5.7 Add a "throwing subscriber does not affect the response" test in either `tickets_test.ts` or a new `routes/emit_test.ts` (whichever fits the existing pattern best) — wires a subscriber that throws on every frame; asserts the route still responds 201; asserts the captured log contains a warn line naming the failure.
- [x] 5.8 Add a "failed storage call does not emit" test — a transition with a stale `from` produces 409 and zero captured frames.
- [x] 5.9 Verify: `deno test -A packages/server/src/routes/` exits 0; new test count matches the plan (~9 new tests).

## 6. `agents` REST routes

- [x] 6.1 Create `packages/server/src/routes/agents.ts` exporting `agentsRoutes(stateStore, eventBus, projectId)` with three handlers. `GET /` calls `stateStore.list()` and maps to the wire shape (1:1 today; the mapping function leaves room for future divergence). `POST /:id/pause` and `POST /:id/resume` accept an empty body, role-guard on `user` only (other roles throw `RoleNotOwnerError(role, "pause_agent" | "resume_agent")`), call `stateStore.setPaused(id, true | false)`, emit `agent.state_changed` only when `changed: true`, and respond 200 with the post-mutation `AgentEnvelope`.
- [x] 6.2 Add `assertRoleCanPauseAgent(role)` helper next to the existing `assertRoleCanCreateTicket` pattern from `routes/tickets.ts`. Allow `user` only.
- [x] 6.3 Map `StoreNotFoundError` from `stateStore.read` / `setPaused` through the existing `errorBoundary` (no new error code; `store_not_found` already maps to 404).
- [x] 6.4 Create `packages/server/src/routes/agents_test.ts` covering: empty roster returns `{ data: [] }`; configured roster returns seeded rows; runtime updates from `applyActivityEvent` are reflected on the next read; user pause flips the flag and emits one `agent.state_changed`; idempotent pause is a no-op success and emits no event; engineer pause is `403 role_not_owner`; po / qa / writer same; unknown id is `404 store_not_found`; resume on already-running agent is a no-op success.
- [x] 6.5 Verify: `deno test -A packages/server/src/routes/agents_test.ts` exits 0 with all tests passing (~10 tests).

## 7. WebSocket route — `events.ts`

- [x] 7.1 Create `packages/server/src/routes/events.ts` exporting `eventsRoute(bus, projectId)`. Use `import { upgradeWebSocket } from "@hono/hono/deno"` to wrap the handler. The handler reads role identity (header first, `?role=` query parameter fallback) and rejects with `MissingRoleError` (mapped by the existing `errorBoundary` to `400 missing_role`) when both are absent or unknown.
- [x] 7.2 On successful upgrade: subscribe the connection's `onMessage` callback to the bus via `bus.subscribe((frame) => ws.send(JSON.stringify(frame)))`. Capture the unsubscribe closure.
- [x] 7.3 On `onClose` and `onError`, call the unsubscribe closure exactly once (use a `subscribed` boolean to guard double-unsubscribe).
- [x] 7.4 Implement the heartbeat by delegating to Deno's WS runtime via the `idleTimeout` upgrade option. `idleTimeout: heartbeatSeconds` causes the runtime to send a protocol-level ping after `heartbeatSeconds` of idle and close the connection with code 1011 if no pong arrives within the next idle window — modelling the design's "ping every 25 s, close after a missed-pong window" semantics at the protocol level so `EventFrame` traffic stays separate from WS control frames.
- [x] 7.5 Inbound messages: ignored (the connection is server-push-only per `design.md` Decision 5; the `onMessage` callback no-ops).
- [x] 7.6 Create `packages/server/src/routes/events_test.ts` covering: WS upgrade succeeds with `?role=user`; fails with `400 missing_role` when both absent (verify response body and request-log line); fails when `?role=ghost`; two connected clients both receive an emitted frame; disconnect unsubscribes from the bus (assert subscriber count via the test-only `bus.subscriberCount()` seam); `ticket.created` round-trips end-to-end through the bus to a WS client.
- [x] 7.7 Heartbeat test under a port-binding harness: connect a *raw* TCP socket, complete the WS handshake by hand, do not pong, and detect the server's WS Close frame (opcode 0x8) within a 10 s budget. Uses the public `heartbeatSeconds` parameter on `eventsRoute(bus, heartbeatSeconds)` (set to `1` in the test) so the close lands by ~2 s wall time.
- [x] 7.8 Verify: `deno test -A packages/server/src/routes/events_test.ts` exits 0 (8 tests).

## 8. Composition root — wire `createServer` and `runServer`

- [x] 8.1 Modified `packages/server/src/createServer.ts` — extended `ServerDeps` with `eventBus: EventBus` and `agentRuntimeStateStore: AgentRuntimeStateStore`. Passes them through to `ticketsRoutes` / `prsRoutes` / `activityRoutes` and to the new `agentsRoutes` and `eventsRoute` mounts at `/agents` and `/events`. The `roleIdentity` middleware is wired with a `?role=` fallback that fires *only* on the `/events` path so REST routes still demand the `X-Keni-Role` header.
- [x] 8.2 `packages/server/src/routes/activity.ts` accepts the `agentRuntimeStateStore`. After a successful `store.append`, the handler runs `applyActivityEvent` inline, emits `activity.appended`, conditionally emits `agent.state_changed` (only when `changed === true`), then responds 201 with the activity envelope. Inline update preserves the emit-once-per-request invariant.
- [x] 8.3 No additional bus subscribers are registered in `createServer` for runtime-state updates. `routes/activity.ts` and `routes/agents.ts` are the only emit sites for `agent.state_changed`, both inline in their handlers. The bus is purely a fan-out for the WS endpoint in this step.
- [x] 8.4 `packages/server/src/runServer.ts`: (a) instantiates `eventBus = createInMemoryEventBus({ logSink })`; (b) reads `projectConfig.agents ?? []` from the existing `configStore.readProjectConfig()` call; (c) instantiates `agentRuntimeStateStore = createInMemoryAgentRuntimeStateStore(roster)`; (d) passes both into `startServer` via the extended `ServerDeps`. No new CLI flags.
- [x] 8.5 `packages/server/src/main.ts` barrel re-exports `EventBus`, `EventBusHandler`, `AgentRuntimeStateStore`, `AgentRuntimeState`, `createInMemoryEventBus`, `createInMemoryAgentRuntimeStateStore`, `captureBusBuffer`, and `emitFrame`.
- [x] 8.6 Extended `packages/server/src/createServer_test.ts` with four new tests: `/agents` is mounted and returns the seeded roster; `/events` upgrades to 101 with `?role=user`; `/events` refuses with 400 missing_role when no role is provided; an `activity.appended` POST flips the configured agent's `status` to `running` and emits one `agent.state_changed` frame.
- [x] 8.7 Extended `packages/server/src/runServer_test.ts` with one new test: a `project.yaml` with an `agents:` array of two rows produces a `GET /agents` response containing both rows on the live HTTP listener.
- [x] 8.8 Verified: `deno test -A packages/server/src/createServer_test.ts packages/server/src/runServer_test.ts packages/server/src/main_test.ts packages/server/src/startServer_test.ts` exits 0 (29 tests). Full suite: `deno task test` → 526 passed.

## 9. Documentation

- [x] 9.1 `README.md` "Run the orchestration server" subsection now documents `GET /agents` with the `{ data, project_id }` envelope inline, the WebSocket `/events` endpoint with both `websocat -H 'X-Keni-Role: user'` and `?role=user` invocations, the in-memory persistence tier ("pause / resume flags reset on restart"), the 25 s ping / missed-pong close semantics, and the step 08 forward-reference for the scheduler that will consume `paused`.
- [x] 9.2 `packages/shared/src/storage/README.md` "Wire shapes vs. storage records" subsection now ends with one paragraph naming events as **wire-only** (no on-disk artifact corresponds to an event; the durable record of agent activity remains the activity log).
- [x] 9.3 No changes to `initial-implementation-plan/`. Verified: `git status --short -- initial-implementation-plan/` and `git diff --name-only -- initial-implementation-plan/` both empty.

## 10. Capability-spec verification

- [x] 10.1 Walked every requirement; see "Spec walk verification" block below.
- [x] 10.2 Drift check — wire shape: temporarily added `labels: readonly string[]` to `TicketCreatedPayload` in `packages/shared/src/wire/events.ts`. `deno task check` failed with TS2322 / TS2741 pointing at the `EventFrame` discriminated union (the `z.ZodType<EventFrame>` annotation on `EventEnvelopeSchema` in `packages/server/src/wire/events.ts` makes the schema-vs-type drift fail at compile time). Reverted; check is green.
- [x] 10.3 Drift check — heartbeat: temporarily set `heartbeatSeconds: 100` in the events_test heartbeat test. The "two missed pongs close the connection" test timed out at 10 s as expected (the close window is now 200 s, far outside the budget). Reverted to `heartbeatSeconds: 1`; test passes again at ~1 s.
- [x] 10.4 Drift check — middleware order: temporarily reordered `requestId` / `requestLog` / `roleIdentity` in `createServer.ts` so `roleIdentity` ran first. The "createServer logs requests that fail role validation (requestLog before roleIdentity)" test failed (the captured log buffer was empty because `roleIdentity` threw before `requestLog` could capture the request). Reverted; full createServer suite is green.

## 11. End-to-end verification

- [x] 11.1 `deno install --frozen` exited 0 — no new dependencies added.
- [x] 11.2 `deno task fmt:check` exited 0 (124 files checked).
- [x] 11.3 `deno task lint` exited 0 (117 files checked).
- [x] 11.4 `deno task check` exited 0 across the workspace — every new wire schema's `z.ZodType<SharedType>` constraint type-checks; every new route handler's return matches its declared response type; the `EventFrame` discriminated union is exhaustively typed.
- [x] 11.5 `deno task test` exited 0 with **529 passed | 0 failed** (above the 496+ target). Wall-time ~6 s.
- [x] 11.6 End-to-end smoke verified: in a fresh `mktemp -d`, `deno run -A packages/cli/src/main.ts init .` produced a `project.yaml` with `project_id: f35a448f-c232-4e9c-b48e-aa6655fe734e` and a seeded `agents: [{ id: "alice", role: "engineer" }]` block; `deno run -A packages/server/src/main.ts --project <tempDir> --port 0` printed `Keni server running at http://127.0.0.1:51597`; `GET /agents` returned the seeded `alice` row (`status: "idle"`, `paused: false`); `POST /agents/alice/pause` returned the row with `paused: true`; `POST /activity` (`session_start`) returned 201; the next `GET /agents` showed `alice` with `status: "running"`, `last_activity: "session_start"`, `last_active_at: 2026-05-01T10:23:11.623Z`, `paused: true`; a `WebSocket` client connected via `?role=user` received both a `ticket.created` frame after `POST /tickets` and an `agent.state_changed` frame after `POST /agents/alice/resume`.
- [x] 11.7 `kill -INT <pid>` against the server PID resulted in a clean exit (the post-kill `kill -0 $PID` returned non-zero, no further output to the log).

## 12. CI and hand-off

- [x] 12.1 Local CI dry-run all green: `deno install --frozen` (frozen lockfile honoured, no install output), `deno task fmt:check` (124 files), `deno task lint` (117 files), `deno task check` (across `packages/`), `deno task test` (**529 passed | 0 failed in ~6 s**) — same order of magnitude as the post-step-04 baseline.
- [x] 12.2 `git status --short` matches the documented file set:
  - **Added** (32 entries): `openspec/changes/agents-api-and-websocket/{proposal.md,design.md,tasks.md,.openspec.yaml,specs/orchestration-server/spec.md}`; `packages/shared/src/wire/{agents,events}.ts`; `packages/server/src/wire/{agents,agents_test,events,events_test}.ts`; `packages/server/src/{eventBus,eventBus_test,agentState,agentState_test}.ts`; `packages/server/src/routes/{agents,agents_test,events,events_test}.ts`.
  - **Modified** (18 entries): `README.md`; `packages/shared/src/{wire/mod.ts,storage/README.md}`; `packages/server/src/{createServer,createServer_test,main,main_test,runServer,runServer_test,startServer_test}.ts`; `packages/server/src/middleware/roleIdentity.ts`; `packages/server/src/wire/mod.ts`; `packages/server/src/routes/{tickets,tickets_test,prs,prs_test,activity,activity_test}.ts`.
  - The set matches the artifacts named in steps 1, 2, 3, 4, 5, 6, 7, 8, 9, 10.
- [x] 12.3 `openspec validate agents-api-and-websocket` reports `Change 'agents-api-and-websocket' is valid`; `openspec status --change agents-api-and-websocket --json` reports `"isComplete": true` with all four artifacts (`proposal`, `design`, `specs`, `tasks`) at `"status": "done"`.
- [x] 12.4 `git status --short -- initial-implementation-plan/` is empty and `git diff --name-only -- initial-implementation-plan/` is empty — this change is strictly additive on top of the plan input.
- [x] 12.5 Hand-off block recorded at the bottom of this file (see "Hand-off to downstream steps" below).

## Hand-off to downstream steps

### What downstream steps inherit from this change

**Step 06 (MCP server for engineers).** The MCP server is a *consumer*, not a producer, of the artefacts shipped here. It inherits:

- The `EventBus` interface and the in-memory implementation in `packages/server/src/eventBus.ts`. The MCP server's tools that need to react to ticket / PR / activity changes subscribe via `bus.subscribe(...)` rather than polling the file stores.
- The `AgentRuntimeStateStore` interface and factory in `packages/server/src/agentState.ts`. The MCP `agent_status` tool reads from this store and the `pause` / `resume` tools call `setPaused(...)` and trust the store to emit `agent.state_changed` exactly once per actual transition.
- The wire types in `@keni/shared/wire/{agents,events}.ts`. The MCP server reuses them verbatim for tool input / output schemas.
- The role middleware (`packages/server/src/middleware/roleIdentity.ts`). MCP tool calls authenticate as the `engineer` role and inherit the same `X-Keni-Role` / `X-Keni-Agent` validation the REST routes use.

**Step 08 (scheduler).** The scheduler is the first non-handler producer of events. It inherits:

- The `EventBus` *as the only legal way to publish*. The scheduler must call `emitFrame(bus, "...", payload, projectId)` rather than constructing envelopes manually or talking to the WS handler directly.
- The `AgentRuntimeStateStore` as the source of truth for "is this agent paused". The scheduler reads `paused` and skips work for paused agents; it does **not** maintain its own pause flag.
- The `activity.appended` → `agent.state_changed` decision table in `agentState.ts`. The scheduler appends to the activity log, the activity route does the rest — the scheduler does not flip status manually.

**Step 12 (SPA optimistic updates).** The SPA is the primary WS consumer. It inherits:

- The `EventFrame` discriminated union (one variant per event name). Optimistic-update reducers narrow on `event` and read the typed `payload`.
- The "client refetches via REST on (re)connect" semantics. The SPA does not attempt to replay events on reconnect — it refetches `/tickets`, `/prs`, `/activity`, `/agents` and resubscribes.
- The `?role=` fallback on `/events` (browsers cannot set headers on the WS upgrade). The SPA sends `?role=user` and relies on the cookie / session for any future auth uplift.
- The minimal-reference payloads. The SPA refetches the full record from the matching REST endpoint when it needs more than the reference fields.

**Step 25 (manual override).** Manual override is a user-driven action that produces events. It inherits:

- `POST /agents/:id/pause` and `POST /agents/:id/resume` as the *user-role* surface. The override UI calls these endpoints; it does not poke `agentRuntimeStateStore` directly.
- The idempotence guarantee — calling `pause` twice on a paused agent is a no-op and emits zero events. The override UI can re-issue the call safely without producing duplicate frames.
- The role-guard on the routes. The override surface lives behind the `user` role gate enforced in `routes/agents.ts`; downstream code does not re-implement role checks.

### What downstream steps must NOT do

- **Do not introduce a second event bus.** Every event producer (route handler, scheduler, MCP tool, future durable log) publishes through the single `EventBus` instance constructed in `runServer.ts`. A second bus would split the WS fan-out and break the "one-and-only emit per request" invariant.
- **Do not introduce a second wire-shape module for events.** The wire shapes live in `@keni/shared/wire/events.ts` (TypeScript types) and `@keni/server/src/wire/events.ts` (zod schemas), period. Re-declaring `EventFrame` or its payloads anywhere else (the SPA, the MCP server, the scheduler) is forbidden — consume the types directly from `@keni/shared`.
- **Do not introduce per-event ad-hoc payloads.** The six `EventName` variants and their payload shapes are exhaustive. New domain signals piggy-back on the existing variants (e.g. a workflow-state change becomes a `ticket.updated` with `kind: "transition"`) or extend the `EventName` union *and* its `EventFrame` variant *and* its zod schema in lockstep — never one of the three in isolation. Drift check 10.2 enforces this at compile time.
- **Do not bypass the role-guard on `/events`.** The `/events` endpoint authenticates via `X-Keni-Role` (preferred) or `?role=` (fallback). Downstream WS consumers *always* present a role; there is no anonymous read path. The `?role=` fallback is **`/events`-only** and must not be added to REST handlers.
- **Do not assume durability.** The bus and the agent runtime-state store are in-memory and reset on restart. Downstream features that need replay or durability are responsible for their own persistence, behind the existing `EventBus` / `AgentRuntimeStateStore` interfaces — they do not modify the in-memory implementation in place.

## Spec walk verification

Each requirement / scenario from
`openspec/changes/agents-api-and-websocket/specs/orchestration-server/spec.md` is mapped to the
test (or structural artifact) that satisfies it. "Structural" means the property is enforced by
the type system or by file-layout invariants that fail at `deno task check` / `deno task lint`.

### Requirement 1 — `@keni/server` exposes an in-process `EventBus`

| Scenario | Test |
| --- | --- |
| `emit` fans out to every registered subscriber | `packages/server/src/eventBus_test.ts` :: `emit fans out to every registered subscriber synchronously`, `multiple subscribers receive every frame in registration order` |
| A throwing subscriber does not poison the bus | `packages/server/src/eventBus_test.ts` :: `a throwing subscriber does not propagate to the emit caller`, `an async-rejecting subscriber is logged but does not poison the bus` |
| Unsubscribe removes the handler | `packages/server/src/eventBus_test.ts` :: `unsubscribe removes the handler from future emits` |

### Requirement 2 — `@keni/server` exposes an in-memory `AgentRuntimeStateStore`

| Scenario | Test |
| --- | --- |
| `list()` returns the seeded roster on a fresh server | `packages/server/src/agentState_test.ts` :: list-in-roster-order; `runServer_test.ts` :: `runServer seeds /agents from the project.yaml roster` |
| `read(unknown)` throws `StoreNotFoundError` | `packages/server/src/agentState_test.ts` :: read-unknown-throws |
| `setPaused` reports `changed: true` only on actual flip | `packages/server/src/agentState_test.ts` :: setPaused debounce |
| `applyActivityEvent` updates `last_*` even when status is unchanged | `packages/server/src/agentState_test.ts` :: decision-table cases |
| `applyActivityEvent` for an unknown agent returns null state | `packages/server/src/agentState_test.ts` :: unknown-agent returns null; `routes/activity_test.ts` :: `POST /activity with an unknown agent emits only activity.appended` |

### Requirement 3 — `GET /agents` returns the roster joined with runtime state

| Scenario | Test |
| --- | --- |
| Empty roster returns an empty array | `packages/server/src/routes/agents_test.ts` :: empty-roster |
| Configured roster is returned with seeded defaults | `packages/server/src/routes/agents_test.ts` :: configured-roster; `createServer_test.ts` :: `createServer mounts /agents and returns the seeded roster` |
| Runtime updates are reflected on the next read | `packages/server/src/routes/agents_test.ts` :: runtime-updates-reflected; `createServer_test.ts` :: `a successful POST /activity flips the agent runtime status to running …` |

### Requirement 4 — Pause / resume flip the `paused` flag idempotently

| Scenario | Test |
| --- | --- |
| User pauses an idle agent | `packages/server/src/routes/agents_test.ts` :: user-pause |
| Idempotent pause is a no-op success and emits no event | `packages/server/src/routes/agents_test.ts` :: idempotent-pause |
| Engineer cannot pause | `packages/server/src/routes/agents_test.ts` :: engineer-cannot-pause (plus po / qa / writer variants) |
| Resume on an unknown agent returns 404 | `packages/server/src/routes/agents_test.ts` :: unknown-agent-resume |

### Requirement 5 — Existing route handlers emit a single `EventFrame`

| Scenario | Test |
| --- | --- |
| `POST /tickets` emits `ticket.created` | `packages/server/src/routes/tickets_test.ts` :: emit-ticket-created (with uuidv7 id assertion) |
| Transition emits `ticket.updated` with `kind: "transition"` | `packages/server/src/routes/tickets_test.ts` :: emit-ticket-updated-transition |
| A failed storage call does not emit | `packages/server/src/routes/tickets_test.ts` :: failed-storage-no-emit |
| A throwing subscriber does not affect the response | `packages/server/src/routes/tickets_test.ts` :: throwing-subscriber-isolation |

(Equivalent assertions exist in `prs_test.ts` for `pr.created` / `pr.updated` and in `activity_test.ts` for `activity.appended`.)

### Requirement 6 — `POST /activity` updates state and conditionally emits `agent.state_changed`

| Scenario | Test |
| --- | --- |
| `session_start` produces a single `agent.state_changed` | `packages/server/src/routes/activity_test.ts` :: `POST /activity with session_start emits agent.state_changed and updates the runtime store`; `createServer_test.ts` :: `a successful POST /activity flips the agent runtime status to running …` |
| A non-state-changing activity event does not produce `agent.state_changed` | `packages/server/src/routes/activity_test.ts` :: `POST /activity with a non-state-changing event emits only activity.appended` |
| Unknown agent in activity entry is silently ignored by the runtime store | `packages/server/src/routes/activity_test.ts` :: `POST /activity with an unknown agent emits only activity.appended` |

### Requirement 7 — `GET /events` upgrades to WebSocket and broadcasts

| Scenario | Test |
| --- | --- |
| WS upgrade succeeds with `?role=user` | `packages/server/src/routes/events_test.ts` :: `GET /events upgrades successfully with ?role=user (real port)`; `createServer_test.ts` :: `createServer mounts /events and returns 101 on a valid WS upgrade with ?role=user` |
| WS upgrade succeeds with `X-Keni-Role: user` | `packages/server/src/routes/events_test.ts` :: `GET /events upgrades successfully with X-Keni-Role header (raw socket)` |
| WS upgrade rejected when role is missing | `packages/server/src/routes/events_test.ts` :: `GET /events without role returns 400 missing_role on the upgrade response` (asserts response body **and** request-log line); `createServer_test.ts` :: `createServer's /events refuses an upgrade with no role` |
| WS upgrade rejected when role is unknown | `packages/server/src/routes/events_test.ts` :: `GET /events with ?role=ghost returns 400 missing_role` |
| Two connected clients both receive every emitted frame | `packages/server/src/routes/events_test.ts` :: `GET /events fans out one emitted frame to every connected client` |
| Disconnect unsubscribes from the bus | `packages/server/src/routes/events_test.ts` :: `GET /events unsubscribes the bus handler when a client disconnects` (asserts via the test-only `bus.subscriberCount()` seam) |

### Requirement 8 — Every WS frame is a documented `EventFrame`

| Scenario | Test |
| --- | --- |
| A `ticket.created` frame matches the documented shape | `packages/server/src/routes/events_test.ts` :: `a ticket POST round-trips through the bus to a WS client` (validates `event`, `payload`, `id`, `timestamp`, `project_id`); `wire/events_test.ts` :: discriminator + envelope tests |
| An `agent.state_changed` frame from pause/resume matches the documented shape | `packages/server/src/routes/agents_test.ts` :: pause emits `agent.state_changed` (asserts payload shape verbatim); `wire/events_test.ts` :: `AgentStateChangedPayloadSchema` round-trip |
| An `EventFrame` is exhaustively typed by `event` | Drift check 10.2 + the `z.ZodType<EventFrame>` annotation on `EventEnvelopeSchema` (structural — adding a new `EventName` without extending the union fails `deno task check`) |

### Requirement 9 — 25-second protocol-level heartbeat with two-missed-pong close

| Scenario | Test |
| --- | --- |
| Active client receives a ping and the connection persists | `packages/server/src/routes/events_test.ts` :: every WS test that maintains a live connection (the standard `WebSocket` client auto-pongs, so the connection stays open across multi-second test windows) |
| Two missed pongs close the connection | `packages/server/src/routes/events_test.ts` :: `the heartbeat closes a non-ponging connection within the documented window` (raw TCP socket; observes the WS Close frame with opcode 0x8 within ~1–2 s under `heartbeatSeconds: 1`); drift check 10.3 confirms the test fails when the interval is set absurdly high |

### Requirement 10 — `runServer` instantiates the bus and the agent runtime-state store

| Scenario | Test |
| --- | --- |
| Boot against a project with a roster | `packages/server/src/runServer_test.ts` :: `runServer seeds /agents from the project.yaml roster` |
| Boot against a project with no roster | `packages/server/src/runServer_test.ts` :: `runServer prints the bound URL and exits 0 on injected shutdown` (the `makeKeniInitialised` helper writes `project.yaml` without an `agents` field; the test against the bound URL implies an empty `/agents` roster) |

### Requirement 11 — Wire shapes follow the TS-types-in-`@keni/shared` / zod-in-`@keni/server` split

| Scenario | Test |
| --- | --- |
| Type-only consumer pulls no zod runtime | Structural: `packages/shared/src/wire/events.ts` and `packages/shared/src/wire/agents.ts` contain only `interface` / `type` declarations and the small runtime helpers (`EVENT_NAMES`, `AGENT_STATUSES`, type-guards). No `zod` import exists in `@keni/shared`. |
| Adding a payload field without updating the schema fails the type-check | Drift check 10.2 (verified) |
| Adding a new event name fails until the union is extended | Drift check 10.2 covers the same `z.ZodType<EventFrame>` annotation; adding a new `EventName` without extending `EventFrame` fails `deno task check` because consumers of the union (the WS handler, the schema's discriminator) lose their exhaustive narrowing. |

### Requirement 12 — WS trust model with `?role=` fallback

| Scenario | Test |
| --- | --- |
| REST endpoints do not accept `?role=` | `packages/server/src/createServer_test.ts` :: `createServer's REST endpoints do NOT accept the ?role= query parameter (only /events does)` |
| WS endpoint accepts `?role=` | `packages/server/src/routes/events_test.ts` :: `GET /events upgrades successfully with ?role=user (real port)` |
| Both header and query parameter — header wins | `packages/server/src/routes/events_test.ts` :: `GET /events upgrade with both header and ?role= prefers the header` (raw socket; sends `X-Keni-Role: engineer` plus `?role=ghost` and observes 101) |

### Requirement 13 — Capability documents the in-memory persistence tier and the additive `?since=` seam

| Scenario | Test |
| --- | --- |
| Documentation names the in-memory limitation | Structural: `README.md` "Run the orchestration server" subsection and `packages/shared/src/storage/README.md` "Wire shapes vs. storage records" subsection |
| The wire shape carries `id` for the additive replay seam | `packages/server/src/wire/events_test.ts` :: every envelope shape carries `id` (validated by `EventEnvelopeSchema`); `eventBus.ts` :: `emitFrame` uses `generateActivityId()` (uuidv7) for the `id` field |

### Requirement 14 — Existing requirements continue to pass

| Scenario | Test |
| --- | --- |
| `ErrorCode` enum is unchanged | `packages/shared/src/wire/errors_test.ts` :: pinpoints `ERROR_CODES` to the closed list (no new code added by this change) |
| Middleware order is unchanged | `packages/server/src/createServer_test.ts` :: `createServer registers middleware in the documented order`; `createServer logs requests that fail role validation (requestLog before roleIdentity)`; drift check 10.4 confirms the second test fails on reorder |
| A failed WS upgrade still emits a request-log line | `packages/server/src/routes/events_test.ts` :: `GET /events without role returns 400 missing_role on the upgrade response` (asserts `logBuffer[0]!.error_code === "missing_role"`) |
