## 1. Vite + React framework wiring

- [x] 1.1 Update `packages/spa/deno.json` `imports` to add `react` (`npm:react@^18`), `react-dom` (`npm:react-dom@^18`), `react-dom/client` (`npm:react-dom@^18/client`), `react-router-dom` (`npm:react-router-dom@^6`), `vite` (`npm:vite@^5`), `@vitejs/plugin-react` (`npm:@vitejs/plugin-react@^4`), `@deno/vite-plugin` (`jsr:@deno/vite-plugin@^1`), `@testing-library/react` (`npm:@testing-library/react@^16`), `@testing-library/jest-dom` (`npm:@testing-library/jest-dom@^6`), `happy-dom` (`npm:happy-dom@^15`), `@happy-dom/global-registrator` (`npm:@happy-dom/global-registrator@^15`). Replace the existing `tasks.build` with the four documented tasks: `dev`, `build`, `preview`, `test` (all using `deno run -A --node-modules-dir npm:vite[ build| preview]` for the Vite-shaped tasks, and `deno test -A` for `test`).
- [x] 1.2 Run `deno install` (without `--frozen`) at the workspace root to refresh `deno.lock` with the new SPA-local deps. Verify the workspace-root `deno.json` `imports` map is unchanged (the new deps live SPA-locally).
- [x] 1.3 Create `packages/spa/index.html` mounting `<div id="root"></div>` and pointing `<script type="module" src="/src/main.tsx">`. Include a `<title>Keni</title>` and `<meta name="viewport">` for sensible mobile rendering.
- [x] 1.4 Create `packages/spa/vite.config.ts` registering `@deno/vite-plugin`'s `deno()` and `@vitejs/plugin-react`'s `react()` plugins. Set `build.outDir: "dist/"`. Configure `server.proxy` with two entries: `/api` → `Deno.env.get("KENI_SERVER_URL") ?? "http://127.0.0.1:8000"` (with `rewrite: (p) => p.replace(/^\/api/, "")`), `/events` → same target with `ws: true`.
- [x] 1.5 Add `packages/spa/dist/` and `packages/spa/node_modules/` to the root `.gitignore` if not already covered by an existing pattern.
- [x] 1.6 Smoke-test: `cd packages/spa && deno task build` exits 0 and produces a populated `dist/` (an `index.html` and at least one `.js` chunk). Delete `dist/` afterward; CI does not commit it.

## 2. Replace placeholder source files with the React entry

- [x] 2.1 Delete `packages/spa/src/main.ts` and `packages/spa/src/main_test.ts` (the placeholder).
- [x] 2.2 Create `packages/spa/src/main.tsx`: import `React`, `createRoot` from `react-dom/client`, `App` from `./App.tsx`, and `./index.css`. Construct one `apiClient` (default opts) and one `eventsClient` (default opts). Wrap `<App />` in `<ApiClientProvider value={apiClient}>` and `<EventsClientProvider value={eventsClient}>` and call `createRoot(document.getElementById("root")!).render(...)`.
- [x] 2.3 Create `packages/spa/src/index.css` with the CSS reset (zero `margin` / `padding` on `body`, `box-sizing: border-box` everywhere, `font-family: var(--keni-font-body)`, `color: var(--keni-color-text)`, `background: var(--keni-color-bg)`) and an `@import url("./theme/tokens.css")` line.
- [x] 2.4 Create `packages/spa/src/prototypeFlags.ts` exporting `Object.freeze({ chatPanelEnabled: false })`. Document at the top that flipping a flag is a code change (no env-var or query-string toggle).
- [x] 2.5 Create `packages/spa/src/test_setup.ts` importing `GlobalRegistrator` from `@happy-dom/global-registrator` and calling `GlobalRegistrator.register()` at module top level. Add a one-line module comment naming this as "import this first in every `*_test.tsx` file".
- [x] 2.6 Verify: `deno task check` exits 0 against the SPA package (no missing-type errors from the new file set).

## 3. Theming and design tokens

- [x] 3.1 Create `packages/spa/src/theme/tokens.css` declaring the `:root` light-theme variables per `spec.md` Decision 7: `--keni-color-bg`, `--keni-color-text`, `--keni-color-text-muted`, `--keni-color-border`, `--keni-color-accent`, `--keni-color-status-running`, `--keni-color-status-idle`, `--keni-color-disconnected`; `--keni-space-1` through `--keni-space-6`; `--keni-font-body`, `--keni-font-mono`. Add the `@media (prefers-color-scheme: dark) :root { ... }` block re-declaring at minimum every color token with dark-mode-friendly values.
- [x] 3.2 Pick concrete color values that pass WCAG AA contrast against the matching background in both themes (e.g., light: `#1a1a1a` text on `#ffffff` bg; dark: `#c9d1d9` text on `#0d1117` bg). Document the choices inline in `tokens.css` so a future contributor knows the constraint.
- [x] 3.3 Verify: open `packages/spa/index.html` in a browser via `deno task dev`, observe the body text and background switch when toggling the OS theme.

