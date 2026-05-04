## MODIFIED Requirements

### Requirement: A typed `apiClient` is the only place the SPA issues HTTP calls to the orchestration server

The SPA SHALL expose exactly one REST-client surface, defined in `packages/spa/src/transport/apiClient.ts`. Every method's return type SHALL be a TypeScript type imported directly from `@keni/shared` (no client-side re-declaration of wire shapes). The interface SHALL include at minimum `getProjectId(): Promise<string>`, `listAgents(): Promise<AgentListResponse>`, `pauseAgent(id): Promise<AgentEnvelope>`, `resumeAgent(id): Promise<AgentEnvelope>`, `interruptAgent(id): Promise<AgentEnvelope>`, `listTickets(filter?): Promise<TicketListResponse>`, `listPrs(filter?): Promise<PRListResponse>`, and `listActivity(filter?): Promise<ActivityQueryResponse>`. The factory `createApiClient(opts)` SHALL accept `{ baseUrl?: string; role?: Role }` and SHALL default `baseUrl` to the empty string (relative URLs go through the dev-server proxy or, in production, hit the orchestration server's same-origin Hono app) and `role` to `"user"`. Every outbound request SHALL carry the `X-Keni-Role: <role>` header. Non-2xx responses SHALL be parsed as `ErrorResponse` and surfaced as a typed `KeniApiError` whose `status: number`, `code: ErrorCode`, and optional `details: Record<string, unknown>` fields are populated from the response. No file under `packages/spa/src/` other than `apiClient.ts` and its test file SHALL call `fetch` against an orchestration-server endpoint.

`interruptAgent(id)` SHALL issue `POST /agents/<id>/interrupt` with an empty body and SHALL return the resolved `AgentEnvelope` (`{ data: AgentResponse, project_id: string }`). The method SHALL surface the orchestration server's documented response codes via the standard `KeniApiError` path: `403 role_not_owner` (the SPA is misconfigured if this fires — the default role is `user`), `404 store_not_found` (unknown agent id), and any other non-2xx code per the typed `ErrorCode` union. A `200` response with `data.last_activity === null` (the "no active cycle" idempotent-success case) SHALL resolve normally — the method does not distinguish "interrupt fired" from "nothing to interrupt"; that information is carried by `data.last_activity` for callers to inspect if they wish.

#### Scenario: Every outbound call carries `X-Keni-Role: user` by default

- **WHEN** `createApiClient({})` is invoked and the resulting client's `listAgents()` is called against a mock backend
- **THEN** the request received by the backend has the header `X-Keni-Role: user`
- **AND** the request's `Accept` header is `application/json`

#### Scenario: A typed envelope is returned on success

- **WHEN** the mock backend responds `200 { data: [{ id: "alice", role: "engineer", status: "idle", last_activity: null, last_active_at: null, paused: false }], project_id: "abc-123" }` to `GET /agents`
- **THEN** the `listAgents()` promise resolves with `{ data: [...], project_id: "abc-123" }`
- **AND** the resolved value is structurally assignable to `AgentListResponse` (TypeScript-checked at compile time)

#### Scenario: A non-2xx response surfaces as `KeniApiError`

- **WHEN** the mock backend responds `403 { error: { code: "role_not_owner", message: "..." }, project_id: "abc-123" }` to `POST /agents/alice/pause`
- **THEN** the `pauseAgent("alice")` promise rejects with a `KeniApiError`
- **AND** the error's `status === 403`, `code === "role_not_owner"`, and `message` is the original error message
- **AND** the error's `code` field is narrowed to the closed `ErrorCode` union (not a free-form string)

#### Scenario: `interruptAgent` issues `POST /agents/<id>/interrupt` with an empty body

- **WHEN** `client.interruptAgent("alice")` is called against a mock backend
- **THEN** the backend received exactly one request whose method is `POST` and path is `/agents/alice/interrupt`
- **AND** the request's body is empty (zero bytes)
- **AND** the request carries `X-Keni-Role: user` and `Accept: application/json`

#### Scenario: `interruptAgent` resolves with the typed `AgentEnvelope`

