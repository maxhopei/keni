## Why

Steps 04 and 05 shipped the orchestration server: `GET /agents`, `GET /tickets`, `GET /prs`, `GET /activity` plus a live WebSocket at `/events`, all governed by the `X-Keni-Role` / `?role=` trust model. Step 09 then made an actual engineer run inside that server, producing a stream of activity entries and `agent.state_changed` frames. Today, however, none of that surface is visible to a human — `packages/spa/` is a placeholder file, the SPA `build` task is `echo noop`, and there is no browser code anywhere that consumes the typed wire shapes from `@keni/shared`. The project's `spec.md` §7.2 promise — "the dashboard updates live as agents move tickets" — and the §6.1 "user can pause or resume any individual agent from the UI" affordance are both structurally blocked on the same missing piece: a real SPA package with a build pipeline, a typed REST + WebSocket client, a routed shell, and a working agent-roster panel. Step 10 closes that gap by turning `packages/spa/` from a stub into a runnable browser app whose left pane already renders the configured roster, updates live as agents go `running` / `idle`, and lets the user flip the `paused` flag through the existing `/agents/:id/{pause,resume}` endpoints. Step 11 (board + drill-downs) and steps 12 (interrupt / timeout controls), 13 (`keni start` serving the bundle), 23 (chat panel), and 24 (spec viewer / CR list) all plug into the routing scaffold, REST/WS plumbing, and three-region shell this step ships.

## What Changes

