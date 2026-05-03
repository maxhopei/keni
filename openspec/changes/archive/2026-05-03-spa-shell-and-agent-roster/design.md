## Context

`packages/spa/` is a Deno workspace member created by step 01 with a single placeholder file (`src/main.ts` exporting one constant) and a `build` task wired to `echo noop`. The orchestration server (steps 04–05) and the engineer runtime (step 09) ship a complete REST + WebSocket surface — `GET /tickets`, `GET /prs`, `GET /activity`, `GET /agents`, `POST /agents/:id/{pause,resume}`, and a typed `EventFrame` stream over `/events?role=user` — that nothing in the codebase consumes from a browser. The README already commits the project to **React + Vite via [`@deno/vite-plugin`](https://jsr.io/@deno/vite-plugin)** (see the `developer-setup` capability's "README documents the contributor onboarding path" requirement and the existing "SPA stack (to be wired)" paragraph that names this exact change as the home of the wiring), so the framework choice is structurally pre-decided and this design only has to confirm it and pin the seam.

What this step has to settle, in addition to that pre-pinned framework choice:

- **The build & dev pipeline** (Vite config, dev-server proxy to a running orchestration server, the `dev` / `build` / `preview` task surface).
- **The transport architecture** (a typed REST client and a reconnecting WebSocket client, both built directly against the existing `@keni/shared/wire/` types — no codegen).
- **The shell** (three-region CSS-grid layout per `spec.md` §7.2 — agent roster left, board placeholder centre, chat slot right hidden in the prototype).
- **The routing scaffold** (the four documented routes plus a catch-all, all behind `<BrowserRouter>` from `react-router-dom`).
- **The agent-roster panel** (the live-updating left region — its data shape, its update protocol, its empty / loading / error states, the pause/resume affordance).
- **The component-testing approach** (Deno tests + `@testing-library/react` against a JSDOM-flavoured DOM environment).
- **A handful of non-load-bearing choices** (state management, theming, CSS approach) that are picked lightly here to keep step 11 unblocked without over-specifying.

Constraints and givens:

- Runtime is Deno 2.7+. `@deno/vite-plugin` lives on JSR and works against vanilla Vite 5 today; React ships from `npm:react` via Deno's npm-compat layer.
- The server's trust model from step 04 is unchanged: the SPA presents `X-Keni-Role: user` on every REST call and `?role=user` on the WS handshake (browsers cannot set arbitrary headers on `new WebSocket(...)`). No auth; CORS is intentionally not configured because the dev server proxies to the orchestration server (same-origin from the browser's perspective) and step 13 will host the production bundle from the orchestration server itself.
- The reconnect tier the orchestration server commits to is **"client refetches via REST on (re)connect"**. The SPA does not assume any server-side replay buffer. The wire shape carries `EventEnvelope.id` (uuidv7) so a future `?since=<event-id>` replay is purely additive in the SPA too.
- The agent runtime state on the server is in-memory (`paused`, `status`, `last_activity`, `last_active_at` reset on server restart). The SPA must reconcile against REST after every `eventsClient` `connected` lifecycle event.
- The `developer-setup` capability requires every package contribute at least one `Deno.test` to `deno task test`. The current placeholder `main_test.ts` covers that; this step replaces it with the real component / unit tests, which collectively are well above the floor.
- Wire types live in `@keni/shared/wire/` as types-only modules (no zod imports, no runtime weight). The SPA imports them directly via `@keni/shared`'s barrel.

Non-constraints (deliberately free to pick lightly here):

