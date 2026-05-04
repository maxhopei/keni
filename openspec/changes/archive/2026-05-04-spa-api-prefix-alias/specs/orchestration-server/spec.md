## ADDED Requirements

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

## MODIFIED Requirements

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