## 4. REST client (`apiClient`)

- [x] 4.1 Create `packages/spa/src/transport/apiClient.ts` exporting the `ApiClient` interface (per `design.md` Decision 4 and the `spa-shell` capability), the `KeniApiError` class, and the `createApiClient(opts: { baseUrl?: string; role?: Role })` factory. Default `baseUrl: ""`, `role: "user"`. Each method builds a `Request` with `headers: { "X-Keni-Role": role, "Accept": "application/json" }`, awaits `fetch`, branches on `response.ok`, parses the body as JSON, and either returns the typed envelope or throws `KeniApiError(status, parsedBody.error.code, parsedBody.error.details)`.
- [x] 4.2 Implement `getProjectId()` as a one-shot cached call: on first invocation call `GET /agents` (or any endpoint that returns `{ data, project_id }`), cache the resolved `project_id` in a module-level promise, return it on every subsequent call. Document the rationale inline.
- [x] 4.3 Implement `listAgents`, `pauseAgent(id)`, `resumeAgent(id)`, `listTickets(filter?)`, `listPrs(filter?)`, `listActivity(filter?)`. Each method's signature SHALL bind to the matching type from `@keni/shared` (e.g., `listAgents(): Promise<AgentListResponse>`). Filter parameters SHALL be optional and SHALL be serialised to query string only when non-empty.
- [x] 4.4 Create the `ApiClientProvider` React Context and the `useApiClient()` hook (in `packages/spa/src/transport/apiClient.tsx` or a sibling file). The hook SHALL throw a clear `Error` when called outside the provider.
- [x] 4.5 Create `packages/spa/src/transport/apiClient_test.ts` driving the client against a `Deno.serve`-backed mock orchestration server (bind `port: 0`, build the routes inline, tear down with `abort()`). Test cases: (1) `listAgents` returns the seeded envelope and parses the typed shape; (2) `pauseAgent` issues `POST /agents/:id/pause` with the role header; (3) a 403 response with `error.code: "role_not_owner"` rejects with `KeniApiError` carrying the code; (4) the role header is `X-Keni-Role: user` by default; (5) `getProjectId()` is called twice and the second call does not re-issue a `fetch`.
- [x] 4.6 Static-grep the SPA tree for `fetch(` calls — every match outside `apiClient.ts` and `apiClient_test.ts` is a violation. Document the search pattern in a comment in `apiClient.ts`.
- [x] 4.7 Verify: `deno test -A packages/spa/src/transport/apiClient_test.ts` exits 0 with all cases passing.

## 5. WebSocket client (`eventsClient`)

- [x] 5.1 Create `packages/spa/src/transport/eventsClient.ts` exporting the `EventsClient` interface (`subscribe`, `onLifecycle`, `state`, `close`), the `EventsClientLifecycle` type union, and the `createEventsClient(opts)` factory. Default URL: derive from `location.origin` by replacing the protocol (`https://...` → `wss://...`, `http://...` → `ws://...`) and appending `/events?role=user`. Default backoff: `{ initialMs: 500, maxMs: 30_000, jitter: 0.3 }`.
- [x] 5.2 Implement the connection state machine: on construction emit `"connecting"`, open the WS, on `open` emit `"live"`, on `message` parse `event.data` as JSON and dispatch to every subscriber (wrap each subscriber call in `try/catch` and `console.warn` the failure on throw), on `close` / `error` emit `"disconnected"` and schedule a reconnect using exponential backoff (next-attempt delay `= min(initialMs * 2^attempts, maxMs)`, then multiplied by `1 ± jitter` randomly in that range).
- [x] 5.3 Implement `close()` to: cancel any pending reconnect timer, close the live WS if open, emit one final `"disconnected"`, and prevent further reconnects.
- [x] 5.4 Make the internal clock and `WebSocket` constructor injectable via `opts` (default `globalThis.WebSocket` and `setTimeout` / `clearTimeout`) so tests can drive the schedule without real network or wall-clock waits.
- [x] 5.5 Create the `EventsClientProvider` React Context and the `useEventsClient()` hook. The hook SHALL throw a clear `Error` when called outside the provider.
- [x] 5.6 Create `packages/spa/src/transport/eventsClient_test.ts` covering: (1) initial `"connecting"` → `"live"` lifecycle transition; (2) one subscriber receives a typed `EventFrame`; (3) two subscribers fan-out; (4) a throwing subscriber does not affect the connection (other subscribers and the WS itself are unaffected); (5) the exponential-backoff schedule is exact under a fake clock with `jitter: 0` (verify the first 6 attempts: 500, 1000, 2000, 4000, 8000, 16000 ms); (6) `close()` stops reconnects (advance the fake clock past `maxMs` after `close()` and observe no new WS construction); (7) `unsubscribe` returned by `subscribe(...)` removes the handler.
- [x] 5.7 Static-grep the SPA tree for `new WebSocket(` — every match outside `eventsClient.ts` and `eventsClient_test.ts` is a violation.
- [x] 5.8 Verify: `deno test -A packages/spa/src/transport/eventsClient_test.ts` exits 0 with all cases passing.

