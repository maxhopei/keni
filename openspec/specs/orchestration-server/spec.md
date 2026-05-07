# orchestration-server Specification

## Purpose

Defines the contract for `@keni/server` — the local HTTP orchestration server that is the single gatekeeper for every legitimate write to a Keni project's `.keni/` tree (per `spec.md` §5.3) and the structural communication bus between the SPA, role runtimes, MCP layer, and the user. The capability cements `spec.md` §2#1 ("environment as communication bus"), §2#3 ("status drives behaviour"), §4.1 (ticket lifecycle), §4.2 (owning-role rule), §5.1 (project artifacts), §7.1 ("one server, one project"), and §11#5 ("files first, storage abstracted") by requiring a single Hono app that mounts a documented REST surface (`/tickets`, `/prs`, `/activity`, `/agents`) plus a server-push `/events` WebSocket, enforces the status graph and the owning-role rule on every transition, exposes a stable error envelope (`ErrorResponse`) with a closed `ErrorCode` enum, emits structured per-request JSONL log lines, owns a typed in-process `EventBus` and an in-memory `AgentRuntimeStateStore` whose updates fan out to every connected WS client as a documented `EventFrame` discriminated union, separates wire shapes (TS types in `@keni/shared`, zod schemas in `@keni/server`) from storage records, trusts a local-only role-header identity (with a `?role=` query-parameter fallback restricted to `/events`) in the prototype, and ships a development-mode `deno run` entry point that step 13's `keni start` later wraps. The bus and the agent runtime-state store are in-memory only — a server restart resets `paused`, `status`, and `last_*` fields and drops any undelivered events; the activity log remains the durable record and the SPA reconciles via REST on (re)connect. Any change that adds an endpoint, alters the status graph, changes the role-owner table, mutates an error code, edits the middleware order, extends the `EventName` union, or relaxes the trust model lands as a delta spec against this capability.
## Requirements
### Requirement: `@keni/server` exposes a Hono-based HTTP orchestration server

The `@keni/server` package SHALL export three composable entry-point functions: `createServer(deps, opts)` SHALL return a `Hono` app instance with every middleware and route mounted, performing no I/O of its own; `startServer(opts)` SHALL bind the Hono app via `Deno.serve`, returning `{ abort, port, url }` for lifecycle control; `runServer(args)` SHALL parse CLI-style argv (`--project <path>`, `--port <number>`, `--host <hostname>`), instantiate the file-backed stores against the resolved project root, call `startServer`, and return an exit code (0 success, 1 runtime error, 2 usage error). `packages/server/src/main.ts` SHALL re-export the three functions and SHALL invoke `Deno.exit(await runServer(Deno.args))` only when run as a script (`import.meta.main`). The server SHALL bind to `127.0.0.1` by default; binding to other hostnames SHALL require explicit `--host`.

#### Scenario: `createServer` returns a Hono app without performing I/O

- **WHEN** a caller invokes `createServer({ ticketStore, prStore, activityLogStore, configStore, logSink }, { projectId: "fixed" })`
- **THEN** the call resolves synchronously without reading or writing any file
- **AND** the returned value is a `Hono` instance whose `fetch` method routes requests through the documented middleware stack and onto the documented routes

#### Scenario: `startServer` binds an OS-assigned port when none is supplied

- **WHEN** a test invokes `startServer({ deps, projectId: "test", port: 0 })`
- **THEN** the call resolves with `{ abort, port, url }` where `port > 0`
- **AND** `url` matches `http://127.0.0.1:<port>`
- **AND** calling `abort()` shuts down the server cleanly

#### Scenario: `runServer` exits 0 on a successful clean shutdown

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a `keni init`-produced temp dir
- **AND** the process is signalled to abort
- **THEN** the function returns exit code 0
- **AND** stdout names the bound URL during startup

#### Scenario: `runServer` exits 2 when `--project` is missing

- **WHEN** `runServer([])` is invoked with no arguments
- **THEN** the function returns exit code 2
- **AND** stderr names the missing `--project` argument and lists the supported flags

#### Scenario: `runServer` exits 1 when the project is not a Keni project

- **WHEN** `runServer(["--project=<emptyDir>"])` is invoked against a directory that has no `.keni/project.yaml`
- **THEN** the function returns exit code 1
- **AND** stderr identifies the missing project config and instructs the user to run `keni init`

### Requirement: The composition root reads `project_id` once at startup and stamps it on every response

`runServer` SHALL invoke `configStore.readProjectConfig()` exactly once at startup, extract `project_id`, and pass it to `createServer` via `ServerOptions.projectId`. `createServer` SHALL NOT read the project config itself. Every response body that carries an envelope (the success envelope `{ data, project_id }` or the error envelope `{ error: { code, message, details? } }`) SHALL include the `project_id` field — for the success envelope unconditionally; for the error envelope when the response is produced after middleware mounted the project context. A request that explicitly names a different `project_id` (in any future request shape that supports it) SHALL be rejected with `400 validation_failed`. The cached `project_id` SHALL NOT be re-read mid-process; runtime edits to `project.yaml` SHALL require a server restart to take effect.

#### Scenario: `project_id` is read once at bootstrap

- **WHEN** the server is started against a project whose `project.yaml` declares `project_id: a3f5b1c7-…`
- **AND** the test inspects the `configStore.readProjectConfig` call count after `runServer` returns from its bootstrap phase
- **THEN** the count is exactly 1

#### Scenario: Successful responses carry `project_id`

- **WHEN** a `GET /tickets` request is sent against a server whose `project_id` is `a3f5b1c7-…`
- **THEN** the response body parses as `{ data: TicketSummaryResponse[], project_id: "a3f5b1c7-…" }`
- **AND** the same id appears on `GET /tickets/:id`, `POST /tickets`, `PATCH /tickets/:id`, `POST /tickets/:id/transition`, every PR endpoint, and every activity-log endpoint

#### Scenario: A future request carrying a mismatched `project_id` is rejected

- **WHEN** a request body that includes a `project_id` field whose value does not equal the server's resolved `project_id` is received
- **THEN** the server responds with `400` and `error.code: "validation_failed"`
- **AND** the response body identifies the field and the expected value

### Requirement: Every request carries a role identity via `X-Keni-Role` and optional `X-Keni-Agent` headers

Every request to the server SHALL include an `X-Keni-Role` header whose value is one of `user`, `engineer`, `qa`, `po`, `writer`. Requests MAY include an `X-Keni-Agent` header naming the calling agent id (used for activity-log attribution and future per-agent guards). A `roleIdentity` middleware SHALL parse both headers, expose them on `c.var.role` and `c.var.agent`, and SHALL respond with `400 missing_role` when the role header is absent or its value is outside the documented enum. The middleware SHALL run before every route handler so handlers may rely on `c.var.role` being a typed `Role`. The role headers SHALL be trusted in the prototype (no signature, no auth); the trust model SHALL be documented in the capability spec and in the README.

#### Scenario: Missing role header rejected with `missing_role`

- **WHEN** any HTTP request is sent without the `X-Keni-Role` header
- **THEN** the server responds with status 400
- **AND** the response body is `{ error: { code: "missing_role", message: "X-Keni-Role header is required" } }`

#### Scenario: Unknown role value rejected with `missing_role`

- **WHEN** an HTTP request is sent with `X-Keni-Role: super-user`
- **THEN** the server responds with status 400
- **AND** the response body is `{ error: { code: "missing_role", message: <message naming the received value and the allowed enum> } }`

#### Scenario: Valid role propagates to handlers as `c.var.role`

