## ADDED Requirements

### Requirement: `@keni/server` exposes an in-process `EventBus` for live updates

The server SHALL provide a typed in-process event bus that fans out updates emitted by route handlers to subscribers (the WebSocket endpoint, the in-memory agent-runtime-state store, future observers). The bus SHALL expose two methods: `emit(frame: EventFrame): void` (synchronous, fire-and-forget; iterates subscribers in registration order; catches and logs handler errors so a failing subscriber never propagates back to the emit caller) and `subscribe(handler): () => void` (returns an unsubscribe closure that removes the handler from the set). The bus SHALL be in-process only — no cross-process messaging, no persistence, no replay buffer in this step. The bus SHALL be injected into `createServer` via `ServerDeps.eventBus`; `runServer` SHALL instantiate `createInMemoryEventBus()` once at bootstrap and pass it through. A subscriber that throws or rejects SHALL have its error logged at warn level via the existing `LogSink` and SHALL NOT cause the emit caller to observe an exception.

#### Scenario: `emit` fans out to every registered subscriber

- **WHEN** two subscribers are registered against the bus
- **AND** the bus emits one `ticket.created` frame
- **THEN** both subscribers receive the same frame object
- **AND** the emit call returns synchronously without awaiting either handler

#### Scenario: A throwing subscriber does not poison the bus

- **WHEN** a subscriber is registered that throws on every frame
- **AND** a second subscriber is registered after it
- **AND** the bus emits one frame
- **THEN** the second subscriber receives the frame
- **AND** the emit caller observes no exception
- **AND** the captured log has a single warn-level line naming the subscriber failure

#### Scenario: Unsubscribe removes the handler

- **WHEN** a subscriber registers and then calls the returned unsubscribe closure
- **AND** the bus emits a frame after the unsubscribe
- **THEN** the unsubscribed handler is not called

### Requirement: `@keni/server` exposes an in-memory `AgentRuntimeStateStore` keyed by agent id

