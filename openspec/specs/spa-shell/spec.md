# spa-shell Specification

## Purpose

Defines the contract for `@keni/spa` — the browser dashboard a Keni user opens after `keni start`. Pins the framework choice (React 18 + Vite 5 via [`@deno/vite-plugin`](https://jsr.io/@deno/vite-plugin)), the Deno-workspace task surface (`dev`, `build`, `preview`, `test`), the dev-server's `KENI_SERVER_URL`-driven proxy that lets the browser see one origin while the orchestration server runs separately, the typed REST client (`apiClient`) and the reconnecting WebSocket client (`eventsClient`) that are the only allowed places `fetch` and `new WebSocket(...)` are called inside the SPA, the three-region CSS-grid application shell that satisfies `spec.md` §7.2 (left = roster, centre = `<Outlet />` / board placeholder, right = chat slot hidden by a documented prototype flag), the `react-router-dom` v6 routing scaffold registering the four documented routes plus a catch-all, the connection-indicator UX in the top nav, the design-token convention via CSS custom properties, and the React component-test harness (`@testing-library/react` over `happy-dom`). Together with the `spa-agent-roster` capability, this spec is the contract that downstream SPA steps (board, drill-downs, interrupt UX, chat panel, spec viewer, CR list) plug into without re-deciding any of the framework, transport, layout, or testing choices.

## Requirements

### Requirement: `@keni/spa` is a Vite + React 18 application built and served via `@deno/vite-plugin`

`packages/spa/` SHALL be a runnable Vite + React application. The framework SHALL be React 18 (`npm:react@^18`, `npm:react-dom@^18`) with the React Fast Refresh / JSX-runtime plugin (`npm:@vitejs/plugin-react@^4`) registered against Vite 5 (`npm:vite@^5`). The Deno-aware bundler integration SHALL be `jsr:@deno/vite-plugin@^1`. All four dependencies SHALL be declared in `packages/spa/deno.json`'s `imports` map and SHALL NOT be added to the workspace-root `deno.json` `imports` map (no other package consumes them). The SPA's React entry point SHALL live at `packages/spa/src/main.tsx` and SHALL call `createRoot(document.getElementById("root")!).render(<App />)` against an `index.html` at the package root that mounts `<div id="root">`. A `vite.config.ts` at the package root SHALL register `@deno/vite-plugin()` and `react()` and SHALL set `build.outDir: "dist/"`.

#### Scenario: `packages/spa/deno.json` declares the framework imports SPA-locally

- **WHEN** the file `packages/spa/deno.json` is read
- **THEN** the `imports` map contains entries for `react` (`npm:react@^18`), `react-dom` (`npm:react-dom@^18`), `react-dom/client` (`npm:react-dom@^18/client`), `vite` (`npm:vite@^5`), `@vitejs/plugin-react` (`npm:@vitejs/plugin-react@^4`), and `@deno/vite-plugin` (`jsr:@deno/vite-plugin@^1`)
- **AND** the workspace-root `deno.json`'s `imports` map contains none of those entries

#### Scenario: The React root mounts onto `index.html`'s `#root`

- **WHEN** the developer opens the dev server in a browser
- **THEN** `packages/spa/index.html` is the served document
- **AND** it contains exactly one `<div id="root"></div>` element
- **AND** `packages/spa/src/main.tsx` calls `createRoot(document.getElementById("root")!).render(<App />)` exactly once
- **AND** the rendered `<App />` is the routed application defined by Decision 6 of `design.md`

#### Scenario: The Vite config registers both plugins

- **WHEN** `packages/spa/vite.config.ts` is read
- **THEN** the `defineConfig`-returned object's `plugins` array contains the result of calling `deno()` (from `@deno/vite-plugin`) and `react()` (from `@vitejs/plugin-react`)
- **AND** `build.outDir` is `"dist/"` (relative to the package root)

### Requirement: The SPA package exposes `dev`, `build`, `preview`, and `test` Deno tasks

`packages/spa/deno.json`'s `tasks` block SHALL define four entries: `dev` (runs the Vite dev server), `build` (runs `vite build` against the package's `vite.config.ts` and writes a static bundle to `dist/`), `preview` (runs `vite preview` against `dist/`), and `test` (runs `deno test -A` over the package). Each `vite`-shaped task SHALL invoke Vite via Deno's `npm:vite` specifier with `--node-modules-dir` so Vite's plugins resolve transitive npm deps against a materialised `node_modules/` cache. The workspace-level `deno task build` SHALL fan out to every `@keni/*` member's `build` task per the existing `developer-setup` capability; `@keni/spa`'s `build` task SHALL no longer be `echo noop`.

#### Scenario: The four documented tasks exist with the documented commands

- **WHEN** the file `packages/spa/deno.json` is read
- **THEN** `tasks.dev`, `tasks.build`, `tasks.preview`, and `tasks.test` are all defined
- **AND** `tasks.dev`, `tasks.build`, and `tasks.preview` invoke Vite via `deno run -A --node-modules-dir npm:vite[ build|  preview]`
- **AND** `tasks.test` is `deno test -A`

#### Scenario: `deno task build` produces a real `dist/` output

- **WHEN** a contributor runs `deno task build` from `packages/spa/`
- **THEN** the command exits with status 0
- **AND** `packages/spa/dist/` exists and contains an `index.html` and at least one bundled `.js` chunk
- **AND** the bundle is consumable by step 13's `keni start` static file server (no developer-side post-processing required)

#### Scenario: Workspace-level `deno task build` covers the SPA

- **WHEN** a contributor runs `deno task build` from the repository root
- **THEN** the SPA's `build` task is invoked exactly once
- **AND** the workspace-aggregate exit status is 0 only when the SPA's build succeeds (a Vite failure causes the aggregate `deno task build` to exit non-zero)

### Requirement: The Vite dev server proxies `/api/*` and `/events` to a `KENI_SERVER_URL`-configured origin

The dev server's `vite.config.ts` SHALL register a `server.proxy` configuration whose entries forward `/api/*` (HTTP) and `/events` (HTTP upgrade with `ws: true`) to the origin named by the environment variable `KENI_SERVER_URL` (default `http://127.0.0.1:8000`). The proxy SHALL strip the `/api` prefix before forwarding (so the SPA calls `fetch("/api/agents")` and the orchestration server sees `GET /agents`). Production behaviour is out of scope for this requirement — step 13's `keni start` will serve the static bundle from the same Hono process that mounts the API, so production is same-origin and no proxy is involved. The browser SHALL see exactly one origin during development; the orchestration server SHALL NOT be configured with CORS to support the SPA.

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

### Requirement: A typed `apiClient` is the only place the SPA issues HTTP calls to the orchestration server

The SPA SHALL expose exactly one REST-client surface, defined in `packages/spa/src/transport/apiClient.ts`. Every method's return type SHALL be a TypeScript type imported directly from `@keni/shared` (no client-side re-declaration of wire shapes). The interface SHALL include at minimum `getProjectId(): Promise<string>`, `listAgents(): Promise<AgentListResponse>`, `pauseAgent(id): Promise<AgentEnvelope>`, `resumeAgent(id): Promise<AgentEnvelope>`, `listTickets(filter?): Promise<TicketListResponse>`, `listPrs(filter?): Promise<PRListResponse>`, and `listActivity(filter?): Promise<ActivityQueryResponse>`. The factory `createApiClient(opts)` SHALL accept `{ baseUrl?: string; role?: Role }` and SHALL default `baseUrl` to the empty string (relative URLs go through the dev-server proxy or, in production, hit the orchestration server's same-origin Hono app) and `role` to `"user"`. Every outbound request SHALL carry the `X-Keni-Role: <role>` header. Non-2xx responses SHALL be parsed as `ErrorResponse` and surfaced as a typed `KeniApiError` whose `status: number`, `code: ErrorCode`, and optional `details: Record<string, unknown>` fields are populated from the response. No file under `packages/spa/src/` other than `apiClient.ts` and its test file SHALL call `fetch` against an orchestration-server endpoint.

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