- **WHEN** a request with `X-Keni-Role: engineer` and `X-Keni-Agent: alice` reaches a handler
- **THEN** the handler observes `c.var.role === "engineer"` and `c.var.agent === "alice"`
- **AND** the handler observes `c.var.role` typed as `Role` (the union of the documented values)

### Requirement: A status-graph constant encodes the §4.1 ticket lifecycle and the §4.2 owning-role rule

The server SHALL export a frozen constant `TICKET_STATUS_TRANSITIONS` whose shape is `Readonly<Record<TicketStatus, readonly TicketStatus[]>>` and whose entries SHALL match the diagram in `spec.md` §4.1 edge-for-edge: `open → [in_progress]`; `in_progress → [ready_for_review]`; `ready_for_review → [in_review]`; `in_review → [has_comments, approved]`; `has_comments → [in_progress]`; `approved → [merged]`; `merged → [ready_for_test]`; `ready_for_test → [in_testing]`; `in_testing → [tested, test_failed]`; `tested → [done]`; `test_failed → [in_progress]`; `done → []`. The server SHALL export a frozen constant `TICKET_STATUS_OWNING_ROLES` whose entries map each status to the role(s) authorised to transition into it: `engineer` for `in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, `ready_for_test`; `qa` for `in_testing`, `tested`, `test_failed`; `po` for `done`; `[]` (no role) for `open`. The server SHALL also export `USER_OVERRIDE_ALLOWED = ["user"]`: the `user` role SHALL be authorised to transition into any status (the override path), although the prototype SHALL NOT yet emit a corresponding `manual_override` activity-log entry (see the deferred-override requirement below). PRs SHALL have an analogous pair of constants (`PR_STATUS_TRANSITIONS`, `PR_STATUS_OWNING_ROLES`) covering the engineer-only PR lifecycle, **including a documented edge `approved → merged` that the new `POST /prs/:id/merge` endpoint owns** (the endpoint calls `PRStore.updateStatus(id, prRecord.status, "merged")` after the fast-forward succeeds; the engineer also has the option to drive this transition via the existing `POST /prs/:id/transition` endpoint, but production code SHALL prefer the merge endpoint because the merge endpoint is the only path that performs the actual git fast-forward).

#### Scenario: `TICKET_STATUS_TRANSITIONS` matches `spec.md` §4.1 line-for-line

- **WHEN** the value of `TICKET_STATUS_TRANSITIONS` is read
- **THEN** every key listed in `spec.md` §4.1 is present
- **AND** every outgoing edge listed in `spec.md` §4.1 is in the corresponding array
- **AND** no extra edges are present

#### Scenario: `done` is a terminal state in the graph

- **WHEN** the value of `TICKET_STATUS_TRANSITIONS.done` is read
- **THEN** the array is empty
- **AND** any transition request whose `to` field is `done` is allowed only from `tested` (per the graph)

#### Scenario: `TICKET_STATUS_OWNING_ROLES` enforces the §4.2 ownership table

- **WHEN** the value of `TICKET_STATUS_OWNING_ROLES` is read
- **THEN** `in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, and `ready_for_test` map to `["engineer"]`
- **AND** `in_testing`, `tested`, `test_failed` map to `["qa"]`
- **AND** `done` maps to `["po"]`
- **AND** `open` maps to `[]`

#### Scenario: `user` is allowed for every transition target

- **WHEN** any ticket-transition request is made with `X-Keni-Role: user`
- **AND** the `from`/`to` pair is in `TICKET_STATUS_TRANSITIONS`
- **THEN** the role guard SHALL NOT reject the request
- **AND** the transition SHALL be applied

#### Scenario: `PR_STATUS_TRANSITIONS` includes the `approved → merged` edge owned by the merge endpoint

- **WHEN** the value of `PR_STATUS_TRANSITIONS.approved` is read
- **THEN** the array contains `"merged"`
- **AND** the merge endpoint's post-success `PRStore.updateStatus(id, "approved", "merged")` call passes the `from`/`to` graph check

### Requirement: `POST /tickets/:id/transition` enforces the status graph and the owning-role rule

The endpoint SHALL accept a JSON body `{ from: TicketStatus, to: TicketStatus }`. It SHALL: (1) validate the body shape via zod (rejecting with `400 validation_failed` on shape mismatch); (2) verify that `to` is in `TICKET_STATUS_TRANSITIONS[from]`, rejecting with `403 status_graph_violation` otherwise; (3) verify that the calling role (from `X-Keni-Role`) is in `TICKET_STATUS_OWNING_ROLES[to]` or in `USER_OVERRIDE_ALLOWED`, rejecting with `403 role_not_owner` otherwise; (4) call `TicketStore.transitionStatus(id, from, to)`, mapping `StaleStateError` to `409 stale_state` and `StoreNotFoundError` to `404 store_not_found`; (5) return `200 { data: TicketResponse, project_id }` on success. The endpoint SHALL NOT perform `to ∈ to-list` and `role ∈ owners` checks in any order other than this (graph first, then role) so that an unreachable transition is reported as a graph violation regardless of role.

#### Scenario: Engineer transitions `open → in_progress`

- **WHEN** `POST /tickets/ticket-0001/transition` is called with `X-Keni-Role: engineer` and body `{ from: "open", to: "in_progress" }`
- **AND** the on-disk status is `open`
- **THEN** the response is 200
- **AND** the response body's `data.status` is `in_progress`
- **AND** the on-disk file at `.keni/tickets/ticket-0001.md` has `status: in_progress`

#### Scenario: Engineer rejected from QA-owned `tested`

- **WHEN** `POST /tickets/ticket-0001/transition` is called with `X-Keni-Role: engineer` and body `{ from: "in_testing", to: "tested" }`
- **AND** the on-disk status is `in_testing`
- **THEN** the response is 403
- **AND** `error.code === "role_not_owner"`
- **AND** the on-disk file is unchanged

#### Scenario: QA rejected from PO-owned `done`

- **WHEN** `POST /tickets/ticket-0001/transition` is called with `X-Keni-Role: qa` and body `{ from: "tested", to: "done" }`
- **THEN** the response is 403
- **AND** `error.code === "role_not_owner"`

#### Scenario: Status-graph violation rejected before role check

- **WHEN** `POST /tickets/ticket-0001/transition` is called with `X-Keni-Role: engineer` and body `{ from: "open", to: "merged" }`
- **THEN** the response is 403
- **AND** `error.code === "status_graph_violation"` (not `role_not_owner`, even though `merged` is engineer-owned, because the graph violation is checked first)

#### Scenario: Stale-state on disk surfaces as 409

- **WHEN** `POST /tickets/ticket-0001/transition` is called with `from: "open"` but the on-disk status is `in_progress`
- **THEN** the response is 409
- **AND** `error.code === "stale_state"`
- **AND** `error.details` names the expected and actual status

### Requirement: `GET /tickets`, `GET /tickets/:id`, `POST /tickets`, `PATCH /tickets/:id` cover the ticket read/create/update surface

`GET /tickets` SHALL return `200 { data: TicketSummaryResponse[], project_id }` derived from `TicketStore.list(filter)`. The filter SHALL be parsed from query-string parameters: `status` (single value or comma-separated list), `assignee` (string id, the literal `null`, or absent), `priorityMin` (integer), `priorityMax` (integer), `changeRequest` (CR id, the literal `null`, or absent). Unknown query parameters SHALL be ignored. `GET /tickets/:id` SHALL return `200 { data: TicketResponse, project_id }` derived from `TicketStore.read(id)`; `StoreNotFoundError` maps to `404 store_not_found`. `POST /tickets` SHALL accept the `TicketCreateRequest` body shape, validate it with zod, allow `X-Keni-Role: user` and `X-Keni-Role: engineer` (PO and other roles are rejected with `403 role_not_owner`), and delegate to `TicketStore.create(input)`; the response SHALL be `201 { data: TicketResponse, project_id }`. `PATCH /tickets/:id` SHALL accept the `TicketHeaderPatchRequest` body shape (header fields plus optional `body`), validate it with zod, and delegate to `TicketStore.updateHeader(...)` and/or `TicketStore.updateBody(...)` as appropriate; the response SHALL be `200 { data: TicketResponse, project_id }`. A `PATCH` body that includes `status` SHALL be rejected with `400 status_in_patch` (the storage layer raises `InvalidArtifactError("status_in_patch")` and the error mapper translates it).