- The **CSS strategy**: CSS Modules vs. CSS custom properties + plain CSS vs. utility-first. Picked: CSS custom properties + plain CSS files (no runtime cost, no bundler config beyond Vite's defaults). Documented in Decision 7.
- The **state-management library**: none (Decision 5). Local React state + `useEffect` for the prototype; we revisit if step 11/12 forces a global cache.
- The **router internals** (data router vs. component router): we use the component router today (`<BrowserRouter>` + `<Routes>`/`<Route>`) because it has zero data-loader semantics to learn for placeholder pages. Decision 6.
- The **JSDOM flavour** (`jsdom` via npm vs. `happy-dom`): picked `happy-dom` (Decision 8) because it is faster and Deno-friendly, but the `@testing-library/react` API is identical so a swap is one-line if `happy-dom` runs into a rendering edge case.

## Goals / Non-Goals

**Goals:**

- `packages/spa/` is a runnable Vite + React app: `cd packages/spa && deno task dev` opens a dev server on a documented port, the bundle imports `@keni/shared` types, and a browser session against a running orchestration server shows a working dashboard route.
- The dev server proxies `/api/*` and `/events` to a configurable origin (`KENI_SERVER_URL`, default `http://127.0.0.1:8000`) so the browser sees a same-origin app and CORS does not need to be configured on the server.
- `deno task build` produces a production-shaped static bundle in `packages/spa/dist/` that step 13's `keni start` will serve as-is.
- Exactly one **typed REST client** (`apiClient`) and exactly one **reconnecting WebSocket client** (`eventsClient`) live under `packages/spa/src/transport/` and are the only places a `fetch` or `new WebSocket(...)` call is made in the SPA. Both consume the existing `@keni/shared/wire/` types — no client codegen, no duplicate wire shapes.
- The application shell at `packages/spa/src/shell/AppShell.tsx` is a three-region CSS-grid layout: left (the agent roster — mounted in this step), centre (a `<BoardPlaceholder />` mount point step 11 replaces), right (the chat slot — hidden by a documented prototype flag step 23 flips). The layout collapses to a single column under a documented breakpoint.
- A routing scaffold under `packages/spa/src/routes/` registers `/`, `/tickets/:id`, `/prs/:id`, `/activity`, and a catch-all `/404`; placeholder routes share one `<RoutePlaceholder />` component.
- The **agent roster panel** at `packages/spa/src/features/agentRoster/` renders the configured roster from `apiClient.listAgents()` on mount, subscribes to the events stream for live updates, exposes a working pause/resume toggle, and explicitly handles loading / empty / error / disconnected states.
- A **connection indicator** in the top nav reflects the events client's lifecycle (`connecting` → `live` → `disconnected`); the indicator is the single visible signal of WS health for the prototype.
- The **test surface** for the SPA is non-trivial: `apiClient_test.ts`, `eventsClient_test.ts`, `AgentRosterPanel_test.tsx`, `AppShell_test.tsx`, and `formatRelativeTime_test.ts` collectively give the package real coverage of the shipped behaviour and let `deno task test` exercise it on every CI run.
- Two new capability specs (`spa-shell`, `spa-agent-roster`) and one delta on `developer-setup` document everything above; downstream SPA steps (board, drill-downs, interrupt UX, chat panel, spec viewer) plug into the seams these specs pin without re-deciding.

**Non-Goals:**

- **No board view, no ticket detail, no PR detail, no activity-log view.** Step 11 lands all four; this step ships the routing slot and the placeholder component.
- **No interrupt / timeout UX.** Step 12. The roster card has a pause toggle (`paused` flag) but no `interrupt` button.
- **No chat panel.** Step 23. The right region of `AppShell` is hidden in the prototype layout via a documented flag step 23 flips.
- **No spec viewer or CR list.** Step 24.
- **No manual-override confirmation modal.** Step 25.
- **No project-settings UI.** Post-MVP per `spec.md` §10.
- **No multi-project switcher in the UI.** The data model already carries `project_id`; the SPA is single-project per the existing one-server-one-project rule.
- **No client-side caching beyond local React state.** No `react-query`, no SWR, no Zustand, no Redux. The reconnect tier is "refetch from REST"; mounting / unmounting a panel triggers fresh requests. Decision 5.
- **No service worker, no PWA shell, no offline mode.** The SPA is a local dev tool.
- **No internationalisation, no theme switcher, no accessibility audit.** The components ship with sensible defaults (semantic HTML, keyboard-focusable controls, `prefers-color-scheme`-driven dark/light), but a formal a11y / i18n pass is post-MVP.
- **No OpenAPI / typed-client codegen.** The hand-written client is the contract; the type-check is the drift detector. Decision 4.
- **No new orchestration-server endpoints, no new wire types, no new `EventName` variants, no new error codes.** This step is a pure consumer of the existing surface.
- **No CI workflow change.** `deno task test` grows by ~25 cases but `.github/workflows/ci.yml` is unchanged.

## Decisions

### Decision 1: Framework — React + Vite via `@deno/vite-plugin`

**Why:** the `developer-setup` capability already commits the SPA to "React + Vite via `@deno/vite-plugin`" (the existing README sentence and the spec scenario "README records the SPA stack decision" both name this exact change as the home of the wiring). This decision confirms it and pins the version surface:

- `react` and `react-dom` at major `^18` (the current LTS of React with stable concurrent rendering and the `createRoot` API the SPA uses).
- `vite` at major `^5` (current LTS).
- `@vitejs/plugin-react` at major `^4` (the supported React Fast Refresh / JSX-runtime plugin for Vite 5).
- `@deno/vite-plugin` at the JSR major in effect at the change's land time (we add the explicit version pin in `packages/spa/deno.json`'s `imports` map; see Decision 9).

**Why not other frameworks:** the engineer's bundled prompt (`spec.md` §8) targets TS/Deno/React, so reusing React for the SPA keeps a single mental model. SolidJS / Svelte / Vue are all viable but introduce a second component model the rest of Keni does not produce. Vanilla TypeScript without a framework would force this step to ship a hand-rolled reactivity layer the prototype does not need.

**Why not Next.js / Remix / TanStack Router:** the SPA is a single-page app shipped as a static bundle (no server-side rendering, no route loaders against a database, no streaming) — meta-frameworks would add operational and config surface for zero benefit. Vite + React + `react-router-dom` is the smallest stack that satisfies §7.2 and unblocks every later SPA step.

### Decision 2: Build & dev pipeline — Vite at the package root, with a documented dev-server proxy

**Layout:**

```
packages/spa/
├── deno.json            (modified — tasks: dev, build, preview, test; imports map for npm: deps)
├── index.html           (new — Vite entry; mounts <div id="root">)
├── vite.config.ts       (new — registers @deno/vite-plugin and @vitejs/plugin-react;
│                                 dev-server proxy /api and /events to KENI_SERVER_URL;
│                                 build.outDir = "dist/")
├── dist/                (gitignored — vite build output; consumed by step 13's keni start)
└── src/
    ├── main.tsx         (replaces main.ts — React 18 createRoot mount)
    └── ... (described in Decisions 3 onwards)
```

**Tasks (in `packages/spa/deno.json`):**

```json
{
  "tasks": {
    "dev": "deno run -A --node-modules-dir npm:vite",
    "build": "deno run -A --node-modules-dir npm:vite build",
    "preview": "deno run -A --node-modules-dir npm:vite preview",
    "test": "deno test -A"
  }
}
```