## 6. Application shell (`AppShell`, `TopNav`, `BoardPlaceholder`)

- [x] 6.1 Create `packages/spa/src/shell/AppShell.tsx` as a function component that imports `chatPanelEnabled` from `../prototypeFlags.ts` and renders the documented three-region grid: `<header>` for the nav, `<aside>` for the roster, `<main>` for the `<Outlet />`, and conditionally a second `<aside>` for the chat slot (only rendered when `chatPanelEnabled === true`). The container SHALL set `data-chat-visible={chatPanelEnabled.toString()}`.
- [x] 6.2 Create `packages/spa/src/shell/AppShell.css` with the documented `grid-template-areas`, `grid-template-columns: 280px 1fr` (chat hidden) / `280px 1fr 360px` (chat visible), the `@media (max-width: 720px)` collapse, and the `height: 100vh` on the container.
- [x] 6.3 Create `packages/spa/src/shell/TopNav.tsx` rendering: a "Keni" wordmark on the left; the project id (resolved via `useApiClient().getProjectId()`, rendered with `useState` + `useEffect` for the async load — show `—` until resolved) in the middle, monospace; the connection indicator on the right (subscribes via `useEventsClient().onLifecycle(...)`, renders one of three `data-state="connecting|live|disconnected"` variants with the documented labels). A small `<nav>` element with placeholder anchors for `/` and `/activity` is fine.
- [x] 6.4 Create `packages/spa/src/shell/TopNav.css` with the indicator dot's three colors (`var(--keni-color-status-running)` for live, `var(--keni-color-text-muted)` for connecting, `var(--keni-color-disconnected)` for disconnected) and a small CSS animation for the pulsing connecting state.
- [x] 6.5 Create `packages/spa/src/shell/BoardPlaceholder.tsx` rendering a centred panel with the text `Kanban board lands in step 11.` and a subtle `data-testid="board-placeholder"` attribute for the structural test.
- [x] 6.6 Create `packages/spa/src/shell/AppShell_test.tsx` (importing `./test_setup.ts` first via the `../test_setup.ts` path; or place `test_setup.ts` so the import path is `../test_setup.ts` — pick one and stick to it). Test cases: (1) the shell renders `<header>`, one `<aside>` (roster), one `<main>` when `chatPanelEnabled` is `false`; (2) when temporarily flipped to `true` (use a test-only prop or wrapper), a second `<aside>` is rendered; (3) `data-chat-visible` is the right string in both cases. Mock the `apiClient` and `eventsClient` via the providers at test-render time so the panel's children mount without real I/O.
- [x] 6.7 Verify: `deno test -A packages/spa/src/shell/AppShell_test.tsx` exits 0 with all cases passing.

## 7. Routing scaffold