#### Scenario: Empty project returns an empty `data` array

- **WHEN** `GET /tickets` is called against a freshly initialised project
- **THEN** the response is 200
- **AND** the response body is `{ data: [], project_id: <uuid> }`

#### Scenario: Status filter accepts a comma-separated list

- **WHEN** `GET /tickets?status=open,in_progress` is called against a project containing tickets in three statuses
- **THEN** only `open` and `in_progress` tickets are returned
- **AND** the order is whatever `TicketStore.list` returns (no specific ordering guaranteed)

#### Scenario: Reading a missing id returns 404

- **WHEN** `GET /tickets/ticket-9999` is called and no such ticket exists
- **THEN** the response is 404
- **AND** the response body is `{ error: { code: "store_not_found", message: <message naming the id> }, project_id: <uuid> }`

#### Scenario: User creates a ticket

- **WHEN** `POST /tickets` is called with `X-Keni-Role: user` and body `{ title: "Add login page", priority: 100 }`
- **THEN** the response is 201
- **AND** `data.id` matches `/^ticket-\d{4,}$/`
- **AND** `data.status === "open"`
- **AND** `data.title === "Add login page"`
- **AND** the file `.keni/tickets/ticket-NNNN.md` exists on disk

#### Scenario: Engineer creates a follow-up ticket

- **WHEN** `POST /tickets` is called with `X-Keni-Role: engineer` and a valid body
- **THEN** the response is 201
- **AND** the engineer-as-author intent is unchanged (the prototype does not record authorship; this is documented for forward compatibility)

#### Scenario: PO is not allowed to create tickets in the prototype

- **WHEN** `POST /tickets` is called with `X-Keni-Role: po`
- **THEN** the response is 403
- **AND** `error.code === "role_not_owner"`

#### Scenario: `PATCH` rejects a body containing `status`

- **WHEN** `PATCH /tickets/ticket-0001` is called with body `{ status: "in_progress" }`
- **THEN** the response is 400
- **AND** `error.code === "validation_failed"` (the strict zod schema for `TicketHeaderPatchRequest` rejects unknown fields at the wire boundary)
- **AND** the on-disk file is unchanged
- **AND** the `status_in_patch` error code remains documented in `mapErrorToResponse` for callers that bypass the wire schema (e.g., direct storage usage from the CLI or MCP) and trigger `InvalidArtifactError("status_in_patch")`

#### Scenario: `PATCH` accepts header and body together

- **WHEN** `PATCH /tickets/ticket-0001` is called with body `{ title: "New title", priority: 50, body: "Updated description" }`
- **THEN** the response is 200
- **AND** `data.title === "New title"`, `data.priority === 50`, `data.body === "Updated description"`
- **AND** the on-disk YAML header reflects the new title/priority and the markdown body reflects the new content

### Requirement: PR endpoints mirror the ticket surface for the engineer-owned PR lifecycle

`GET /prs` SHALL return `200 { data: PRSummaryResponse[], project_id }` derived from `PRStore.list(filter)`. Filter parameters SHALL include `status` (single value or comma-separated list), `ticket` (ticket id), `author` (agent id). `GET /prs/:id` SHALL return `200 { data: PRResponse, project_id }` derived from `PRStore.read(id)`. `POST /prs` SHALL accept the `PRCreateRequest` body shape, validate it with zod, allow `X-Keni-Role: engineer` (and `user` for the override path), and delegate to `PRStore.create(input)`; the response SHALL be `201 { data: PRResponse, project_id }`. `PATCH /prs/:id/intent` SHALL accept the `PRIntentPatchRequest` body (`{ intent: string }`) and delegate to `PRStore.updateIntent(id, intent)`. `POST /prs/:id/transition` SHALL accept `{ from: PRStatus, to: PRStatus }`, enforce `PR_STATUS_TRANSITIONS` and `PR_STATUS_OWNING_ROLES` (engineer owns the entire PR lifecycle; user can override), and delegate to `PRStore.updateStatus(id, from, to)`; status mappings (`StaleStateError → 409`, `StoreNotFoundError → 404`, `status_graph_violation → 403`, `role_not_owner → 403`) match the ticket endpoint.

#### Scenario: Engineer creates a PR

- **WHEN** `POST /prs` is called with `X-Keni-Role: engineer`, `X-Keni-Agent: alice`, and body `{ title: "Login form", ticket: "ticket-0001", branch: "ticket-0001", author: "alice" }`
- **THEN** the response is 201
- **AND** `data.id` matches `/^pr-\d{4,}$/`
- **AND** `data.status === "open"`
- **AND** the file `.keni/prs/pr-NNNN.md` exists on disk

#### Scenario: QA cannot transition a PR

- **WHEN** `POST /prs/pr-0001/transition` is called with `X-Keni-Role: qa` and body `{ from: "in_review", to: "approved" }`
- **THEN** the response is 403
- **AND** `error.code === "role_not_owner"`

#### Scenario: Engineer transitions PR `in_review → approved`

- **WHEN** `POST /prs/pr-0001/transition` is called with `X-Keni-Role: engineer`, `X-Keni-Agent: alice`, and body `{ from: "in_review", to: "approved" }`
- **AND** the on-disk PR status is `in_review`
- **THEN** the response is 200
- **AND** `data.status === "approved"`

### Requirement: Activity log endpoints expose append and query

`GET /activity` SHALL accept query-string filters `agent`, `role`, `from`, `to` (the latter two ISO 8601 timestamps) and SHALL return `200 { data: ActivityEntryResponse[], project_id }` whose `data` array is the materialised result of `ActivityLogStore.query(filter)` in increasing-id order. The prototype SHALL NOT paginate the response; the wire shape SHALL leave room for a future `next_cursor` field by virtue of the envelope (additive, no breaking change). `POST /activity` SHALL accept the `ActivityAppendRequest` body shape (`session_id`, `agent`, `role`, `event`, optional `timestamp`, optional `summary`, optional `refs`), validate it with zod, and delegate to `ActivityLogStore.append(input)`. The response SHALL be `201 { data: ActivityEntryResponse, project_id }`. `InvalidArtifactError("size_exceeded")` SHALL map to `422 invalid_artifact` with `error.details.reason = "size_exceeded"`.

#### Scenario: Empty log returns an empty `data` array

- **WHEN** `GET /activity` is called against a freshly initialised project
- **THEN** the response is 200
- **AND** the response body is `{ data: [], project_id: <uuid> }`

#### Scenario: Append produces a uuidv7 id and persists to the date partition

- **WHEN** `POST /activity` is called with `X-Keni-Role: engineer`, `X-Keni-Agent: alice`, and body `{ session_id: "s1", agent: "alice", role: "engineer", event: "session_start", summary: "Start" }`
- **THEN** the response is 201
- **AND** `data.id` is a uuidv7 string
- **AND** `data.timestamp` is an ISO 8601 string close to `now`
- **AND** the file `.keni/activity/YYYY-MM-DD.jsonl` (UTC date) contains exactly one matching line