**Why proxy, not CORS:** the orchestration server intentionally has no CORS middleware (step 04 trust model: local-only, role-headers trusted; CORS is not in the closed `ErrorCode` enum and the server has no way to advertise allowed origins). The Vite dev server's `server.proxy` config forwards `/api/*` to the configured backend origin and `/events` to the same origin with `ws: true` (Vite handles the WS upgrade transparently). The browser sees one origin; the orchestration server sees REST and WS calls from the dev server's process. In production (step 13), `keni start` serves the static bundle from the same Hono process that mounts the API, so the proxy disappears entirely and same-origin remains true. This sidesteps the entire CORS conversation cleanly and matches the architecture step 13 already commits to.

**Why a `KENI_SERVER_URL` env var:** different developers run the orchestration server on different ports (`--port 0` is the recommended default; the bound port is printed to stdout). Hard-coding the proxy target would force every developer into a fixed port. Reading from `Deno.env.get("KENI_SERVER_URL")` with a `http://127.0.0.1:8000` default lets the developer either point at the printed port or pin the server to `8000` and forget about it.

**Alternatives considered:**

- **Same-origin in dev (no proxy) by also serving the SPA from the orchestration server.** Possible but requires step 13 changes inside step 10's scope; the proxy keeps the two concerns separate and lets step 13 swap to the same-origin model with no SPA-side change.
- **Configure CORS on the server.** Adds a configuration field nobody else needs; the production deployment is same-origin so CORS would be vestigial in step 13.

### Decision 3: Three-region shell — CSS Grid with documented region names

**Why CSS Grid:** it is the only layout primitive that maps directly to the `spec.md` §7.2 promise of "three regions" without nested flex containers, and it lets each region size independently (the roster wants a fixed width, the centre flexes, the chat slot wants a fixed width when shown and zero when hidden). Grid template areas double as documentation.

**Shape:**

```tsx
// packages/spa/src/shell/AppShell.tsx
<div className="app-shell" data-chat-visible={chatVisible}>
  <header className="app-shell__nav">
    <TopNav />
  </header>
  <aside className="app-shell__roster">
    <AgentRosterPanel />
  </aside>
  <main className="app-shell__main">
    <Outlet />  {/* react-router-dom mount point — board placeholder today */}
  </main>
  {chatVisible && (
    <aside className="app-shell__chat">
      {/* step 23 mounts the chat panel here */}
    </aside>
  )}
</div>
```

```css
/* index.css */
.app-shell {
  display: grid;
  grid-template-columns: 280px 1fr;
  grid-template-rows: 56px 1fr;
  grid-template-areas:
    "nav nav"
    "roster main";
  height: 100vh;
}
.app-shell[data-chat-visible="true"] {
  grid-template-columns: 280px 1fr 360px;
  grid-template-areas:
    "nav nav nav"
    "roster main chat";
}
@media (max-width: 720px) {
  .app-shell { grid-template-columns: 1fr; grid-template-areas: "nav" "main"; }
  .app-shell__roster, .app-shell__chat { display: none; }  /* roster moves into a future hamburger; out of scope */
}
```

**Why a `data-chat-visible` flag and not a route or a store:** the prototype hides the chat slot by default; step 23 flips a single component-level flag and the third grid column appears. Wiring the visibility through the router or a global store today would build infrastructure for a single boolean. The flag's default lives in a `prototypeFlags.ts` module with a one-liner `chatPanelEnabled = false` so step 23's diff is a one-line change.

**Why a fixed 280 px roster width:** the documented `AgentResponse` fields (`id`, `role`, `status`, `last_activity`, `last_active_at`, `paused`) and the toggle button render comfortably at 280 px. We do not parameterise it; tweaking by a few pixels is post-MVP.

### Decision 4: Transport — hand-written `apiClient` and `eventsClient` against `@keni/shared/wire/`

**Why hand-written, not generated:** the orchestration server already exports `@keni/shared/wire/` TypeScript types for every endpoint's request and response (the `developer-setup` and `orchestration-server` capabilities both pin this rule). A hand-written client that imports those types as its method signatures is the smallest possible adapter — the type-check is the drift detector (Decision 11). An OpenAPI / json-schema codegen pipeline would add a build step (the spec, the codegen tool, the regen-on-CI gate) for the same correctness guarantee the type system already provides.

**Shape (`packages/spa/src/transport/apiClient.ts`):**

```ts
import type {
  AgentListResponse, AgentEnvelope,
  TicketListResponse, PRListResponse, ActivityQueryResponse,
  ErrorResponse, Role,
} from "@keni/shared";

export class KeniApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorResponse["error"]["code"],
    public readonly details?: Record<string, unknown>,
  ) { super(`${code} (${status})`); }
}

export interface ApiClient {
  getProjectId(): Promise<string>;        // resolved on first call, cached for the lifetime of this client
  listAgents(): Promise<AgentListResponse>;
  pauseAgent(id: string): Promise<AgentEnvelope>;
  resumeAgent(id: string): Promise<AgentEnvelope>;
  listTickets(filter?: { status?: readonly string[] }): Promise<TicketListResponse>;
  listPrs(filter?: { status?: readonly string[] }): Promise<PRListResponse>;
  listActivity(filter?: { agent?: string; from?: string; to?: string }): Promise<ActivityQueryResponse>;
}

export function createApiClient(opts: { baseUrl?: string; role?: Role }): ApiClient { /* ... */ }
```

