## ADDED Requirements

### Requirement: `GET /health` is unconditionally `200` and is the only documented exemption from the role-identity middleware

The orchestration server SHALL expose `GET /health`. The endpoint SHALL respond `200 { data: { status: "ok", project_id, uptime_ms, version }, project_id }` to any GET request, *without* requiring the `X-Keni-Role` header. This is the **only** documented exemption from the role-identity middleware. The exemption SHALL be implemented by registering the `/health` route handler **before** the `roleIdentity` middleware in the Hono app's middleware chain — the chain order itself is the contract; a per-route bypass token would be a worse design (the next contributor would not see the chain order and would assume the role guard runs everywhere).

`uptime_ms` SHALL be computed as `Date.now() - serverStartedAt.getTime()`, where `serverStartedAt` is supplied to `createServer` via the new field `ServerDeps.serverStartedAt: Date`. When `serverStartedAt` is absent (existing test call sites that do not yet pass the field), `uptime_ms` SHALL be `0`. `version` SHALL be a string read from `@keni/shared`'s exported `VERSION` constant (`"0.0.0-prototype"` for the prototype; future binary packaging will replace it via a `--build-arg`).

The `/health` endpoint SHALL NOT mutate any store and SHALL NOT emit any `EventFrame`. The endpoint SHALL accept GET only; POST / PATCH / DELETE / PUT to `/health` SHALL return `405 method_not_allowed` (the existing error envelope, with a new `method_not_allowed` member added to `ErrorCode` if Hono's default 405 cannot be emitted via the existing `errorBoundary`; otherwise reusing Hono's default 405 + the existing `internal_error` envelope is acceptable, decided in the design's open-questions). The endpoint SHALL appear in the request-log line stream like every other request (the `requestLog` middleware DOES run for `/health` even though `roleIdentity` does not — `requestLog` is registered before both, and the log line's `role` and `agent` fields SHALL be `null` for `/health` requests because the role middleware was skipped).

The previously-documented requirement *"Composition-root middleware order is request-id → request-log → role-identity → routes, with `errorBoundary` registered as the Hono `onError` handler"* is updated by the requirement below — this `/health` requirement is the rationale and the user-visible behaviour; the middleware-order requirement carries the structural change.

#### Scenario: `GET /health` succeeds without `X-Keni-Role`

- **WHEN** any HTTP request `GET /health` is sent without the `X-Keni-Role` header
- **THEN** the response is 200
- **AND** the body parses as `{ data: { status: "ok", project_id: <uuid>, uptime_ms: <number>, version: <string> }, project_id: <uuid> }`
- **AND** the `data.project_id` equals the response envelope's `project_id`

#### Scenario: `GET /health` succeeds with `X-Keni-Role` (the header is ignored when present)

- **WHEN** `GET /health` is sent with `X-Keni-Role: user`
- **THEN** the response is 200
- **AND** the body shape matches the no-header scenario verbatim

#### Scenario: `uptime_ms` advances over time

- **WHEN** `GET /health` is called twice with a `200` ms gap between the calls (against the same booted server)
- **THEN** the second response's `data.uptime_ms` is at least `200` greater than the first response's `data.uptime_ms`
- **AND** both values are non-negative

#### Scenario: `serverStartedAt` absent yields `uptime_ms: 0`

- **WHEN** an existing test call site invokes `createServer({...}, opts)` without supplying `serverStartedAt`
- **AND** `GET /health` is sent against the resulting app
- **THEN** the response's `data.uptime_ms` is `0`
- **AND** the rest of the body shape matches the documented envelope

#### Scenario: `/health` does not mutate any store and emits no EventFrame

- **WHEN** `GET /health` is sent against a booted server with one bus subscriber registered
- **THEN** the bus subscriber receives zero frames attributable to the `/health` request
- **AND** `agentRuntimeStateStore.list()` returns an array byte-for-byte identical to its pre-call snapshot

#### Scenario: A `POST /health` returns 405 (or the existing 4xx envelope, per implementation)

- **WHEN** `POST /health` is called
- **THEN** the response status is in the 4xx range
- **AND** the response body does NOT carry the `data.status: "ok"` payload (i.e., the GET handler did not run)

