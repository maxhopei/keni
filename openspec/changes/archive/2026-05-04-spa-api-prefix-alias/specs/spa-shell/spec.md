## MODIFIED Requirements

### Requirement: The Vite dev server proxies `/api/*` and `/events` to a `KENI_SERVER_URL`-configured origin

The dev server's `vite.config.ts` SHALL register a `server.proxy` configuration whose entries forward `/api/*` (HTTP) and `/events` (HTTP upgrade with `ws: true`) to the origin named by the environment variable `KENI_SERVER_URL` (default `http://127.0.0.1:8000`). The proxy SHALL strip the `/api` prefix before forwarding (so the SPA calls `fetch("/api/agents")` and the orchestration server sees `GET /agents`).

In production-mode SPA serving (the default of `keni start` — the orchestration server hosts both the bundled SPA from `packages/spa/dist/` and the REST API on a single loopback port) there is NO Vite proxy and NO path rewriting between the SPA and the API: the same `apiClient` URL forms that work in dev (e.g. `fetch("/api/agents")`) SHALL work in production because the orchestration server mounts every REST and WebSocket route under both the bare path (`/agents`) AND its `/api`-prefixed mirror (`/api/agents`). The two URL forms hit the same handler with no behavioural drift; the SPA does NOT need to know which mode it is running in. This same-origin-production behaviour is specified in detail by the `orchestration-server` capability's "Every REST and WS route is reachable under both `/<x>` and `/api/<x>`" requirement.

The browser SHALL see exactly one origin during development; the orchestration server SHALL NOT be configured with CORS to support the SPA. The same single-origin invariant holds in production-mode serving (the SPA bundle and the REST API are reachable on the same loopback port).

#### Scenario: `/api/*` requests are forwarded to the orchestration server

- **WHEN** the dev server is running with `KENI_SERVER_URL=http://127.0.0.1:9000`
- **AND** the SPA issues `fetch("/api/agents", { headers: { "X-Keni-Role": "user" } })`
- **THEN** the orchestration server at `http://127.0.0.1:9000` receives a `GET /agents` request with the documented role header
- **AND** the response body is the documented `AgentListResponse` envelope

#### Scenario: `/events` upgrades through the proxy as a WebSocket

- **WHEN** the dev server is running with `KENI_SERVER_URL=http://127.0.0.1:9000`
- **AND** the SPA opens `new WebSocket("/events?role=user")` against the dev-server origin
- **THEN** the orchestration server at `http://127.0.0.1:9000` sees a `/events?role=user` upgrade request
- **AND** the upgrade succeeds and frames flow end-to-end through the proxy

#### Scenario: The default `KENI_SERVER_URL` is documented and overridable

- **WHEN** the dev server is started without `KENI_SERVER_URL` in the environment
- **THEN** the proxy targets `http://127.0.0.1:8000`
- **WHEN** the dev server is started with `KENI_SERVER_URL=http://127.0.0.1:51597` exported in the shell
- **THEN** the proxy targets `http://127.0.0.1:51597`
- **AND** the README's "Run the SPA" subsection documents both the default and the override

#### Scenario: Production-mode same-origin SPA reaches the API without a proxy

- **WHEN** `keni start <projectDir>` boots in the default production-mode SPA configuration (the orchestration server hosts the bundled SPA from `packages/spa/dist/`)
- **AND** the SPA's typed `apiClient` issues `fetch("/api/agents", { headers: { "X-Keni-Role": "user" } })` against the same origin
- **THEN** the orchestration server MATCHES the request against its `/api/agents` route mirror (per the `orchestration-server` capability's `/api/<x>` alias requirement)
- **AND** the response body is the documented `AgentListResponse` envelope (NOT the bundle's `index.html`)
- **AND** the same outcome holds for every REST URL the `apiClient` issues (`/api/tickets`, `/api/prs`, `/api/activity`, `/api/agents/<id>/{pause,resume,interrupt}`, `/api/prs/<id>/merge`, etc.)

#### Scenario: Production-mode WebSocket reaches the API without a proxy

- **WHEN** `keni start <projectDir>` boots in the default production-mode SPA configuration
- **AND** the SPA's typed `eventsClient` opens `new WebSocket("ws://<host>:<port>/api/events?role=user")` against the same origin
- **THEN** the upgrade succeeds (101) and frames flow live to the SPA
- **AND** the upgrade also succeeds against the bare URL form `ws://<host>:<port>/events?role=user` (the two forms are equivalent per the `orchestration-server` capability's WS-alias requirement)