The default `baseUrl` is the empty string (relative URLs go through Vite's dev-server proxy or, in production, hit the orchestration server's same-origin Hono app). The default `role` is `"user"`. The implementation builds requests with `X-Keni-Role: <role>` always present, parses `application/json` bodies, and constructs a `KeniApiError` whose `code` is narrowed to the closed `ErrorResponse["error"]["code"]` union.

**Shape (`packages/spa/src/transport/eventsClient.ts`):**

```ts
import type { EventFrame } from "@keni/shared";

export type EventsClientLifecycle = "connecting" | "live" | "disconnected";

export interface EventsClient {
  subscribe(handler: (frame: EventFrame) => void): () => void;
  onLifecycle(handler: (state: EventsClientLifecycle) => void): () => void;
  state(): EventsClientLifecycle;
  close(): void;
}

export function createEventsClient(opts: {
  url?: string;                  // defaults to (location.origin replace http→ws) + "/events?role=user"
  backoff?: {
    initialMs?: number;          // default 500
    maxMs?: number;              // default 30_000
    jitter?: number;             // default 0.3 (±30%)
  };
}): EventsClient { /* ... */ }
```

The client owns its `WebSocket`, the reconnection schedule, and the lifecycle event emission. Consumers see one typed channel (`subscribe(handler)` + `onLifecycle(handler)`) and never touch a `WebSocket` directly. The `connected` (i.e., `state() === "live"`) lifecycle event is the SPA's signal to refetch canonical state — every panel that subscribes also subscribes to lifecycle events and re-issues its REST call on `connecting → live` transitions.