#### Scenario: Filtered query returns the right slice in id order

- **WHEN** the activity log contains entries for `alice` and `bob` across two days
- **AND** `GET /activity?agent=alice&from=2026-04-30T00:00:00Z&to=2026-04-30T23:59:59Z` is called
- **THEN** the response's `data` array contains only `alice`'s entries from `2026-04-30`
- **AND** the entries are ordered by increasing `id`

#### Scenario: Oversized append produces 422

- **WHEN** `POST /activity` is called with a body whose serialised JSON exceeds the storage layer's 4 KB limit
- **THEN** the response is 422
- **AND** `error.code === "invalid_artifact"`
- **AND** `error.details.reason === "size_exceeded"`

### Requirement: Every error response uses the documented envelope and a stable `error.code`

The server SHALL respond to every non-2xx request with a body matching `ErrorResponse`: `{ error: { code: ErrorCode, message: string, details?: Record<string, unknown> }, project_id?: string }`. The `error.code` SHALL be one of: `store_not_found`, `stale_state`, `duplicate_id`, `invalid_artifact`, `status_in_patch`, `status_graph_violation`, `role_not_owner`, `missing_role`, `validation_failed`, `internal_error`. A single `mapErrorToResponse` function SHALL own the mapping from typed exceptions to `(httpStatus, body)` pairs. `StoreNotFoundError → 404 store_not_found`; `StaleStateError → 409 stale_state`; `DuplicateIdError → 409 duplicate_id`; `InvalidArtifactError → 422 invalid_artifact` (with the reason copied into `error.details.reason`), with the special case that `InvalidArtifactError("status_in_patch")` is re-mapped to `400 status_in_patch`; `StatusGraphViolationError → 403 status_graph_violation`; `RoleNotOwnerError → 403 role_not_owner`; `MissingRoleError → 400 missing_role`; `ZodError → 400 validation_failed` (with `error.details.issues` populated from the zod issues array); any other error → `500 internal_error` (with the original message logged but redacted from the response). An `errorBoundary` middleware SHALL wrap every handler so handlers do not need their own `try`/`catch` for typed errors.

#### Scenario: Zod validation failure surfaces field-level details

- **WHEN** `POST /tickets` is called with body `{ title: "" }` (missing `priority`, empty `title`)
- **THEN** the response is 400
- **AND** `error.code === "validation_failed"`
- **AND** `error.details.issues` is an array naming both `title` (min length 1) and `priority` (required)

#### Scenario: Internal error maps to 500 with redacted message

- **WHEN** a handler throws an unexpected `Error("database connection lost")`
- **THEN** the response is 500
- **AND** `error.code === "internal_error"`
- **AND** the response body's `error.message` does not include the original exception message verbatim
- **AND** the request log line records the request id, the status 500, and the original error class for debugging

#### Scenario: Storage `DuplicateIdError` maps to 409 `duplicate_id`

- **WHEN** a handler propagates a `DuplicateIdError`
- **THEN** the response is 409
- **AND** `error.code === "duplicate_id"`

### Requirement: A `requestId` middleware assigns a per-request UUIDv4 and echoes it on the response

The server SHALL generate a UUIDv4 per request, store it on `c.var.request_id`, and add it to the response as the `X-Keni-Request-Id` header. The middleware SHALL run before any other middleware that may emit log lines so the id is available to them. Inbound requests that supply their own `X-Keni-Request-Id` header SHALL be honoured (the value is propagated as-is to `c.var.request_id` and echoed on the response) so callers can trace round-trips when needed.

#### Scenario: Server-assigned request id

- **WHEN** any HTTP request is sent without an `X-Keni-Request-Id` header
- **THEN** the response includes an `X-Keni-Request-Id` header
- **AND** the header value matches the UUIDv4 regex
- **AND** the same value appears in the request log line for that request

#### Scenario: Caller-supplied request id is honoured

- **WHEN** a request is sent with `X-Keni-Request-Id: trace-abc-123`
- **THEN** the response header `X-Keni-Request-Id: trace-abc-123` is returned
- **AND** the request log line for that request uses `request_id: "trace-abc-123"`

### Requirement: A `requestLog` middleware emits one structured JSONL line per request

The middleware SHALL emit a single line per completed request via an injected `LogSink` (defaulting to a stdout sink in dev). Each line SHALL be valid JSON containing: `request_id` (string), `timestamp` (ISO 8601 UTC), `method` (string), `path` (string), `status` (integer), `duration_ms` (integer ≥ 0), `role` (string or null), `agent` (string or null), `project_id` (string), and `error_code` (string, present only when `status >= 400`). The sink SHALL be swappable via dependency injection; the package SHALL expose `stdoutLogSink()`, `captureLogSink(buffer)`, and `fileLogSink(dir)` factories. Tests SHALL use `captureLogSink` to assert on emitted lines without touching stdout.

#### Scenario: Successful request emits a log line with no `error_code`

- **WHEN** a `GET /tickets` request returns 200
- **THEN** the captured log line has `status: 200` and no `error_code` key
- **AND** the line has every other documented core field populated

#### Scenario: Failed request emits a log line with `error_code`

- **WHEN** a `GET /tickets/ticket-9999` request returns 404 `store_not_found`
- **THEN** the captured log line has `status: 404` and `error_code: "store_not_found"`

#### Scenario: Log line is valid JSON

- **WHEN** a request completes
- **THEN** the captured log line, parsed with `JSON.parse`, returns an object whose fields match the documented shape

### Requirement: Wire shapes are TypeScript types in `@keni/shared` and zod schemas in `@keni/server`; the schema enforces type alignment at compile time

The `@keni/shared` package SHALL export, from `@keni/shared/wire/`, TypeScript types for every request and response shape: `TicketCreateRequest`, `TicketHeaderPatchRequest`, `TicketTransitionRequest`, `TicketResponse`, `TicketSummaryResponse`, `TicketListResponse`, `PRCreateRequest`, `PRIntentPatchRequest`, `PRTransitionRequest`, `PRResponse`, `PRSummaryResponse`, `PRListResponse`, `ActivityAppendRequest`, `ActivityEntryResponse`, `ActivityQueryResponse`, `ErrorResponse`, `ErrorCode`, `Role`. None of these types SHALL pull `npm:zod` into the import graph. The `@keni/server` package SHALL export, from `packages/server/src/wire/`, zod schemas for every request shape (and for the error envelope), each declared with the explicit type constraint `z.ZodType<SharedType>` so a drift between the schema and the shared type fails the type-check at compile time. Each `wire/*_test.ts` SHALL include a type-equivalence assertion (`expectType<z.infer<typeof Schema>>().toEqual<SharedType>()` or equivalent) so that a schema field added without a shared-type field also fails the build.

#### Scenario: SPA-style importer pulls types only

- **WHEN** a consumer writes `import type { TicketResponse, TicketCreateRequest, ErrorResponse } from "@keni/shared"`
- **THEN** the imports resolve to TypeScript types
- **AND** the consumer's bundle (after tree-shaking) contains no zod runtime code

#### Scenario: Schema-type drift fails the type-check

- **WHEN** a contributor adds a field `labels: string[]` to `TicketCreateRequest` in `@keni/shared/wire/tickets.ts`
- **AND** does not add the corresponding zod field to `TicketCreateRequestSchema` in `@keni/server/wire/tickets.ts`
- **THEN** `deno task check` fails with a TypeScript error pointing at the schema's `z.ZodType<TicketCreateRequest>` annotation

### Requirement: User overrides on transitions are structurally allowed but `manual_override` activity emission is deferred to step 25