The server SHALL provide an in-memory `AgentRuntimeStateStore` whose entries shape `AgentRuntimeState = { id: string, role: string, status: "idle" | "running", last_activity: string | null, last_active_at: string | null, paused: boolean }`. The store SHALL expose `list(): readonly AgentRuntimeState[]` (returns a snapshot in seed order), `read(id: string): AgentRuntimeState` (throws `StoreNotFoundError` for unknown ids), `setPaused(id: string, paused: boolean): { state: AgentRuntimeState, changed: boolean }` (returns `changed: true` only when the flag actually flipped), and `applyActivityEvent(entry: ActivityEntryResponse): { state: AgentRuntimeState | null, changed: boolean }` (returns `state: null` when the entry's `agent` is not in the roster; otherwise updates `last_activity` to the entry's `event` and `last_active_at` to the entry's `timestamp`, and toggles `status` per the documented decision table — `session_start` → `running`; `session_end`, `session_interrupted`, `session_timeout`, `idle` → `idle`; any other event leaves status unchanged). `runServer` SHALL seed the store from `projectConfig.agents` (or an empty roster when the field is absent) with each agent starting `paused: false`, `status: "idle"`, `last_activity: null`, `last_active_at: null`. The in-memory choice SHALL be documented in this spec; restart behaviour (`paused`, `status`, `last_*` fields reset) SHALL be named explicitly. A future on-disk adapter SHALL be a constructor-argument swap; the interface SHALL NOT change.

#### Scenario: `list()` returns the seeded roster on a fresh server

- **WHEN** `runServer` is invoked against a project whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }, { id: "qa-bob", role: "qa" }]`
- **AND** no activity entries have arrived yet
- **THEN** the store's `list()` returns two entries
- **AND** each entry has `status: "idle"`, `paused: false`, `last_activity: null`, `last_active_at: null`
- **AND** the order matches the YAML declaration order

#### Scenario: `read(unknown)` throws `StoreNotFoundError`

- **WHEN** the store's `read("ghost")` is called for an agent not in the roster
- **THEN** the call throws `StoreNotFoundError` whose `id` is `"ghost"`

#### Scenario: `setPaused` reports `changed: true` only on actual flip

- **WHEN** `setPaused("alice", true)` is called against a roster row whose current `paused` is `false`
- **THEN** the return value is `{ state: { …, paused: true }, changed: true }`
- **AND** a subsequent `setPaused("alice", true)` returns `{ state: { …, paused: true }, changed: false }`

#### Scenario: `applyActivityEvent` updates last_* even when status is unchanged

- **WHEN** the roster contains `alice` with `status: "running"`, `last_activity: "session_start"`, `last_active_at: "2026-05-01T10:00:00Z"`
- **AND** `applyActivityEvent({ agent: "alice", event: "summary", timestamp: "2026-05-01T10:00:30Z", … })` is called
- **THEN** the return value's `state.status` is `"running"` (unchanged)
- **AND** the return value's `state.last_activity` is `"summary"`
- **AND** the return value's `state.last_active_at` is `"2026-05-01T10:00:30Z"`
- **AND** the return value's `changed` is `false` (because status and paused both unchanged; status-changing transitions and pause flips are the only things that set `changed: true`)

#### Scenario: `applyActivityEvent` for an unknown agent returns null state

- **WHEN** an activity entry whose `agent` is `"ghost"` reaches `applyActivityEvent`
- **AND** `"ghost"` is not in the roster
- **THEN** the return value is `{ state: null, changed: false }`

### Requirement: `GET /agents` returns the roster joined with runtime state

`GET /agents` SHALL return `200 { data: AgentResponse[], project_id }` where each `AgentResponse` is `{ id: string, role: string, status: "idle" | "running", last_activity: string | null, last_active_at: string | null, paused: boolean }`. The `data` array SHALL be the result of `AgentRuntimeStateStore.list()` mapped 1:1 to the wire shape. The endpoint SHALL accept any documented role on `X-Keni-Role` (the agent roster is readable by every role in the prototype). Unknown query parameters SHALL be ignored. The endpoint SHALL NOT take a request body.

#### Scenario: Empty roster returns an empty array

- **WHEN** `GET /agents` is called against a project whose `project.yaml` has no `agents` field
- **AND** the request carries `X-Keni-Role: user`
- **THEN** the response is 200
- **AND** the body is `{ data: [], project_id: <uuid> }`

#### Scenario: Configured roster is returned with seeded defaults

- **WHEN** `GET /agents` is called against a project whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]`
- **AND** no activity entries have arrived
- **THEN** the body's `data` contains exactly one entry
- **AND** the entry equals `{ id: "alice", role: "engineer", status: "idle", last_activity: null, last_active_at: null, paused: false }`

#### Scenario: Runtime updates are reflected on the next read

- **WHEN** `POST /activity` is called with `{ agent: "alice", role: "engineer", event: "session_start", session_id: "s1", timestamp: "2026-05-01T10:00:00Z" }`
- **AND** afterwards `GET /agents` is called
- **THEN** the entry for `alice` has `status: "running"`, `last_activity: "session_start"`, `last_active_at: "2026-05-01T10:00:00Z"`, `paused: false`

### Requirement: `POST /agents/:id/pause` and `POST /agents/:id/resume` flip the `paused` flag idempotently

The pause endpoint SHALL set the named agent's `paused` flag to `true`; the resume endpoint SHALL set it to `false`. Both endpoints SHALL accept an empty request body, return `200 { data: AgentResponse, project_id }` with the post-mutation runtime state, and be idempotent (calling pause on an already-paused agent SHALL succeed and return the unchanged state). The role guard SHALL allow only `X-Keni-Role: user`; other roles SHALL be rejected with `403 role_not_owner`. An unknown agent id SHALL produce `404 store_not_found`. Both endpoints SHALL emit `agent.state_changed` on the bus when (and only when) the flag actually flips; an idempotent no-op pause / resume SHALL NOT emit. The flag is consumed by the scheduler in step 08; this requirement does NOT define scheduler behaviour.

#### Scenario: User pauses an idle agent

- **WHEN** `POST /agents/alice/pause` is called with `X-Keni-Role: user` and an empty body
- **AND** `alice`'s current `paused` is `false`
- **THEN** the response is 200
- **AND** the body's `data.paused` is `true`
- **AND** a single `agent.state_changed` frame is emitted on the bus with `payload: { agent_id: "alice", paused: true, status: "idle" }`