**Why the lifecycle API rather than emitting a synthetic `connected` frame:** an `EventFrame` is a typed union over six known event names (`ticket.created`, `pr.created`, `activity.appended`, `agent.state_changed`, etc.). Adding a synthetic seventh would either require extending the wire-side `EventName` union (a server-side concern, not the client's call) or producing a frame the type system cannot narrow over. A separate `onLifecycle` channel keeps the wire shape pure and makes the intent obvious to readers.

**Alternatives considered:**

- **OpenAPI / typed-client codegen.** Adds a build step and a generated-code review burden for the same correctness guarantee the type-check already provides. Defer to post-MVP.
- **One client, four methods.** Folding `apiClient` and `eventsClient` into a single object would couple two transport concerns with very different lifecycles (REST is request/response, WS is long-lived). Splitting them keeps each file small and testable.
- **`EventSource` (SSE) instead of `WebSocket`.** The orchestration server already exposes WS, not SSE; switching transports would force a server-side change.

### Decision 5: State management — none beyond local React state

**Why:** the prototype's stateful surface in this step is small and panel-local: the agent roster has a list-of-agents state and a per-agent in-flight pause/resume flag, the connection indicator has a 3-state lifecycle, and that is it. Introducing Zustand / Redux Toolkit / Jotai today would build infrastructure for one consumer that can be expressed cleanly in a `useReducer` and a `useEffect`. The reconnect tier the orchestration server commits to ("client refetches via REST") removes the main reason a SPA reaches for a global cache (cross-component synchronisation) — every panel's data lifecycle is bounded by its own mount/unmount.

When step 11 (board) and step 12 (interrupt UX) land, the question of a shared cache becomes more concrete (the kanban view and the activity log will both want to react to `ticket.updated` frames without re-issuing a `GET /tickets` per consumer). At that point a small store (Zustand is the natural pick because it does not require a context provider) can be added without changing the existing roster panel — the roster's data path is `apiClient` directly, and a future store would sit between them, not above them.

**Documented seam:** `apiClient` returns plain typed objects; `eventsClient` emits typed `EventFrame`s. Inserting a store between these two primitives and the consuming panels is a one-file change. No other architectural surface needs to move.

**Alternatives considered:**

- **Zustand or Jotai today.** Premature; one consumer.
- **`react-query` / TanStack Query.** Heavier (its own caching and refetch model on top of the WS reconciliation we already have); the "refetch on reconnect" tier maps cleanly to the lifecycle event and a `useEffect`.
- **React Context for the API and events clients.** Picked. Two providers (`ApiClientProvider`, `EventsClientProvider`) at the root let panels `useApiClient()` and `useEventsClient()` without prop-drilling. Both contexts are shallow (they wrap the singleton client instance constructed in `main.tsx`) so they do not constitute a "store" in the state-management sense.

### Decision 6: Routing — `react-router-dom` v6, component router, with a shared `<RoutePlaceholder />`

**Why `react-router-dom` v6:** the most widely-deployed React router, well-typed, integrates naturally with `<Outlet />` (which the shell uses to mount the per-route content into the centre region), supports the catch-all `path="*"` pattern, and is straightforward to test against `MemoryRouter` in component tests. The data router (`createBrowserRouter` + loaders) is the v6.4+ alternative — we pick the **component router** today because there are no per-route data loaders to register: the dashboard route's panels do their own fetching via `apiClient`, and the placeholder routes have nothing to load. When step 11 lands real ticket / PR / activity views with route-level data fetching, switching to the data router is mechanical (`createBrowserRouter` accepts the same `<Route>` definitions wrapped in `createRoutesFromElements`).

**Routes registered today:**

```tsx
<BrowserRouter>
  <Routes>
    <Route element={<AppShell />}>
      <Route index element={<BoardPlaceholder />} />
      <Route path="tickets/:id" element={<RoutePlaceholder title="Ticket detail" stepRef="step 11" />} />
      <Route path="prs/:id" element={<RoutePlaceholder title="PR detail" stepRef="step 11" />} />
      <Route path="activity" element={<RoutePlaceholder title="Activity log" stepRef="step 11" />} />
    </Route>
    <Route path="*" element={<NotFound />} />
  </Routes>
</BrowserRouter>
```

**The shared `<RoutePlaceholder />`** keeps the placeholder routes from being four near-identical 5-line files, and gives `AppShell_test.tsx` a single `data-testid="route-placeholder"` to assert against rather than four. When step 11 replaces these routes one by one, each replacement is a single `<Route element={<TicketDetailView />} />` change and the shared placeholder file disappears.

**Alternatives considered:**

- **TanStack Router** — typed routes, fully integrated data loaders, file-based routing optional. More to learn and more setup for placeholder pages. Defer to post-MVP if the routing model ever needs more than v6 offers.
- **No router (state-driven view switching).** Doable for a single-route prototype but the spec already calls out four views; a router is the right primitive.

### Decision 7: CSS approach — design tokens via CSS custom properties, plain `.css` files, no CSS-in-JS

**Why:** Vite handles `.css` imports out of the box, design tokens via CSS custom properties have zero runtime cost, and `prefers-color-scheme: dark` / `light` lets the SPA look reasonable on either system theme without a theme switcher. CSS Modules would be a reasonable upgrade if class-name collisions become a concern; for the prototype's small surface area, BEM-style naming (`.app-shell__roster`) is clearer in devtools and one less build-time concern.

**Token shape (`packages/spa/src/theme/tokens.css`):**

```css
:root {
  --keni-color-bg: #ffffff;
  --keni-color-text: #1a1a1a;
  --keni-color-text-muted: #6a6a6a;
  --keni-color-border: #e0e0e0;
  --keni-color-accent: #1f6feb;
  --keni-color-status-running: #2ea043;
  --keni-color-status-idle: #6a737d;
  --keni-color-disconnected: #cf222e;

  --keni-space-1: 4px; --keni-space-2: 8px; --keni-space-3: 12px;
  --keni-space-4: 16px; --keni-space-6: 24px;

  --keni-font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --keni-font-mono: "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --keni-color-bg: #0d1117;
    --keni-color-text: #c9d1d9;
    --keni-color-text-muted: #8b949e;
    --keni-color-border: #30363d;
    /* ... */
  }
}
```

Components consume tokens via `var(--keni-*)` references in their adjacent `.css` files. No theme switcher today; promoting one is additive (override `:root` from a JS-set `data-theme` attribute on `<html>`).

**Alternatives considered:**

- **Tailwind.** Big ergonomic win for component density but adds a build-time pipeline (and a class-name aesthetic decision) that this step does not need to make on behalf of the team.
- **CSS-in-JS (Emotion / styled-components).** Runtime cost for no clear benefit at this surface area.
- **CSS Modules.** Reasonable; deferred until name collisions actually appear.

### Decision 8: Component testing — Deno tests + `@testing-library/react` against `happy-dom`

**Why:** `@testing-library/react` is the de-facto React component-testing API; running it under Deno requires a DOM environment because React expects `document`, `window`, etc. The two production-quality npm-compatible options are `jsdom` (mature, the de-facto Node default) and `happy-dom` (newer, faster, smaller, and explicitly designed for npm-compat runtimes). We pick **`happy-dom`** because:

- It is faster (often 2–3× over `jsdom`) and the SPA test count will grow with every later step.
- The `@testing-library/react` API is identical against either, so swapping is a one-import change if `happy-dom` ever proves insufficient.
- Deno's `npm:` compat layer handles `happy-dom` cleanly today (it is `npm:happy-dom@^15` at the change's land time).

**Shape (`packages/spa/src/test_setup.ts` — imported at the top of each `*.tsx` test file):**

```ts
import { GlobalRegistrator } from "npm:@happy-dom/global-registrator@^15";
GlobalRegistrator.register();   // installs window, document, etc. into Deno's globalThis
```

**Test file conventions:**

- Pure TS tests are `*_test.ts` (the existing convention).
- React component tests are `*_test.tsx` so the JSX parser kicks in for the test file itself.
- Every `*_test.tsx` file imports `./test_setup.ts` first, then `@testing-library/react`.
- Component tests build mock `apiClient` / `eventsClient` instances inline; no global mocking framework. The clients are interfaces (Decision 4), so a 20-line in-file mock is the simplest approach.

**Alternatives considered:**

- **Vitest in `node` mode.** Would force a second test runner and CI step; the workspace contract is `deno task test`.
- **`jsdom`.** Reasonable; we pick `happy-dom` for speed but document the swap.
- **Hand-rolled DOM stubs.** Brittle; `@testing-library/react` is the right primitive.

### Decision 9: Dependency layout — SPA-local `imports` map, no spillover into root `deno.json`

**Why:** the React / Vite / `react-router-dom` / testing-library deps are SPA-only. Adding them to the workspace-root `deno.json` `imports` map would force every other package's `deno check` to consider them in resolution, and would tempt a future contributor to import React into the server. Pinning them in `packages/spa/deno.json` keeps the surface honest.

**Shape (`packages/spa/deno.json`):**