The role guard SHALL accept `X-Keni-Role: user` for every status transition (both ticket and PR), so the user can curl through any `from → to` allowed by the graph. The server SHALL NOT yet emit a `manual_override` activity-log entry on these transitions; the confirmation flow and the activity-log emission SHALL be added by the `manual-override` change (step 25). The capability spec SHALL document this gap explicitly, and the source code at the transition seam SHALL carry a clearly-marked `// TODO(step-25): emit manual_override activity entry when role === "user"` comment so the gap is discoverable.

#### Scenario: User can curl a transition through every legal `from → to`

- **WHEN** `POST /tickets/ticket-0001/transition` is called with `X-Keni-Role: user` and body `{ from: "in_testing", to: "tested" }`
- **AND** the on-disk status is `in_testing`
- **THEN** the response is 200
- **AND** `data.status === "tested"`

#### Scenario: No `manual_override` activity entry is produced in the prototype

- **WHEN** a `user`-role transition succeeds
- **AND** the activity log is queried for entries with `event === "manual_override"`
- **THEN** the result is empty
- **AND** the source code at `packages/server/src/routes/tickets.ts` contains the documented `TODO(step-25)` comment

#### Scenario: User cannot bypass the status graph

- **WHEN** `POST /tickets/ticket-0001/transition` is called with `X-Keni-Role: user` and body `{ from: "open", to: "merged" }`
- **THEN** the response is 403
- **AND** `error.code === "status_graph_violation"`
- **AND** the user-override allowance does not extend to bypassing the graph

### Requirement: Trust model — local-only, no auth, role headers trusted

The server SHALL bind to `127.0.0.1` by default. It SHALL NOT implement authentication, TLS, CORS, or rate-limiting in the prototype. The `X-Keni-Role` and `X-Keni-Agent` headers SHALL be trusted at face value. The trust model SHALL be documented prominently in both the capability spec and the root README ("Run the orchestration server" subsection), naming the rationale (single-user local prototype) and the seam where future auth slots in (in front of the role-identity middleware, by the same `app.use(...)` mechanism). Future auth changes SHALL NOT alter the role-guard contract; they SHALL only verify the caller's right to claim the role.

#### Scenario: Default bind is `127.0.0.1`

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked without `--host`
- **THEN** the server binds to `127.0.0.1`
- **AND** `url` returned by `startServer` is `http://127.0.0.1:<port>`

#### Scenario: Trust model is documented in the README

- **WHEN** the root `README.md` is read
- **THEN** the "Run the orchestration server" subsection states the prototype binds to `127.0.0.1`, has no auth, and trusts the role header
- **AND** the section names step 13 as the future home of `keni start` and indicates auth is post-MVP

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

### Requirement: A development-mode entry point is runnable directly via `deno run` without `keni start`

The server SHALL be runnable via `deno run -A packages/server/src/main.ts --project=<path>` for development and integration testing, before step 13 introduces the `keni start` CLI. The README SHALL document this invocation alongside a one-line `curl` example showing the role header. The same `runServer` function consumed here SHALL be the function step 13 calls from its `keni start` arm, so that wiring is a one-line addition in step 13 (not a rewrite).

#### Scenario: Direct invocation prints the bound URL

- **WHEN** a developer runs `deno run -A packages/server/src/main.ts --project=<tempDir> --port=0` against a `keni init`-produced temp dir
- **THEN** stdout contains a line of the form `Keni server running at http://127.0.0.1:<port>` (or equivalent documented format)
- **AND** the server responds to `GET /tickets` with `X-Keni-Role: user` with status 200

#### Scenario: README documents the invocation

- **WHEN** the root `README.md` is read
- **THEN** the "Run the orchestration server" subsection shows `deno run -A packages/server/src/main.ts --project=<path>`
- **AND** shows a one-line `curl` example with `-H "X-Keni-Role: user"`
- **AND** notes that `keni start` (forthcoming in step 13) will fold this into the CLI

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

The trust model from the existing capability requirement (local-only, no auth, role headers trusted) SHALL extend to the WS upgrade verbatim with one addition: when the upgrade request lacks an `X-Keni-Role` header (the common case for `new WebSocket(...)` from a browser), the upgrade handler SHALL accept the role from the `?role=<role>` query parameter. The query parameter SHALL apply *only* to the WS upgrade path; REST endpoints SHALL continue to require the header. A request with both header and query parameter SHALL prefer the header. The fallback SHALL apply equally to BOTH WS upgrade URL forms documented in this capability: `/events` (the bare path) AND `/api/events` (the `/api`-prefixed alias). Future auth (post-MVP) SHALL slot in front of both, validating the caller's right to claim the role; the role-resolution rule itself SHALL NOT change.

#### Scenario: REST endpoints do not accept `?role=`

- **WHEN** `GET /tickets?role=user` is called without `X-Keni-Role`
- **THEN** the response is 400 `missing_role`

#### Scenario: WS endpoint accepts `?role=`

- **WHEN** an upgrade request to `/events?role=user` is sent without `X-Keni-Role`
- **THEN** the response is 101 (the upgrade succeeds)

#### Scenario: WS endpoint accepts `?role=` on the `/api`-prefixed mirror

- **WHEN** an upgrade request to `/api/events?role=user` is sent without `X-Keni-Role`
- **THEN** the response is 101 (the upgrade succeeds)
- **AND** the connection's role for downstream subscribers is `user`

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

### Requirement: `runServer` wires up role runners polymorphically via the `roleWires` registry; the server holds zero role-specific knowledge

`runServer` SHALL accept, on its `RunServerDeps` value bag, a `roleWires: Readonly<Record<string, WireFn>>` field where `WireFn` is the type imported from `@keni/runtime-common`. After constructing the scheduler but before `Deno.serve` accepts connections, `runServer` SHALL: (1) instantiate a single shared `WorkspaceProvisioner` (concretely, `GitWorkspaceProvisioner` from `@keni/runtime-workspace`) and pass it through to every wire's `WireInput`; (2) iterate the project's `agents` roster in declaration order; (3) for each agent, look up `wireFn = roleWires[agent.role]`; (4) when `wireFn` is undefined, log one info-level `runner.skipped` line naming the agent and the missing role and proceed; (5) when `wireFn` is defined, call `await wireFn(input)` with a `WireInput` carrying `projectId`, `projectName`, `projectRepoPath`, `serverUrl`, `agentConfig`, `resolvedConfig`, `mcpEntryPath`, `logger`, `makeActivityHttpClient`, `codingAgentCliRegistry`, and the shared `workspaceProvisioner`; (6) when the wire returns a non-`null` `AgentRunner`, call `scheduler.registerRunner(runner)`; when the wire returns `null`, log one info-level `runner.skipped` line naming the agent (the wire itself has already logged the reason) and proceed; (7) when the wire throws, exit `runServer` with code 1 and a stderr message naming the failed agent and the underlying error message — wire failures are boot failures.

`runServer` SHALL NOT import `createEngineerRunner`, `createPoRunner`, or any role-specific factory. `runServer`'s source under `packages/server/src/` SHALL contain zero `=== "engineer"`, `=== "qa"`, `=== "po"`, or `=== "writer"` literal comparisons in its boot path. `runServer` SHALL emit one info-level log line per registered runner naming the agent id, the role, the workspace path (when applicable), and the elapsed wiring time.

`runServer` SHALL call `scheduler.start()` exactly once after every roster entry has been processed, and only then SHALL `Deno.serve` accept connections. When `roleWires` is empty (no roles registered) or when every roster entry's wire returns `null`, `runServer` SHALL still complete bootstrap successfully — the scheduler runs with zero registered runners, every per-tick invocation logs `runner.missing` per the `scheduler` capability.

