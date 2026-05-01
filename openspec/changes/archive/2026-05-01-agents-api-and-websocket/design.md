## Context

Step 04 has shipped: `@keni/server` exposes a Hono app with REST endpoints for tickets, PRs, and the activity log; every write goes through a role-guarded handler that emits a structured request-log line and a stable error envelope; the project is bound to a single `project_id` resolved once at bootstrap; integration tests drive the real composition root via `app.fetch(new Request(...))` against file-backed stores rooted in `Deno.makeTempDir()`. What that step deliberately did *not* ship is anything that closes the loop back to the user — the dashboard `spec.md` §7.2 promises ("the board updates live as agents move tickets") cannot be honoured off REST polling alone, and the §6.1 "pause or resume any individual agent from the UI" affordance has nowhere to land because there is no `/agents` endpoint behind it. Step 05 builds that closing loop on top of the existing server.

Several spec principles drive this design:

- **§2#1 — Environment as communication bus.** The WebSocket stream is structurally a *re-broadcast* of the writes the existing REST handlers already perform. It does not introduce a second source of truth — the bus subscriber publishes after the storage write returns successfully. This keeps the §2#1 invariant ("artifacts are the channel") intact: every event the SPA receives corresponds to a write that happened against `.keni/`.
- **§5.3 — Server is the gatekeeper.** The agents endpoint and the WS handshake reuse the same `roleIdentity` middleware and the same `errorBoundary`-driven envelope. There is no second middleware order, no second error envelope, no second project-id resolution rule. The trust model from step 04 (local-only, no auth, role headers trusted) extends to the WS surface verbatim, with a `?role=` query parameter as the SPA-friendly equivalent (browsers cannot set arbitrary headers on `new WebSocket(...)`).
- **§6.1 — Scheduler-driven pause / resume.** The `paused` flag is the seam between this step's user affordance and step 08's scheduler. We ship the contract (REST endpoint, in-memory state, emit-on-change event) so step 08 can read it; we do not ship the scheduler.
- **§7.1 — One server, one project.** Events carry `project_id` so a future multi-project server (post-MVP) is purely additive — the WS upgrade rejects with 400 if a future client sends a mismatched `project_id` in a future filter. For the prototype the project id is the resolved one and is stamped on every frame.
- **§7.2 — Dashboard regions.** The agent roster (left) is fed by `GET /agents` (initial load) and `agent.state_changed` (live updates); the kanban (centre) is fed by `GET /tickets` plus `ticket.created` / `ticket.updated`; the activity feed (separate view) is fed by `GET /activity` plus `activity.appended`. The minimal-reference payload shape (Decision 3) is what makes the dashboard's optimistic-update seam (step 12) tractable: the SPA receives a small, stable signal and refetches the canonical record from REST, so the storage record's shape can evolve without breaking the live channel.

Constraints and givens:

- Runtime is Deno 2.7+. Hono v4's `@hono/hono/deno` ships an `upgradeWebSocket` helper that wraps `Deno.serve`'s native WS upgrade — same router, same middleware stack, same `app.fetch`-based test harness.
- The `EventBus` is in-process. The orchestration server is one-server-one-project (`spec.md` §7.1); cross-process pub/sub is structurally out of scope. A future multi-process expansion would slot a NATS / Redis / equivalent adapter behind the same `EventBus` interface — that change is post-MVP and additive.
- The `AgentRuntimeStateStore` is in-memory. Restart resets `paused` / `status` / `last_activity` / `last_active_at`. The capability spec documents this explicitly so a contributor does not assume persistence and so step 08's scheduler knows what state survives a server bounce (none today).
- The closed `ErrorCode` enum from step 04 is preserved. No new error codes in this step; the WS handshake's role-guard failure surfaces the existing `missing_role` code via a JSON body in the upgrade refusal *and* a 1008 close on the (briefly opened) socket.

Non-constraints (explicitly free to choose):

- The **internal layout** of the new code under `packages/server/src/`: whether to put the bus next to `errors.ts` / `statusGraph.ts` or in its own folder, whether the WS route is a `routes/events.ts` file or a new `ws/` directory.
- The **bus implementation**: a `Set<Handler>` with synchronous fan-out, a `BroadcastChannel`, an `EventTarget` subclass, or an array. Whichever is simplest and testable.
- The **heartbeat interval** (within reasonable bounds — 10–60 s).
- The **debounce policy** on `agent.state_changed` (whether successive same-state writes coalesce).
- The **WS test pattern**: `Deno.serve` + a real socket vs. Hono's `app.fetch`-based upgrade. The latter is preferred because the existing test suite uses it for REST and a single style keeps cognitive load low.

## Goals / Non-Goals

**Goals:**