```json
{
  "name": "@keni/spa",
  "version": "0.0.0",
  "imports": {
    "react": "npm:react@^18",
    "react-dom": "npm:react-dom@^18",
    "react-dom/client": "npm:react-dom@^18/client",
    "react-router-dom": "npm:react-router-dom@^6",
    "vite": "npm:vite@^5",
    "@vitejs/plugin-react": "npm:@vitejs/plugin-react@^4",
    "@deno/vite-plugin": "jsr:@deno/vite-plugin@^1",
    "@testing-library/react": "npm:@testing-library/react@^16",
    "@testing-library/jest-dom": "npm:@testing-library/jest-dom@^6",
    "happy-dom": "npm:happy-dom@^15",
    "@happy-dom/global-registrator": "npm:@happy-dom/global-registrator@^15"
  },
  "tasks": {
    "dev": "deno run -A --node-modules-dir npm:vite",
    "build": "deno run -A --node-modules-dir npm:vite build",
    "preview": "deno run -A --node-modules-dir npm:vite preview",
    "test": "deno test -A"
  }
}
```

**Why `--node-modules-dir`:** Vite's plugins assume Node-style module resolution under `node_modules/` for some transitive deps. The `--node-modules-dir` flag lets Deno materialise an `npm:` cache as a local `node_modules/` so Vite's bundler is happy. The directory is gitignored.

**Lockfile:** `deno install --frozen` (the CI step) honours the new `imports` and pins the resolved versions in `deno.lock` — the existing `developer-setup` "Lockfile out of sync fails CI" requirement is unchanged.

### Decision 10: Agent-roster live-update protocol — frame-driven status flips, debounced REST refetches for `last_activity`

**Why split the responsibilities:** `agent.state_changed` payloads carry only `{ agent_id, paused, status }` (the `EventFrame` discriminated-union choice from step 05). The roster card needs `last_activity` and `last_active_at` too — those come from the `AgentResponse` envelope, which is updated server-side by the activity-log handler. The cleanest reconciliation is:

1. **`agent.state_changed`**: apply the payload directly to the local roster state — a single-card re-render, no network call. The card's `paused` and `status` flip immediately.
2. **`activity.appended`** (filtered to entries whose `agent` is in the local roster): schedule a debounced `apiClient.listAgents()` refetch on a 250 ms trailing timer. A burst of activity entries (the engineer's stdout chunks, for example) collapses into one refetch; the canonical `last_activity` and `last_active_at` come from the server in one round-trip.
3. **`connected` lifecycle event** (initial connect or reconnect): unconditional `apiClient.listAgents()` refetch — the server may have lost in-memory state on a restart, and the durable record is the activity log on disk reflected through the `/agents` endpoint.

**Why 250 ms:** long enough to absorb a typical stdout flush (often 10–50 ms apart), short enough that a human eye does not notice the lag. The value lives in a `ROSTER_REFETCH_DEBOUNCE_MS` constant in the panel module so a future change can tune it without spelunking; we intentionally do not expose it as a prop or a config field.

**Optimistic update on pause/resume:** the toggle's click handler (a) computes the optimistic next state, (b) updates local React state immediately, (c) calls `apiClient.pauseAgent(id)` or `resumeAgent(id)`, (d) on success applies the server-returned `AgentResponse` envelope (which is identical to the optimistic state on the happy path; in the "concurrent toggle from another tab" race the server's response wins), (e) on `KeniApiError` rolls back to the pre-click state and surfaces a one-line error in the card. There is no in-flight disabled state on the toggle; rolling back on error is the only failure UX.

**Alternatives considered:**

- **Refetch on every `agent.state_changed`.** Wasteful — the payload already carries `paused` and `status`; the only missing fields are `last_*`, which are bound to the activity-log feed, not the pause/resume feed.
- **Compute `last_activity` client-side from `activity.appended` payloads.** Fragile — the wire payload's `event` field name is the activity log's event name, but `last_activity` semantics (e.g., the special `summary` handling) live server-side in the agent-state decision table; mirroring that logic in the SPA would split the source of truth.
- **No debounce.** A burst of activity entries would produce N refetches per second under load. The 250 ms trailing debounce is a one-line `useEffect` cleanup-driven `setTimeout` that reads cleanly.

### Decision 11: Type-driven contract enforcement — the SPA's transport types are the same types the server uses

**Why:** every method on `ApiClient` is typed `(...) => Promise<TypeFromShared>`; a contributor who adds a field to `AgentResponse` in `@keni/shared/wire/agents.ts` automatically sees the SPA's roster card fail `deno task check` until the new field is rendered (or explicitly destructured-and-ignored). The roster card's render function consumes `AgentResponse` directly:

```tsx
function AgentRosterCard({ agent }: { agent: AgentResponse }) { /* ... */ }
```

so a missing field in the destructure is a build error. Combined with the `z.ZodType<SharedType>` annotations on the server-side schemas (the existing wire-test pattern), the drift detector chain is end-to-end: server-side schema → shared TS type → SPA component prop type → render. A field added in any one place without being added in the others fails the workspace-level `deno task check`.

**Drift check (verified during implementation):** temporarily add `labels: readonly string[]` to `AgentResponse` in `@keni/shared/wire/agents.ts`, run `deno task check`, observe the failure in `packages/spa/src/features/agentRoster/AgentRosterCard.tsx`'s destructure (or in the `apiClient` return type — both fail, the closer one wins). Revert and re-check green.

### Decision 12: Internal layout under `packages/spa/src/`