#### Scenario: `runServer` polymorphically dispatches per-agent wiring

- **WHEN** `runServer(deps, opts)` is invoked with `deps.roleWires = { engineer: <fakeEngineerWire>, po: <fakePoWire> }` against a project whose roster is `[{ id: "alice", role: "engineer" }, { id: "petra", role: "po" }]`
- **AND** instrumented wires record their calls
- **THEN** `<fakeEngineerWire>` is called exactly once with `WireInput.agentConfig.id === "alice"`
- **AND** `<fakePoWire>` is called exactly once with `WireInput.agentConfig.id === "petra"`
- **AND** `scheduler.registerRunner` is called exactly twice (once per non-null wire return), with the engineer runner registered before the PO runner (roster order)
- **AND** `scheduler.start()` is called exactly once after both `registerRunner` calls
- **AND** every captured registration call resolves before `Deno.serve` begins accepting connections

#### Scenario: Missing role wire logs `runner.skipped` and continues

- **WHEN** `runServer` is invoked with `deps.roleWires = { engineer: <wire> }` against a project whose roster is `[{ id: "petra", role: "po" }]` (no PO wire registered)
- **THEN** the captured logger received exactly one info-level `runner.skipped` line naming `agent: "petra"` and `role: "po"`
- **AND** `scheduler.registerRunner` is called zero times
- **AND** `scheduler.start()` is called exactly once
- **AND** `runServer` completes bootstrap successfully (no exit code 1)

#### Scenario: Wire `null` return logs `runner.skipped` and continues

- **WHEN** the engineer wire returns `null` for `alice` (e.g., no CLI configured)
- **THEN** the captured logger received the wire's own role-specific skip log (e.g., `engineer.runner_skipped` with `reason: "no_cli_configured"`) plus exactly one `runner.skipped` line at the runServer layer
- **AND** `scheduler.registerRunner` is not called for `alice`
- **AND** `runServer` completes bootstrap successfully

#### Scenario: Wire throw exits `runServer` with code 1

- **WHEN** the engineer wire throws `new Error("workspace clone failed")` for `alice`
- **THEN** `runServer` returns exit code 1
- **AND** stderr names `"alice"` and the error message
- **AND** `scheduler.start()` is not invoked
- **AND** `Deno.serve` is not invoked

#### Scenario: `runServer`'s source is role-agnostic

- **WHEN** the production source files under `packages/server/src/` (excluding `*_test.ts`) are scanned for `createEngineerRunner`, `createPoRunner`, or any other role-specific factory name
- **THEN** zero occurrences are found
- **AND** scanning the same files for `=== "engineer"`, `=== "qa"`, `=== "po"`, `=== "writer"` finds zero occurrences in the boot path

### Requirement: `POST /prs/:id/merge` performs a fast-forward merge of the PR's branch onto `main` and returns the merge commit SHA

The orchestration server SHALL expose a new endpoint `POST /prs/:id/merge`. The endpoint SHALL: (1) require `X-Keni-Role: engineer` (rejecting any other role with `403 role_not_owner`, including `qa`, `po`, and `writer`; the `user` role override path is allowed per the existing `USER_OVERRIDE_ALLOWED` constant); (2) require an `X-Keni-Agent` header (rejecting absence with `400 missing_role` consistent with the existing role-identity middleware); (3) reject a non-empty request body with `400 validation_failed` (the PR record names the source branch — the request is identifier-only); (4) read the PR record via `PRStore.read(id)`, mapping `StoreNotFoundError` to `404 store_not_found`; (5) extract the source branch and the workspace path from the PR record (the workspace path is computed via the in-process `WorkspaceProvisioner.workspacePathFor(projectId, prRecord.author)`, where `prRecord.author` is the engineer who created the PR; the `WorkspaceProvisioner` interface is imported from `@keni/runtime-workspace`, not from any role-specific package); (6) execute, in the project repo working directory `runServer.projectRepoPath`, the sequence `git fetch <workspacePath> <branch>:<branch>` followed by `git merge --ff-only <branch>` against `main`; (7) on `git merge --ff-only` exit code 0, read the merge commit SHA via `git rev-parse HEAD`, call `PRStore.updateStatus(id, prRecord.status, "merged")` (mapping `StaleStateError` to `409 stale_state`), call `ActivityLogStore.append(...)` with `event: "pr_merged"`, `agent: <calling agent id>`, `role: "engineer"`, `summary: "Merged PR <id> as <sha>"`, `refs: { pr_id: id, branch, merge_commit_sha: <sha> }`, and respond `200 { data: { merge_commit_sha: string }, project_id }`; (8) on `git merge --ff-only` exit code 1 (the workspace's branch tip is not a descendant of `main`'s tip), respond `409 { error: { code: "merge_conflict", message: "Branch is not a fast-forward of main", details: { branch, base: "main", git_stderr } }, project_id }` and SHALL NOT update the PR's status; (9) on any other git failure (missing branch, missing workspace, git binary unavailable), respond `400 { error: { code: "validation_failed", message: <message naming the failure mode>, details: { ... } }, project_id }`. The endpoint SHALL serialise concurrent merge attempts via a per-server in-process `Mutex` (single-writer on the project repo); concurrent requests SHALL queue and execute in arrival order with no observable interleaving.

`packages/server/src/routes/prs.ts` SHALL import `WorkspaceProvisioner` from `@keni/runtime-workspace` and SHALL NOT import from `@keni/runtime-engineer` or any other role-specific package.

#### Scenario: Engineer fast-forward merges a clean branch

- **WHEN** an engineer's pushed branch `ticket-0001` is one commit ahead of `main`
- **AND** `POST /prs/pr-0001/merge` is called with `X-Keni-Role: engineer` and `X-Keni-Agent: alice`
- **THEN** the response is 200
- **AND** the response body is `{ data: { merge_commit_sha: <40-char SHA> }, project_id: <uuid> }`
- **AND** the project repo's `main` HEAD now equals the engineer's `ticket-0001` tip
- **AND** the PR's status on disk is `merged`
- **AND** the activity log gained one entry with `event: "pr_merged"` whose `refs.merge_commit_sha` equals the response's value

#### Scenario: Non-fast-forward returns 409 `merge_conflict`

- **WHEN** the engineer's pushed branch and `main` have diverged (a different commit landed on `main` after the engineer branched)
- **AND** `POST /prs/pr-0001/merge` is called with `X-Keni-Role: engineer` and `X-Keni-Agent: alice`
- **THEN** the response is 409
- **AND** `error.code === "merge_conflict"`
- **AND** `error.details.branch === "ticket-0001"` and `error.details.base === "main"`
- **AND** `main`'s HEAD is unchanged (the failed `git merge --ff-only` aborted cleanly)
- **AND** the PR's status on disk is unchanged (still whatever it was before the call)
- **AND** the activity log gained zero `pr_merged` entries for this PR

#### Scenario: Non-engineer role rejected with 403 `role_not_owner`

- **WHEN** `POST /prs/pr-0001/merge` is called with `X-Keni-Role: qa` and `X-Keni-Agent: bob`
- **THEN** the response is 403
- **AND** `error.code === "role_not_owner"`
- **AND** `main`'s HEAD is unchanged
- **AND** the PR's status on disk is unchanged

#### Scenario: User override role is allowed

- **WHEN** `POST /prs/pr-0001/merge` is called with `X-Keni-Role: user`
- **AND** the branch is a fast-forward of `main`
- **THEN** the response is 200
- **AND** the activity-log `pr_merged` entry's `role` field is `"user"` (the calling role is recorded verbatim) and `agent` field is whatever the request's `X-Keni-Agent` value was, or absent if no `X-Keni-Agent` was sent