#### Scenario: No file outside `apiClient.ts` calls `fetch` against an orchestration endpoint

- **WHEN** the entire `packages/spa/src/` tree is scanned for `fetch(` calls whose URL begins with `/api`, `/agents`, `/tickets`, `/prs`, `/activity`, or `KENI_SERVER_URL`
- **THEN** the only matches are in `packages/spa/src/transport/apiClient.ts` and `packages/spa/src/transport/apiClient_test.ts`

### Requirement: A reconnecting `eventsClient` is the only place the SPA opens a WebSocket to the orchestration server

The SPA SHALL expose exactly one WebSocket-client surface, defined in `packages/spa/src/transport/eventsClient.ts`. The interface SHALL expose `subscribe(handler: (frame: EventFrame) => void): () => void`, `onLifecycle(handler: (state: EventsClientLifecycle) => void): () => void`, `state(): EventsClientLifecycle`, and `close(): void`, where `EventsClientLifecycle` is the type union `"connecting" | "live" | "disconnected"`. The factory `createEventsClient(opts)` SHALL accept `{ url?: string; backoff?: { initialMs?: number; maxMs?: number; jitter?: number } }`. The default URL SHALL be `(location.origin replace http→ws) + "/events?role=user"`. The default backoff SHALL be `{ initialMs: 500, maxMs: 30_000, jitter: 0.3 }`. The client SHALL: (1) open a WebSocket to the configured URL on construction; (2) emit `state: "connecting"` on the lifecycle channel before the open completes; (3) emit `state: "live"` on `WebSocket.open`; (4) on `WebSocket.message`, parse `event.data` as JSON and dispatch the resulting `EventFrame` to every subscriber registered via `subscribe(...)`; (5) on `WebSocket.close` or `WebSocket.error`, emit `state: "disconnected"`, schedule a reconnect using exponential backoff with jitter (next-attempt delay `= min(initialMs * 2^attempts, maxMs) * (1 ± jitter)`), and re-open; (6) on every successful re-open, emit `state: "live"` again so consumers can refetch canonical state via REST. A subscriber whose handler throws SHALL have the exception caught and logged to `console.warn`; the WebSocket connection SHALL NOT be closed by a subscriber error. `close()` SHALL stop reconnecting and emit a final `state: "disconnected"`. No file under `packages/spa/src/` other than `eventsClient.ts` and its test file SHALL call `new WebSocket(...)`.