```
packages/spa/src/
├── main.tsx                          (React root mount; constructs apiClient + eventsClient; wraps <App />)
├── App.tsx                           (BrowserRouter + Routes)
├── index.css                         (reset + AppShell layout + token wiring)
├── test_setup.ts                     (happy-dom global registrar; imported by every *_test.tsx file)
├── prototypeFlags.ts                 (chatPanelEnabled = false, etc. — single source for step-23 wiring)
├── theme/
│   └── tokens.css                    (CSS custom properties for colour/space/typography/elevation)
├── shell/
│   ├── AppShell.tsx                  (three-region grid; mounts roster left, <Outlet/> centre, chat slot right)
│   ├── AppShell.css
│   ├── AppShell_test.tsx             (regions present, chat hidden by default)
│   ├── TopNav.tsx                    (connection indicator + project id + route switcher)
│   ├── TopNav.css
│   └── BoardPlaceholder.tsx          (centre-region placeholder; replaced in step 11)
├── routes/
│   ├── RoutePlaceholder.tsx          (shared placeholder for ticket-detail / pr-detail / activity)
│   └── NotFound.tsx                  (catch-all)
├── transport/
│   ├── apiClient.ts                  (typed REST client; KeniApiError)
│   ├── apiClient_test.ts             (Deno.serve mock backend; happy-path + error-mapping coverage)
│   ├── eventsClient.ts               (reconnecting WS client; lifecycle events; backoff)
│   └── eventsClient_test.ts          (fake clock; reconnect schedule; lifecycle dispatch; frame typing)
└── features/
    └── agentRoster/
        ├── AgentRosterPanel.tsx      (panel container; subscriptions; debounced refetch; loading/empty/error)
        ├── AgentRosterPanel.css
        ├── AgentRosterPanel_test.tsx (component test against in-memory clients)
        ├── AgentRosterCard.tsx       (one card per agent; pause/resume toggle)
        ├── AgentRosterCard.css
        ├── formatRelativeTime.ts     (pure helper for last_active_at)
        └── formatRelativeTime_test.ts
```

**Why `features/agentRoster/` rather than `panels/` or `regions/`:** the panel is a *feature* in the domain sense (a slice of UX that owns its own data / behaviour / UI), whereas the shell is structural. Step 11's board, step 12's interrupt UX, step 23's chat panel, step 24's spec viewer all naturally land as siblings under `features/`. The naming convention is consistent with mid-sized React codebases and the file count stays manageable.

## Risks / Trade-offs