- [x] 7.1 Create `packages/spa/src/routes/RoutePlaceholder.tsx` exporting a default component `function RoutePlaceholder({ title, stepRef }: { title: string; stepRef: string })` that renders a centred panel with the title, a one-line "This view lands in {stepRef}" subtitle, and a `data-testid="route-placeholder"` attribute. Read the URL params via `useParams()` from `react-router-dom` and surface them in a small monospace span (e.g., `Ticket id: ticket-0001`) so the placeholder is verifiably hooked into the router.
- [x] 7.2 Create `packages/spa/src/routes/NotFound.tsx` rendering a 404 page (no shell wrapping; just a centred message and a "Back to dashboard" `<Link to="/">`).
- [x] 7.3 Create `packages/spa/src/App.tsx` exporting the routed app: `<BrowserRouter><Routes>` with the layout route `<Route element={<AppShell />}>` containing the four child routes (`index` → `<BoardPlaceholder />`; `tickets/:id` → `<RoutePlaceholder title="Ticket detail" stepRef="step 11" />`; `prs/:id` → `<RoutePlaceholder title="PR detail" stepRef="step 11" />`; `activity` → `<RoutePlaceholder title="Activity log" stepRef="step 11" />`), and a sibling `<Route path="*" element={<NotFound />} />`.
- [x] 7.4 Add a routing test inside `AppShell_test.tsx` (or a new `App_test.tsx`) using `MemoryRouter` to assert: at `/` the rendered tree contains `data-testid="board-placeholder"`; at `/tickets/abc` the tree contains exactly one `data-testid="route-placeholder"` whose text mentions `Ticket detail` and `abc`; at `/totally-unknown` the tree contains `<NotFound />`.
- [x] 7.5 Verify: the routing tests exit 0; `deno task check` passes against the new files.

## 8. Agent roster panel

- [x] 8.1 Create `packages/spa/src/features/agentRoster/formatRelativeTime.ts` exporting `formatRelativeTime(iso: string, now: Date): string`. Implement the bands: `< 5 s` → `"now"`; `< 60 s` → `"Ns ago"`; `< 3600 s` → `"Nm ago"`; `< 86400 s` → `"Nh ago"`; otherwise `"Nd ago"`. A future-dated `iso` returns `"now"` (clock-skew tolerance).
- [x] 8.2 Create `packages/spa/src/features/agentRoster/formatRelativeTime_test.ts` covering the documented boundaries (0 s, 1 s, 59 s, 60 s, 3599 s, 3600 s, 86399 s, 86400 s, 5 days, future).
- [x] 8.3 Create `packages/spa/src/features/agentRoster/AgentRosterCard.tsx` exporting the default component. Render the documented fields in the documented order and shape (id monospace prominent; role muted; status with colored dot + `Running`/`Idle` literal; `last_activity` event-name string or `—`; `last_active_at` via `formatRelativeTime` or `—`; pause/resume `<button type="button">` whose label flips with `agent.paused`). The toggle's `onClick` invokes a callback passed via props (e.g., `onTogglePause: (next: boolean) => Promise<void>`); rendering an in-card `data-testid="card-error"` block when an `error` prop is non-null.
- [x] 8.4 Create `packages/spa/src/features/agentRoster/AgentRosterCard.css` with the dot colors, layout, and typography (using the `--keni-*` tokens).
- [x] 8.5 Create `packages/spa/src/features/agentRoster/AgentRosterPanel.tsx` as the panel container. Define `const ROSTER_REFETCH_DEBOUNCE_MS = 250` at the top. State: `agents: AgentResponse[] | null` (null = loading), `error: KeniApiError | null`, `disconnected: boolean`, plus a per-card `cardErrors: Record<string, string | null>`. Effects: (1) on mount, call `apiClient.listAgents()`, set state; (2) subscribe to `eventsClient` for frames; (3) subscribe to `eventsClient` for lifecycle events. Frame handler: `agent.state_changed` → update one row's `paused` and `status` in place; `activity.appended` (when `payload.agent` is in the local roster) → schedule a debounced refetch with the documented constant; ignore unknown agents. Lifecycle handler: on `"live"`, call `listAgents()`; on `"disconnected"`, set `disconnected: true`; on `"connecting"`, set `disconnected: false`. Render branches: loading (`agents === null && error === null`), error (`error !== null`), empty (`agents !== null && agents.length === 0`), populated (one `<AgentRosterCard>` per row). Pass `onTogglePause` to each card; the handler does the optimistic update + REST call + server-response merge / rollback per the spec.
- [x] 8.6 Create `packages/spa/src/features/agentRoster/AgentRosterPanel.css` with the panel container background, the empty / loading / error layout, and a `[data-disconnected="true"]` rule that dims the cards (e.g., `opacity: 0.7`).
- [x] 8.7 Create `packages/spa/src/features/agentRoster/AgentRosterPanel_test.tsx` (importing `../../test_setup.ts` first). Build inline `apiClient`-shaped and `eventsClient`-shaped fakes (`subscribe`, `onLifecycle`, `state`, `close` methods that record calls and let the test push frames / flip lifecycle states). Test cases: (1) initial loading → cards rendered after `listAgents` resolves; (2) empty roster renders `data-testid="roster-empty"`; (3) `listAgents` rejection renders `data-testid="roster-error"` with a `Retry` button that re-issues; (4) an `agent.state_changed` frame flips the matching card's status; (5) clicking the toggle calls `pauseAgent` / `resumeAgent` and renders the optimistic state synchronously; (6) a rejected `pauseAgent` rolls back and renders `data-testid="card-error"`; (7) a burst of five `activity.appended` frames within 250 ms collapses into one debounced `listAgents` refetch (use a fake clock); (8) a `connecting → live` lifecycle transition triggers an unconditional `listAgents` refetch; (9) a `disconnected` lifecycle event sets `data-disconnected="true"` and the cards keep showing their last-seen state.
- [x] 8.8 Verify: `deno test -A packages/spa/src/features/agentRoster/` exits 0 with all cases passing.