#### Scenario: Idempotent pause is a no-op success and emits no event

- **WHEN** `POST /agents/alice/pause` is called twice in succession with `X-Keni-Role: user`
- **THEN** both responses are 200 with `data.paused: true`
- **AND** exactly one `agent.state_changed` frame was emitted on the bus across the two calls

#### Scenario: Engineer cannot pause

- **WHEN** `POST /agents/alice/pause` is called with `X-Keni-Role: engineer`
- **THEN** the response is 403
- **AND** `error.code === "role_not_owner"`
- **AND** `alice`'s `paused` flag is unchanged

#### Scenario: Resume on an unknown agent returns 404

- **WHEN** `POST /agents/ghost/resume` is called with `X-Keni-Role: user`
- **AND** `ghost` is not in the roster
- **THEN** the response is 404
- **AND** `error.code === "store_not_found"`

### Requirement: Existing route handlers emit a single `EventFrame` after every successful mutation

`POST /tickets` SHALL emit `ticket.created` with payload `{ ticket_id, status }` after `TicketStore.create` returns. `PATCH /tickets/:id` SHALL emit `ticket.updated` with payload `{ ticket_id, status, kind: "patch" }` after a successful header / body update. `POST /tickets/:id/transition` SHALL emit `ticket.updated` with payload `{ ticket_id, status, kind: "transition" }` after `TicketStore.transitionStatus` returns. `POST /prs` SHALL emit `pr.created` with payload `{ pr_id, status, ticket }`. `PATCH /prs/:id/intent` SHALL emit `pr.updated` with payload `{ pr_id, status, kind: "intent" }`. `POST /prs/:id/transition` SHALL emit `pr.updated` with payload `{ pr_id, status, kind: "transition" }`. `POST /activity` SHALL emit `activity.appended` with payload `{ entry_id, agent, role, event }`. Each emission SHALL happen after the storage call succeeds and before the response is returned; a storage failure SHALL prevent the emit. The emit SHALL be fire-and-forget (the bus catches subscriber errors); a slow or hung subscriber SHALL NOT delay the HTTP response. Every frame SHALL carry a fresh uuidv7 `id`, the documented `event` name, the resolved `project_id`, and an ISO 8601 UTC `timestamp` captured at emit time.

#### Scenario: `POST /tickets` emits `ticket.created`

- **WHEN** `POST /tickets` is called with `X-Keni-Role: user` and body `{ title: "X", priority: 100 }`
- **AND** the captured bus has one subscriber
- **THEN** the response is 201
- **AND** the captured frames contain exactly one frame whose `event` is `"ticket.created"`
- **AND** the frame's `payload` is `{ ticket_id: <id from response>, status: "open" }`
- **AND** the frame's `id` is a uuidv7 string
- **AND** the frame's `project_id` matches the server's resolved project id

#### Scenario: Transition emits `ticket.updated` with `kind: "transition"`

- **WHEN** `POST /tickets/ticket-0001/transition` is called successfully with `from: "open", to: "in_progress"`
- **THEN** the captured frames contain exactly one frame whose `event` is `"ticket.updated"`
- **AND** the frame's `payload.kind` is `"transition"`
- **AND** the frame's `payload.status` is `"in_progress"`

#### Scenario: A failed storage call does not emit

- **WHEN** `POST /tickets/ticket-0001/transition` is called with a `from` that does not match the on-disk status (a `StaleStateError`)
- **THEN** the response is 409
- **AND** the captured bus has zero frames

#### Scenario: A throwing subscriber does not affect the response

- **WHEN** the bus has one subscriber that throws on every frame
- **AND** `POST /tickets` is called with a valid body and role
- **THEN** the response is 201 with the documented envelope
- **AND** the captured log shows a warn-level line naming the subscriber failure

### Requirement: A successful `POST /activity` updates the agent runtime state and emits `agent.state_changed` when (and only when) the state changes