- Wire **`packages/spa/`** into a real Vite + React app built and dev-served via `@deno/vite-plugin`:
  - Replace the placeholder `src/main.ts` with a Vite-shaped entry: `src/main.tsx` (React root mount onto `index.html`'s `#root`), `src/App.tsx` (top-level route + layout shell), `src/index.css` (CSS reset + design tokens), and an `index.html` at the package root that Vite consumes.
  - Add a `vite.config.ts` at the package root that registers `@deno/vite-plugin` and `@vitejs/plugin-react`, sets the dev server port (default 5173, overridable via `--port`), enables a `/api` and `/events` proxy to a configurable orchestration-server origin (`KENI_SERVER_URL`, default `http://127.0.0.1:8000`) so `fetch("/api/...")` and `new WebSocket("/events")` work in dev without CORS, and sets `build.outDir` to `dist/` (relative to the package).
  - Replace the package's `tasks` block with `dev` (`vite`), `build` (`vite build`), `preview` (`vite preview`), and `test` (`deno test -A`) so the workspace-level `deno task build` produces a real static bundle and `deno task test` still hits at least one `Deno.test` per the `developer-setup` capability.
  - Pin the React major (`^18` or whatever the most recent Vite-friendly major is at the change's land time) and Vite major in `packages/spa/deno.json`'s `imports` map; do not pull these into the workspace-root `deno.json` (the SPA is the only consumer).
- Stand up a **typed REST + WebSocket client** under `packages/spa/src/transport/`:
  - `apiClient.ts` — a thin `fetch`-based wrapper that always sends `X-Keni-Role: user`, parses the documented `{ data, project_id }` envelope, and surfaces `ErrorResponse` failures as a typed `KeniApiError` (carrying `status`, `code`, `message`, `details`). One method per documented endpoint the prototype consumes today (`listAgents`, `pauseAgent`, `resumeAgent`, `listTickets`, `listPrs`, `listActivity`); each method's return type is the matching `@keni/shared/wire/...` type. No code generation — the client is hand-written against the shared types so the type-check is the contract.
  - `eventsClient.ts` — a small reconnecting WebSocket client. On connect it opens `ws://<server>/events?role=user`, subscribes to incoming `EventFrame`s, and exposes `subscribe(handler)` / `close()` to consumers. On `close` / `error`, it backs off (initial 500 ms, exponential to a 30 s ceiling, with a small jitter) and reconnects; on every successful reconnect it emits a typed `connected` lifecycle event so consumers can refetch their canonical state via REST (the documented prototype reconnect tier). Consumers see a single typed channel — the client owns retry, debounce, and the lifecycle.
- Build a **three-region application shell** at `packages/spa/src/shell/`:
  - `AppShell.tsx` — a CSS-grid layout with three named regions: **left** (the agent roster, mounted from this step), **center** (the board view's mount point — a `<BoardPlaceholder />` in this step), **right** (the chat panel mount point — hidden by default in the prototype layout via a `display: none` toggle that step 23 will flip). The layout collapses to a single column under a documented breakpoint so smoke-testing on a small window stays usable; persistent panel state (e.g., right-panel visibility) lives in the layout's local React state today and migrates to the URL or a store later.
  - `TopNav.tsx` — a slim header showing the connection indicator (one of `connecting` / `live` / `disconnected`) sourced from `eventsClient`'s lifecycle events, the project id (read once via `apiClient.getProjectId()`), and a placeholder route switcher.
- Wire a **routing scaffold** at `packages/spa/src/routes/` using a tree-shakable router (the proposer picks: `react-router-dom` v6 is the obvious default; an alternative is documented in `design.md`). Routes registered today:
  - `/` (dashboard — renders the `AppShell` with the live roster on the left and the board placeholder in the center).
  - `/tickets/:id` (ticket detail — placeholder component that renders the id and a "Coming in step 11" notice).
  - `/prs/:id` (PR detail — same placeholder shape).
  - `/activity` (activity log — placeholder).
  - `/404` plus a catch-all that renders it.
  - The placeholder routes share a single `<RoutePlaceholder title="…" stepRef="step-11" />` component so the structural test for "every documented route mounts a component" can assert on it without N near-identical files.
- Build the **agent roster panel** at `packages/spa/src/features/agentRoster/` (per `spec.md` §7.2 left region):
  - `AgentRosterPanel.tsx` — the panel container. On mount, it calls `apiClient.listAgents()` once for the initial state, then subscribes to `eventsClient` for `agent.state_changed` and `activity.appended` frames. `agent.state_changed` updates a single agent's `paused` and `status`; `activity.appended` triggers a debounced refetch of `apiClient.listAgents()` (250 ms trailing) so `last_activity` and `last_active_at` come from the canonical REST envelope rather than being inferred client-side. On `eventsClient` `connected` (initial or reconnect), the panel re-issues `listAgents()` to reconcile.
  - `AgentRosterCard.tsx` — one card per agent. Renders the documented fields verbatim from the `AgentResponse` wire type: `id`, `role`, `status` (with a small `running` / `idle` indicator), `last_activity` (the event name string, or "—" when null), `last_active_at` (rendered as a relative time via a tiny `formatRelativeTime` helper, or "—" when null), and a `paused` toggle button. Clicking the toggle calls `apiClient.pauseAgent(id)` or `resumeAgent(id)` per the current state, applies the response optimistically, and falls back to the REST envelope on error (no mid-call disabled state — the optimistic rollback is the only failure UX).
  - **Empty / loading / error states** are explicit: `loading` (spinner card before the first list returns); `empty` (a "No agents configured. Add one to `.keni/project.yaml`." panel — the project starts with `alice` so this is rare); `error` (a one-line failure message with a "Retry" button that re-issues `listAgents()`); `disconnected` (the `<TopNav>` indicator goes red but the cards keep showing the last-seen state).
- Add **basic theming and design tokens** at `packages/spa/src/theme/`:
  - A small `tokens.css` (or equivalent — picked in `design.md`) defining color, spacing, typography, and elevation tokens. No theme-switcher today; the values map to `prefers-color-scheme: dark` and `light` so the dev experience is reasonable on either system theme.
  - The roster card, top nav, and shell consume tokens via CSS custom properties. No CSS-in-JS runtime; styles are static and shipped in the bundle.
- **Tests** — the SPA gains its first three test files plus a unit test for the API client:
  - `packages/spa/src/transport/apiClient_test.ts` — `Deno.test` cases that drive `apiClient` against a `Deno.serve`-backed mock orchestration server (responses match the documented envelope and error shapes); covers happy-path list calls, the pause/resume calls, the role-header stamping, and the `KeniApiError` mapping.
  - `packages/spa/src/transport/eventsClient_test.ts` — `Deno.test` cases for the reconnecting client: the reconnect sequence on socket close, the exponential-backoff schedule (asserted with a fake clock), the `connected` lifecycle event, the per-frame typed dispatch.
  - `packages/spa/src/features/agentRoster/AgentRosterPanel_test.tsx` — a React component test using `@testing-library/react` running in a JSDOM-backed Deno test (configured per `design.md`) that mounts the panel against an in-memory `apiClient` + `eventsClient` and asserts: the panel renders the seeded roster, an `agent.state_changed` frame flips the right card's `paused` flag, the toggle calls `pauseAgent`, and the empty / error states render as documented.
  - `packages/spa/src/shell/AppShell_test.tsx` — one structural test that the three regions are present and the right region is hidden when the prototype flag is set.
- Update the **`@keni/shared/wire/` re-exports** if needed to make the SPA's imports stable: no new types are added (the SPA consumes existing `AgentResponse`, `EventFrame`, `TicketSummaryResponse`, `PRSummaryResponse`, `ActivityEntryResponse`, `ErrorResponse`, etc.), but the `mod.ts` barrel SHALL re-export every type the SPA imports so `import type { … } from "@keni/shared"` is the single import path. This is a non-breaking additive sweep of the barrel and is the only change to `@keni/shared` in this step.
- Update **root `README.md`**:
  - Drop the existing "SPA stack (to be wired)" paragraph (which currently says the wiring lands "in a later change `spa-shell-and-agent-roster`") and replace it with a "Run the SPA" subsection: `cd packages/spa && deno task dev` for the dev server (proxy to a running orchestration server), `deno task build` for a static `dist/` bundle, and a one-line note that step 13 will wire the bundle into `keni start`.
  - Cross-link the new `spa-shell` capability spec (the contract for routing, REST/WS clients, the shell, theming) and the `spa-agent-roster` capability spec (the contract for the roster card, pause/resume UX, debounce, lifecycle states).
- Update **`packages/shared/src/storage/README.md`** with one paragraph: the SPA is now a documented consumer of `@keni/shared/wire/`, and the rule "every wire type the SPA needs is re-exported from the barrel" lives there.

## Capabilities

### New Capabilities

- `spa-shell`: the contract for the SPA package's framework choice (React + Vite via `@deno/vite-plugin`), build / dev tasks (`deno task dev`, `deno task build`, `deno task preview`), the typed REST client (`apiClient`), the reconnecting WebSocket client (`eventsClient`) and its lifecycle / backoff semantics, the three-region application shell, the routing scaffold (the four documented routes plus the catch-all and the shared placeholder pattern), the connection-indicator surface, and the theming / design-token convention. This is the "everything that is not the roster panel" half of the SPA contract — the parts every later SPA step (board, drill-downs, chat, spec viewer, CR list) plugs into without re-deciding.
- `spa-agent-roster`: the contract for the left-region agent roster — its card shape (the exact `AgentResponse` fields rendered, in the documented order, with the documented "—" fallback for nulls), the pause/resume affordance (which endpoints it calls, the optimistic-update + REST-envelope rollback rule), the live-update protocol (which `EventFrame` variants drive which fields, the 250 ms debounce on `activity.appended`-driven refetches, the `connected` lifecycle reconciliation), and the documented empty / loading / error / disconnected states. Lives in its own capability so future changes (e.g., post-MVP "show queue depth on each card") modify exactly one spec file without diffing the whole shell contract.

### Modified Capabilities

- `developer-setup`: drop the existing "with the actual Vite wiring deferred to a later change (`spa-shell-and-agent-roster` …)" wording from the "README documents the contributor onboarding path" requirement (the wiring lands here), and add a small additive scenario that the SPA package's `build` task now produces a real `dist/` directory (no longer `echo noop`) and that running `deno task test` from the repo root still exercises at least one `Deno.test` in `packages/spa/` (the existing five-package contract is preserved by the new SPA test files). No change to the existing five-package layout, the workspace tasks, the lockfile contract, the CI workflow, the hygiene-files contract, or the prompts-as-code convention.

## Impact

- **Affected code** — SPA package (most net-new):
  - `packages/spa/index.html` (new) — Vite entry, mounts `<div id="root">`.
  - `packages/spa/vite.config.ts` (new) — registers `@deno/vite-plugin` + `@vitejs/plugin-react`, dev-server `/api` and `/events` proxy to `KENI_SERVER_URL`, `build.outDir: "dist/"`.
  - `packages/spa/deno.json` (modified) — `tasks.dev`, `tasks.build`, `tasks.preview`, `tasks.test`; `imports` adds `react`, `react-dom`, `react-router-dom`, `@vitejs/plugin-react`, `vite`, `@deno/vite-plugin`, `@testing-library/react`, `@testing-library/jest-dom`, JSDOM (or the picked alternative).
  - `packages/spa/src/main.tsx` (replaces `main.ts`) — React 18 `createRoot(document.getElementById("root")!).render(<App />)`.
  - `packages/spa/src/App.tsx` (new) — `<BrowserRouter>` + the documented routes.
  - `packages/spa/src/index.css` (new) — reset + token wiring.
  - `packages/spa/src/theme/tokens.css` (new) — color / spacing / typography / elevation tokens, both light and dark themes.
  - `packages/spa/src/shell/AppShell.tsx` (new) — three-region grid; left = `<AgentRosterPanel />`, center = `<BoardPlaceholder />`, right = chat slot (hidden by prototype flag).
  - `packages/spa/src/shell/TopNav.tsx` (new) — connection indicator, project id, route switcher.
  - `packages/spa/src/shell/BoardPlaceholder.tsx` (new) — "Step 11 lands here" panel.
  - `packages/spa/src/shell/AppShell_test.tsx` (new) — region-presence + hidden-right test.
  - `packages/spa/src/routes/RoutePlaceholder.tsx` (new) — shared placeholder component for `/tickets/:id`, `/prs/:id`, `/activity`, `/404`.
  - `packages/spa/src/routes/NotFound.tsx` (new) — small wrapper around the placeholder for the catch-all.
  - `packages/spa/src/transport/apiClient.ts` + `apiClient_test.ts` (new) — typed REST client, `KeniApiError`, the documented method set.
  - `packages/spa/src/transport/eventsClient.ts` + `eventsClient_test.ts` (new) — reconnecting WS client, exponential backoff, `connected` lifecycle event, typed frame dispatch.
  - `packages/spa/src/features/agentRoster/AgentRosterPanel.tsx` (new) — the panel container; subscribes to the events client, debounces refetches, owns loading / empty / error / disconnected states.
  - `packages/spa/src/features/agentRoster/AgentRosterCard.tsx` (new) — one card per agent, the pause / resume toggle.
  - `packages/spa/src/features/agentRoster/AgentRosterPanel_test.tsx` (new) — the React component test (mounts the panel, drives a frame, asserts on the toggle).
  - `packages/spa/src/features/agentRoster/formatRelativeTime.ts` + a unit test (new) — small pure helper for `last_active_at`.
- **Affected code** — outside the SPA:
  - `packages/shared/src/wire/mod.ts` (modified, additive) — confirm every type the SPA imports is re-exported (`AgentResponse`, `AgentListResponse`, `EventFrame`, `EventName`, all six payload interfaces, `TicketSummaryResponse`, `PRSummaryResponse`, `ActivityEntryResponse`, `ErrorResponse`, `Role`). No new types.
  - `packages/shared/src/storage/README.md` (modified) — one paragraph naming the SPA as a documented consumer of the wire barrel.
  - `README.md` (modified) — replace the "SPA stack (to be wired)" paragraph with a "Run the SPA" subsection (dev server, build, preview, proxy env-var); cross-link the two new capability specs.
  - `openspec/changes/spa-shell-and-agent-roster/specs/spa-shell/spec.md` (new) — the new capability spec.
  - `openspec/changes/spa-shell-and-agent-roster/specs/spa-agent-roster/spec.md` (new) — the new capability spec.
  - `openspec/changes/spa-shell-and-agent-roster/specs/developer-setup/spec.md` (new — delta) — the small additive change to the README requirement and the SPA-test contribution.
- **Affected APIs / contracts**:
  - **Public (HTTP)**: none. The SPA is a consumer of `GET /agents`, `POST /agents/:id/pause`, `POST /agents/:id/resume`, `GET /tickets`, `GET /prs`, `GET /activity`, and the `/events` WebSocket — all already shipped by step 04 and step 05 — and does not introduce any new endpoint.
  - **Public (TS via `@keni/shared/wire/`)**: no new types. The barrel may grow re-exports.
  - **Public (TS via `@keni/spa`)**: the package previously exported only `packageName` from `src/main.ts`. It now ships a real React app from `src/main.tsx` and is consumed via the dev server / static bundle, not as a library. No external consumer imports `@keni/spa` source.
  - **CLI**: no new CLI flags. Step 13 will wire `keni start` to serve the static bundle.
- **Affected dependencies** — new (all SPA-local, none added to the root `deno.json`):
  - `react` (`^18.x`), `react-dom` (`^18.x`).
  - `react-router-dom` (`^6.x`) — or the picked alternative, documented in `design.md`.
  - `vite` (`^5.x`), `@vitejs/plugin-react` (`^4.x`), `@deno/vite-plugin` (`^1.x` — the JSR version that the existing `developer-setup` README sentence already commits to).
  - `@testing-library/react` + `@testing-library/jest-dom` for the React component test; a JSDOM (or `happy-dom` — picked in `design.md`) test environment registered in the SPA's `deno.json`. No change to other packages' dev dependencies.
  - **No new runtime dependencies** in `cli`, `server`, `role-runtimes`, or `shared`.
- **Affected tests**:
  - **New (SPA package)**: `apiClient_test.ts`, `eventsClient_test.ts`, `AgentRosterPanel_test.tsx`, `AppShell_test.tsx`, `formatRelativeTime_test.ts`. Estimated ~25 new tests; per the `developer-setup` capability the package's `Deno.test` count is now well above the "at least one" floor (which the placeholder `main_test.ts` already satisfied).
  - **Removed**: the placeholder `packages/spa/src/main_test.ts` (its sole assertion that `packageName === "@keni/spa"` is replaced by the real test files; `developer-setup` only requires "at least one test" per package, which the new files satisfy).
  - **Unchanged**: every existing test in `cli`, `server`, `role-runtimes`, and `shared` continues to pass; the workspace-level `deno task test` count grows by ~25.
- **Downstream steps unblocked**:
  - **Step 11 (board + drill-downs)** plugs the kanban into the center region's `<BoardPlaceholder />` mount point and replaces the four `<RoutePlaceholder />` routes (ticket detail, PR detail, activity log) with real views; the REST client gains `getTicket`, `getPr`, `transitionTicket`, etc., the WS client's typed `EventFrame` dispatch is the optimistic-update channel.
  - **Step 12 (interrupt / timeout controls)** adds an "Interrupt" affordance to the roster card (the `paused` toggle's sibling) and a per-card timeout indicator; the `eventsClient`'s reconnect tier is the seam.
  - **Step 13 (`keni start` end-to-end wiring)** serves the SPA's `dist/` bundle from the orchestration server and removes the `KENI_SERVER_URL` proxy from the dev workflow for production.
  - **Step 23 (chat panel)** unhides the right region of `AppShell`, mounts a chat component, and reuses the same `apiClient` / `eventsClient` plumbing — only the WS frame names and REST endpoints differ.
  - **Step 24 (spec viewer + CR list)** adds two more routes to the routing scaffold without altering the shell.
  - **Step 25 (manual-override flow)** lands a confirmation modal on the same `pauseAgent` / `resumeAgent` calls when the underlying REST endpoint is a status transition that the user has overridden; the SPA's transport seam is unchanged.
- **Non-impact (deliberate)**:
  - **No board view, no ticket detail, no PR detail, no activity-log view.** Step 11.
  - **No interrupt / timeout UX.** Step 12.
  - **No chat panel.** Step 23.
  - **No spec viewer or CR list.** Step 24.
  - **No manual-override confirmation modal.** Step 25.
  - **No project-settings UI.** Post-MVP per `spec.md` §10.
  - **No multi-project switcher.** Post-MVP per `spec.md` §10.
  - **No SPA-side persistence** beyond local React state. The reconnect tier is "refetch from REST" (the contract step 05 already enforced); the SPA does not cache responses beyond the lifetime of a panel mount.
  - **No service worker, no PWA.** The SPA is a local-only dev tool in the prototype.
  - **No OpenAPI / typed-client codegen.** The hand-written client against `@keni/shared` is the contract; type-check is the drift detector. Codegen is post-MVP if the surface ever grows enough to warrant it.
  - **No new orchestration-server endpoints, no new wire types, no new `EventName` variants.** This step is purely a consumer of the existing surface.
  - **No CI workflow change.** `deno task test` grows by ~25 cases but the workflow file is unchanged.