#### Scenario: `/health` requests appear in the request log with role/agent null

- **WHEN** `GET /health` is sent against a server using `captureLogSink(buffer)`
- **THEN** the captured buffer contains exactly one line for the `/health` request
- **AND** the line's `role` and `agent` fields are both `null` (the `roleIdentity` middleware was skipped)
- **AND** every other documented request-log field is populated as usual

### Requirement: When `ServerDeps.staticAssetsRoot` is supplied, the server mounts a static SPA route group with deep-link fallthrough

`createServer(deps, opts)` SHALL accept a new OPTIONAL field `staticAssetsRoot?: string` on `ServerDeps`. When the field is supplied with an absolute path that exists and contains an `index.html` file, the server SHALL mount a static-asset route group AFTER every existing REST and WS route and AFTER the `/health` route. The group SHALL: (a) serve `<staticAssetsRoot>/index.html` on `GET /`; (b) serve files under `<staticAssetsRoot>/assets/` on `GET /assets/*` with a `Cache-Control: public, max-age=31536000, immutable` header; (c) for any unmatched GET path that does NOT match a documented REST prefix in the closed allowlist `REST_PREFIXES = ["/agents", "/tickets", "/prs", "/activity", "/health", "/events"] as const`, serve `<staticAssetsRoot>/index.html` so the SPA's `react-router-dom` `BrowserRouter` can re-mount on a deep link. The fallthrough SHALL apply ONLY to `GET` requests; non-GET requests with non-allowlisted paths SHALL still return `404` (Hono's default).

The route group SHALL NOT be mounted when `staticAssetsRoot` is absent; existing test call sites that do not pass the field SHALL see the unchanged behaviour. When `staticAssetsRoot` is supplied with a path that does NOT exist or does NOT contain `index.html`, `createServer` SHALL throw a typed `Error` named `StaticAssetsRootInvalid` with a message naming the path and the missing file (so `runStart` can surface a clear exit-1 error to the user before the server begins accepting connections). Files outside `<staticAssetsRoot>` SHALL NOT be reachable (path traversal via `..` SHALL be rejected with `404`); the static handler SHALL resolve every requested path against `staticAssetsRoot` and verify the resolved path has `staticAssetsRoot` as a prefix before serving.

The closed `REST_PREFIXES` allowlist SHALL be exported from `@keni/server` so tests can assert it. Adding a new REST prefix to the orchestration server (e.g., a future `/spec` route group) is a code change to `REST_PREFIXES` by design — this prevents the SPA fallthrough from accidentally swallowing a new endpoint.

#### Scenario: `GET /` serves the SPA bundle's index.html

- **WHEN** `createServer({...staticAssetsRoot: "<absolute>/dist", ...}, opts)` is built against a directory containing `<absolute>/dist/index.html` whose contents are `<!doctype html><html><body><div id="root"></div></body></html>`
- **AND** `GET /` is sent
- **THEN** the response is 200
- **AND** the response's `Content-Type` starts with `text/html`
- **AND** the response body is the bundle's `index.html` contents byte-for-byte

#### Scenario: `GET /assets/<file>` serves the asset with the immutable cache header

- **WHEN** `<staticAssetsRoot>/assets/main-abc123.js` exists
- **AND** `GET /assets/main-abc123.js` is sent
- **THEN** the response is 200
- **AND** the response's `Cache-Control` header is `public, max-age=31536000, immutable`
- **AND** the response body is the file's contents byte-for-byte

#### Scenario: SPA deep-link fallthrough returns index.html for non-allowlisted GET paths

- **WHEN** `<staticAssetsRoot>/index.html` exists
- **AND** `GET /tickets/ticket-0001` is sent (a SPA route, not the REST endpoint — the REST endpoint is `GET /tickets/:id`, which SHOULD match the `REST_PREFIXES` allowlist before fallthrough)
- **AND** the calling code includes the `X-Keni-Role: user` header so the REST handler is reachable
- **THEN** the REST handler runs (the `/tickets` prefix is allowlisted) and returns either 200 (when the ticket exists) or 404 (when it does not)
- **AND** the SPA fallthrough does NOT run for this request

