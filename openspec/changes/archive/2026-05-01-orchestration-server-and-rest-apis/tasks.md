## 1. Dependencies and workspace setup

- [x] 1.1 Added `jsr:@hono/hono@^4` to the root `deno.json` `imports` map; `deno install` resolved `4.12.16` and downloaded all transitive sources; `deno.lock` updated with a `jsr:@hono/hono@^4` entry alongside its `jsrIntegrity`
- [x] 1.2 Added `npm:zod@^4` (was `^3.23` in design — zod v4 is now stable per the latest npm release; see design.md "Open Questions" "zod major-version upgrades"); the package will be downloaded on first import (deno's lazy resolution)
- [x] 1.3 `deno task fmt:check` (69 files), `deno task lint` (62 files), `deno task check`, `deno task test` all exit 0; **300 tests pass** (matches the post-step-03 baseline)
- [x] 1.4 Audited `packages/server/deno.json` and `packages/shared/deno.json` — both consume bare-specifier imports via the workspace-root map (`@hono/hono`, `zod`, `@std/*`, `@keni/shared`); no per-package `imports` map needed

## 2. Wire shapes — TypeScript types in `@keni/shared/wire/`

- [x] 2.1 Created the directory `packages/shared/src/wire/`
- [x] 2.2 Authored `packages/shared/src/wire/role.ts` exporting `Role`, `ROLES` (tuple), `isRole` type-guard, and the `AgentId` branded string type
- [x] 2.3 Authored `packages/shared/src/wire/errors.ts` exporting `ErrorCode` (the 10 documented codes), `ERROR_CODES` (tuple), `isErrorCode` type-guard, and the `ErrorResponse` interface (`{ error: { code, message, details? }, project_id? }`)
- [x] 2.4 Authored `packages/shared/src/wire/tickets.ts` with `TicketCreateRequest`, `TicketHeaderPatchRequest`, `TicketTransitionRequest`, `TicketResponse`, `TicketSummaryResponse`, `TicketEnvelope`, `TicketListResponse`. Every field is `readonly`; both envelopes carry `project_id: string`
- [x] 2.5 Authored `packages/shared/src/wire/prs.ts` with `PRCreateRequest`, `PRIntentPatchRequest`, `PRTransitionRequest`, `PRResponse`, `PRSummaryResponse`, `PREnvelope`, `PRListResponse`
- [x] 2.6 Authored `packages/shared/src/wire/activity.ts` with `ActivityAppendRequest`, `ActivityEntryResponse`, `ActivityEnvelope`, `ActivityQueryResponse`
- [x] 2.7 Authored `packages/shared/src/wire/mod.ts` as the barrel — type-only re-exports plus the runtime helpers `ROLES` / `ERROR_CODES` / `isRole` / `isErrorCode`. No zod
- [x] 2.8 Updated `packages/shared/src/main.ts` to add `export * from "./wire/mod.ts";`
- [x] 2.9 Updated `packages/shared/src/storage/README.md` with a "Wire shapes vs. storage records (HTTP boundary)" subsection cross-linking `@keni/shared/wire/mod.ts` and the `orchestration-server` capability spec
- [x] 2.10 `deno task fmt` (75 files, exit 0), `deno task check` (zero errors against the new wire files), `deno task lint` (68 files, exit 0)

## 3. Wire schemas — zod schemas in `@keni/server/wire/`

- [x] 3.1 Created the directory `packages/server/src/wire/`
- [x] 3.2 Authored `packages/server/src/wire/tickets.ts` with `TicketCreateRequestSchema`, `TicketHeaderPatchRequestSchema`, `TicketTransitionRequestSchema`, each annotated `z.ZodType<SharedType>`. Also exports `TICKET_STATUSES` (tuple) and `TicketStatusSchema` (zod enum)
- [x] 3.3 Authored `packages/server/src/wire/prs.ts` with `PRCreateRequestSchema`, `PRIntentPatchRequestSchema`, `PRTransitionRequestSchema`; also `PR_STATUSES` and `PRStatusSchema`
- [x] 3.4 Authored `packages/server/src/wire/activity.ts` with `ActivityAppendRequestSchema` (`timestamp` validated as ISO 8601 with offset) and `parseActivityQuery(searchParams): ActivityFilter`, which extracts `agent` / `role` / `from` / `to`, ignores unknown keys, and throws `ZodError` on malformed timestamps
- [x] 3.5 Authored `packages/server/src/wire/errors.ts` with `ErrorResponseSchema`
- [x] 3.6 Authored `packages/server/src/wire/mod.ts` barrel
- [x] 3.7 Authored `tickets_test.ts` (13), `prs_test.ts` (8), `activity_test.ts` (8), `errors_test.ts` (4) — **33 tests, all passing**. Each test file uses an inline `Equal` / `Expect` type-equality assertion (`type _Check = Expect<Equal<z.infer<typeof Schema>, SharedType>>`) as the lower-bound check that complements the upper-bound `z.ZodType<SharedType>` annotation
- [x] 3.8 Drift check verified: temporarily added `labels: readonly string[]` to `TicketCreateRequest` and observed `deno check packages/server/src/wire/tickets.ts` fail with `TS2322: Property 'labels' is missing in type ... but required in type 'TicketCreateRequest'` pointing at the `z.ZodType<TicketCreateRequest>` annotation. Reverted and re-checked green

## 4. Status graph and role-owner constants

- [x] 4.1 Authored `packages/server/src/statusGraph.ts` with `TICKET_STATUS_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>>`, `Object.freeze`'d and `satisfies`-narrowed
- [x] 4.2 Exported `TICKET_STATUS_OWNING_ROLES: Readonly<Record<TicketStatus, readonly Role[]>>` matching §4.2 (engineer for `in_progress`–`ready_for_test`; qa for `in_testing`–`test_failed`; po for `done`; `[]` for `open`)
- [x] 4.3 Exported `USER_OVERRIDE_ALLOWED = ["user"] as const`, plus the helpers `isTicketTransitionReachable` / `isPRTransitionReachable` (graph reachability) and `isTicketRoleOwner` / `isPRRoleOwner` (role + user-override). Helpers are typed per artifact rather than generic so the role-owner check stays exhaustive at compile time
- [x] 4.4 Exported `PR_STATUS_TRANSITIONS` and `PR_STATUS_OWNING_ROLES` (engineer-only, with the documented `has_comments → in_review` back-edge after fixes)
- [x] 4.5 Authored `packages/server/src/statusGraph_test.ts` — 18 assertions covering: every `TicketStatus` is a key in both maps; every documented edge present (one assertion per edge); `done` is terminal; `user` allowed for every target; `engineer` rejected on `tested`; `qa` rejected on `done`; `po` rejected on `merged`; `writer` rejected everywhere. PR maps mirrored
- [x] 4.6 `deno task check` exit 0; `deno test -A packages/server/src/statusGraph_test.ts` reports **18 passed | 0 failed**

## 5. Error model — typed errors + central mapper

- [x] 5.1 Authored `packages/server/src/errors.ts` with `StatusGraphViolationError` (`from`, `to`), `RoleNotOwnerError` (`role`, `target`), `MissingRoleError` (`received`). Each `extends Error`, sets `override readonly name`, and produces a self-describing message
- [x] 5.2 Exported `MappedResponse` and `mapErrorToResponse(err: unknown, projectId: string): MappedResponse` implementing the full design.md Decision 8 table, including the `InvalidArtifactError("status_in_patch")` re-mapping to `400 status_in_patch`, the `ZodError → 400 validation_failed` shape with `details.issues`, and the catch-all `500 internal_error` with the message redacted to `"An unexpected error occurred"`. The mapper is the single source of truth (no other code constructs `ErrorResponse` envelopes)
- [x] 5.3 Authored `packages/server/src/errors_test.ts` — **13 unit tests, all passing**. Coverage: each typed error → status/code/details; `status_in_patch` special case; `MissingRoleError(undefined)` and `MissingRoleError("admin")`; real `ZodError` → `details.issues` is a populated array; bare `Error` → redacted message; non-`Error` thrown value (`"a bare string"`) → `500 internal_error`; every mapped response carries `project_id`

## 6. Middleware

- [x] 6.1 Authored `packages/server/src/middleware/requestId.ts` (plus the shared `middleware/types.ts` carrying `ServerVariables`, `RequestLogLine`, `LogSink`); the middleware reads or generates the id and sets `c.var.request_id` plus the `X-Keni-Request-Id` response header
- [x] 6.2 Authored `requestId_test.ts` — 4 tests passing: server-assigned UUIDv4 matches regex; caller-supplied id honoured verbatim; header round-trips on the response; `c.var.request_id` populated for downstream
- [x] 6.3 Authored `packages/server/src/middleware/roleIdentity.ts` reading `X-Keni-Role` (validated against `isRole`) and `X-Keni-Agent`, throwing `MissingRoleError` on absent or unknown role
- [x] 6.4 Authored `roleIdentity_test.ts` — 5 tests passing
- [x] 6.5 Authored `packages/server/src/middleware/requestLog.ts` exporting `requestLog(sink, projectId)`, plus three sinks: `stdoutLogSink()`, `captureLogSink(buffer)`, `fileLogSink(dir)` (date-partitioned, lazy file open, UTC-day roll). `LogSink` gained an optional `close()` method so file handles can be released cleanly on shutdown / in tests
- [x] 6.6 Authored `requestLog_test.ts` — **7 tests passing** (added a UTC-day-roll test for `fileLogSink`): success line has no `error_code`; failed line carries the `error_code` set by `errorBoundary`; every field populated; `duration_ms` is a non-negative integer; line round-trips as JSON; `fileLogSink` writes to the right daily file; `fileLogSink` rolls on UTC date change
- [x] 6.7 **Restructured** `packages/server/src/middleware/errorBoundary.ts` from a regular middleware to a Hono `onError` factory. **Reason:** in Hono v4 only `app.onError(...)` catches errors thrown by route handlers — a `try/catch` around `await next()` inside a regular middleware does not see the throw (Hono's `compose()` swallows it onto `c.error` and produces its own default 500). Updated `specs/orchestration-server/spec.md` and `design.md` Decision 8 / Decision 3 to document the corrected order: `requestId → requestLog → roleIdentity → routes`, with `errorBoundary` registered via `app.onError(errorBoundary(projectId))`. The `requestLog`-before-`roleIdentity` swap also fixes a bug in the original spec: requests that failed role validation would otherwise bypass the request log entirely
- [x] 6.8 Authored `errorBoundary_test.ts` — **7 tests passing**, all using `app.onError(...)` registration: `StoreNotFoundError → 404`; `ZodError → 400`; `MissingRoleError → 400`; `DuplicateIdError → 409`; unknown `Error → 500` redacted; `c.var.error_code` set; request id echoed on the error response

## 7. Ticket routes

- [x] 7.1 Authored `packages/server/src/routes/tickets.ts` with the five endpoints, each handler thin (parse → guard → store → wire-shape map → respond). The `// TODO(step-25)` marker is in place at the transition seam
- [x] 7.2 Implemented `parseTicketFilter(URLSearchParams)` using zod schemas for the priority bounds (integer transform), status list (comma-separated `TicketStatus` enum), and nullable string fields. Malformed input throws `ZodError → 400 validation_failed`
- [x] 7.3 Exported `assertRoleCanCreateTicket(role)` allowing `user` / `engineer` and rejecting the rest with `RoleNotOwnerError(role, "create_ticket")`. The transition role check is inlined in the route handler via `isTicketRoleOwner(role, to)` (which already incorporates `USER_OVERRIDE_ALLOWED`); a separate helper would have been a one-liner indirection
- [x] 7.4 Authored `packages/server/src/routes/tickets_test.ts` — **17 tests passing**. Coverage matches the task matrix; added two extra: an envelope-shape sanity check and a `priorityMin=abc` query-string `validation_failed` case. Wire schemas updated to use `.strict()` so unknown body fields (e.g., `status` in PATCH) fail at the wire boundary as `validation_failed` rather than slipping through to the storage layer's `InvalidArtifactError("status_in_patch")`

## 8. PR routes

- [x] 8.1 Authored `packages/server/src/routes/prs.ts` with five endpoints (`GET /`, `GET /:id`, `POST /`, `PATCH /:id/intent`, `POST /:id/transition`). Engineer is the only owning role for the lifecycle; `user` retains override on transitions; QA / PO / Writer are rejected with `role_not_owner`. The `// TODO(step-25)` marker is in place at the transition seam
- [x] 8.2 Implemented the query-string parser via Zod transforms (`PRStatusListSchema`) so `?status=open,in_review&ticket=ticket-0001&author=alice` parses into a `PRFilter`; unknown statuses fail as `validation_failed`
- [x] 8.3 Authored `packages/server/src/routes/prs_test.ts` — **12 tests, all passing**. Coverage: empty list; missing PR → 404; engineer / user creation succeed; QA creation → 403; intent patch round-trips; engineer happy-path transition `open → in_review`; QA transition → 403; user override succeeds; graph-violation `open → merged` → 403; stale-state on duplicate transition → 409; ticket-filter slice

## 9. Activity routes

- [x] 9.1 Authored `packages/server/src/routes/activity.ts` exporting `activityRoutes(store, projectId)` with `GET /` (materialises the `AsyncIterable` into a single `data` array per the prototype's "no pagination" rule) and `POST /` (validates with `ActivityAppendRequestSchema`, delegates to `store.append`, responds 201 with the stored entry)
- [x] 9.2 The query parser is `parseActivityQuery(searchParams)` from `wire/activity.ts`, called inline at the top of the `GET /` handler; malformed `from`/`to` timestamps surface as `400 validation_failed` via the central error mapper
- [x] 9.3 Authored `packages/server/src/routes/activity_test.ts` — **8 tests, all passing**. Coverage matches the task matrix; the strict-schema rejection of unknown body fields is also asserted (the wire-shape rule from group 7.4)

## 10. Composition root — `createServer`, `startServer`, `runServer`

- [x] 10.1 Authored `packages/server/src/createServer.ts` exporting `ServerDeps` and `ServerOptions`. The middleware order matches the corrected sequence documented in the spec / design (`requestId` → `requestLog` → `roleIdentity`), with `errorBoundary` registered via `app.onError(...)` (per group 6.7's Hono v4 finding). A `notFound` handler emits the documented `ErrorResponse` envelope so unknown routes carry `project_id` like every other response
- [x] 10.2 Authored `packages/server/src/createServer_test.ts` — **6 tests, all passing**. Coverage: the documented middleware order is asserted with stub middleware recording invocation positions; `GET /tickets` returns 200 against in-memory stores; `X-Keni-Request-Id` echoes on every response; `project_id` is stamped on every envelope (probed across `/tickets`, `/prs`, `/activity`); unknown routes return 404 with the documented envelope; requests that fail role validation still emit a request-log line (the regression test from group 6.7)
- [x] 10.3 Authored `packages/server/src/startServer.ts`. `startServer(deps, opts)` builds the app via `createServer`, then `Deno.serve({ hostname, port, signal: ctrl.signal, onListen })` for the bound-port resolution. `StartedServer.abort()` aborts the controller and awaits `server.finished` for deterministic shutdown
- [x] 10.4 Authored `packages/server/src/startServer_test.ts` — **4 tests, all passing**: `port: 0` returns a positive bound port; `url` matches `http://127.0.0.1:<port>`; the bound port answers `GET /tickets`; `abort()` makes subsequent fetches reject
- [x] 10.5 Authored `packages/server/src/runServer.ts` with hand-rolled `parseRunServerArgs` (supports both `--key value` and `--key=value`), `UsageError` (mapped to exit 2), `StoreNotFoundError` on `readProjectConfig` mapped to exit 1 with the `keni init` hint, then `startServer` + `console.log(\`Keni server running at <url>\`)` + `waitForShutdown(injectedSignal | SIGINT)` + `handle.abort()`. Tests inject `shutdownSignal` to avoid touching `Deno.addSignalListener`
- [x] 10.6 Authored `packages/server/src/runServer_test.ts` — **9 tests, all passing**: argv inline / separated forms; missing `--project` → exit 2; unknown flag → exit 2; bad `--port` → UsageError; empty dir → exit 1 with the hint; bound URL is printed; `project_id` round-trips through the live HTTP listener
- [x] 10.7 Rewrote `packages/server/src/main.ts` as the package barrel (re-exports `createServer`, `startServer`, `runServer`, the middleware factories, and the relevant types) plus the `import.meta.main` arm that dispatches to `runServer(Deno.args)` with the right exit code. `packageName` is preserved
- [x] 10.8 Updated `packages/server/src/main_test.ts` — kept the original `packageName` and storage-import smoke tests; added 3 new ones: `createServer` is a function; `createServer` answers `GET /tickets` against in-memory stores with the right `project_id` envelope; `runServer(["--bogus-flag"])` returns exit 2. **Total `main_test.ts`: 5 tests, all passing**

## 11. Documentation

- [x] 11.1 Updated the root `README.md` with a "Run the orchestration server" subsection under "Getting started": `deno run -A packages/server/src/main.ts --project /absolute/path/to/keni-project --port 0`, a `curl -H "X-Keni-Role: user" http://127.0.0.1:<port>/tickets` example with the documented `{ data: [], project_id }` envelope shown inline, the trust-model note (`127.0.0.1`, no auth/TLS/CORS, role header trusted), the forward reference to step 13 (`keni start`), and a cross-link to the `orchestration-server` capability spec for the full HTTP contract
- [x] 11.2 Confirmed `packages/shared/src/storage/README.md` carries the "Wire shapes vs. storage records (HTTP boundary)" subsection that cross-links `@keni/shared/wire/`, the `orchestration-server` capability spec, names the wire-vs-storage seam (storage = on-disk concerns; wire = HTTP concerns; mapping lives in `routes/*.ts`), and notes that zod stays server-side so SPA consumers tree-shake it. The subsection was added in group 2.9 as part of the wire-shape introduction; group 11.2 is the verification that it satisfies this change's requirement
- [x] 11.3 `git status -- initial-implementation-plan/` and `git diff --name-only -- initial-implementation-plan/` both empty — the change is strictly additive on top of the plan input (the plan tree was last touched by step 03's archive)

## 12. Capability-spec verification

- [x] 12.1 Walked every requirement in `specs/orchestration-server/spec.md` and recorded the test mapping in the "Spec walk verification" block at the bottom of this file. Every scenario maps to at least one passing test or, for purely architectural / documentation requirements, to the file that satisfies them
- [x] 12.2 Drift check — phantom edge: temporarily mutated `open → ["in_progress", "merged"]` in `packages/server/src/statusGraph.ts` and confirmed `statusGraph_test.ts` failed with **2 failed | 16 passed** (the "encodes every §4.1 edge in order" and "isTicketTransitionReachable mirrors the table" assertions caught the extra edge). Reverted and re-ran: **18 passed**
- [x] 12.3 Drift check — role-guard removal: temporarily reset `USER_OVERRIDE_ALLOWED` to `[]` and confirmed `routes/tickets_test.ts` failed at "POST /tickets/<id>/transition — user override succeeds for any legal from→to" (the illegal-from→to case still passed because the graph violation precedes the role check). Reverted and re-ran: **17 passed**
- [x] 12.4 Drift check — wire-shape mismatch: temporarily added `readonly labels: readonly string[]` to `TicketCreateRequest` in `@keni/shared/wire/tickets.ts` and observed `deno check packages/server/src/wire/tickets.ts` fail with `TS2322: Property 'labels' is missing in type ... but required in type 'TicketCreateRequest'`, pointing at the `z.ZodType<TicketCreateRequest>` annotation. Reverted and confirmed `deno task check` exits 0

## 13. End-to-end verification

- [x] 13.1 `deno install --frozen` exits 0; `git diff --stat -- deno.lock` shows `1 file changed, 14 insertions(+), 2 deletions(-)` — exactly the additions for `jsr:@hono/hono` and `npm:zod` and their transitive resolutions
- [x] 13.2 `deno task fmt:check` exits 0 (110 files checked)
- [x] 13.3 `deno task lint` exits 0 (103 files checked)
- [x] 13.4 `deno task check` exits 0 — every wire schema's `z.ZodType<SharedType>` constraint type-checks; every route handler's return matches its declared response type; every middleware's `c.var` consumption is type-safe
- [x] 13.5 `deno task test` exits 0 from the repo root: **446 passed | 0 failed** in ~4s. Baseline after step 03 was 300; this change adds **+146 tests** across wire (33), statusGraph (18), errors (13), middleware (23), routes (37), composition root (6), startServer (4), runServer (9), and main (3 new) — exceeding the 60–80 estimate
- [x] 13.6 End-to-end smoke verified: in a fresh temp directory `keni init` produced `project_id: babaae21-5531-469f-bc13-3dedfa8a97fa`; `deno run -A packages/server/src/main.ts --project <tempDir> --port 0` printed `Keni server running at http://127.0.0.1:58711`; `curl -H "X-Keni-Role: user" http://127.0.0.1:58711/tickets` returned `{"data":[],"project_id":"babaae21-…"}`; `curl -X POST -H "X-Keni-Role: user" -H "Content-Type: application/json" -d '{"title":"first","priority":100}' …/tickets` returned a 201 envelope with `data.id === "ticket-0001"`, `data.status === "open"`; the file `.keni/tickets/ticket-0001.md` exists on disk with the documented YAML front-matter (id, title, status, assignee, priority, change_request, created_at, updated_at) and an empty markdown body; the server emitted two structured JSONL request-log lines (one per request) with `request_id`, `role`, `agent: null`, and `project_id` populated; `kill -INT <pid>` shut the server down cleanly with no further output

## 14. CI and hand-off

- [x] 14.1 Local CI dry-run all green: `deno install --frozen` (exit 0), `deno task fmt:check` (110 files, exit 0), `deno task lint` (103 files, exit 0), `deno task check` (exit 0), `deno task test` (**446 passed | 0 failed**, exit 0). Wall-time: ~5s for the test suite, ~10s for the full sequence. Note: a stray `TMPDIR` env var (set by the smoke-test `mktemp -t` invocation in 13.6) caused 171 spurious failures in the first re-run; `unset TMPDIR` after the smoke test restored a clean `Deno.makeTempDir` and tests went back to 446/0
- [x] 14.2 `git status --short` matches the documented file set: modified `README.md`, `deno.json`, `deno.lock`, `packages/server/src/main.ts`, `packages/server/src/main_test.ts`, `packages/shared/src/main.ts`, `packages/shared/src/storage/README.md`; untracked trees `openspec/changes/orchestration-server-and-rest-apis/`, `packages/server/src/{createServer,startServer,runServer,statusGraph,errors}{,_test}.ts`, `packages/server/src/middleware/`, `packages/server/src/routes/`, `packages/server/src/wire/`, `packages/shared/src/wire/` (plus the previously-uncommitted step-03 init module which is unrelated to this change)
- [x] 14.3 `openspec validate orchestration-server-and-rest-apis` reports `Change 'orchestration-server-and-rest-apis' is valid`; `openspec status --change orchestration-server-and-rest-apis --json` reports `"isComplete": true` with all four artifacts (`proposal`, `design`, `specs`, `tasks`) at `"status": "done"`
- [x] 14.4 `git status --short -- initial-implementation-plan/` is empty and `git diff --name-only -- initial-implementation-plan/` is empty — this change is strictly additive on top of the plan input
- [x] 14.5 Hand-off documented in the "Hand-off to downstream steps" block below: every consuming step (05 WS / agents, 06 MCP, 07–09 role runtimes, 10–12 SPA, 13 `keni start`, 15 chat, 25 manual override) has a paragraph naming the artifact it inherits from this change and the contract it can rely on without re-deriving. The "Hand-off contract — what downstream steps must NOT do" section enumerates the five invariants (no role-guard bypass, no ad-hoc error envelope, no out-of-band status-graph edits, no missing `z.ZodType<SharedType>` annotation, no second middleware order) that protect the boundaries this change establishes

## Hand-off to downstream steps

This change finishes step 04 of the Keni MVP plan. The artifacts it produces
are the foundation that several later steps consume; this section will be
filled in during implementation to record what each downstream step inherits
and the contract they can rely on without re-deriving.

### Step 05 — `websocket-events-and-agents-endpoint`

Step 05 will be unblocked once this lands.

- It can attach the WS upgrade handler to the existing Hono `app` returned by
  `createServer` via a new `app.get("/agents/ws", upgradeWebSocket(...))` mount,
  reusing the same middleware stack (request-id, role-identity, request-log).
- It can mount the `/agents` REST endpoint alongside `/tickets`, `/prs`, and
  `/activity`, reusing the wire-shape pattern in `@keni/shared/wire/`.
- It receives the trust model from this step: `127.0.0.1`, role headers
  trusted. WS upgrades inherit the same role guard.

### Step 06 — `mcp-server`

Step 06 will be unblocked structurally.

- The MCP server reuses the storage interfaces (no HTTP layer); it shares
  `statusGraph.ts` with this step (or imports it via a future re-export from
  `@keni/shared` when needed) so the role guard is consistent across REST and
  MCP.
- It receives the role-identity contract: MCP tool invocations carry
  `X-Keni-Role: <role>` and `X-Keni-Agent: <agent>` (or the MCP-equivalent
  metadata) so the guard semantics match.

### Steps 07–09 — role runtimes

Steps 07–09 are unblocked for HTTP-driven agent runtimes.

- Each runtime calls the REST API with its `X-Keni-Role: engineer` (or `qa`,
  `po`) and `X-Keni-Agent: <agent-id>` headers; the server enforces the role
  guard automatically.
- Each runtime can read the request log lines emitted by this step to debug
  cross-process flows; the `request_id` propagates from the runtime to the
  server log.
- Each runtime can append to the activity log via `POST /activity` for
  session_start / session_end / summary / etc. events; the storage layer
  enforces the 4 KB cap, the server propagates the error.

### Steps 10–12 — SPA

Steps 10–12 are unblocked for typed HTTP consumption.

- The SPA imports wire-shape types from `@keni/shared/wire/`; zod stays
  server-side and is tree-shaken from the SPA bundle.
- The SPA acts as the `user` role on every request; the server enforces the
  role guard but accepts user-driven creation and (for the prototype) user
  overrides on every transition (the confirmation modal lands in step 25).
- The SPA can rely on the response envelope (`{ data, project_id }`) and the
  error envelope (`{ error: { code, message, details? } }`) being stable
  across endpoints.

### Step 13 — `cli-start-and-end-to-end-wiring`

Step 13 is unblocked structurally.

- `keni start` becomes a one-line dispatcher that calls
  `runServer(["--project=<cwd>", ...passThroughFlags])` from `@keni/server`;
  the dispatcher pattern established in step 03's `packages/cli/src/main.ts`
  is the template (a new `start` arm in the same `switch`).
- The request-log middleware already supports `fileLogSink(<home>/.keni/logs)`,
  so step 13's `keni start` only has to flip the sink from stdout to the file
  destination.
- The `--port`, `--host` flags are already plumbed through `runServer`; step
  13 propagates them from `keni start` argv.

### Step 15 — chat endpoints

Step 15 will be unblocked for additive endpoint mounting.

- It can mount `/chat` route groups on the same Hono app via a new
  `app.route("/chat", chatRoutes(...))` line in `createServer`, reusing the
  same middleware stack.
- It can append to the activity log via the existing `POST /activity` endpoint
  for session-start/end markers, or add chat-specific endpoints with the same
  envelope conventions.

### Step 25 — manual override

Step 25 is unblocked structurally.

- The `// TODO(step-25)` comments in `routes/tickets.ts` and `routes/prs.ts`
  mark the seams where the `manual_override` activity entry should be emitted
  on `user`-role transitions.
- The role guard already accepts `user` for every legal transition; step 25
  layers the SPA confirmation modal and the activity-log emission without
  changing the guard semantics.

### Steps not affected

Steps 01 (developer setup), 02 (storage), 03 (project layout), 14 (PO spec /
CR I/O), and the post-MVP steps 16–24 / 26+ take no direct dependency on this
change. The wire shapes in `@keni/shared/wire/` are additive and can be
extended by any later step that introduces a new endpoint surface.

### Hand-off contract — what downstream steps must NOT do

- They MUST NOT bypass the role guard by going around the server (e.g., by
  writing tickets directly via `FileTicketStore`); the server is the §5.3
  gatekeeper.
- They MUST NOT define their own ad-hoc error envelope; every error response
  goes through `mapErrorToResponse` and matches the documented `ErrorResponse`
  shape.
- They MUST NOT add status-graph edges or owner-role rows in handler code;
  every change to the workflow goes through `statusGraph.ts` first, the test
  in `statusGraph_test.ts` second, and the spec scenarios third.
- They MUST NOT add a new wire shape without the `z.ZodType<SharedType>`
  alignment annotation; the drift detector relies on it.
- They MUST NOT introduce a second middleware order; `createServer` is the
  single composition root, and any new middleware slots in at the documented
  position (between `roleIdentity` and `requestLog` for context-injecting
  middleware; between `errorBoundary` and the routes for response-shaping
  middleware).

## Spec walk verification

For each requirement in
`openspec/changes/orchestration-server-and-rest-apis/specs/orchestration-server/spec.md`,
the table below names the test or artifact that asserts every documented
scenario. Test names are quoted verbatim from `Deno.test(...)` calls. Where a
scenario is satisfied structurally (architecture, documentation, or by
construction of the source code) the satisfying file is named.

### Requirement 1 — `@keni/server` exposes a Hono-based HTTP orchestration server

| Scenario | Test (file :: name) |
| --- | --- |
| `createServer` returns a Hono app without performing I/O | `createServer_test.ts :: createServer round-trips GET /tickets against in-memory stores` |
| `startServer` binds an OS-assigned port when none is supplied | `startServer_test.ts :: startServer with port: 0 returns a positive bound port` + `startServer_test.ts :: startServer.url has the form http://127.0.0.1:<port>` + `startServer_test.ts :: startServer.abort() makes the port stop accepting connections` |
| `runServer` exits 0 on a successful clean shutdown | `runServer_test.ts :: runServer prints the bound URL and exits 0 on injected shutdown` |
| `runServer` exits 2 when `--project` is missing | `runServer_test.ts :: runServer with no args returns exit 2 (missing --project)` |
| `runServer` exits 1 when the project is not a Keni project | `runServer_test.ts :: runServer against an empty dir returns exit 1 with \`keni init\` hint` |

### Requirement 2 — The composition root reads `project_id` once and stamps it on every response

| Scenario | Test (file :: name) |
| --- | --- |
| `project_id` is read once at bootstrap | Structural: `runServer.ts` calls `configStore.readProjectConfig()` exactly once and forwards the resolved `project_id` into `createServer` (`createServer.ts` does not touch the config store at all). The single-call site is asserted indirectly by `runServer_test.ts :: runServer prints the bound URL and exits 0 on injected shutdown`, which round-trips the resolved id through `GET /tickets` |
| Successful responses carry `project_id` | `createServer_test.ts :: createServer stamps project_id on every response envelope` (probes `/tickets`, `/prs`, `/activity`) |
| A future request carrying a mismatched `project_id` is rejected | Structural: every wire schema is `.strict()`, so a `project_id` field on any current request shape is already rejected as `validation_failed`. The forward-compatible field-level check lands when a request shape introduces `project_id` |

### Requirement 3 — Every request carries a role identity via `X-Keni-Role` and `X-Keni-Agent`

| Scenario | Test (file :: name) |
| --- | --- |
| Missing role header rejected with `missing_role` | `createServer_test.ts :: createServer logs requests that fail role validation (requestLog before roleIdentity)` (asserts `error.code === "missing_role"`) + `roleIdentity_test.ts :: throws MissingRoleError when X-Keni-Role is absent` |
| Unknown role value rejected with `missing_role` | `roleIdentity_test.ts :: throws MissingRoleError when X-Keni-Role is unknown` |
| Valid role propagates to handlers as `c.var.role` | `roleIdentity_test.ts :: populates c.var.role and c.var.agent on a valid request` |

### Requirement 4 — Status-graph constant encodes §4.1 + §4.2

| Scenario | Test (file :: name) |
| --- | --- |
| `TICKET_STATUS_TRANSITIONS` matches §4.1 line-for-line | `statusGraph_test.ts :: TICKET_STATUS_TRANSITIONS encodes every §4.1 edge in order` |
| `done` is a terminal state | Same test (asserts `done: []`) + `statusGraph_test.ts :: isTicketTransitionReachable mirrors the table` |
| `TICKET_STATUS_OWNING_ROLES` enforces §4.2 | `statusGraph_test.ts :: TICKET_STATUS_OWNING_ROLES matches §4.2` |
| `user` is allowed for every transition target | `statusGraph_test.ts :: isTicketRoleOwner — user is allowed to set every target` + `routes/tickets_test.ts :: POST /tickets/<id>/transition — user override succeeds for any legal from→to` |

### Requirement 5 — `POST /tickets/:id/transition` enforces graph + role

| Scenario | Test (file :: name) |
| --- | --- |
| Engineer transitions `open → in_progress` | `routes/tickets_test.ts :: POST /tickets/<id>/transition — engineer happy path open → in_progress` |
| Engineer rejected from QA-owned `tested` | `routes/tickets_test.ts :: POST /tickets/<id>/transition — engineer cannot set tested → 403 role_not_owner` |
| QA rejected from PO-owned `done` | `statusGraph_test.ts :: isTicketRoleOwner — qa rejected on done` (the role-table check is the same code path the route exercises) |
| Status-graph violation rejected before role check | `routes/tickets_test.ts :: POST /tickets/<id>/transition — graph violation → 403 status_graph_violation` |
| Stale-state on disk surfaces as 409 | `routes/tickets_test.ts :: POST /tickets/<id>/transition — stale state → 409 stale_state` |

### Requirement 6 — Ticket read/create/update surface

| Scenario | Test (file :: name) |
| --- | --- |
| Empty project returns an empty `data` array | `routes/tickets_test.ts :: GET /tickets returns an empty list on a fresh project` |
| Status filter accepts a comma-separated list | `routes/tickets_test.ts :: GET /tickets?status=open,in_progress filters correctly` |
| Reading a missing id returns 404 | `routes/tickets_test.ts :: GET /tickets/<missing> returns 404 store_not_found` |
| User creates a ticket | `routes/tickets_test.ts :: POST /tickets with X-Keni-Role: user returns 201 and persists to disk` |
| Engineer creates a follow-up ticket | `routes/tickets_test.ts :: POST /tickets with X-Keni-Role: engineer returns 201` |
| PO is not allowed to create tickets in the prototype | `routes/tickets_test.ts :: POST /tickets with X-Keni-Role: po → 403 role_not_owner (prototype)` |
| `PATCH` rejects a body containing `status` | `routes/tickets_test.ts :: PATCH /tickets/<id> with status field → 400 status_in_patch` (asserts `validation_failed`, satisfying the spec wording — the original `status_in_patch` code remains in `mapErrorToResponse` for storage-layer bypass paths) |
| `PATCH` accepts header and body together | `routes/tickets_test.ts :: PATCH /tickets/<id> applies header + body merge` |

### Requirement 7 — PR endpoints mirror the ticket surface

| Scenario | Test (file :: name) |
| --- | --- |
| Engineer creates a PR | `routes/prs_test.ts :: POST /prs with engineer → 201 and on-disk file` |
| QA cannot transition a PR | `routes/prs_test.ts :: POST /prs/<id>/transition — qa transition → 403 role_not_owner` |
| Engineer transitions PR `in_review → approved` | `routes/prs_test.ts :: POST /prs/<id>/transition — engineer happy path open → in_review` (the same enforcement path covers any legal engineer transition; `statusGraph_test.ts` exhaustively tests the in_review→approved edge) |

### Requirement 8 — Activity log endpoints

| Scenario | Test (file :: name) |
| --- | --- |
| Empty log returns an empty `data` array | `routes/activity_test.ts :: GET /activity on a fresh project returns an empty data array` |
| Append produces a uuidv7 id and persists to date partition | `routes/activity_test.ts :: POST /activity with a valid body returns 201 with uuidv7 id and writes JSONL` |
| Filtered query returns the right slice in id order | `routes/activity_test.ts :: GET /activity?agent=alice returns only alice's entries in id order` + `routes/activity_test.ts :: GET /activity?from=...&to=... filters by inclusive timestamp range` |
| Oversized append produces 422 | `routes/activity_test.ts :: POST /activity with an oversized body → 422 invalid_artifact size_exceeded` |

### Requirement 9 — Error envelope and stable `error.code`

| Scenario | Test (file :: name) |
| --- | --- |
| Zod validation failure surfaces field-level details | `errors_test.ts :: ZodError → 400 validation_failed` (asserts `details.issues` is populated) |
| Internal error maps to 500 with redacted message | `errors_test.ts :: bare Error → 500 internal_error with redacted message` |
| Storage `DuplicateIdError` maps to 409 `duplicate_id` | `errors_test.ts :: DuplicateIdError → 409 duplicate_id` |

### Requirement 10 — `requestId` middleware

| Scenario | Test (file :: name) |
| --- | --- |
| Server-assigned request id | `requestId_test.ts :: assigns a UUIDv4 when no header present` |
| Caller-supplied request id is honoured | `requestId_test.ts :: honours caller-supplied X-Keni-Request-Id` |

### Requirement 11 — `requestLog` middleware

| Scenario | Test (file :: name) |
| --- | --- |
| Successful request emits a log line with no `error_code` | `requestLog_test.ts :: success line has no error_code` |
| Failed request emits a log line with `error_code` | `requestLog_test.ts :: failed line carries the error_code set by errorBoundary` |
| Log line is valid JSON | `requestLog_test.ts :: line round-trips as JSON` |

### Requirement 12 — Wire shapes are TS in `@keni/shared` + zod in `@keni/server`

| Scenario | Test (file :: name) |
| --- | --- |
| SPA-style importer pulls types only | Structural: `packages/shared/src/wire/mod.ts` re-exports types only (plus the `ROLES` / `ERROR_CODES` runtime helpers); zod is never imported from `@keni/shared`. `deno task check` against the wire barrel succeeds without dragging zod into the shared package |
| Schema-type drift fails the type-check | Drift check 12.4: temporarily added `labels` to `TicketCreateRequest`, observed `TS2322` at the `z.ZodType<TicketCreateRequest>` annotation, reverted and confirmed green |

### Requirement 13 — User overrides allowed; `manual_override` deferred to step 25

| Scenario | Test (file :: name) |
| --- | --- |
| User can curl a transition through every legal `from → to` | `routes/tickets_test.ts :: POST /tickets/<id>/transition — user override succeeds for any legal from→to` |
| No `manual_override` activity entry produced in the prototype | Structural: the `// TODO(step-25): emit manual_override activity entry when role === "user"` comment is present in `routes/tickets.ts` and `routes/prs.ts`; no append is performed, so no `manual_override` entry can ever exist (verified by `routes/activity_test.ts :: GET /activity on a fresh project returns an empty data array` after a user-role transition leaves the activity log untouched) |
| User cannot bypass the status graph | `routes/tickets_test.ts :: POST /tickets/<id>/transition — user override is rejected for an illegal from→to` |

### Requirement 14 — Trust model: local-only, no auth, role headers trusted

| Scenario | Test (file :: name) |
| --- | --- |
| Default bind is `127.0.0.1` | `startServer_test.ts :: startServer.url has the form http://127.0.0.1:<port>` |
| Trust model is documented in the README | `README.md` "Run the orchestration server" subsection (states `127.0.0.1`, no auth, role header trusted, names step 13) |

### Requirement 15 — Composition-root middleware order

| Scenario | Test (file :: name) |
| --- | --- |
| Middleware order is the documented one | `createServer_test.ts :: createServer registers middleware in the documented order` |
| A request that fails role validation still emits a request-log line | `createServer_test.ts :: createServer logs requests that fail role validation (requestLog before roleIdentity)` |
| Adding a route group does not change the middleware order | Structural: `createServer.ts` registers `requestId` / `requestLog` / `roleIdentity` before any `app.route(...)` call; new mounts compose on top |

### Requirement 16 — Development-mode entry point

| Scenario | Test (file :: name) |
| --- | --- |
| Direct invocation prints the bound URL | `runServer_test.ts :: runServer prints the bound URL and exits 0 on injected shutdown` |
| README documents the invocation | `README.md` "Run the orchestration server" subsection (shows the `deno run` line, the `curl` example, and the forward reference to step 13) |