## 9. Wire-shape barrel sweep

- [x] 9.1 Inspect `packages/shared/src/wire/mod.ts` and confirm that the SPA's imported types (`AgentResponse`, `AgentListResponse`, `AgentEnvelope`, `AgentStatus`, `EventName`, `EventFrame`, the six payload interfaces, `TicketSummaryResponse`, `PRSummaryResponse`, `ActivityEntryResponse`, `ErrorResponse`, `ErrorCode`, `Role`) are all re-exported. If any are missing, add the `export type { ... } from "./..."` lines in alphabetical order.
- [x] 9.2 Run `deno task check` from the workspace root. Confirm the SPA's `apiClient` method signatures and the `AgentRosterCard` destructure compile against the barrel-exported types (no inline re-declaration in the SPA).
- [x] 9.3 Drift check (manual): temporarily add `labels: readonly string[]` to `AgentResponse` in `packages/shared/src/wire/agents.ts`. Run `deno task check`. Confirm the SPA fails with a TypeScript error pointing at `AgentRosterCard.tsx` (the destructure missing `labels`) or at `apiClient.ts`'s `listAgents` return type. Revert the change and re-check green.

## 10. Documentation updates

- [x] 10.1 Open `README.md` and locate the existing "SPA stack (to be wired)" subsection. Replace it with a "Run the SPA" subsection that documents: `cd packages/spa && deno task dev` (Vite dev server on a default port); `KENI_SERVER_URL` env-var with default `http://127.0.0.1:8000` (and how to point it at a `--port 0`-bound server); `deno task build` (production bundle to `packages/spa/dist/`); `deno task preview` (preview the production bundle locally). Note that step 13 will host the bundle from the orchestration server.
- [x] 10.2 Cross-link the two new capability specs from the README's "Run the SPA" subsection: one link to `openspec/changes/spa-shell-and-agent-roster/specs/spa-shell/spec.md` (and a note that it moves to `openspec/specs/spa-shell/spec.md` post-archive), one link to the `spa-agent-roster` spec.
- [x] 10.3 Update the README's "Repository layout" tree if it shows the SPA's old single-file layout (`packages/spa/src/main.ts`); make it reflect the new shape (`packages/spa/src/{main.tsx, App.tsx, ...}`).
- [x] 10.4 Update `packages/shared/src/storage/README.md` "Wire shapes vs. storage records" subsection (or add a new short paragraph) noting that `@keni/spa` is now a documented consumer of the wire barrel, and that "every wire type the SPA needs is re-exported from the barrel" is the rule.
- [x] 10.5 Verify: `deno task fmt:check` exits 0 against the modified markdown files; the README's "Run the SPA" links resolve to existing files.

## 11. Capability-spec verification (delta-spec walk)

- [x] 11.1 Walk every requirement in `openspec/changes/spa-shell-and-agent-roster/specs/spa-shell/spec.md` and map it to the test (or structural artifact) that satisfies it. Add a "Spec walk verification" block at the bottom of `tasks.md` (or a sibling note) listing each requirement → test pair.
- [x] 11.2 Walk every requirement in `openspec/changes/spa-shell-and-agent-roster/specs/spa-agent-roster/spec.md` the same way.
- [x] 11.3 Walk the `developer-setup` delta: confirm the README modifications match the MODIFIED requirement's scenarios (the SPA stack sentence no longer defers to a later change; the "Run the SPA" subsection covers `KENI_SERVER_URL` and the three SPA tasks; the `build` task is no longer `echo noop`); confirm the placeholder `main_test.ts` is removed and the new SPA test files contribute to `deno task test`.
- [x] 11.4 Drift check (manual): temporarily switch `chatPanelEnabled` to `true` in `prototypeFlags.ts`. Confirm `AppShell_test.tsx`'s "chat hidden" scenario fails (the second `<aside>` is now in the DOM). Revert.
- [x] 11.5 Drift check (manual): rename `ROSTER_REFETCH_DEBOUNCE_MS` to a different value (e.g., `2500`). Confirm `AgentRosterPanel_test.tsx`'s debounce-collapse scenario fails (the burst no longer collapses within the test's fake-clock budget). Revert.