#### Scenario: SPA fallthrough for an unknown SPA route

- **WHEN** `GET /some/spa/route` is sent (a path that does not match any REST prefix and is not a static asset)
- **THEN** the response is 200
- **AND** the response body is `<staticAssetsRoot>/index.html`'s contents
- **AND** the `Content-Type` is `text/html`

#### Scenario: Non-GET requests with unknown paths still return 404

- **WHEN** `POST /some/spa/route` is sent
- **THEN** the response is 404 (Hono's default for unmatched non-GET)
- **AND** the SPA fallthrough does NOT run

#### Scenario: Path traversal via `..` is rejected

- **WHEN** `GET /assets/../../etc/passwd` is sent (after URL normalisation may or may not collapse this — the handler SHALL handle the worst case)
- **THEN** the response is 404
- **AND** the contents of `/etc/passwd` are NOT served

#### Scenario: `staticAssetsRoot` absent skips the route group entirely

- **WHEN** `createServer({...}, opts)` is built WITHOUT `staticAssetsRoot`
- **AND** `GET /` is sent
- **THEN** the response is 404 (the existing behaviour)
- **AND** no static-asset middleware ran

#### Scenario: `staticAssetsRoot` pointing at a missing path throws `StaticAssetsRootInvalid` at construction

- **WHEN** `createServer({...staticAssetsRoot: "/does/not/exist"}, opts)` is built
- **THEN** `createServer` throws a typed `Error` named `StaticAssetsRootInvalid`
- **AND** the error message names the path and the missing `index.html`

#### Scenario: `REST_PREFIXES` is exported and exhaustively covers the existing routes

- **WHEN** `REST_PREFIXES` is read from `@keni/server`
- **THEN** the array equals `["/agents", "/tickets", "/prs", "/activity", "/health", "/events"]` (in this exact order)
- **AND** every existing route group in `createServer` corresponds to a prefix in this list

## MODIFIED Requirements

### Requirement: Composition-root middleware order is request-id → request-log → role-identity → routes, with `errorBoundary` registered as the Hono `onError` handler

`createServer` SHALL register middleware in exactly this order: `requestId` first (so every other middleware can rely on `c.var.request_id`); then `requestLog` (so it observes every request — including those that fail because of a missing or invalid role); then a small **carve-out** that registers the `/health` route handler BEFORE `roleIdentity` so the health endpoint bypasses the role guard (this is the only documented exemption — see the `/health` requirement); then `roleIdentity` (so route handlers see `c.var.role` and `c.var.agent`); then the route groups (`/tickets`, `/prs`, `/activity`, `/agents`); then, when `ServerDeps.staticAssetsRoot` is supplied, the static SPA route group AFTER the REST routes (so REST endpoints win over the SPA fallthrough). The `errorBoundary` SHALL be installed via `app.onError(errorBoundary(projectId))` rather than as a regular middleware, because in Hono v4 only the `onError` hook catches handler-thrown errors (a `try/catch` around `await next()` inside a regular middleware does not). Logically the error handler is still the "last link" in the chain — it always runs after the routes, before the response is returned. A test in `createServer_test.ts` SHALL assert the middleware order by stubbing each middleware to record its position in a shared array and verifying the array against the documented order; a separate test SHALL assert that a thrown error is mapped via the registered `onError` handler.

#### Scenario: Middleware order is the documented one (REST surface)

- **WHEN** `createServer` is built with stubbed middleware that record their invocation order
- **AND** any REST request is sent
- **THEN** the recorded order is `["requestId", "requestLog", "roleIdentity"]`
- **AND** `errorBoundary` is registered via `app.onError(...)` and translates any thrown error into the documented `ErrorResponse` envelope

#### Scenario: `/health` bypasses `roleIdentity` (the only documented exemption)

- **WHEN** `GET /health` is sent without `X-Keni-Role`
- **THEN** the recorded middleware order for this request is `["requestId", "requestLog"]` (the `roleIdentity` middleware did NOT run)
- **AND** the response is 200 per the `/health` requirement

#### Scenario: A request that fails role validation still emits a request-log line

- **WHEN** a non-`/health` request without `X-Keni-Role` is dispatched
- **THEN** `requestLog` records the line (because it ran before `roleIdentity`)
- **AND** the line carries `error_code: "missing_role"` (set by `errorBoundary` in the `onError` handler)
- **AND** the response is `400 missing_role`

#### Scenario: Adding a route group does not change the middleware order

- **WHEN** an additional Hono route group is mounted in `createServer` (e.g., for a future endpoint)
- **THEN** the three core middlewares still execute first, in the documented order (REST surface)
- **AND** the new route group sees `c.var.request_id`, `c.var.role`, `c.var.agent` populated

#### Scenario: Static SPA route group, when mounted, runs after REST routes

- **WHEN** `createServer` is built with `ServerDeps.staticAssetsRoot` supplied
- **AND** a request `GET /tickets` is sent with `X-Keni-Role: user`
- **THEN** the REST `/tickets` handler runs (and returns the documented `TicketListResponse` envelope)
- **AND** the SPA fallthrough does NOT run (the `/tickets` prefix is allowlisted in `REST_PREFIXES`)

### Requirement: `runServer` instantiates the bus and the agent runtime-state store at bootstrap

`runServer` SHALL call `createInMemoryEventBus()` once after parsing argv and before constructing the server. It SHALL read `projectConfig.agents` (treating an absent field as `[]`) and pass that list to `createInMemoryAgentRuntimeStateStore(roster, { initiallyPaused })`, where each entry is seeded with `paused: initiallyPaused.has(agent.id)` (default: `paused: false`), `status: "idle"`, `last_activity: null`, `last_active_at: null` and the role read from the project-config row. The OPTIONAL `initiallyPausedAgents` field on `RunServerDeps` SHALL be the source of `initiallyPaused`; absent or empty, every agent boots `paused: false` (the existing behaviour). `runServer` SHALL also call `createScheduler(deps, opts)` exactly once after the bus and runtime-state store exist, passing `projectConfig.agents`, `projectConfig.schedules`, and `projectConfig.timeouts` (each defaulted to its empty value when absent), and the bound server URL (resolved via the `startServer` return value) for the scheduler's activity-log adapter. `runServer` SHALL call `scheduler.start()` exactly once after the HTTP server is bound and accepting connections, and SHALL call `scheduler.stop()` from the abort handler before resolving the server's exit code (so an in-flight cycle's `AbortSignal` fires before the HTTP server's draining `Deno.serve` shuts down). `runServer` SHALL capture `serverStartedAt: new Date()` at the moment `Deno.serve`'s `onListen` fires and pass it to `createServer` via `ServerDeps.serverStartedAt` (consumed by `/health`). The bus, runtime-state store, scheduler, and `serverStartedAt` SHALL all be passed to `createServer` via the extended `ServerDeps`. Direct `deno run -A packages/server/src/main.ts --project=<path>` invocations SHALL produce a working `/agents` endpoint, `/events` upgrade, `/health` endpoint, *and* a running scheduler without any additional flags. When `projectConfig.agents` is empty, the scheduler SHALL still be started (a no-op tick loop), so adding the first agent later is purely additive.

#### Scenario: Boot against a project with a roster

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a project whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]`
- **THEN** the bound server's `GET /agents` returns the seeded `alice` row
- **AND** the bound server's `/events` accepts a WS upgrade
- **AND** the bound server's `GET /health` returns 200 with the documented envelope
- **AND** the scheduler has been started exactly once with alice in its agent list

#### Scenario: Boot against a project with no roster

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a project whose `project.yaml` has no `agents` field
- **THEN** the bound server's `GET /agents` returns `{ data: [], project_id: <uuid> }`
- **AND** the bound server's `GET /health` returns 200
- **AND** the scheduler has been started with an empty agent list (no per-agent timers armed)

#### Scenario: `initiallyPausedAgents` seeds the runtime store

- **WHEN** `runServer` is invoked against a roster `[alice (engineer), bob (po)]` with `RunServerDeps.initiallyPausedAgents = ["alice"]`
- **THEN** `GET /agents` returns `data` whose `alice` entry has `paused: true` and `bob` entry has `paused: false`
- **AND** the scheduler skips `alice`'s next tick (per the existing scheduler capability)

#### Scenario: Shutdown calls `scheduler.stop()` before resolving

- **WHEN** the test fires the server's abort signal during a normal shutdown
- **THEN** `scheduler.stop()` is invoked exactly once
- **AND** the function returns 0 only after `scheduler.stop()` has resolved
- **AND** the HTTP server's draining `Deno.serve` does not begin its drain until `scheduler.stop()` has resolved (ensuring in-flight cycles' final `POST /activity` calls reach a still-running server)

### Requirement: `POST /agents/:id/pause` and `POST /agents/:id/resume` flip the `paused` flag idempotently

The pause endpoint SHALL set the named agent's `paused` flag to `true`; the resume endpoint SHALL set it to `false`. Both endpoints SHALL accept an empty request body, return `200 { data: AgentResponse, project_id }` with the post-mutation runtime state, and be idempotent (calling pause on an already-paused agent SHALL succeed and return the unchanged state). The role guard SHALL allow only `X-Keni-Role: user`; other roles SHALL be rejected with `403 role_not_owner`. An unknown agent id SHALL produce `404 store_not_found`. Both endpoints SHALL emit `agent.state_changed` on the bus when (and only when) the flag actually flips; an idempotent no-op pause / resume SHALL NOT emit. After a state-changing pause / resume call (changed: true), the handler SHALL fire-and-forget persist the post-call set of paused agent ids to `<projectDir>/.keni/state.json` via the new `ServerDeps.pausedAgentsPersister?: (paused: readonly string[]) => Promise<void>` adapter (when supplied); a rejection from the persister SHALL be caught and logged at warn level via the existing `LogSink` and SHALL NOT fail the HTTP request. When `pausedAgentsPersister` is absent (existing test call sites), the persistence step is skipped silently — the in-memory flip happens regardless. The flag is consumed by the scheduler in step 08; this requirement does NOT define scheduler behaviour.

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
- **AND** the persister was called at most once (only on the actual flip)

#### Scenario: Engineer cannot pause

- **WHEN** `POST /agents/alice/pause` is called with `X-Keni-Role: engineer`
- **THEN** the response is 403
- **AND** `error.code === "role_not_owner"`
- **AND** `alice`'s `paused` flag is unchanged
- **AND** the persister was not called

#### Scenario: Resume on an unknown agent returns 404

- **WHEN** `POST /agents/ghost/resume` is called with `X-Keni-Role: user`
- **AND** `ghost` is not in the roster
- **THEN** the response is 404
- **AND** `error.code === "store_not_found"`

#### Scenario: Persister supplied — a successful pause writes the post-call paused set

- **WHEN** `createServer({...pausedAgentsPersister: persister, ...}, opts)` is built with an instrumented persister
- **AND** `POST /agents/alice/pause` is called with `X-Keni-Role: user` (with `bob` already paused before the call)
- **THEN** the response is 200
- **AND** the persister was called exactly once with the argument `["bob", "alice"]` (or any ordering whose set equals `{"bob", "alice"}`)
- **AND** the persister's call happened AFTER the `agent.state_changed` emit

#### Scenario: Persister rejection does not fail the request

- **WHEN** `createServer({...pausedAgentsPersister: persister, ...}, opts)` is built
- **AND** `persister` rejects with `Error("EACCES")`
- **AND** `POST /agents/alice/pause` is called successfully
- **THEN** the response is 200
- **AND** the in-memory `paused: true` flip remains
- **AND** exactly one warn-level log line names the persistence failure

#### Scenario: Persister absent — no persistence step runs

- **WHEN** `createServer({...}, opts)` is built without `pausedAgentsPersister`
- **AND** `POST /agents/alice/pause` is called successfully
- **THEN** the response is 200
- **AND** no persistence-related log line is emitted (no warn, no info)
- **AND** the in-memory flip happens normally