#### Scenario: Initial connect emits `connecting` then `live`

- **WHEN** `createEventsClient({ url: "ws://test/events?role=user" })` is invoked against a mock WS server that accepts the open
- **AND** the consumer registers `onLifecycle(handler)` synchronously after construction
- **THEN** the handler observes `"connecting"` then `"live"` in that order

#### Scenario: A frame from the server is dispatched to every subscriber

- **WHEN** two subscribers are registered against a connected client
- **AND** the mock WS server sends one JSON frame whose body matches an `EventFrame` shape (e.g., `agent.state_changed`)
- **THEN** both subscribers' handlers are called with the same frame object
- **AND** the handler's argument is structurally assignable to `EventFrame` (TypeScript-checked)

#### Scenario: Reconnect on close uses exponential backoff with jitter

- **WHEN** the client is created with `{ backoff: { initialMs: 100, maxMs: 1_000, jitter: 0 } }` against a fake clock and a mock server that closes after the first frame
- **AND** the close fires
- **THEN** the next reconnect attempt is scheduled `100 ms` later, then `200`, `400`, `800`, `1000`, `1000`, ... (capped at `maxMs`)
- **AND** every transition through `"connecting" → "live"` re-emits the lifecycle event

#### Scenario: A throwing subscriber does not break the connection

- **WHEN** a subscriber registers a handler that throws on every frame
- **AND** a second subscriber registers after it
- **AND** the mock server sends one frame
- **THEN** the second subscriber's handler is called with the frame
- **AND** the WebSocket connection remains open
- **AND** `console.warn` was called once with a message naming the subscriber failure

#### Scenario: `close()` stops reconnecting

- **WHEN** the client is `live`
- **AND** the consumer calls `close()`
- **AND** the mock server is then bounced
- **THEN** the lifecycle reports `"disconnected"` once
- **AND** no subsequent reconnect attempt is scheduled (the fake clock advancing past `maxMs` produces no new `WebSocket` constructor calls)

#### Scenario: No file outside `eventsClient.ts` constructs a WebSocket

- **WHEN** the entire `packages/spa/src/` tree is scanned for `new WebSocket(`
- **THEN** the only matches are in `packages/spa/src/transport/eventsClient.ts` and `packages/spa/src/transport/eventsClient_test.ts`

### Requirement: The application shell at `packages/spa/src/shell/AppShell.tsx` is a three-region CSS-grid layout matching `spec.md` §7.2