#### Scenario: Non-empty request body rejected with 400 `validation_failed`

- **WHEN** `POST /prs/pr-0001/merge` is called with a non-empty JSON body (e.g., `{ branch: "ticket-0001" }`)
- **AND** `X-Keni-Role: engineer`
- **THEN** the response is 400
- **AND** `error.code === "validation_failed"`
- **AND** `main`'s HEAD is unchanged

#### Scenario: Missing PR returns 404 `store_not_found`

- **WHEN** `POST /prs/pr-9999/merge` is called and no such PR exists
- **AND** `X-Keni-Role: engineer`
- **THEN** the response is 404
- **AND** `error.code === "store_not_found"`

#### Scenario: Concurrent merge attempts queue and execute serially

- **WHEN** two `POST /prs/:id/merge` requests for two different PRs (`pr-0001` and `pr-0002`, both fast-forward of `main` at request time) are issued concurrently
- **THEN** both responses are 200
- **AND** the second response's `merge_commit_sha` is a descendant of the first response's `merge_commit_sha` in the project repo's `main` history
- **AND** the activity log shows two `pr_merged` entries whose timestamps are non-overlapping (the second entry's `timestamp` is greater than or equal to the first entry's)

#### Scenario: `routes/prs.ts` does not import role-specific code

- **WHEN** the source of `packages/server/src/routes/prs.ts` is scanned for `from "@keni/runtime-engineer"`, `from "@keni/runtime-po"`, or `from "@keni/role-runtimes"`
- **THEN** zero occurrences are found
- **AND** the only `@keni/runtime-*` import is from `@keni/runtime-workspace`

### Requirement: The `ErrorCode` enum gains `merge_conflict` and the `EventName` union gains `pr_merged`

The `ErrorCode` enum exported from `@keni/shared/wire/errors.ts` SHALL be extended additively to include the new code `merge_conflict`. The `EventName` union exported from `@keni/shared/wire/activity.ts` SHALL be extended additively to include the new event `pr_merged`. Both additions SHALL be backward-compatible (existing consumers that pattern-match on the enum/union SHALL continue to compile; consumers that exhaustively switch over either union SHALL gain a new case to handle, and TypeScript SHALL flag missing branches at `deno task check` time). No existing code SHALL be removed or renamed.

#### Scenario: `ErrorCode` enum includes `merge_conflict`

- **WHEN** the `ErrorCode` type or constant exported from `@keni/shared` is inspected
- **THEN** the value `"merge_conflict"` is a member
- **AND** all previously-documented values (`store_not_found`, `stale_state`, `duplicate_id`, `invalid_artifact`, `status_in_patch`, `status_graph_violation`, `role_not_owner`, `missing_role`, `validation_failed`, `internal_error`) are still members

#### Scenario: `EventName` union includes `pr_merged`

- **WHEN** the `EventName` type or constant exported from `@keni/shared` is inspected
- **THEN** the value `"pr_merged"` is a member
- **AND** all previously-documented event names (including `session_start`, `session_end`, `subprocess_stdout`, `subprocess_stderr`, `idle`, `subprocess_output_truncated`, `session_interrupted`, `session_timeout`) are still members

#### Scenario: Exhaustive switches over `ErrorCode` flag a missing `merge_conflict` branch

- **WHEN** a consumer writes a `switch (code)` that omits the `"merge_conflict"` case
- **THEN** `deno task check` fails with a TypeScript error naming the missing case

### Requirement: `runServer` constructs the workspace provisioner once per server lifecycle and shares it across handlers and role wires

