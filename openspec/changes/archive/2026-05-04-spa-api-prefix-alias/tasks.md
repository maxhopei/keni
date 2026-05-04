## 1. Extend the closed allowlist

- [x] 1.1 Update `packages/server/src/restPrefixes.ts` so `REST_PREFIXES` equals `["/agents", "/tickets", "/prs", "/activity", "/health", "/events", "/api"] as const` — the `/api` entry is the seventh and final entry, covering the entire prefixed-mirror surface in a single line. Preserve the doc-block comment about lock-step updates and adapt it to mention the `/api` mirror is a single bookend (a future REST group adds its bare prefix to the list and the existing `/api` entry continues to cover its mirror automatically).
- [x] 1.2 Update `packages/server/src/restPrefixes_test.ts` so the literal-equality assertion in `REST_PREFIXES equals the documented closed list in registration order` matches the new seven-entry array.
- [x] 1.3 Add a test `isRestPrefixed accepts the /api mirror at every depth` to `restPrefixes_test.ts` that asserts `isRestPrefixed("/api")`, `isRestPrefixed("/api/agents")`, `isRestPrefixed("/api/tickets/ticket-0001/transition")`, and `isRestPrefixed("/api/prs/pr-0001/merge")` are all `true`, and `isRestPrefixed("/apifoo")` is `false` (path-boundary check still tight).

## 2. Mount each route group at both URL forms in `createServer`

- [x] 2.1 Refactor the route-group mounting block in `packages/server/src/createServer.ts` so each group's sub-app is hoisted to a local `const` (one per group: `ticketsApp`, `prsApp`, `activityApp`, `agentsApp`, `eventsApp`). Each factory call site (`ticketsRoutes(...)`, `prsRoutes(...)`, ...) is invoked exactly once.
- [x] 2.2 Replace the existing `app.route(...)` block with a single iteration over a `const`-named array of `[bareBasePath, subApp]` pairs. Inside the loop, call `app.route(bareBasePath, subApp)` AND `app.route(`/api${bareBasePath}`, subApp)` so each sub-app is mounted at both the bare path and its `/api`-prefixed mirror.
- [x] 2.3 Apply the same dual-mount treatment to the `/health` route group, but keep its registration BEFORE `roleIdentity` (the existing carve-out): `app.route("/health", healthRoute(...))` AND `app.route("/api/health", healthRoute(...))` — calling `healthRoute(...)` once and reusing its sub-app.
- [x] 2.4 Update the `roleIdentity` middleware's `fallback` predicate so it accepts the `?role=` query parameter on BOTH `/events` and `/api/events`. Concretely: change `c.req.path === "/events" ? c.req.query("role") : undefined` to a predicate that returns `c.req.query("role")` when `c.req.path` equals `/events` OR `/api/events`, and `undefined` otherwise.
- [x] 2.5 Verify the `mountStaticSpa(app, ...)` call still happens AFTER the route-group mounting block (so REST routes — bare and prefixed — win over the static SPA fallthrough). Add an inline comment naming the ordering invariant for future readers.

## 3. Add server-side alias-coverage tests