## 12. End-to-end verification

- [x] 12.1 `deno install --frozen` exits 0 (after the lockfile refresh in 1.2).
- [x] 12.2 `deno task fmt:check` exits 0 (every new `.ts`, `.tsx`, `.css`, `.html`, `.json` file is `deno fmt`-clean).
- [x] 12.3 `deno task lint` exits 0 across the workspace; no new lint violations in the SPA package.
- [x] 12.4 `deno task check` exits 0 across the workspace; the SPA's `apiClient`, `eventsClient`, and components type-check against the imported `@keni/shared/wire/` types.
- [x] 12.5 `deno task test` exits 0; the SPA package contributes the documented number of new test cases (at least one per the file list in §1–§8). Aggregate failure count is 0.
- [x] 12.6 `deno task build` exits 0 from the workspace root; `packages/spa/dist/index.html` exists; the bundle is non-empty.
- [x] 12.7 End-to-end smoke test: in one terminal run a fresh `mktemp -d`, `deno run -A packages/cli/src/main.ts init .`, then `deno run -A packages/server/src/main.ts --project <tempDir> --port 8000`. In a second terminal run `cd packages/spa && deno task dev`. Open the printed dev URL in a browser. Confirm: the dashboard loads; the top-nav shows the project id and a `Live` connection indicator; the left roster shows the seeded `alice` row with `Idle` status and a `Pause` button. Click `Pause` and observe the button flip to `Resume`. In the first terminal run `curl -X POST -H "X-Keni-Role: user" http://127.0.0.1:8000/agents/alice/resume`. Observe the SPA's button flip back to `Pause` (the `agent.state_changed` frame). Stop the server (`Ctrl+C`); observe the connection indicator turn red; restart the server and observe the indicator return to `Live` and the roster refetch (the `paused` flag is back to `false` per the in-memory tier).

## 13. CI and hand-off