- An `@keni/server` Hono app exists that, when bound to file-backed stores rooted at a `keni init`-produced `.keni/`, exposes both the existing REST surface and a new WebSocket event stream on the same port, with the same middleware stack and the same trust model.
- `GET /agents` returns the project's configured roster joined to runtime state; the wire shape does not leak the in-memory choice of state storage.
- `POST /agents/:id/pause` and `POST /agents/:id/resume` flip the `paused` flag idempotently, emit `agent.state_changed`, and respond `200`.
- The WS endpoint at `/events` multiplexes six event types (`ticket.created`, `ticket.updated`, `pr.created`, `pr.updated`, `activity.appended`, `agent.state_changed`) over a single connection, with minimal-reference payloads, every frame carrying `id` (uuidv7), `event`, `project_id`, `timestamp`, and `payload`.
- The connection lifecycle is documented end-to-end: handshake (with role guard via header *or* `?role=` query parameter), heartbeat ping every 25 s with a 2-missed-pong close threshold, and a "client refetches via REST on reconnect" tier with a forward-compatible seam for `?since=<event-id>` replay.
- Existing route handlers gain one `bus.emit(...)` line each after their successful storage write; the emit is fire-and-forget and a failing subscriber cannot poison the request handler.
- The `AgentRuntimeStateStore` listens for `activity.appended` and updates `last_activity` / `last_active_at` / `status` per a small decision table; pause / resume go through the store's `setPaused` method which emits `agent.state_changed` *only when the flag actually changes* (debounce).
- Wire shapes (`Agent*`, `Event*`) live in `@keni/shared/wire/` as types-only; zod schemas live in `@keni/server/src/wire/` with `z.ZodType<SharedType>` drift annotations; the existing wire-test pattern from step 04 carries through.
- Integration tests cover every endpoint and every event type using `app.fetch`-based WS upgrades (no port binding), including the role-guard refusal path and the heartbeat round-trip.
- The capability spec gains additive requirements; no existing requirement changes.

**Non-Goals:**

- **No scheduler.** Step 08 reads the `paused` flag and writes `agent.state_changed` on session start / end. This step ships the API contract and the in-memory state machine; the scheduler is its consumer.
- **No persisted agent state.** A future change can swap the in-memory `AgentRuntimeStateStore` for a `state.json`-backed adapter — interface stays stable, only the constructor argument changes. Documented as a known limitation in the capability spec.
- **No multi-topic WS subscription.** One fan-out channel; per-topic subscription (`?topics=ticket.*,activity.*`) is additive.
- **No bidirectional WS messages.** The prototype connection is push-only; future inbound messages (subscription filters, ack frames for `?since=` replay) slot in additively.
- **No `?since=<event-id>` replay.** The wire shape carries `id` so it lands additively. The prototype tier is "client refetches via REST on reconnect."
- **No new error codes.** The closed `ErrorCode` enum from step 04 is preserved.
- **No WS-level auth.** Inherits step 04's local-only / role-header trust model. The capability spec extends the trust-model requirement to name the `?role=` query parameter.
- **No cross-process bus.** In-process; one server, one project.
- **No `manual_override` activity emission on pause / resume.** Pause / resume are user-driven but not status transitions; the §4.2 / §7.4 override-flow with confirmation and `manual_override` activity entries lives in step 25 and applies only to status transitions.
- **No PO chat / spec / CR endpoints.** Steps 14–15 own those.
- **No file-watcher reactivity.** Direct edits to `.keni/` on disk do not produce events. The capability spec names this gap and points at file-watching as a post-MVP additive change (`spec.md` §10).

## Decisions

### Decision 1: WebSocket transport — Hono's `upgradeWebSocket` from `@hono/hono/deno`

**Why:** the existing app already builds on `@hono/hono`; the `deno` sub-export ships an `upgradeWebSocket(handler)` helper that wraps `Deno.serve`'s native WS upgrade, lets the upgrade handler read the same `c.var.role` / `c.var.agent` / `c.var.request_id` set by the existing middleware stack, and is tested with the same `app.fetch(new Request(..., { upgrade: "websocket" }))` pattern used for REST. Picking it gives us one router, one middleware order, one trust model, one test harness, and one runtime dep to upgrade when Hono v5 lands.

**Alternatives considered:**