After `ActivityLogStore.append(input)` returns the persisted entry, the `POST /activity` handler SHALL call `agentRuntimeStateStore.applyActivityEvent(entry)` exactly once before responding. When the call returns `{ changed: true }`, the handler SHALL emit one `agent.state_changed` frame on the bus carrying `payload: { agent_id, paused, status }` reflecting the post-update state, in addition to the `activity.appended` frame the handler always emits. When `changed` is `false` (the entry's agent is unknown, or its event does not flip `status` / `paused`) the handler SHALL NOT emit `agent.state_changed`. The order SHALL be: (1) append, (2) apply activity event, (3) emit `activity.appended`, (4) conditionally emit `agent.state_changed`, (5) respond. The handler — not a bus subscriber — owns this update so the entry is consumed without a refetch and the emit-once-per-request invariant of the route layer is preserved. (`createServer` MAY in a future change register an additional bus subscriber for cross-cutting observers, but the runtime-state update lives inline in the route.)

#### Scenario: `session_start` produces a single `agent.state_changed`

- **WHEN** the activity-log endpoint receives `{ agent: "alice", event: "session_start", session_id: "s1", role: "engineer" }`
- **AND** `alice` is in the roster with `status: "idle"`
- **THEN** the captured frames contain `activity.appended` and exactly one `agent.state_changed`
- **AND** the `agent.state_changed` payload is `{ agent_id: "alice", paused: false, status: "running" }`

#### Scenario: A non-state-changing activity event does not produce `agent.state_changed`

- **WHEN** the activity log receives `{ agent: "alice", event: "summary", … }`
- **AND** `alice` is `running` and not paused
- **THEN** the captured frames contain `activity.appended` only
- **AND** no `agent.state_changed` is emitted

#### Scenario: Unknown agent in activity entry is silently ignored by the runtime store

- **WHEN** the activity log receives `{ agent: "ghost", event: "session_start", … }`
- **AND** `"ghost"` is not in the roster
- **THEN** the captured frames contain `activity.appended` only
- **AND** the runtime store's `list()` does not now contain a `"ghost"` entry

### Requirement: `GET /events` upgrades the connection to a WebSocket and broadcasts every emitted `EventFrame`

`GET /events` SHALL accept a WebSocket upgrade. The handshake SHALL go through the same `requestId` / `requestLog` middlewares the REST surface uses (so every WS handshake produces a request-log line carrying its `request_id`, role, agent, and final status). The handshake SHALL accept the role identity either from the `X-Keni-Role` header or, when the header is absent, from the `?role=<role>` query parameter (browsers cannot set arbitrary headers on `new WebSocket(...)`); the handshake SHALL reject with the documented `400 missing_role` JSON envelope (and SHALL NOT open the socket) when both are absent or unknown. After upgrade, the handler SHALL subscribe to the bus and forward every emitted `EventFrame` to the connected client as a single text frame containing `JSON.stringify(frame)`. On disconnect (`close` or `error`), the handler SHALL unsubscribe from the bus exactly once. The handler SHALL NOT interpret inbound message frames in this step; receiving a non-control frame SHALL be ignored at debug log level. The endpoint SHALL inherit the trust model of the REST surface (local-only, role headers trusted) and SHALL NOT implement any further auth.

#### Scenario: WS upgrade succeeds with `?role=user`

- **WHEN** an HTTP request to `/events?role=user` carries the standard WebSocket upgrade headers
- **AND** no `X-Keni-Role` header is present
- **THEN** the response is a 101 upgrade
- **AND** the upgraded socket receives every subsequent emitted frame as a JSON text message

#### Scenario: WS upgrade succeeds with `X-Keni-Role: user`

- **WHEN** an HTTP request to `/events` carries the standard WebSocket upgrade headers and `X-Keni-Role: user`
- **THEN** the response is a 101 upgrade

#### Scenario: WS upgrade rejected when role is missing

- **WHEN** an HTTP request to `/events` carries the standard WebSocket upgrade headers but no `X-Keni-Role` and no `?role=`
- **THEN** the response is 400 with body `{ error: { code: "missing_role", message: <message> }, project_id: <uuid> }`
- **AND** no socket is opened
- **AND** the request log records a line with `path: "/events"`, `status: 400`, `error_code: "missing_role"`

#### Scenario: WS upgrade rejected when role is unknown

- **WHEN** an HTTP request to `/events?role=super-admin` carries the standard WebSocket upgrade headers
- **THEN** the response is 400 `missing_role`
- **AND** no socket is opened

#### Scenario: Two connected clients both receive every emitted frame

- **WHEN** two WS clients are connected to `/events` (one via header, one via `?role=`)
- **AND** the bus emits one `ticket.created` and one `activity.appended`
- **THEN** each client receives both frames in arrival order

#### Scenario: Disconnect unsubscribes from the bus

- **WHEN** a WS client connects, receives one frame, and disconnects
- **AND** the bus emits a second frame after the disconnect
- **THEN** the disconnected client's bus handler is no longer registered
- **AND** the bus has zero registered subscribers attributable to that connection

### Requirement: Every WS frame is a documented `EventFrame` carrying `id`, `event`, `project_id`, `timestamp`, and `payload`

Every frame written to a connected WS client SHALL be a JSON object matching `EventEnvelope<P>`: `{ id: string (uuidv7), event: EventName, project_id: string, timestamp: string (ISO 8601 UTC), payload: P }`. The discriminated union `EventFrame` SHALL be the union of `EventEnvelope<TicketCreatedPayload>` (event = `ticket.created`, payload = `{ ticket_id, status }`), `EventEnvelope<TicketUpdatedPayload>` (event = `ticket.updated`, payload = `{ ticket_id, status, kind: "patch" | "transition" }`), `EventEnvelope<PRCreatedPayload>` (event = `pr.created`, payload = `{ pr_id, status, ticket }`), `EventEnvelope<PRUpdatedPayload>` (event = `pr.updated`, payload = `{ pr_id, status, kind: "intent" | "transition" }`), `EventEnvelope<ActivityAppendedPayload>` (event = `activity.appended`, payload = `{ entry_id, agent, role, event }`), and `EventEnvelope<AgentStateChangedPayload>` (event = `agent.state_changed`, payload = `{ agent_id, paused, status }`). Frames SHALL NOT carry the full storage record; the SPA refetches via REST when it needs detail. Frames SHALL NOT be re-broadcast on reconnect (the prototype reconnect tier is "client refetches via REST"); the wire shape SHALL leave the `id` field in place so a future `?since=<event-id>` replay is purely additive.

#### Scenario: A `ticket.created` frame matches the documented shape

- **WHEN** a client connected to `/events` receives a frame after `POST /tickets` with `{ title: "X", priority: 100 }`
- **THEN** the parsed JSON has `event: "ticket.created"`
- **AND** `payload` is `{ ticket_id: <id>, status: "open" }`
- **AND** `id` is a uuidv7 string
- **AND** `timestamp` parses as a valid ISO 8601 UTC instant
- **AND** `project_id` matches the server's resolved id

#### Scenario: An `agent.state_changed` frame from pause/resume matches the documented shape

- **WHEN** a client receives a frame after `POST /agents/alice/pause`
- **THEN** the parsed JSON has `event: "agent.state_changed"` and `payload: { agent_id: "alice", paused: true, status: "idle" }`

#### Scenario: An `EventFrame` is exhaustively typed by `event`

- **WHEN** a contributor adds a new event name to `EventName` in `@keni/shared/wire/events.ts` without extending the discriminated union
- **THEN** `deno task check` fails — the `EventFrame` union does not cover the new variant and consumers (the WS handler, the SPA's switch) cannot exhaustively type-narrow

### Requirement: The WS connection runs a 25-second protocol-level heartbeat with a two-missed-pong close threshold

The server SHALL send a WebSocket protocol-level `ping` control frame to every connected client every 25 seconds. The client is expected to respond with a `pong` control frame within the same window. After two consecutive missed pongs (50 seconds without a response), the server SHALL close the connection with WebSocket close code `1011` (server error / abnormal closure). Clients SHALL be expected to reconnect immediately. Heartbeat ping / pong frames SHALL NOT be visible to the application-event channel (they are protocol-level, not application messages). The interval SHALL be hard-coded in the prototype; promoting it to a configurable value is an additive change.

#### Scenario: Active client receives a ping and the connection persists

- **WHEN** a client connects to `/events` and remains connected for 30 seconds
- **AND** the client's WS implementation auto-replies to ping with pong
- **THEN** the connection remains open
- **AND** the bus subscription remains active

#### Scenario: Two missed pongs close the connection

- **WHEN** a client connects to `/events` but its socket is silently dropped (no pong reply)
- **AND** 60 seconds pass
- **THEN** the connection is closed by the server with code 1011
- **AND** the bus subscription registered for that connection has been removed

### Requirement: `runServer` instantiates the bus and the agent runtime-state store at bootstrap

`runServer` SHALL call `createInMemoryEventBus()` once after parsing argv and before constructing the server. It SHALL read `projectConfig.agents` (treating an absent field as `[]`) and pass that list to `createInMemoryAgentRuntimeStateStore(roster)`, where each entry is seeded with `paused: false`, `status: "idle"`, `last_activity: null`, `last_active_at: null` and the role read from the project-config row. Both instances SHALL be passed to `createServer` via the extended `ServerDeps`. Direct `deno run -A packages/server/src/main.ts --project=<path>` invocations SHALL produce a working `/agents` endpoint and `/events` upgrade without any additional flags.

#### Scenario: Boot against a project with a roster

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a project whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]`
- **THEN** the bound server's `GET /agents` returns the seeded `alice` row
- **AND** the bound server's `/events` accepts a WS upgrade

#### Scenario: Boot against a project with no roster

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a project whose `project.yaml` has no `agents` field
- **THEN** the bound server's `GET /agents` returns `{ data: [], project_id: <uuid> }`

### Requirement: Wire shapes for `agents` and `events` follow the same TS-types-in-`@keni/shared` / zod-schemas-in-`@keni/server` split as the existing endpoints

The `@keni/shared` package SHALL export, from `@keni/shared/wire/`, TypeScript types for the new shapes: `AgentStatus` (the union `"idle" | "running"`), `AGENT_STATUSES` (the runtime tuple), `isAgentStatus` (the type-guard), `AgentResponse`, `AgentListResponse`, `AgentEnvelope`, `EventName` (the closed union of the six documented strings), `EVENT_NAMES` (tuple), `isEventName` (type-guard), `EventEnvelope<P>`, `TicketCreatedPayload`, `TicketUpdatedPayload`, `PRCreatedPayload`, `PRUpdatedPayload`, `ActivityAppendedPayload`, `AgentStateChangedPayload`, and the `EventFrame` discriminated union. None of these types SHALL pull `npm:zod` into the import graph. The `@keni/server` package SHALL export, from `packages/server/src/wire/`, zod schemas for `AgentResponse` and `EventEnvelope` (and each per-payload variant), each declared with the explicit `z.ZodType<SharedType>` constraint so a drift fails the type-check. Each new `wire/*_test.ts` SHALL include the type-equivalence assertion (`expectType<z.infer<typeof Schema>>().toEqual<SharedType>()`) the existing wire tests use.

#### Scenario: Type-only consumer pulls no zod runtime

- **WHEN** a consumer writes `import type { AgentResponse, EventFrame } from "@keni/shared"`
- **THEN** the imports resolve to TypeScript types
- **AND** the consumer's bundle (after tree-shaking) contains no zod runtime code

#### Scenario: Adding a payload field without updating the schema fails the type-check

- **WHEN** a contributor adds `labels: readonly string[]` to `TicketCreatedPayload` in `@keni/shared/wire/events.ts`
- **AND** does not add the corresponding zod field to the matching schema in `@keni/server/wire/events.ts`
- **THEN** `deno task check` fails with a TS error pointing at the schema's `z.ZodType<…>` annotation

#### Scenario: Adding a new event name fails until the union is extended

- **WHEN** a contributor adds `"ticket.deleted"` to `EVENT_NAMES` in `@keni/shared/wire/events.ts`
- **AND** does not extend the `EventFrame` discriminated union
- **THEN** `deno task check` fails because consumers of `EventFrame` no longer exhaustively cover the union

### Requirement: The WS endpoint's trust model extends the role-header trust model with a `?role=` query-parameter fallback

The trust model from the existing capability requirement (local-only, no auth, role headers trusted) SHALL extend to the WS upgrade verbatim with one addition: when the upgrade request lacks an `X-Keni-Role` header (the common case for `new WebSocket(...)` from a browser), the upgrade handler SHALL accept the role from the `?role=<role>` query parameter. The query parameter SHALL apply *only* to the WS upgrade path; REST endpoints SHALL continue to require the header. A request with both header and query parameter SHALL prefer the header. Future auth (post-MVP) SHALL slot in front of both, validating the caller's right to claim the role; the role-resolution rule itself SHALL NOT change.

#### Scenario: REST endpoints do not accept `?role=`

- **WHEN** `GET /tickets?role=user` is called without `X-Keni-Role`
- **THEN** the response is 400 `missing_role`

#### Scenario: WS endpoint accepts `?role=`

- **WHEN** an upgrade request to `/events?role=user` is sent without `X-Keni-Role`
- **THEN** the response is 101 (the upgrade succeeds)

#### Scenario: Both header and query parameter — header wins

- **WHEN** an upgrade request to `/events?role=user` carries `X-Keni-Role: engineer`
- **THEN** the upgrade succeeds with `c.var.role === "engineer"`
- **AND** the WS handler observes the role as `engineer` for downstream subscribers

### Requirement: The capability documents the in-memory persistence tier and the additive seam for future `?since=` replay

This capability SHALL document, in this spec file and in the README, that the agent runtime state and the event-bus stream are both **in-memory only** in this step: a server restart resets `paused`, `status`, `last_activity`, `last_active_at` for every agent, and any in-flight events not yet delivered are lost. The reconnect tier SHALL be "client refetches via REST" — no replay buffer, no `?since=` query parameter. The wire shape (`EventEnvelope.id` = uuidv7) SHALL be designed so a future ring-buffered `?since=<event-id>` replay is purely additive: no breaking change is required. Step 25's manual-override flow and a future persistence change MAY add this seam without modifying the existing requirements.

#### Scenario: Documentation names the in-memory limitation

- **WHEN** the root `README.md` is read
- **THEN** the "Run the orchestration server" subsection states that pause / resume flags reset on restart
- **AND** names the activity log as the durable record of agent activity
- **AND** notes that the events stream is live-only — REST is the canonical record

#### Scenario: The wire shape carries `id` for the additive replay seam

- **WHEN** any frame is observed on the WS channel
- **THEN** the parsed JSON has a `id` field that is a uuidv7 string
- **AND** the same `id` is monotonically increasing across consecutive frames in time order

### Requirement: Existing route handlers continue to satisfy every requirement from the prior step

The existing requirements covering the ticket / PR / activity / error-envelope / status-graph / role-identity / project-id-stamping / middleware-order / trust-model / dev-entry-point surfaces SHALL continue to pass unchanged. No existing requirement SHALL be modified, weakened, or removed by this change. The new requirements above SHALL be additive: the existing `errorBoundary` registration, the existing closed `ErrorCode` enum, the existing JSONL log line shape, and the existing `requestId → requestLog → roleIdentity → routes` middleware order SHALL all remain in force. Specifically: the WS upgrade SHALL go through the same middleware order; `agent_paused` is NOT added to `ErrorCode` (the scheduler is step 08); and no new error code is introduced in this step.

#### Scenario: `ErrorCode` enum is unchanged

- **WHEN** the value of `ERROR_CODES` in `@keni/shared/wire/errors.ts` is read
- **THEN** the array equals the closed list from the prior step (`store_not_found`, `stale_state`, `duplicate_id`, `invalid_artifact`, `status_in_patch`, `status_graph_violation`, `role_not_owner`, `missing_role`, `validation_failed`, `internal_error`)
- **AND** no new code has been added

#### Scenario: Middleware order is unchanged

- **WHEN** `createServer` is built with stub middleware that record their invocation order
- **AND** any request is sent (REST or WS upgrade)
- **THEN** the recorded order is `["requestId", "requestLog", "roleIdentity"]`
- **AND** `errorBoundary` is registered via `app.onError(...)`

#### Scenario: A failed WS upgrade still emits a request-log line

- **WHEN** an upgrade request without a role is dispatched
- **THEN** the request log captures one line with `path: "/events"`, `status: 400`, `error_code: "missing_role"`
- **AND** the line carries the `request_id` echoed on the response