- **WHEN** the mock backend responds `200 { data: { id: "alice", role: "engineer", status: "idle", last_activity: "session_interrupted", last_active_at: "2026-05-04T07:00:00Z", paused: false }, project_id: "abc-123" }` to `POST /agents/alice/interrupt`
- **THEN** the `interruptAgent("alice")` promise resolves with `{ data: { id: "alice", ..., last_activity: "session_interrupted", ... }, project_id: "abc-123" }`
- **AND** the resolved value is structurally assignable to `AgentEnvelope` (TypeScript-checked at compile time)

#### Scenario: `interruptAgent` surfaces `404 store_not_found` as `KeniApiError`

- **WHEN** the mock backend responds `404 { error: { code: "store_not_found", message: "agent not found: ghost" }, project_id: "abc-123" }` to `POST /agents/ghost/interrupt`
- **THEN** `interruptAgent("ghost")` rejects with a `KeniApiError`
- **AND** the error's `status === 404` and `code === "store_not_found"`

#### Scenario: `interruptAgent` accepts the no-active-cycle idempotent success path

- **WHEN** the mock backend responds `200 { data: { id: "alice", role: "engineer", status: "idle", last_activity: null, last_active_at: null, paused: false }, project_id: "abc-123" }` to `POST /agents/alice/interrupt`
- **THEN** the `interruptAgent("alice")` promise resolves (does not reject)
- **AND** the resolved `data.last_activity` is `null`

#### Scenario: No file outside `apiClient.ts` calls `fetch` against an orchestration endpoint

- **WHEN** the entire `packages/spa/src/` tree is scanned for `fetch(` calls whose URL begins with `/api`, `/agents`, `/tickets`, `/prs`, `/activity`, or `KENI_SERVER_URL`
- **THEN** the only matches are in `packages/spa/src/transport/apiClient.ts` and `packages/spa/src/transport/apiClient_test.ts`

### Requirement: Design tokens are CSS custom properties; component CSS is plain `.css` files; no CSS-in-JS runtime

`packages/spa/src/theme/tokens.css` SHALL define a documented set of `--keni-*` CSS custom properties for color (background, text, muted text, border, accent, status-running, status-idle, disconnected, **warning**, **danger**), spacing (`--keni-space-1` through `--keni-space-6`), and typography (`--keni-font-body`, `--keni-font-mono`). The tokens SHALL define a `:root` block for the light theme and a `@media (prefers-color-scheme: dark) :root` override for the dark theme. The SPA SHALL import `tokens.css` via `index.css`. Components SHALL consume tokens via `var(--keni-*)` references in adjacent `.css` files (e.g., `AppShell.tsx` imports `AppShell.css`). No JavaScript runtime CSS-in-JS library SHALL be used. No theme switcher SHALL be implemented in this step (`prefers-color-scheme` covers the prototype's needs).

The two new tokens introduced by this change SHALL be:

- `--keni-color-warning`: an amber / yellow hue used for the timeout terminal-event badge and the `keni-activity-row--terminal-timeout` row variant.
- `--keni-color-danger`: a red hue used for the interrupt terminal-event badge, the `keni-activity-row--terminal-interrupted` row variant, and the destructive `Interrupt` button in the confirmation dialog.

Both tokens SHALL be declared in both the `:root` light-theme block and the `@media (prefers-color-scheme: dark) :root` dark-theme block; the dark variant SHALL re-declare the value at a perceptually-similar luminance so contrast against the dark background is preserved.

#### Scenario: The token file declares both light and dark variants

- **WHEN** the file `packages/spa/src/theme/tokens.css` is read
- **THEN** the file contains a `:root { ... }` block defining at minimum `--keni-color-bg`, `--keni-color-text`, `--keni-color-text-muted`, `--keni-color-border`, `--keni-color-accent`, `--keni-color-status-running`, `--keni-color-status-idle`, `--keni-color-disconnected`, `--keni-color-warning`, `--keni-color-danger`, `--keni-space-1` through `--keni-space-6`, `--keni-font-body`, `--keni-font-mono`
- **AND** the file contains a `@media (prefers-color-scheme: dark) { :root { ... } }` block that re-declares at least every color token (including `--keni-color-warning` and `--keni-color-danger`)

#### Scenario: No CSS-in-JS runtime is bundled

- **WHEN** the package's `imports` map is read
- **THEN** no entry for `@emotion/*`, `styled-components`, `linaria`, `tailwindcss`, or any other CSS-in-JS / utility-first runtime is present