`AppShell.tsx` SHALL render a CSS-grid layout with the documented `grid-template-areas`: `"nav nav" / "roster main"` (chat hidden, the prototype default) or `"nav nav nav" / "roster main chat"` (chat visible, post-step-23). The header region (`nav`) SHALL render the `<TopNav />` component. The roster region SHALL mount `<AgentRosterPanel />` (per the `spa-agent-roster` capability). The main region SHALL render React Router's `<Outlet />` so the active route's element renders inside the shell. The chat region SHALL render conditionally on a single boolean read from `packages/spa/src/prototypeFlags.ts`'s `chatPanelEnabled` constant (default `false`); when `false`, the chat region SHALL NOT be in the rendered DOM (not merely `display: none` — the grid layout must reflect the visible columns). The shell SHALL collapse to a single column under `max-width: 720px` (the roster moves to a future hamburger; out of scope here). The roster column SHALL be `280px` wide; the chat column SHALL be `360px` wide; both widths SHALL be hard-coded for the prototype. The `dist/` bundle SHALL render a usable layout without any browser-side JS configuration step.

#### Scenario: The three regions render in the documented grid order

- **WHEN** `<AppShell />` is rendered into a `happy-dom` document with `chatPanelEnabled = false`
- **THEN** the rendered tree contains exactly one `<header>` (the top nav), one `<aside>` (the agent-roster panel), one `<main>` (the React Router `<Outlet />` host)
- **AND** no second `<aside>` (the chat region) is in the DOM
- **AND** the rendered grid container has `data-chat-visible="false"`

#### Scenario: Flipping `chatPanelEnabled` to `true` adds the chat region

- **WHEN** `chatPanelEnabled` is `true` and `<AppShell />` is re-rendered
- **THEN** the rendered tree contains a second `<aside>` for the chat slot
- **AND** the rendered grid container has `data-chat-visible="true"`

#### Scenario: The roster slot mounts `AgentRosterPanel`

- **WHEN** `<AppShell />` is rendered against an in-memory `apiClient` and `eventsClient`
- **THEN** the rendered tree contains the agent-roster panel's documented elements (per the `spa-agent-roster` capability)

### Requirement: The top nav renders a connection indicator sourced from `eventsClient`'s lifecycle channel

`packages/spa/src/shell/TopNav.tsx` SHALL render a slim header that contains: (1) the project id as resolved by `apiClient.getProjectId()` (rendered as a small monospace string; renders an em-dash placeholder until the promise resolves); (2) a connection indicator that subscribes to `eventsClient.onLifecycle(...)` and renders one of three documented visual states — `"connecting"` (a pulsing neutral dot with the label `Connecting…`), `"live"` (a green dot with the label `Live`), `"disconnected"` (a red dot with the label `Disconnected — reconnecting…`); (3) a placeholder route switcher (a single `<nav>` element with one anchor per registered top-level route — `/`, `/activity`). The indicator SHALL re-render synchronously on every lifecycle event. The indicator SHALL NOT expose the WebSocket close code to the rendered text (debug-level only — logged to the console).

#### Scenario: The indicator reflects the lifecycle state

- **WHEN** `<TopNav />` is rendered against an in-memory `eventsClient` whose initial lifecycle is `"connecting"`
- **THEN** the rendered indicator's text is `Connecting…`
- **AND** the indicator's container has `data-state="connecting"`
- **WHEN** the in-memory client transitions to `"live"`
- **THEN** the indicator's text becomes `Live`
- **AND** the container's `data-state` becomes `"live"`

#### Scenario: The project id renders once `getProjectId` resolves

- **WHEN** `<TopNav />` is rendered against an `apiClient` whose `getProjectId()` resolves to `"abc-123"`
- **THEN** the initial render shows the placeholder `—`
- **AND** after the promise resolves, the render shows `abc-123` in a monospace span

### Requirement: The routing scaffold registers the four documented routes plus a catch-all

`packages/spa/src/App.tsx` SHALL wrap the app in `<BrowserRouter>` (from `react-router-dom@^6`) and SHALL register exactly the following routes: `/` (the `index` route renders `<BoardPlaceholder />` inside `<AppShell />`'s `<Outlet />`); `/tickets/:id` (renders `<RoutePlaceholder title="Ticket detail" stepRef="step 11" />`); `/prs/:id` (renders `<RoutePlaceholder title="PR detail" stepRef="step 11" />`); `/activity` (renders `<RoutePlaceholder title="Activity log" stepRef="step 11" />`); and a catch-all `path="*"` that renders `<NotFound />`. The four placeholder routes SHALL share a single `<RoutePlaceholder>` component at `packages/spa/src/routes/RoutePlaceholder.tsx` so a structural test can assert on a single `data-testid="route-placeholder"`. The router SHALL render the `<AppShell />` as a layout route so navigation between the four documented routes never re-mounts the shell (the agent-roster panel's data does not refetch on navigation). The catch-all SHALL NOT mount inside the shell (a 404 page is its own layout in this step).

