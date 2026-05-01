# orchestration-server Specification

## Purpose

Defines the contract for `@keni/server` — the local HTTP orchestration server that is the single gatekeeper for every legitimate write to a Keni project's `.keni/` tree (per `spec.md` §5.3) and the structural communication bus between the SPA, role runtimes, MCP layer, and the user. The capability cements `spec.md` §2#1 ("environment as communication bus"), §2#3 ("status drives behaviour"), §4.1 (ticket lifecycle), §4.2 (owning-role rule), §5.1 (project artifacts), §7.1 ("one server, one project"), and §11#5 ("files first, storage abstracted") by requiring a single Hono app that mounts a documented REST surface (`/tickets`, `/prs`, `/activity`), enforces the status graph and the owning-role rule on every transition, exposes a stable error envelope (`ErrorResponse`) with a closed `ErrorCode` enum, emits structured per-request JSONL log lines, separates wire shapes (TS types in `@keni/shared`, zod schemas in `@keni/server`) from storage records, trusts a local-only role-header identity in the prototype, and ships a development-mode `deno run` entry point that step 13's `keni start` later wraps. Any change that adds an endpoint, alters the status graph, changes the role-owner table, mutates an error code, edits the middleware order, or relaxes the trust model lands as a delta spec against this capability.

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

The server SHALL export a frozen constant `TICKET_STATUS_TRANSITIONS` whose shape is `Readonly<Record<TicketStatus, readonly TicketStatus[]>>` and whose entries SHALL match the diagram in `spec.md` §4.1 edge-for-edge: `open → [in_progress]`; `in_progress → [ready_for_review]`; `ready_for_review → [in_review]`; `in_review → [has_comments, approved]`; `has_comments → [in_progress]`; `approved → [merged]`; `merged → [ready_for_test]`; `ready_for_test → [in_testing]`; `in_testing → [tested, test_failed]`; `tested → [done]`; `test_failed → [in_progress]`; `done → []`. The server SHALL export a frozen constant `TICKET_STATUS_OWNING_ROLES` whose entries map each status to the role(s) authorised to transition into it: `engineer` for `in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, `ready_for_test`; `qa` for `in_testing`, `tested`, `test_failed`; `po` for `done`; `[]` (no role) for `open`. The server SHALL also export `USER_OVERRIDE_ALLOWED = ["user"]`: the `user` role SHALL be authorised to transition into any status (the override path), although the prototype SHALL NOT yet emit a corresponding `manual_override` activity-log entry (see the deferred-override requirement below). PRs SHALL have an analogous pair of constants (`PR_STATUS_TRANSITIONS`, `PR_STATUS_OWNING_ROLES`) covering the engineer-only PR lifecycle.

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

`createServer` SHALL register middleware in exactly this order: `requestId` first (so every other middleware can rely on `c.var.request_id`); then `requestLog` (so it observes every request — including those that fail because of a missing or invalid role); then `roleIdentity` (so route handlers see `c.var.role` and `c.var.agent`); then the route groups (`/tickets`, `/prs`, `/activity`). The `errorBoundary` SHALL be installed via `app.onError(errorBoundary(projectId))` rather than as a regular middleware, because in Hono v4 only the `onError` hook catches handler-thrown errors (a `try/catch` around `await next()` inside a regular middleware does not). Logically the error handler is still the "fourth link" in the chain — it always runs after the routes, before the response is returned. A test in `createServer_test.ts` SHALL assert the middleware order by stubbing each middleware to record its position in a shared array and verifying the array against the documented order; a separate test SHALL assert that a thrown error is mapped via the registered `onError` handler.

#### Scenario: Middleware order is the documented one

- **WHEN** `createServer` is built with stubbed middleware that record their invocation order
- **AND** any request is sent
- **THEN** the recorded order is `["requestId", "requestLog", "roleIdentity"]`
- **AND** `errorBoundary` is registered via `app.onError(...)` and translates any thrown error into the documented `ErrorResponse` envelope

#### Scenario: A request that fails role validation still emits a request-log line

- **WHEN** a request without `X-Keni-Role` is dispatched
- **THEN** `requestLog` records the line (because it ran before `roleIdentity`)
- **AND** the line carries `error_code: "missing_role"` (set by `errorBoundary` in the `onError` handler)
- **AND** the response is `400 missing_role`

#### Scenario: Adding a route group does not change the middleware order

- **WHEN** an additional Hono route group is mounted in `createServer` (e.g., for a future endpoint)
- **THEN** the three core middlewares still execute first, in the documented order
- **AND** the new route group sees `c.var.request_id`, `c.var.role`, `c.var.agent` populated

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