- **Server-Sent Events (SSE).** Simpler than WS (one-way only, automatic reconnect built into the browser's `EventSource`), no upgrade handshake, fits naturally with the "push-only" choice in Decision 5. Rejected because: SSE's server-push character is *less* general than WS (no path open for a future bidirectional message in step 12 / 22 without a parallel WS endpoint), browser support for setting headers on `EventSource` is even weaker than on `WebSocket`, and the integration-test harness for SSE is less ergonomic in Deno (`fetch` returns a streaming body but iterating it in `app.fetch` requires manual stream-reader plumbing — the WS upgrade pattern is shorter and more declarative in the test). The `id` field per frame is also a SSE-native field, which would have been a nice match — but its semantics differ from our uuidv7 (SSE's `id` is the *last-event-id* a client echoes back on reconnect, which we explicitly defer — Decision 6). Net: SSE saves us nothing today and constrains tomorrow. Rejected.
- **Raw `Deno.serve` WS upgrade with a hand-rolled router.** No new dependency, full control, but every other route already lives on the Hono app and benefits from the middleware stack — running the WS endpoint outside Hono would either bypass `requestId` / `requestLog` / `roleIdentity` (creating a second trust model) or duplicate them inline (drift risk). Rejected.
- **`npm:ws` or `npm:socket.io` via Deno's npm-compat layer.** Both pull in a Node-emulation chunk for an upgrade we already have native to Deno. socket.io adds protocol overhead (rooms, namespaces, polling fallback) we do not need on a 127.0.0.1 prototype. Rejected.
- **Long-poll endpoint (`GET /events/long-poll?wait=30s`).** Cheap to test, but fans out poorly — every reconnect window costs a roundtrip of headers, every subscriber holds a request slot, and the server has to maintain a per-client queue anyway. Rejected.

### Decision 2: One topic-style channel, fan-out from a single in-process bus

**Why:** the prototype dashboard subscribes to all six event types simultaneously (the SPA needs ticket, PR, activity, and agent updates concurrently). Splitting events across separate channels would force the SPA to manage N WS connections with no benefit (N is fixed at 6, payload shapes are tiny, fan-out at the server is trivial). A single channel also makes the heartbeat / reconnect / role-guard logic single-instance: one timer per connection, one close-handler per connection. When a future change wants per-topic subscription (e.g., a CLI tool that only cares about ticket transitions), the additive seam is `?topics=ticket.*,activity.*` on the same endpoint — implemented as a server-side filter applied between the bus subscriber and the WS frame writer, no new endpoint.

**Alternatives considered:**

- **Per-topic endpoint (`/events/tickets`, `/events/prs`, …).** SPA must open six connections, each with its own handshake, heartbeat, and reconnect logic. Multiplies surface area for no current benefit. Rejected.
- **One channel per project_id (forward-looking multi-project).** Premature; one server, one project per `spec.md` §7.1. Rejected.
- **Topic prefix routing on the bus instead of the wire.** The bus could expose `subscribe("ticket.*", handler)` and the WS handler would fan out to per-topic subscriptions. Same end result, more code today. We can add the glob-prefix subscription later when we need it for filtering.

### Decision 3: Event payload shape — minimal reference, not full record

**Every event frame** carries `{ id, event, project_id, timestamp, payload }`:

- `id`: uuidv7 — chronological, sortable, dedupe-friendly. Generated at emit time.
- `event`: one of the six documented strings (the discriminator for the typed `EventFrame` union).
- `project_id`: the resolved project id (forward-compat for multi-project).
- `timestamp`: ISO 8601 UTC, captured at emit time. (Storage records also carry a timestamp; we pick the emit time for the event because the event is *about* the emit, not the storage write — which may have happened a few microseconds earlier.)
- `payload`: a minimal reference. *Not* the full storage record.

| Event | Payload |
| --- | --- |
| `ticket.created` | `{ ticket_id: string, status: TicketStatus }` |
| `ticket.updated` | `{ ticket_id: string, status: TicketStatus, kind: "patch" \| "transition" }` |
| `pr.created` | `{ pr_id: string, status: PRStatus, ticket: string }` |
| `pr.updated` | `{ pr_id: string, status: PRStatus, kind: "intent" \| "transition" }` |
| `activity.appended` | `{ entry_id: string, agent: string, role: string, event: string }` |
| `agent.state_changed` | `{ agent_id: string, paused: boolean, status: AgentStatus }` |

**Why minimal:**

- **Stability under storage evolution.** The wire-vs-storage split (step 04 Decision 6) lets the storage record gain fields without changing the API response. Minimal-reference event payloads extend the same property to the event channel — a future `ticket.labels` field cannot leak into the live stream because the live stream never carried the full record.
- **Race avoidance.** If the event payload included the full ticket and a second mutation lands between the storage write and the emit, the SPA could see an event whose payload is *older* than the next REST refetch. A minimal reference always agrees with the canonical REST representation because the SPA refetches.
- **Smaller frames.** A typical ticket record is ~500 bytes JSON; a reference is ~80 bytes. With six event types and a busy project, this matters at scale (post-MVP) and costs nothing today.

**The `kind` field on `*.updated` events** distinguishes the cause (which the SPA can use to prioritise its refetch — a `transition` is always status-relevant and warrants an immediate kanban update; a `patch` may be a body edit that only the ticket-detail view cares about). It is a small, closed-set hint, not a full diff.

**Alternatives considered:**

- **Full record in payload.** Larger frames, race risk above, couples the live channel to the storage shape. Rejected.
- **`{ before, after }` diff payload.** Adds a layer of state-change semantics the prototype does not need; the SPA's optimistic-update layer (step 12) does its own reconciliation against REST. Rejected.
- **Just the id, no `status` / `kind`.** The SPA would have to refetch on *every* event to know whether the kanban needs to move a card vs. just bump a "last-updated" timestamp. Tiny, hot fields like `status` are cheap to send and save a refetch. Picked the small-but-useful reference.

### Decision 4: `AgentRuntimeStateStore` — in-memory, swappable interface

**Why:** the runtime state (`paused`, `status`, `last_activity`, `last_active_at`) is *transient* in `spec.md`'s sense (`state.json` is git-ignored, restart-volatile). The simplest implementation that holds the API contract is an in-memory `Map<agent_id, runtime>` initialised from the project config's `agents:` field. It is also the one we can ship in a single file with no I/O surface. The interface is what matters — once it is stable, a future step (08, or a dedicated persistence change later) can swap in a `StateJsonAgentRuntimeStateStore` adapter without touching anything else.

**Shape:**

```ts
// packages/server/src/agentState.ts
export interface AgentRuntimeState {
  readonly id: string;
  readonly role: string;
  readonly status: AgentStatus;            // "idle" | "running"
  readonly last_activity: string | null;   // last activity-log event name (e.g., "session_end")
  readonly last_active_at: string | null;  // ISO 8601 UTC
  readonly paused: boolean;
}

export interface AgentRuntimeStateStore {
  list(): readonly AgentRuntimeState[];
  read(id: string): AgentRuntimeState;                 // throws StoreNotFoundError
  setPaused(id: string, paused: boolean): {
    readonly state: AgentRuntimeState;
    readonly changed: boolean;                          // true iff the flag actually flipped
  };
  applyActivityEvent(entry: ActivityEntryResponse): {
    readonly state: AgentRuntimeState | null;           // null if the entry's agent is unknown
    readonly changed: boolean;                          // true iff status or last_* fields changed
  };
}
```

**The `applyActivityEvent` decision table** (the table is small enough to live next to its tests):

| `entry.event` | New `status` | Update `last_activity` / `last_active_at` |
| --- | --- | --- |
| `session_start` | `"running"` | yes |
| `session_end` | `"idle"` | yes |
| `session_interrupted` | `"idle"` | yes |
| `session_timeout` | `"idle"` | yes |
| `idle` | `"idle"` | yes |
| any other event | unchanged | yes (the agent is alive — `last_activity` reflects the latest event by name; e.g., `summary`) |

The `setPaused` and `applyActivityEvent` return shapes carry a `changed: boolean` that the **calling route handler** uses to decide whether to emit `agent.state_changed`. This is the debounce: an activity entry whose new status equals the current status (e.g., a `summary` event mid-session keeps `status: "running"`) does not produce an event; only genuine transitions do. This keeps WS frames meaningful and the SPA's per-agent re-render count low. The bus is purely fan-out (Decision 8); the runtime-state update happens inline in the route handler that owns the write, so there is no refetch and no second bus subscriber to coordinate.

**Seeding from project config:**

- `runServer` calls `configStore.readProjectConfig()`, takes the `agents` array (or `[]` if missing), and constructs an `InMemoryAgentRuntimeStateStore(initial)` where every agent starts `paused: false`, `status: "idle"`, `last_activity: null`, `last_active_at: null`.
- An activity entry whose `agent` id is not in the roster has `applyActivityEvent` return `{ state: null, changed: false }`. The bus subscriber then emits no `agent.state_changed`. This is the documented behaviour for "an agent appeared in the activity log that isn't in `project.yaml`" — the activity entry still persists (not the orchestration server's call) but the roster doesn't gain a row. Step 09 (engineer workspaces) is where the roster invariant is enforced; this step only reflects what is configured.

**Alternatives considered:**

- **Persist to `state.json`.** Doable but premature; the activity log is the durable record of agent activity, the runtime state is just a derived view. Rebuilding on startup from the activity log (last entry per agent) would cost one log scan per boot — fine, but more code than the prototype needs. Punt.
- **Re-derive on every `GET /agents`.** Same cost, but moved per-request. Punt.
- **Store the status as a string union *with* an explicit `unknown` for unconfigured agents.** Considered, but the `GET /agents` shape must equal the `project.yaml` roster's shape exactly (`spec.md` §7.2 dashboard render contract); there is no UI affordance for "unknown" agents in the prototype roster. Rejected — the bus subscriber simply ignores unknown ids.

### Decision 5: WS connection is server-push-only in the prototype

**Why:** the only inbound messages we'd want today are subscription filters (`?topics=…`) and `?since=<event-id>` ack-or-replay frames, both of which are forward-compatible additive changes (Decisions 2, 6). Shipping bidirectional message handling now would require a parser, a per-message zod schema, and a per-message authorisation rule for no current consumer. The handler reads no inbound messages; if a client sends a frame, the handler logs at debug level and continues (it does *not* drop the connection — a future client / proxy may emit pings or browser-level keepalives). The only inbound traffic the handler interprets is the WS-protocol-level `pong` reply to the heartbeat (Decision 7).

**Alternatives considered:**

- **Bidirectional from day one (subscription filter + ack frames).** Adds a parser and a closed inbound-message-type enum we haven't designed. Build it when the SPA's optimistic-update layer (step 12) actually needs ack frames or filters. Rejected.

### Decision 6: Reconnect tier — "client refetches via REST", with a forward-compatible `?since=` seam

**Why:** the simplest reconnect model that keeps the SPA correct is "treat reconnect as a fresh subscription; refetch the canonical state from REST." It costs the SPA one batched REST call per reconnect (`GET /tickets` + `GET /prs` + `GET /agents` — `GET /activity` is bounded by the date partition and is cheap). It also avoids two whole categories of bugs: server-side replay buffer bounded by what — heap size? a TTL? a client cursor? — and the inevitable ambiguity when the server *did* expire the buffer ("did the client miss anything? we don't know, so we'd have to tell it to refetch anyway"). For prototype scope this is the right tier.

**The forward-compatible seam:** every event frame carries `id` (uuidv7). When a future change wants replay, it adds `?since=<event-id>` to the WS upgrade and a server-side ring buffer (sized by entry count, not memory). The wire shape is unchanged; the client logic gains a stored "last-seen id" and a `since` parameter on reconnect; the server gains a buffer and a "events newer than this id" lookup. Capability spec documents the seam by name so a later contributor can find it.

**Heartbeat:** the server sends a WS `ping` (control frame, not a message frame) every 25 s. The client must respond with a `pong` (which Hono's `upgradeWebSocket` plumbs from `Deno.serve`) within the same window. Two consecutive missed pongs close the connection with code `1011`. The client is expected to reconnect immediately. The 25 s interval is short enough to detect dead connections within a minute and long enough to not spam frames. The capability spec names the interval as a single value (no per-deployment config) so a contributor doesn't accidentally desync client and server. (Step 12 may make it tunable; today it's a constant.)

**Alternatives considered:**

- **Server-side ring buffer with `?since=<event-id>` from day one.** ~80 lines of code (buffer, lookup, parameter parsing, eviction policy) and the same ~80 lines of tests. Defer. Picked the seam-only approach.
- **No heartbeat.** Dead connections silently linger, leaking subscribers on the bus. Bad. Rejected.
- **Client-driven heartbeat.** Browsers don't expose a way to send WS pings from JS — the `pong` is the server's; the client would have to send a regular message frame and the server would have to interpret it. We pick server-driven pings to keep the inbound channel push-only (Decision 5).

### Decision 7: Role identity on the WS handshake — header *and* `?role=` query parameter

**Why:** the prototype trusts the role header at the REST boundary; the WS handshake inherits that contract verbatim. But: the browser's `WebSocket` constructor does not let JS set arbitrary headers on the upgrade request. The SPA cannot send `X-Keni-Role: user` on `new WebSocket("ws://localhost:8000/events")`. The straightforward fix — and the one most production WS APIs use — is to accept the role in a query parameter when the header is absent. The roleIdentity middleware is extended to fall back to `?role=...` when `X-Keni-Role` is missing on the upgrade request *only* (the REST endpoints continue to require the header; introducing the query parameter on REST would make role-spoofing too easy in development logs / browser histories).

**Implementation:** the WS endpoint's pre-upgrade middleware reads `c.req.header("X-Keni-Role")` first; if absent, reads `c.req.query("role")`. If both are absent or the value is unknown, the upgrade fails with a 400 JSON body identical to the REST refusal (`{ error: { code: "missing_role", … } }`) and the connection is not opened. The `roleIdentity` middleware itself stays unchanged; the WS route's upgrade handler does the query-param fallback inline before calling `upgradeWebSocket(...)`.

**Alternatives considered:**

- **Header-only.** Forces the SPA to use a custom WS client (e.g., a `fetch`-based polyfill over a streaming body) just to set a header. Wasteful. Rejected.
- **Subprotocol negotiation (`Sec-WebSocket-Protocol: keni-role-user`).** Standard WS-spec way to ferry handshake metadata. More complex to test and less self-documenting in browser devtools. Picked the query-parameter pattern as the more discoverable equivalent.
- **First-message authentication (`{ "role": "user" }` as the first frame).** Bidirectional, so violates Decision 5. Rejected.

### Decision 8: The bus is in-process, fire-and-forget, with subscriber-error isolation

**Shape:**

```ts
// packages/server/src/eventBus.ts
export interface EventBus {
  emit(frame: EventFrame): void;
  subscribe(handler: (frame: EventFrame) => void | Promise<void>): () => void; // returns unsubscribe
}

export function createInMemoryEventBus(): EventBus { /* Set<Handler>, fan-out, error swallow */ }
```

**Behaviour:**

- `emit(frame)` iterates the subscriber set synchronously, calling each handler. A handler that throws (sync) or rejects (async) has its error caught and logged at warn level via the existing `LogSink`; the emit caller observes nothing. Handlers run in registration order, but no guarantee is offered (subscribers MUST NOT depend on order — the WS handler subscribes once per connection and only cares about its own frames).
- `subscribe(handler)` returns a closure that removes the handler from the set. The WS connection's `close` and `error` handlers both call this to avoid leaking handlers across reconnects.
- The bus does **not** persist anything. The "durable" channel is the activity log, on disk; the bus is the live channel.

**Why fire-and-forget:** a slow or hung WS subscriber must not block the request handler that called `emit(...)`. The bus drops an emit's await semantics; the subscriber owns its own buffering / backpressure. The WS handler in turn writes to the socket via `send(...)` which is fire-and-forget on Hono's `WSContext`; if a connection's send queue overflows, the connection is closed (Hono / Deno-runtime default).

**Why subscribers swallow errors:** the alternative is to either propagate (which corrupts the request handler) or to mark the subscriber as bad (which adds dead-handler eviction logic). For the prototype's "single SPA + a few curl websocats" load, a logged warning is enough.

**Alternatives considered:**

- **`EventTarget` / `BroadcastChannel`.** Both work but neither plays as nicely with TypeScript discriminated-union types as a typed `EventBus<EventFrame>`. We get more compile-time safety from a hand-rolled shape. Rejected.
- **Deno-native `BroadcastChannel`.** Cross-process, but we are explicitly in-process (`spec.md` §7.1). Overkill. Rejected.
- **Async-iterator subscription.** Cleaner consumer ergonomics (`for await (const frame of bus.subscribe())`) but the WS handler doesn't need that — it has its own loop driven by socket events. Rejected for now.

### Decision 9: Where the new code lives — flat under `packages/server/src/`

**Layout (additions only — every other file in step 04 unchanged):**

```
packages/server/src/
├── eventBus.ts            (new — typed in-process pub/sub)
├── eventBus_test.ts       (new)
├── agentState.ts          (new — InMemoryAgentRuntimeStateStore + interface)
├── agentState_test.ts     (new)
├── routes/
│   ├── agents.ts          (new — GET /, POST /:id/pause, POST /:id/resume)
│   ├── agents_test.ts     (new)
│   ├── events.ts          (new — GET / with WS upgrade)
│   ├── events_test.ts     (new)
│   ├── tickets.ts         (modified — emit ticket.created / ticket.updated)
│   ├── prs.ts             (modified — emit pr.created / pr.updated)
│   └── activity.ts        (modified — emit activity.appended)
├── wire/
│   ├── agents.ts          (new — AgentResponseSchema)
│   ├── agents_test.ts     (new)
│   ├── events.ts          (new — EventEnvelopeSchema + per-payload schemas)
│   ├── events_test.ts     (new)
│   └── mod.ts             (modified — barrel)
├── createServer.ts        (modified — accept eventBus + agentRuntimeStateStore;
│                                       mount /agents, /events; subscribe to bus)
├── createServer_test.ts   (extended — new mounts + subscriber wiring)
├── runServer.ts           (modified — instantiate bus + state store, seed from config)
├── runServer_test.ts      (extended — roster seed test)
└── main.ts                (modified — re-export EventBus / AgentRuntimeStateStore)

packages/shared/src/wire/
├── agents.ts              (new — AgentStatus, AgentResponse, AgentListResponse, AgentEnvelope)
├── events.ts              (new — EventName, EventEnvelope, six payloads, EventFrame union)
└── mod.ts                 (modified — type-only re-exports)
```

**Why flat:** the existing layout (step 04 Decision 3) puts each concern in one file at `packages/server/src/`. The two new concerns — bus and agent state — fit that pattern. The new routes go where the existing routes go. No new top-level folders. Imports stay short (`import { createInMemoryEventBus } from "./eventBus.ts"`).

### Decision 10: Test strategy — `app.fetch` for WS upgrades, captured bus for emit assertions

**Why:** the existing test suite uses `app.fetch(new Request(...))` against the real `createServer` Hono app — no port binding, no real network, identical middleware stack. Hono's `upgradeWebSocket` sits on `Deno.serve`'s native upgrade, which `app.fetch` passes through correctly *if* the test harness uses the same Deno-flavoured upgrade. The pattern is:

```ts
const app = createServer({ ... }, { projectId: "test" });
const req = new Request("http://localhost/events?role=user", {
  headers: { "Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "..." },
});
const res = await app.fetch(req);
// res is a Response object whose body is the WebSocket; in the Deno runtime this returns
// an upgraded response. For tests we drive the bus directly and assert on the captured frames.
```

For the test pattern that simply asserts "an event was emitted in response to a REST call," we **don't** need to drive a WS connection — we wire a `captureBusSink(buffer)` via the same dependency-injection seam the existing `captureLogSink` uses, and assert on the emitted `EventFrame`. WS-specific tests (heartbeat, role-guard refusal on upgrade, frame round-trip) bind `Deno.serve` (via `startServer({ port: 0 })`) and use Deno's built-in `WebSocket` client.

**Coverage targets:**

- Every new endpoint has at least one happy-path, one role-refusal, and one storage-error test.
- Every event type has at least one "REST call → captured frame" test.
- The WS endpoint has at least one role-refusal-on-upgrade test, one heartbeat ping/pong test, and one "frame is delivered to a connected client" test.
- The bus has its own unit tests (subscribe / unsubscribe / fan-out / error swallow).
- The agent-state store has its own unit tests (seed / read / setPaused with debounce / applyActivityEvent across the decision table).
- Wire schemas have the same `expectType<z.infer<…>>().toEqual<SharedType>()` alignment assertion the existing wire tests use.

### Decision 11: `agent.state_changed` is debounced — only emit on actual state change

**Why:** activity entries arrive frequently (the activity log is the primary debug surface, `spec.md` §7.3); a busy session emits one entry per coding-agent stdout chunk. If the route handler emitted `agent.state_changed` on every entry, the SPA would receive a flood of identical frames whose only effect is to bump `last_activity` by one event name. That is wasteful: the SPA already gets `activity.appended` per entry and can update its activity feed off that frame; the agent roster only cares about *transitions* (running → idle, paused → unpaused, etc.).

**Implementation:** `applyActivityEvent` and `setPaused` both return `changed: boolean`. The route handler that owns the write (the activity route after a successful append; the agents route after a successful pause / resume) emits `agent.state_changed` if and only if `changed === true`. The decision table in Decision 4 makes this concrete: a `summary` event for an already-running agent does not flip status, so `changed = false` (we still update `last_activity` / `last_active_at`, but not status), and an `agent.state_changed` is not emitted unless the spec demands it for those fields too. **In this prototype**, `agent.state_changed` carries only `{ agent_id, paused, status }` (Decision 3) — `last_activity` / `last_active_at` are not in the payload, so a non-status, non-paused update legitimately does *not* warrant an emit. The SPA learns the new `last_activity` either from `activity.appended` (agent matches the entry's `agent`) or from a refetch on next reconnect / page-load.

**Alternatives considered:**

- **Always emit.** Wasteful, see above.
- **Emit a `last_activity` field in the payload and emit on every entry.** Couples the WS shape to a per-character-of-output stream and makes the SPA's per-agent re-render count tied to log volume. Rejected.

## Risks / Trade-offs

- **[In-memory state lost on restart.]** Pause / resume flags reset to `false`, all `last_activity` / `last_active_at` reset to `null`, all `status` reset to `"idle"`. → **Mitigation:** documented in the capability spec ("Restart resets the agent runtime state. Persistence is additive"). The activity log on disk preserves the history, so a future "rebuild on startup from the last entry per agent" change is feasible.
- **[WS stream is not a durable channel.]** A subscriber that misses a frame — because it disconnected, because the network blipped, because the SPA tab was backgrounded — does not see it again. → **Mitigation:** the documented reconnect tier is "client refetches via REST." The wire shape carries `id` so a future ring-buffer + `?since=` change is purely additive. Capability spec names both.
- **[Slow subscriber blocking the bus.]** The bus is synchronous: a handler that takes 50 ms blocks the request handler that emitted. → **Mitigation:** in-process, single user, single SPA — the realistic concurrent subscriber count is 1 to 3. The handlers are themselves fire-and-forget against the WS socket (`ws.send(...)` returns immediately; backpressure is handled by `Deno.serve`'s send queue, which drops frames or closes the connection if it overflows). For prototype scope, the synchronous bus is acceptable; switching to a microtask-deferred `queueMicrotask(handler)` is a one-line change if profiling ever shows handler cost.
- **[Browser cannot set the role header on `new WebSocket(...)`.]** → **Mitigation:** the `?role=<role>` query-parameter fallback (Decision 7). Documented in the capability spec and the README.
- **[Activity-log entries for unconfigured agents are silently ignored by the runtime store.]** A typo in `project.yaml` could mean an agent's events never produce a roster row. → **Mitigation:** the unknown id is a normal case (e.g., a future "writer" role might emit before being configured); silently ignoring is the right default for this step. The capability spec documents the contract; step 09 (engineer workspaces) will validate that an agent's id matches one in `project.yaml` before the role runtime spawns.
- **[Heartbeat interval is hard-coded to 25 s.]** A flaky network with >50 s round-trips would close every connection. → **Mitigation:** the 25 s value is conservative for a 127.0.0.1 prototype; the LAN round-trip is sub-millisecond. A future change can promote it to a config field if real deployments demand it. Capability spec names the value so a contributor knows to update both client and server.
- **[Two consecutive `agent.state_changed` debounce-fires can be reordered relative to `activity.appended`.]** The bus emits in handler-registration order, not emit order — but per-emit it iterates synchronously, so a single emit's subscribers all run before the next emit. The risk is "ticket transition then activity entry both happening in one HTTP request" (none today; the routes are 1 emit per handler) reordering on the wire if the WS handler's `ws.send` is asynchronous. → **Mitigation:** route handlers emit at most once per request. If a future handler emits multiple times per request, document the ordering contract (FIFO per subscribe call) at that point.
- **[New WS frame type added without updating the discriminated union.]** A future contributor adds an event name without updating `EventName` / `EventFrame` / the schema. → **Mitigation:** the `z.ZodType<EventFrame>` annotation on `EventEnvelopeSchema` catches the schema-vs-type drift at compile time; the wire-test alignment assertion catches the type-vs-schema reverse drift; the union type forces every consumer (the SPA's `switch (frame.event)`) to handle every case. Three layers of defence.
- **[Pause / resume not yet wired to a scheduler.]** Today the flag is "decorative" — paused agents still run because the scheduler doesn't exist yet (step 08). → **Mitigation:** documented forward-reference in the README and the capability spec ("the scheduler that consumes `paused` lands in step 08"). The API contract is stable so step 08 is structurally a one-line read.
- **[Multiple SPA tabs open against the same server.]** Each is a separate WS connection; pause / resume from tab A reaches tab B via the bus subscriber's broadcast. → **Mitigation:** by design — each tab subscribes independently; the bus fans out. Tested.

## Migration Plan

Not applicable — additive on top of the existing orchestration server. Rollback is `git revert`; no on-disk artefacts are produced or consumed by the events stream (the activity log is unchanged, file-backed, and step 04's surface).

## Open Questions

- **Should `agent.state_changed` carry `last_activity` / `last_active_at`?** Today it does not (Decision 11). The SPA can reconstruct them from `activity.appended` or a `GET /agents` refetch. → **Decision for this step:** no — keep the payload minimal; revisit when the SPA's optimistic-update pass actually demands them in the frame.
- **Should the `?since=<event-id>` replay seam be implemented now or deferred to step 12?** The wire shape is forward-compatible either way. → **Decision for this step:** deferred. Implementing the ring buffer now adds ~100 lines for a feature no current consumer uses; the SPA's reconnect path is REST-refetch, which is correct and tested.
- **Should a `*-only` topic filter (`?topics=ticket.*,activity.*`) ship now?** → **Decision for this step:** no. Defer to the first consumer that needs it (likely the future MCP push-channel, post-MVP).
- **Should the bus expose a metrics hook (subscriber count, emit count, queue depth)?** Useful for debug / observability. → **Decision for this step:** no; the request log already names the WS path and status; bus metrics are an additive change in a later observability step.
- **Should `POST /agents/:id/pause` / `resume` accept an optional `reason: string` body for audit trail?** Aligns with the future `manual_override` concept. → **Decision for this step:** no; pause / resume aren't status transitions and the activity log already attributes user-driven actions via `X-Keni-Agent`. If a future audit need emerges, add the field additively.
- **Should the WS endpoint live at `/events` or `/ws` or `/agents/ws`?** The plan input names "the WebSocket endpoint" abstractly. `/events` is the most descriptive for a multi-resource stream and avoids implying it is per-resource. → **Decision for this step:** `/events`. The capability spec pins it.
- **Should we add a `server.hello` welcome frame on connection (with the project_id and the supported event names)?** Useful for client validation but unnecessary today (the SPA already knows the project_id from REST). → **Decision for this step:** no; an additive change if a CLI consumer needs it.
- **Should heartbeat use WS protocol-level pings or message-level `{ "event": "ping" }` frames?** Protocol-level (Decision 6) — they don't pollute the application-event stream. Hono's `upgradeWebSocket` exposes the protocol-level ping callback. → **Decision for this step:** WS protocol-level pings.