- **[`@deno/vite-plugin` JSR ecosystem maturity.]** The plugin is comparatively young; a Vite-side breaking change (Vite 6, eventually) could require a coordinated bump. → **Mitigation:** the plugin is pinned to a major in `packages/spa/deno.json`; CI enforces the lockfile; a new major lands as its own openspec change. The same risk applies to every JSR dep we already use (`@hono/hono`, `@std/uuid`).
- **[Vite + Deno + React via `npm:` compat is a less-trodden path than Vite on Node.]** Edge cases (e.g., a React-DOM transitive that assumes a specific Node API) can surface at build time. → **Mitigation:** the `--node-modules-dir` flag materialises an `npm:` cache that closely mirrors a Node `node_modules/`, which is what Vite's tooling expects; if a hard incompatibility surfaces, the fall-back is documented in `design.md` (run Vite under Node via `deno task dev` shelling to `npx vite` — same `vite.config.ts`, same proxy, only the runtime changes).
- **[The dev-server proxy hides CORS misconfigurations until production.]** If a future change accidentally introduces CORS state on the server, the dev SPA wouldn't notice. → **Mitigation:** step 13 hosts the production bundle from the orchestration server (same-origin), so production has no CORS surface either. If a real CORS need ever arises (post-MVP, multi-origin SPA?), it is a deliberate future change with its own spec.
- **[`KENI_SERVER_URL` defaults to a fixed `http://127.0.0.1:8000` while the documented orchestration-server invocation uses `--port 0`.]** A developer who runs the server with `--port 0` and the SPA without setting the env var sees connection failures. → **Mitigation:** the README's "Run the SPA" subsection is explicit (`--port 0` ↔ printed port ↔ `KENI_SERVER_URL`); the default is documented as a convenience for "I always pin the server to 8000" workflows, not a universal default. The `<TopNav>` connection indicator goes red so the failure mode is visible.
- **[Local React state means a panel that unmounts and remounts re-fetches.]** The agent roster is in the persistent shell so this is rare today; future panels (board, drill-downs) may unmount on route change. → **Mitigation:** explicitly accepted for the prototype (per Decision 5). When step 11 makes this concrete, a small Zustand store can be added without touching the existing roster panel; the migration is mechanical.
- **[`happy-dom` may render some component edge cases differently from a real browser.]** A test passing under `happy-dom` could mask a real-browser bug. → **Mitigation:** the components in this step are extremely simple (cards, a toggle button, a CSS-grid layout); a future step with non-trivial DOM interactions (e.g., drag-and-drop in the board) can swap to `jsdom` or run a Playwright smoke pass — both are additive changes.
- **[The roster card's `last_active_at` rendering uses a static formatter — it does not auto-tick.]** A user who leaves the dashboard open will see "5 minutes ago" stay frozen until the next event triggers a re-render. → **Mitigation:** every `activity.appended` frame for any agent in the roster triggers a debounced refetch (Decision 10); active sessions produce events frequently enough that the timestamp re-renders within a typical user's attention window. A periodic `setInterval(rerender, 60_000)` would be a one-line addition if profiling ever shows the staleness is a problem.
- **[Optimistic pause/resume + concurrent toggle from another tab can briefly show the wrong state.]** Tab A clicks pause; tab B receives the `agent.state_changed` frame and updates; tab A also receives the frame; but tab A's optimistic state is already correct, so the frame is a no-op. The race only manifests if A pauses and B resumes within a few ms. → **Mitigation:** the server is the tie-breaker — A's eventual REST response (or A's eventual `agent.state_changed` for B's resume) overrides A's optimistic state. The closure ordering is "POST returns first → state matches optimistic; frame arrives later → state matches optimistic" or "frame arrives first → state matches frame; POST returns later with a different state → state matches POST's response." Both paths converge.
- **[A subscriber error in the roster panel does not unsubscribe — the events client's typed dispatch is handler-driven, not bus-style.]** A throwing handler could leak. → **Mitigation:** the panel wraps its handler in a `try/catch` and logs to the console; the events client itself does not propagate handler errors to the WS connection. Tested.
- **[The chat slot's `display: none` is the prototype's only "right region" mechanism.]** A future step that wants the slot visible without the chat panel (an unusual request, but possible) would have to re-think the toggle. → **Mitigation:** the `prototypeFlags.ts` module is the single seam; the slot's content is conditional inside `AppShell` (`{chatVisible && <aside>...</aside>}`), so the *grid layout* is also conditional and the empty slot doesn't take space. Step 23 can either render its panel inside the slot (slot becomes visible because the feature it hosts is ready) or extend the flag set if a more-nuanced visibility rule emerges.
- **[`@deno/vite-plugin`'s production bundling produces a static `dist/` that step 13 serves.]** If the bundling adds dynamic imports the server has no Content-Type for, step 13 has to handle them. → **Mitigation:** Vite's defaults produce `.js`, `.css`, `.svg`, `.html`, and a small fixed set; step 13 already plans to mount a `serveDir`-style middleware. No coordination required in this step beyond producing a correct `dist/`.

## Migration Plan

Not applicable — the SPA package is currently a single-file placeholder; this change replaces that file. There is no on-disk artifact, no API surface, and no consumer of the existing placeholder to migrate. Rollback is `git revert`. Step 13 will adapt to whatever bundle layout this step ships; until step 13 lands, the dev server is the only way to run the SPA, and that is documented in the README.

## Open Questions

- **Should the roster card show the agent's `id` or its `role` more prominently?** The wire shape carries both. → **Decision for this step:** `id` first (large, monospace), `role` underneath (smaller, muted) — agents are addressed by id in `project.yaml` and in pause/resume calls. The visual hierarchy can be revised when a non-engineer prototype role lands.
- **Should the connection indicator surface the WebSocket close code on disconnect (e.g., `1011`)?** Useful for debugging but noisy for end-users. → **Decision for this step:** no — the indicator is a binary `live` / `disconnected` (with a transient `connecting`); the WS close code is logged to the browser console for developer debugging.
- **Should the roster sort agents alphabetically by id, by role, or in `project.yaml` declaration order?** → **Decision for this step:** declaration order — matches the server's `AgentRuntimeStateStore.list()` contract, which preserves the YAML order. No client-side sort.
- **Should `apiClient` retry idempotent reads on transient network failures (e.g., a `503` during a server restart)?** → **Decision for this step:** no — the events client's reconnect lifecycle handles the "server came back" case by triggering a refetch; an in-flight REST call that fails surfaces a `KeniApiError` to the panel, which renders the error state and a "Retry" button. Adding silent retries would muddy the failure surface.
- **Should the SPA persist any state (e.g., right-panel visibility, last-viewed route) to `localStorage`?** → **Decision for this step:** no — the prototype's surface is small and the shell flag for the chat region is a hard-coded `false` until step 23. `localStorage` becomes interesting when step 24 / 25 add UI preferences worth persisting.
- **Should the dev server be reachable from another host (i.e., bind `0.0.0.0`) so a phone or tablet on the same Wi-Fi can hit it?** → **Decision for this step:** no — Vite's default bind is `localhost`, matching the orchestration server's `127.0.0.1` trust model. Promoting to `0.0.0.0` is a per-developer override (`--host` flag) and not a default.
- **Should the SPA render a static "first ever load" splash before `apiClient.getProjectId()` resolves?** → **Decision for this step:** no — the project id lookup is a single `GET /tickets` (or any endpoint that returns the envelope) and resolves in ~1 ms against a local server. The shell renders immediately with placeholder text; the project id lands in the top nav as soon as the call resolves. A formal splash is post-MVP.
- **Should we ship a basic theme switcher (light/dark/auto) in this step?** → **Decision for this step:** no — `prefers-color-scheme` covers the common case; an explicit switcher is a small additive change in a future UX step.
- **Should the placeholder routes for `/tickets/:id`, `/prs/:id`, and `/activity` deep-link from the roster card** (e.g., clicking the agent's name navigates to its filtered activity log)? → **Decision for this step:** no — the placeholder routes are mount-point smoke tests; the navigation primitives (clickable agent name → filtered activity) belong with the activity-log view in step 11.
- **Should the events client's exponential-backoff schedule be observable to the connection indicator** (e.g., "reconnecting in 3s")? → **Decision for this step:** no — the indicator shows `connecting` between attempts; the next-attempt-in countdown is debug-only and lives in the browser console.