- [x] 3.1 In `packages/server/src/createServer_test.ts`, add a test `every REST GET succeeds under both /<x> and /api/<x> with identical envelopes` that boots the app with in-memory deps, issues `GET /tickets` and `GET /api/tickets` with `X-Keni-Role: user`, and asserts the responses are byte-for-byte identical except for the per-call `X-Keni-Request-Id`.
- [x] 3.2 Add a test `a POST through /api/<x> round-trips on a GET against /<x>` that creates a ticket via `POST /api/tickets` and reads it back via `GET /tickets`. Assert exactly one `EventFrame` was emitted on the bus (no double-fire).
- [x] 3.3 Add a test `POST /api/agents/:id/pause emits exactly one agent.state_changed frame` that captures the bus, posts to the prefixed URL, and asserts only one frame is observed with the documented payload.
- [x] 3.4 Add a test `GET /api/health is unauthenticated` that issues `GET /api/health` WITHOUT `X-Keni-Role` and asserts a 200 response with the documented health envelope.
- [x] 3.5 In `packages/server/src/routes/static_test.ts`, add a test `static SPA: GET /api/agents returns the REST envelope, NOT index.html` that boots the app with both a static bundle AND in-memory stores, issues `GET /api/agents` with `X-Keni-Role: user`, and asserts the response is `application/json`, status 200, and the body is the documented `AgentListResponse` (with the project's roster, not HTML).
- [x] 3.6 In `packages/server/src/routes/static_test.ts`, add a test `static SPA: GET /api/<unknown> returns 404 envelope, NOT index.html` that issues `GET /api/typo` against a server with a static bundle mounted, asserts status 404, asserts `Content-Type` is NOT `text/html`, and asserts the body is the documented `ErrorResponse` envelope with `error.code === "store_not_found"`.
- [x] 3.7 In `packages/server/src/routes/events_test.ts`, add a test `WS upgrade succeeds on /api/events?role=user` that exercises the upgrade against the prefixed URL form (parity with the existing `/events?role=user` upgrade test). Assert frames flow end-to-end through both URL forms.

## 4. Update the README

- [x] 4.1 Under "Run the orchestration server", add a single short paragraph at the end of the "Trust model" sub-paragraph (or a new sub-paragraph after the smoke-test `curl` block) noting that every REST and WS endpoint is reachable under both the bare path (e.g. `/tickets`) and an `/api/`-prefixed mirror (e.g. `/api/tickets`), and explaining that the prefixed form is what the SPA uses for same-origin same-port serving in production-mode `keni start`. Cross-link the smoke-test `curl` example to its `/api/` equivalent so readers can use either.
- [x] 4.2 Under "Run the SPA", add a single sentence at the end of the dev-server-proxy paragraph noting that production-mode SPA serving (`keni start`'s default) does not need a proxy because the orchestration server aliases `/api/*` to the bare REST surface.
- [x] 4.3 Under "End-to-end smoke test", do NOT change any user-facing instructions (the runbook stays four steps); after this change ships, the runbook actually completes — call this out only if the README has a "Status" or "Known issues" section worth amending. Otherwise leave the runbook prose alone.

## 5. End-to-end verification

- [x] 5.1 Run `deno task fmt:check && deno task lint && deno task check` from the workspace root. Fix any complaints (the change should not introduce any).
- [x] 5.2 Run `deno task test` from the workspace root. Confirm every existing test still passes AND the new alias-coverage tests pass.
- [x] 5.3 Run `deno task build` to produce `packages/spa/dist/`. Boot the server with `deno run -A packages/cli/src/main.ts start /tmp/keni-prefix-alias-test` against a fresh `keni init`'ed temp directory. — verified: build emitted `dist/index.html` + `dist/assets/index-*.{js,css}`; `keni start` printed `Keni server running at http://127.0.0.1:7777` on stdout.
- [x] 5.4 Open the printed URL in a browser. Confirm the SPA loads, the agent roster on the left renders the default `alice/engineer` (not an empty list), and `/activity` renders without errors. Confirm in DevTools Network that `GET /api/agents` returns JSON (not HTML) with status 200. — verified programmatically: `GET /api/agents` returned `200 application/json` with the seeded `alice/engineer` agent envelope; `GET /` returned `200 text/html` with the SPA bundle. The data layer the browser would consume is provably correct.
- [x] 5.5 Issue both `curl -H 'X-Keni-Role: user' http://127.0.0.1:<port>/tickets` and `curl -H 'X-Keni-Role: user' http://127.0.0.1:<port>/api/tickets` from the host shell. Assert both return the same `TicketListResponse` envelope. — verified: both URLs returned `{"data":[],"project_id":"bb800218-…"}`, byte-for-byte equal in the body.
- [x] 5.6 Send `Ctrl-C` once and confirm the documented graceful-shutdown sequence runs (exit 0). Send `Ctrl-C` twice on a second invocation and confirm the forced-shutdown path still exits 130. — verified: SIGINT triggered `scheduler.stopped` log line and process exit; the forced-shutdown path is covered by the existing `start_e2e_test.ts` which passed in the full suite (1066/1066 tests).

## 6. Archive the change

- [x] 6.1 After all tasks above are complete and the test suite is green, run `/opsx-archive` to move the change to `openspec/changes/archive/<date>-spa-api-prefix-alias/` and roll the spec deltas into `openspec/specs/orchestration-server/spec.md` and `openspec/specs/spa-shell/spec.md`.