`runServer` SHALL instantiate exactly one `GitWorkspaceProvisioner` per server invocation, *before* the polymorphic role-wiring loop. The `GitWorkspaceProvisioner` class and the `WorkspaceProvisioner` interface SHALL be imported from `@keni/runtime-workspace`. The same instance SHALL be passed into every `WireFn` invocation via `WireInput.workspaceProvisioner` (so any role's wire can call `ensureProvisioned(...)` with its own sparse pattern) and SHALL be made available to the `POST /prs/:id/merge` handler via the existing `createServer(deps, opts)` deps bag (a `workspaceProvisioner: WorkspaceProvisioner` field on `ServerDeps`). The provisioner SHALL NOT be reconstructed on hot-reload, request boundary, or any in-process boundary other than `runServer` exit. On `runServer` shutdown, the provisioner SHALL NOT be discarded — workspaces persist across server restarts per the `runtime-workspace` capability's documented lifecycle.

#### Scenario: Exactly one provisioner is constructed per `runServer` lifecycle

- **WHEN** an instrumented `GitWorkspaceProvisioner` constructor records its calls
- **AND** `runServer(["--project=<tempDir>", "--port=0"])` is invoked, runs through bootstrap, accepts one merge request, and shuts down cleanly
- **THEN** the constructor was called exactly once during that lifecycle

#### Scenario: The provisioner is sourced from `@keni/runtime-workspace`

- **WHEN** the production source of `packages/server/src/runServer.ts` is inspected for the import of `GitWorkspaceProvisioner`
- **THEN** the import specifier is `@keni/runtime-workspace`
- **AND** no `@keni/role-runtimes` or `@keni/runtime-engineer` import provides this symbol

#### Scenario: The merge handler reads `workspaceProvisioner` from `ServerDeps`

- **WHEN** `createServer({ ticketStore, prStore, activityLogStore, configStore, logSink, workspaceProvisioner }, opts)` is constructed
- **AND** the merge handler is invoked for a PR whose `author` is `"alice"`
- **THEN** the handler calls `workspaceProvisioner.workspacePathFor(opts.projectId, "alice")` to obtain the source-branch's workspace path
- **AND** the resolved path is the absolute path the engineer's pushed branch lives in

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

`createServer(deps, opts)` SHALL accept a new OPTIONAL field `staticAssetsRoot?: string` on `ServerDeps`. When the field is supplied with an absolute path that exists and contains an `index.html` file, the server SHALL mount a static-asset route group AFTER every existing REST and WS route (in both their bare and `/api`-prefixed forms) and AFTER the `/health` route (in both forms). The group SHALL: (a) serve `<staticAssetsRoot>/index.html` on `GET /`; (b) serve files under `<staticAssetsRoot>/assets/` on `GET /assets/*` with a `Cache-Control: public, max-age=31536000, immutable` header; (c) for any unmatched GET path that does NOT match a documented REST prefix in the closed allowlist `REST_PREFIXES = ["/agents", "/tickets", "/prs", "/activity", "/health", "/events", "/api"] as const`, serve `<staticAssetsRoot>/index.html` so the SPA's `react-router-dom` `BrowserRouter` can re-mount on a deep link. The `/api` entry in `REST_PREFIXES` SHALL be matched as a path-boundary prefix (`/api`, `/api/anything`, `/api/anything/with/sub/parts`) so every `/api/<x>` URL form — matched or not — is excluded from the SPA fallthrough; an unmatched `/api/<typo>` SHALL therefore return the documented 404 envelope from `app.notFound`, not the SPA's `index.html`. The fallthrough SHALL apply ONLY to `GET` requests; non-GET requests with non-allowlisted paths SHALL still return `404` (Hono's default).

The route group SHALL NOT be mounted when `staticAssetsRoot` is absent; existing test call sites that do not pass the field SHALL see the unchanged behaviour. When `staticAssetsRoot` is supplied with a path that does NOT exist or does NOT contain `index.html`, `createServer` SHALL throw a typed `Error` named `StaticAssetsRootInvalid` with a message naming the path and the missing file (so `runStart` can surface a clear exit-1 error to the user before the server begins accepting connections). Files outside `<staticAssetsRoot>` SHALL NOT be reachable (path traversal via `..` SHALL be rejected with `404`); the static handler SHALL resolve every requested path against `staticAssetsRoot` and verify the resolved path has `staticAssetsRoot` as a prefix before serving.

The closed `REST_PREFIXES` allowlist SHALL be exported from `@keni/server` so tests can assert it. Adding a new REST prefix to the orchestration server (e.g., a future `/spec` route group) is a code change to `REST_PREFIXES` by design — this prevents the SPA fallthrough from accidentally swallowing a new endpoint. The single `/api` entry covers the entire `/api/<x>` mirror surface so future REST groups added under the alias do NOT each need their own `/api/<x>` entry — only the bare prefix is added to the list, and the `/api` entry continues to cover its prefixed counterpart.

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

#### Scenario: `REST_PREFIXES` is exported and exhaustively covers the existing routes plus the `/api` alias

- **WHEN** `REST_PREFIXES` is read from `@keni/server`
- **THEN** the array equals `["/agents", "/tickets", "/prs", "/activity", "/health", "/events", "/api"]` (in this exact order — bare prefixes first in registration order, with `/api` as the final entry covering the entire prefixed-mirror surface)
- **AND** every existing route group in `createServer` corresponds to a bare prefix in the first six entries
- **AND** every `/api/<x>` URL form is excluded from the SPA fallthrough by the single `/api` entry

#### Scenario: `GET /api/<unknown>` does NOT serve index.html

- **WHEN** `createServer({...staticAssetsRoot: "<absolute>/dist", ...}, opts)` is built
- **AND** `GET /api/typo` is sent
- **THEN** the response is 404 (the documented `store_not_found` envelope)
- **AND** the response's `Content-Type` is NOT `text/html`
- **AND** the response body is NOT the bundle's `index.html` contents

### Requirement: Every REST and WS route is reachable under both `/<x>` and `/api/<x>`

The orchestration server SHALL mount each documented REST and WS route group at two equivalent base paths: the canonical bare path (`/agents`, `/tickets`, `/prs`, `/activity`, `/events`, `/health`) AND its `/api`-prefixed mirror (`/api/agents`, `/api/tickets`, `/api/prs`, `/api/activity`, `/api/events`, `/api/health`). Both URLs SHALL hit the same handler, the same store, the same event bus, the same role-allowed-method matrix, and emit the same `EventFrame` payloads. The two URLs are first-class equivalent: neither is preferred at the wire level. A request that mutates state via one URL SHALL be observable on subsequent reads against the other URL with no behavioural drift.

The alias SHALL be unconditional — it is mounted on every `createServer(...)` call regardless of whether `ServerDeps.staticAssetsRoot` is supplied. The `requestId`, `requestLog`, `roleIdentity`, and `errorBoundary` middleware SHALL run exactly once per inbound request regardless of which URL form was used (no double-counting in the request log, no double-fired `EventFrame`s on a single mutation). The `roleIdentity` middleware's `?role=` query-parameter fallback for WebSocket upgrades SHALL apply to both `/events` and `/api/events`. The `/health` carve-out from the role guard SHALL apply to both `/health` and `/api/health`.

The `REST_PREFIXES` allowlist SHALL be extended to include `/api` so the static SPA route group's GET fallthrough no longer swallows `/api/<anything>` paths into `index.html`. A `GET /api/<typo>` SHALL therefore return the documented `404 store_not_found` envelope (consistent with the existing 404 behaviour for unknown bare-prefix paths under non-allowlisted prefixes), not the SPA's `index.html` content.

The motivation is the same-origin production-mode SPA wire: the SPA's typed `apiClient` issues every REST call under `/api/...` (because the dev-mode wire goes through a Vite proxy that strips the prefix). In production-mode `keni start` (orchestration server hosts both the bundled SPA and the REST API on a single loopback port) there is no Vite proxy; the alias is what makes the SPA reach the REST surface without forcing the SPA to know which mode it is running in. The bare-prefix URLs remain the canonical wire for non-browser callers (CLI tooling, the engineer MCP server's `httpClient`, the role-runtime's `activityClient`, the README's smoke-test `curl` calls).

#### Scenario: A REST GET succeeds under both URL forms with identical envelopes

- **WHEN** `createServer({...}, opts)` is built with the bare-prefix routes mounted (every existing requirement)
- **AND** `GET /tickets` and `GET /api/tickets` are both sent with `X-Keni-Role: user`
- **THEN** both responses are 200
- **AND** both response bodies are the same `TicketListResponse` envelope (`{ data: [...], project_id }`)
- **AND** both responses carry the same documented `X-Keni-Request-Id` semantics (a per-call uuidv4, distinct across the two requests)

#### Scenario: A REST POST round-trips across URL forms (shared store)

- **WHEN** `POST /api/tickets` creates a ticket with body `{ "title": "alpha" }` and `X-Keni-Role: user`
- **AND** `GET /tickets` is then sent with `X-Keni-Role: user`
- **THEN** the listed tickets contain the just-created ticket exactly once
- **AND** the `EventFrame` bus has exactly one `ticket_created` frame for the operation (not two)

#### Scenario: A REST mutation under the prefixed URL emits exactly one `EventFrame`

- **WHEN** `POST /api/agents/alice/pause` is sent with `X-Keni-Role: user`
- **THEN** the orchestration server emits exactly one `agent.state_changed` `EventFrame` with `payload.id === "alice"` and `payload.paused === true`
- **AND** WebSocket subscribers on either `/events` or `/api/events` receive the frame exactly once

#### Scenario: WebSocket `?role=` fallback works on the prefixed URL

- **WHEN** a WebSocket upgrade request to `/api/events?role=user` is sent without an `X-Keni-Role` header
- **THEN** the upgrade succeeds (101 Switching Protocols)
- **AND** the connection's role is `user` for downstream subscribers

#### Scenario: `GET /api/health` is unauthenticated and 200

- **WHEN** `GET /api/health` is sent without `X-Keni-Role`
- **THEN** the response is 200
- **AND** the response body equals the `GET /health` envelope: `{ data: { status: "ok", project_id, uptime_ms, version }, project_id }`

#### Scenario: `GET /api/<unknown-prefix>` returns the documented 404 envelope, not `index.html`

- **WHEN** `createServer({...}, opts)` is built with `staticAssetsRoot` supplied (production-mode SPA serving)
- **AND** `GET /api/typo` is sent
- **THEN** the response status is 404
- **AND** the response body is the documented `ErrorResponse` envelope with `error.code === "store_not_found"`
- **AND** the response body is NOT `<staticAssetsRoot>/index.html`'s contents

#### Scenario: The bare-prefix wire is unchanged (existing callers)

- **WHEN** any existing caller (the engineer MCP server's `httpClient`, the role-runtime's `activityClient`, a `curl` invocation matching the README's smoke test) issues a request against a bare-prefix URL (`GET /tickets`, `POST /activity`, etc.)
- **THEN** the response is the documented envelope, the documented status code, and the documented set of emitted `EventFrame`s
- **AND** the behaviour is identical to the pre-alias behaviour (the change is wire-additive, not wire-altering)

#### Scenario: The mounting block is loop-driven (a new REST group gets the alias for free)

- **WHEN** the source of `createServer.ts` is read
- **THEN** the bare-prefix and `/api`-prefix mounts for the route groups (`/tickets`, `/prs`, `/activity`, `/agents`, `/events`) are registered via a single iteration over a `const`-named array of `[bareBasePath, subApp]` pairs
- **AND** adding a new REST route group is a one-line addition to that array, which mounts the new group at both URL forms in one step