- [x] 13.1 Local CI dry-run all green: `deno install --frozen`, `deno task fmt:check`, `deno task lint`, `deno task check`, `deno task test`. Wall-time should be modest (ten-second order); the SPA's tests dominate the new wall time but are bounded.
- [x] 13.2 `git status --short` matches the documented file set: SPA files (added — Vite config, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/prototypeFlags.ts`, `src/test_setup.ts`, `src/theme/tokens.css`, `src/shell/*.{tsx,css,_test.tsx}`, `src/routes/*.tsx`, `src/transport/*.{ts,_test.ts}`, `src/features/agentRoster/*.{tsx,css,ts,_test.tsx,_test.ts}`); SPA files (removed — `src/main.ts`, `src/main_test.ts`); modified — `packages/spa/deno.json`, `packages/shared/src/wire/mod.ts` (if any barrel additions), `packages/shared/src/storage/README.md`, `README.md`, `.gitignore` (if `dist/` and `node_modules/` weren't already covered); openspec change tree complete (proposal, design, three spec files, tasks).
- [x] 13.3 `openspec validate spa-shell-and-agent-roster` reports `Change 'spa-shell-and-agent-roster' is valid`; `openspec status --change spa-shell-and-agent-roster --json` reports `"isComplete": true` with all four artifacts (`proposal`, `design`, `specs`, `tasks`) at `"status": "done"`.
- [x] 13.4 `git status --short -- initial-implementation-plan/` is empty and `git diff --name-only -- initial-implementation-plan/` is empty — this change is strictly additive on top of the plan input.
- [x] 13.5 Hand-off block recorded at the bottom of this file (see "Hand-off to downstream steps" below).

## Spec walk verification

The mapping below pairs each requirement in the change's three spec files to the test (or
structural artifact) that satisfies it. Every requirement is covered.

### `spa-shell` capability

| Requirement                                                              | Satisfied by                                                                                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| SPA is a Vite + React app with documented Deno tasks                     | `packages/spa/deno.json` (`dev`, `build`, `preview`, `test`); `vite.config.ts`; build smoke in §1.6                                       |
| Vite dev server proxies `/api` and `/events` to `KENI_SERVER_URL`        | `packages/spa/vite.config.ts` `server.proxy` (rewrite + `ws: true`)                                                                       |
| `apiClient` is the single REST seam, with `KeniApiError`                 | `packages/spa/src/transport/apiClient.ts`; `apiClient_test.ts` cases 1-7                                                                  |
| `eventsClient` is the single WS seam, with reconnect + lifecycle events  | `packages/spa/src/transport/eventsClient.ts`; `eventsClient_test.ts` cases 1-7                                                            |
| Three-region grid shell with optional chat region                        | `packages/spa/src/shell/AppShell.tsx` + `AppShell.css`; `AppShell_test.tsx` "renders the three-region grid" + "renders the chat region"   |
| `TopNav` shows project id + connection indicator                         | `packages/spa/src/shell/TopNav.tsx`; rendered structurally inside `AppShell_test.tsx`                                                     |
| `react-router-dom` v6 routing with index, drill-downs, and `*` catch-all | `packages/spa/src/App.tsx`; `AppShell_test.tsx` "index route", "/tickets/:id", "unknown path" cases                                       |
| CSS design tokens via `:root` custom properties + dark mode              | `packages/spa/src/theme/tokens.css`; `index.css` `@import` chain                                                                          |
| Component tests run under `happy-dom` via `test_setup.ts`                | `packages/spa/src/test_setup.ts`; every `*_test.tsx` imports it first                                                                     |
| Wire shapes consumed only via `@keni/shared` barrel                      | `apiClient.ts`, `AgentRosterCard.tsx` import from `@keni/shared`; `wire/mod.ts` re-exports verified in §9.1; drift check in §9.3 / §11.3  |

### `spa-agent-roster` capability

| Requirement                                                            | Satisfied by                                                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AgentRosterPanel` mounts and loads via `apiClient.listAgents()`       | `AgentRosterPanel.tsx` mount effect; test "loads agents on mount and renders one card per row"              |
| `AgentRosterCard` renders id, role, status, last_activity, last_active | `AgentRosterCard.tsx`; rendered in panel test, `data-status`/`data-paused` attrs asserted                   |
| Pause/resume button flips label on `agent.paused`                      | `AgentRosterCard.tsx` `buttonLabel`; panel test "clicking the toggle calls pauseAgent"                      |
| Optimistic pause/resume with rollback on REST rejection                | `AgentRosterPanel.tsx` `togglePause`; tests "optimistic state synchronously" and "rolls back …card-error"   |
| `agent.state_changed` frame updates the matching row in place         | `AgentRosterPanel.tsx` frame handler; test "flips a card status when an agent.state_changed frame arrives"  |
| `activity.appended` frames trigger a `ROSTER_REFETCH_DEBOUNCE_MS` refetch | `AgentRosterPanel.tsx` debounce timer; test "collapses a burst of activity.appended frames"                 |
| `connecting → connected` lifecycle triggers an unconditional refetch  | `AgentRosterPanel.tsx` lifecycle handler; test "a connecting → connected lifecycle transition triggers …"   |
| `disconnected` lifecycle dims cards via `data-disconnected="true"`     | `AgentRosterPanel.css`; test "a disconnected lifecycle event marks the panel"                               |
| Loading / empty / error states are explicit                             | `AgentRosterPanel.tsx` render branches; tests "renders the empty state" and "renders the error state"      |
| `formatRelativeTime` covers documented bands                           | `formatRelativeTime.ts`; `formatRelativeTime_test.ts` 11 boundary cases                                     |
| Roster preserves order from `listAgents`                               | `AgentRosterPanel.tsx` `agents.map` preserves array order; in-place merge in `agent.state_changed` handler  |
| Pause/resume button is keyboard-accessible (`<button type="button">` with `aria-pressed`/`aria-label`) | `AgentRosterCard.tsx` button props                                                                          |

### `developer-setup` delta

| Requirement                                                          | Satisfied by                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| README documents the contributor onboarding path (SPA section live) | `README.md` "Run the SPA" subsection (replaces "SPA stack (to be wired)"); links to both new capability specs               |
| SPA `build` task produces a real bundle                              | `packages/spa/deno.json` `tasks.build` runs Vite; smoke-built in §1.6 → `dist/index.html` + JS + CSS chunks                  |
| SPA test files contribute to workspace `deno task test`              | `apiClient_test.ts`, `eventsClient_test.ts`, `formatRelativeTime_test.ts`, `AppShell_test.tsx`, `AgentRosterPanel_test.tsx` |

## Hand-off to downstream steps

### What downstream steps inherit from this change

**Step 11 (SPA board + drill-downs).** Step 11 is the first consumer of the routing scaffold and the centre region. It inherits:

- The `<BoardPlaceholder />` mount point in the `index` route — step 11 replaces it with the real kanban board component.
- The four placeholder routes (`/tickets/:id`, `/prs/:id`, `/activity`) — step 11 replaces each `<RoutePlaceholder />` with the real view.
- The typed `apiClient` — step 11 adds `getTicket(id)`, `getPr(id)`, `transitionTicket(id, from, to)`, etc., as new methods on the existing interface.
- The typed `eventsClient` — step 11's board reducer narrows on `EventFrame.event` to apply `ticket.created` / `ticket.updated` / `pr.created` / `pr.updated` updates.
- The "client refetches via REST on (re)connect" tier — step 11's board panel re-issues `listTickets()` and `listPrs()` on every `live` lifecycle transition, mirroring the roster panel's pattern.

**Step 12 (interrupt / timeout controls).** Step 12 lands on the same roster card. It inherits:

- The `<AgentRosterCard>` component — step 12 adds an "Interrupt" button alongside the existing pause/resume toggle, calling a new `apiClient.interruptAgent(id)` method.
- The optimistic-update + REST-envelope rollback pattern — step 12's interrupt button uses the same shape.
- The `data-testid="card-error"` slot — step 12 surfaces interrupt failures through it.

**Step 13 (`keni start` end-to-end wiring).** Step 13 ships the first production deployment. It inherits:

- The `packages/spa/dist/` static bundle — step 13's `keni start` mounts it via a `serveDir`-style middleware on the orchestration server's Hono app, so the dev-server proxy is no longer required in production.
- The same-origin assumption — step 13 keeps the SPA same-origin with the API; no CORS configuration is needed.
- The `apiClient`'s `baseUrl: ""` default — when same-origin, the empty baseUrl is correct unchanged.

**Step 23 (chat panel).** Step 23 unhides the right region of the shell. It inherits:

- The `prototypeFlags.ts` flag `chatPanelEnabled` — step 23 flips it to `true` (or replaces it with a real per-feature flag).
- The third grid column in `AppShell` — step 23's chat panel renders inside the right `<aside>` slot.
- The `apiClient` — step 23 adds `listChatMessages`, `appendChatMessage`, `closeChatSession` methods.
- The `eventsClient` — step 23 narrows on the new chat-related `EventFrame` variants once they are added to the wire.

**Step 24 (spec viewer + CR list).** Step 24 adds two more routes. It inherits:

- The routing scaffold pattern — adding `/spec` and `/changes` routes is two `<Route>` lines next to the existing four.
- The `apiClient` — step 24 adds spec / CR read methods.

**Step 25 (manual override flow).** Step 25 wraps the existing pause/resume affordance in a confirmation modal. It inherits:

- The `pauseAgent` / `resumeAgent` `apiClient` methods — step 25 wraps the existing toggle's click handler in a `<ConfirmManualOverride>` modal but does not change the underlying transport.

### What downstream steps must NOT do

- **Do not introduce a second REST client.** Every HTTP call to the orchestration server flows through `apiClient`. A new endpoint adds a method to the existing interface; no new client.
- **Do not introduce a second WebSocket client.** Every WS connection to the orchestration server flows through `eventsClient`. A new event variant adds a case to the existing typed dispatch; no new client.
- **Do not declare wire types in the SPA.** Every wire shape comes from `@keni/shared/wire/` via the barrel. The drift check in §11.3 enforces this at compile time.
- **Do not bypass the role header.** The SPA always sends `X-Keni-Role: user` — there is no role switcher and the prototype trust model assumes the SPA is the user. Future auth (post-MVP) wraps the existing methods; it does not bypass them.
- **Do not assume client-side caching beyond local React state.** The "refetch on (re)connect" tier is the current contract. A future change that adds a global cache (Zustand, react-query) does so explicitly with its own openspec change and design rationale.
- **Do not add ad-hoc CSS-in-JS or a UI library.** Tokens via CSS custom properties + plain `.css` files are the convention. Adopting a UI kit (Radix, MUI, shadcn/ui) is a deliberate future change with its own spec.
- **Do not bypass the proxy in dev.** The dev workflow assumes same-origin via the Vite proxy; if a future change wants direct cross-origin in dev, it must configure CORS on the server (and document the change).