#### Scenario: Each documented route mounts a known component

- **WHEN** the router is constructed and `MemoryRouter` is set to each of `/`, `/tickets/abc`, `/prs/xyz`, `/activity`, and `/totally-unknown` in turn
- **THEN** at `/` the rendered tree contains the `<BoardPlaceholder />` element
- **AND** at `/tickets/abc`, `/prs/xyz`, and `/activity` the rendered tree contains exactly one `data-testid="route-placeholder"`
- **AND** at `/totally-unknown` the rendered tree contains `<NotFound />`

#### Scenario: The shell does not unmount on navigation between top-level routes

- **WHEN** the user navigates from `/` to `/activity`
- **THEN** the `<AppShell />` instance remains mounted (the `<AgentRosterPanel />` does not refetch its initial roster)

### Requirement: Design tokens are CSS custom properties; component CSS is plain `.css` files; no CSS-in-JS runtime

`packages/spa/src/theme/tokens.css` SHALL define a documented set of `--keni-*` CSS custom properties for color (background, text, muted text, border, accent, status-running, status-idle, disconnected), spacing (`--keni-space-1` through `--keni-space-6`), and typography (`--keni-font-body`, `--keni-font-mono`). The tokens SHALL define a `:root` block for the light theme and a `@media (prefers-color-scheme: dark) :root` override for the dark theme. The SPA SHALL import `tokens.css` via `index.css`. Components SHALL consume tokens via `var(--keni-*)` references in adjacent `.css` files (e.g., `AppShell.tsx` imports `AppShell.css`). No JavaScript runtime CSS-in-JS library SHALL be used. No theme switcher SHALL be implemented in this step (`prefers-color-scheme` covers the prototype's needs).

#### Scenario: The token file declares both light and dark variants

- **WHEN** the file `packages/spa/src/theme/tokens.css` is read
- **THEN** the file contains a `:root { ... }` block defining at minimum `--keni-color-bg`, `--keni-color-text`, `--keni-color-text-muted`, `--keni-color-border`, `--keni-color-accent`, `--keni-color-status-running`, `--keni-color-status-idle`, `--keni-color-disconnected`, `--keni-space-1` through `--keni-space-6`, `--keni-font-body`, `--keni-font-mono`
- **AND** the file contains a `@media (prefers-color-scheme: dark) { :root { ... } }` block that re-declares at least every color token

#### Scenario: No CSS-in-JS runtime is bundled

- **WHEN** the package's `imports` map is read
- **THEN** no entry for `@emotion/*`, `styled-components`, `linaria`, `tailwindcss`, or any other CSS-in-JS / utility-first runtime is present

### Requirement: React component tests run under Deno via `@testing-library/react` over `happy-dom`

`packages/spa/src/test_setup.ts` SHALL import `@happy-dom/global-registrator` and call `GlobalRegistrator.register()` so `Deno.test`-driven `*.tsx` files run with `window`, `document`, and the standard DOM globals available. Every component test file SHALL be named `*_test.tsx`, SHALL import `./test_setup.ts` first (before any other import), and SHALL use `@testing-library/react`'s `render`, `screen`, `fireEvent`, and matching helpers. The SPA package's `deno task test` SHALL execute every `*_test.ts` and `*_test.tsx` under `packages/spa/src/`. No second test runner (Vitest, Jest, etc.) SHALL be added.

#### Scenario: The test setup module installs the DOM globals

- **WHEN** `packages/spa/src/test_setup.ts` is read
- **THEN** the file imports `GlobalRegistrator` from `@happy-dom/global-registrator`
- **AND** calls `GlobalRegistrator.register()` at module top level

#### Scenario: A `_test.tsx` file successfully renders a component under `deno test`

- **WHEN** `deno test -A packages/spa/src/shell/AppShell_test.tsx` is invoked
- **THEN** the test runner discovers the file, imports `./test_setup.ts` first, and renders `<AppShell />` against `happy-dom`
- **AND** the test exits with status 0 (no missing-DOM-API errors)

#### Scenario: The workspace `deno task test` exercises every SPA test file

- **WHEN** `deno task test` is invoked from the repository root
- **THEN** every `*_test.ts` and `*_test.tsx` file under `packages/spa/src/` is executed
- **AND** the SPA package contributes more than one test case to the aggregate count (satisfying the `developer-setup` "at least one test" floor)

### Requirement: The SPA imports every wire shape from `@keni/shared` — no client-side re-declaration

Every type imported by the SPA from the orchestration server's wire surface SHALL be imported from `@keni/shared` (or an explicit subpath under `@keni/shared/wire/`). The SPA SHALL NOT declare its own `interface AgentResponse`, `type EventFrame`, `interface ErrorResponse`, etc. The `@keni/shared/wire/mod.ts` barrel SHALL re-export every type the SPA consumes (`AgentResponse`, `AgentListResponse`, `AgentEnvelope`, `AgentStatus`, `EventName`, `EventFrame`, the six payload interfaces, `TicketSummaryResponse`, `TicketResponse`, `PRSummaryResponse`, `PRResponse`, `ActivityEntryResponse`, `ErrorResponse`, `ErrorCode`, `Role`). The `apiClient` method signatures and the `eventsClient`'s frame dispatch type SHALL bind to these imports directly so a server-side wire-type change cascades into the SPA at `deno task check` time.

#### Scenario: Every SPA wire type comes from `@keni/shared`

- **WHEN** the entire `packages/spa/src/` tree is scanned for `interface`, `type`, or `enum` declarations whose name matches the documented wire-type list (`AgentResponse`, `EventFrame`, `ErrorResponse`, etc.)
- **THEN** no such declaration exists in the SPA package
- **AND** every consumer imports the type via `import type { ... } from "@keni/shared"`

#### Scenario: A wire-type change in `@keni/shared` cascades to a SPA build error

- **WHEN** a contributor adds a required field `labels: readonly string[]` to `AgentResponse` in `@keni/shared/wire/agents.ts`
- **AND** does not update the SPA's `AgentRosterCard` to render or destructure it
- **THEN** `deno task check` fails with a TypeScript error pointing at `AgentRosterCard.tsx` (the `{ id, role, status, ... }` destructure missing `labels`)

### Requirement: The SPA uses local React state and shallow context — no global state-management library

The SPA SHALL NOT depend on `redux`, `@reduxjs/toolkit`, `zustand`, `jotai`, `mobx`, `@tanstack/react-query`, `swr`, or any equivalent global / cache-aware state-management library in this step. The single `apiClient` and `eventsClient` instances SHALL be constructed in `packages/spa/src/main.tsx` and SHALL be exposed to the component tree via two thin React Contexts (`ApiClientContext`, `EventsClientContext`). Hooks `useApiClient()` and `useEventsClient()` SHALL throw if called outside the context providers. All other state (per-panel data, lifecycle indicators, optimistic-update flags) SHALL be local React state via `useState` / `useReducer`.

#### Scenario: No state-management library is in the imports map

- **WHEN** `packages/spa/deno.json` is read
- **THEN** the `imports` map does not contain entries for `redux`, `@reduxjs/toolkit`, `zustand`, `jotai`, `mobx`, `@tanstack/react-query`, or `swr`

#### Scenario: `useApiClient()` throws outside the provider

- **WHEN** a component calls `useApiClient()` while not nested under `<ApiClientProvider>`
- **THEN** the call throws an `Error` whose message names the provider that must be present

### Requirement: A `prototypeFlags.ts` module is the single seam for prototype-only UI toggles

`packages/spa/src/prototypeFlags.ts` SHALL export a frozen object whose keys are the prototype-only UI toggles. In this step, the only documented key is `chatPanelEnabled: boolean` (default `false`). The shell SHALL read this flag to decide whether to render the chat region. Future SPA steps that want to introduce or flip a prototype-only behaviour SHALL add a key to this module rather than scatter feature flags throughout the codebase. The module SHALL NOT depend on any runtime configuration (env var, query string, localStorage); flipping a flag is a code change.

#### Scenario: The flag module has the documented default

- **WHEN** `packages/spa/src/prototypeFlags.ts` is read
- **THEN** the file exports a frozen object containing at least the key `chatPanelEnabled` whose value is `false`

#### Scenario: The shell consumes `chatPanelEnabled` directly

- **WHEN** the file `packages/spa/src/shell/AppShell.tsx` is read
- **THEN** the file imports `chatPanelEnabled` from `../prototypeFlags.ts`
- **AND** the chat region's render is gated on that import (no other condition controls the chat region's visibility)
