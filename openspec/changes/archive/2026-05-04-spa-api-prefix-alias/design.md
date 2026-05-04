## Context

The orchestration server hosts two route surfaces today: a typed REST + WebSocket API at `/agents`, `/tickets`, `/prs`, `/activity`, `/health`, `/events`, and (when `staticAssetsRoot` is supplied) a static SPA route group serving `index.html` and `/assets/*` from the production SPA bundle.

The SPA's transport client (`packages/spa/src/transport/apiClient.ts`) hardcodes every URL with an `/api/...` prefix because the dev-mode wire goes through a Vite proxy that strips the prefix on its way to the orchestration server (`packages/spa/vite.config.ts` line 18: `rewrite: (p) => p.replace(/^\/api/, "")`). In production-mode `keni start`, both surfaces are served from the same Hono app on the same loopback port — there is no Vite proxy. The result is a wire mismatch:

- Browser issues `GET /api/agents`.
- `roleIdentity` middleware exempts non-REST GETs (and `/api/agents` is not REST-prefixed), so the role guard does not block.
- The route groups are mounted at `/agents`, not `/api/agents` — no match.
- The SPA fallthrough (`app.get("*")` in `mountStaticSpa`) runs. `isRestPrefixed("/api/agents")` is `false`, so it serves `index.html`.
- The browser parses HTML as JSON, the SPA's React Query layer surfaces a parse error, the dashboard renders an empty agent roster forever.

This design is the minimum viable wire-protocol fix that makes the production-mode SPA + same-origin REST loop work without breaking the dev-mode wire, the bare-prefix REST callers (the engineer MCP server's `httpClient`, the role-runtime's `activityClient`, the README's smoke-test `curl` calls), or any existing test.

## Goals / Non-Goals

**Goals:**

- Production-mode `keni start` (the default — orchestration server hosts both the bundled SPA and the REST API) renders the dashboard and drives the four-step `spec.md` §8 runbook end-to-end without any further user configuration.
- Every documented REST and WS route becomes reachable under two equivalent URLs: the bare form (`/agents`) and the `/api`-prefixed form (`/api/agents`). The two URLs hit the same handler, the same store, the same event bus, the same role guard.
- `REST_PREFIXES` remains the single source of truth for the SPA fallthrough; adding `/api` to it preserves the closed-allowlist contract (a future contributor adding a new REST prefix updates this constant in lock-step with `createServer`).
- Dev-mode SPA wire (separate Vite dev server in front of the orchestration server) keeps working unchanged. Vite still strips `/api/`, the orchestration server still receives `/agents`-shaped paths, the existing tests cover that path verbatim.
- Existing bare-prefix callers — the README's `curl`, the engineer MCP's `HttpClient`, the role-runtime's `activityClient`, and every existing `*_test.ts` — keep working without modification.

**Non-Goals:**

- We do NOT remove the bare-prefix routes. The bare form remains the canonical wire for non-browser callers (CLI tooling, MCP, role runtimes) that have always used it. Both forms are first-class and equivalent.
- We do NOT change the SPA's `apiClient` to drop the `/api` prefix. Touching the SPA-side client would cascade through every test stub, the `spa-shell` capability spec scenario verbatim, and the dev-server proxy semantics. The server-side alias is a smaller, more contained change.
- We do NOT introduce a flag or a config seam for enabling/disabling the alias. The alias is unconditional: the orchestration server is a local-only loopback service per `spec.md`'s "no auth, no TLS, no CORS" trust model — exposing the same endpoints under a second equivalent URL on the same loopback port has no security or performance implication.
- We do NOT mirror the static SPA route group under `/api`. `GET /api/` is not a valid SPA path; `GET /api/assets/*` is not a valid asset path (the Vite build hardcodes assets to `/assets/*`). With `/api` in `REST_PREFIXES`, an unknown GET under `/api/...` returns the documented 404 envelope instead of `index.html` — strictly an improvement over today.
- We do NOT change the boot output line, the `cli-start` flag surface, the response envelope shape, the role-allowed-method matrix, the `EventFrame` taxonomy, or the WS protocol-ping semantics. The change is wire-protocol-additive only.

## Decisions

### Decision 1: Mount each route group's Hono sub-app at both `/<x>` and `/api/<x>`

**Decision:** Pre-build each route group's sub-app once via the existing factory (`ticketsRoutes(...)`, `prsRoutes(...)`, etc.), then call `app.route(...)` twice per group — once with the bare prefix and once with the `/api`-prefixed form. Both registrations point at the same sub-app instance.

**Rationale:** Hono v4's `app.route(prefix, sub)` walks `sub`'s internal route table and copies entries into the parent under `prefix`. Calling it twice with the same `sub` registers the same handlers under two prefixes in the parent's table. There is no per-instance mutable state in any route group's Hono — every store, event bus, mutex, and project id is captured by closure into the handler functions during the factory call, so a second mount is a pure routing-table addition with zero behavioural drift between the two URLs.

The current bare-prefix mounting block in `createServer.ts` looks like this today:

```typescript
app.route("/tickets", ticketsRoutes(deps.ticketStore, deps.eventBus, opts.projectId));
app.route("/prs", prsRoutes(deps.prStore, deps.eventBus, opts.projectId, mergeDeps));
app.route("/activity", activityRoutes(deps.activityLogStore, deps.agentRuntimeStateStore, deps.eventBus, opts.projectId));
app.route("/agents", agentsRoutes(deps.agentRuntimeStateStore, deps.eventBus, opts.projectId, deps.getScheduler, deps.pausedAgentsPersister, deps.logSink));
app.route("/events", eventsRoute(deps.eventBus));
```

After the change, each group is hoisted to a local `const` and mounted twice:

```typescript
const ticketsApp = ticketsRoutes(deps.ticketStore, deps.eventBus, opts.projectId);
const prsApp = prsRoutes(deps.prStore, deps.eventBus, opts.projectId, mergeDeps);
const activityApp = activityRoutes(deps.activityLogStore, deps.agentRuntimeStateStore, deps.eventBus, opts.projectId);
const agentsApp = agentsRoutes(deps.agentRuntimeStateStore, deps.eventBus, opts.projectId, deps.getScheduler, deps.pausedAgentsPersister, deps.logSink);
const eventsApp = eventsRoute(deps.eventBus);

for (const [bare, sub] of [
  ["/tickets", ticketsApp],
  ["/prs", prsApp],
  ["/activity", activityApp],
  ["/agents", agentsApp],
  ["/events", eventsApp],
] as const) {
  app.route(bare, sub);
  app.route(`/api${bare}`, sub);
}
```

`/health` follows the same shape but is registered before `roleIdentity` (it remains the documented unauthenticated probe; both `/health` and `/api/health` are exempt from the role guard).

**Alternatives considered:**

- *Path-rewrite middleware that strips `/api/` before route matching.* Hono v4 does not support runtime mutation of the matched path mid-pipeline. The only way to do a true rewrite is to re-enter the app via `app.fetch(rewrittenRequest)`, which would re-run `requestId` and `requestLog` and double-count every request in the log sink. Rejected as a regression on the request-log invariant (`X-Keni-Request-Id` is generated exactly once per inbound request).
- *Build a single sub-app `apiApp` that contains all non-`/health` routes mounted under their bare prefixes, then `app.route("/", apiApp)` and `app.route("/api", apiApp)`.* This works but `app.route("/", subApp)` is a less-common pattern in the existing codebase and the shape is harder to reason about when reading top-to-bottom. The chosen approach (a plain loop) is one screen of code with no cleverness.
- *Register the bare prefix and the `/api` prefix at separate factory call sites (call each factory twice).* Doubles the work at startup, doubles the closure allocations, and (more importantly) doubles the code size with no benefit. Rejected.

### Decision 2: Add `/api` to `REST_PREFIXES`

**Decision:** Extend the closed allowlist in `packages/server/src/restPrefixes.ts` to include `/api` as a single entry. The list becomes `["/agents", "/tickets", "/prs", "/activity", "/health", "/events", "/api"] as const`.

**Rationale:** The SPA fallthrough (`app.get("*")` in `mountStaticSpa`) consults `isRestPrefixed(c.req.path)` to decide whether an unmatched GET should fall through to `index.html`. Without `/api` in the list, `/api/foo` (typo or stale URL) would be served `index.html` — exactly the bug we are fixing. With `/api` in the list, `/api/foo` returns the documented 404 envelope (`store_not_found` from `app.notFound`). This is strictly correct: a SPA path beginning with `/api` is not a SPA route in any router config we ship.

**Alternatives considered:**

- *Add every `/api/<x>` prefix individually (`/api/agents`, `/api/tickets`, etc.).* Tighter type-narrowing for the `RestPrefix` union, but two surfaces to keep in sync (every new REST prefix added means two entries to add). Rejected — the single `/api` entry is enough for the fallthrough's purposes, and the closed-allowlist contract is preserved.
- *Compute the allowlist dynamically by reading the parent app's route table.* Out of scope for this change; introduces a new abstraction for no immediate benefit.

### Decision 3: Update `roleIdentity`'s WS `?role=` fallback predicate to match both `/events` and `/api/events`

**Decision:** Change the fallback predicate in `createServer.ts` from `c.req.path === "/events"` to `c.req.path === "/events" || c.req.path === "/api/events"`. Same applies to the `exempt` carve-out's path-membership check (already routed through `isRestPrefixed`, so it picks up the new `/api` prefix automatically — no change needed there).

**Rationale:** The `?role=` query-parameter fallback exists because browsers cannot set arbitrary headers on `new WebSocket(...)`. A SPA that connects to `ws://127.0.0.1:7777/api/events?role=user` (the prefixed form, matching the `apiClient`'s same-origin pattern) needs the fallback to fire on the prefixed path too. Without this update, the WS upgrade would be rejected with `400 missing_role` even though the bare-prefix counterpart works.

**Alternatives considered:**

- *Use `c.req.path.endsWith("/events")`.* Too loose — would also match `/foo/events` if a future route ever lands there. Rejected for tightness.
- *Move the predicate into a helper that consults `REST_PREFIXES`.* Reasonable, but the WS-specific concern (only `/events` and `/api/events`, not other REST routes) is narrow enough that an inline `===` check is clearer. The helper can be introduced later if a third route ever needs `?role=` fallback (none do today).

### Decision 4: The alias is unconditional, not gated on `staticAssetsRoot` or any other flag

**Decision:** Mount the `/api/<x>` aliases on every `createServer(...)` call. The alias is not predicated on `staticAssetsRoot` being supplied, on a CLI flag, or on an environment variable.

**Rationale:** The orchestration server is a local-only loopback service per `spec.md` §3 ("no auth, no TLS, no CORS"). Exposing every endpoint under a second equivalent URL on the same loopback port has zero attack surface impact. Gating the alias would create two configurations to test (alias on / alias off) and two ways for a future contributor to break the SPA wire. Unconditional is simpler and lower-risk.

The user's earlier ask was "only in dev env"; on the follow-up exchange, we settled that the deno-run-vs-future-binary distinction doesn't apply at the wire-protocol level (both run the same orchestration-server code) and that the dev-mode SPA wire (separate Vite dev server) doesn't issue `/api/*` paths to the orchestration server in the first place — so an unconditional alias is invisible in dev-mode and necessary in production-mode.

**Alternatives considered:**

- *Gate on `staticAssetsRoot !== undefined`.* The alias would be active only when the orchestration server also serves the bundled SPA. But the `--spa-dev-url` mode (where Vite serves the SPA and the orchestration server doesn't) never receives `/api/*` paths in the first place — the gate is a no-op. Rejected as needless conditionality.
- *Gate on a `KENI_API_ALIAS=1` env var (default ON).* Adds a config seam with no demonstrated need. Rejected.

### Decision 5: Tests live where the existing tests live, not in a new file

**Decision:** Add the alias-coverage assertions to the existing `restPrefixes_test.ts`, `createServer_test.ts`, and `routes/static_test.ts`. No new test file.

**Rationale:** The existing tests already cover the bare-prefix wire end-to-end. Each gains one or two new cases asserting that the prefixed form returns the same envelope as the bare form (or, for `static_test.ts`, that the SPA fallthrough no longer swallows `/api/agents`). Co-locating with the existing assertions keeps the test surface minimal and the locality of behaviour-under-test obvious.

The minimum coverage matrix is:

| File | New scenario |
| --- | --- |
| `restPrefixes_test.ts` | Literal-equality: `REST_PREFIXES` equals the new seven-entry list. `isRestPrefixed("/api")` and `isRestPrefixed("/api/anything")` are `true`. |
| `createServer_test.ts` | `GET /api/tickets` with `X-Keni-Role: user` returns the same `TicketListResponse` envelope as `GET /tickets`. `POST /api/tickets` round-trips: a ticket created via `/api/tickets` is visible via `GET /tickets` (proves shared store, single sub-app). One `EventFrame` is emitted per write regardless of which URL is used (proves no double-fire). |
| `routes/static_test.ts` | `GET /api/agents` (with `X-Keni-Role: user` and a static bundle mounted) returns the documented `AgentListResponse` JSON, NOT `index.html`. |
| `routes/events_test.ts` | The `?role=` fallback works on `/api/events?role=user` (parity with the existing `/events?role=user` test). |

Every other test continues to pass without modification.

## Risks / Trade-offs

- **Risk:** Forgetting to update the `/events` `?role=` fallback predicate in `createServer.ts` → SPA's WebSocket connect to `/api/events?role=user` is rejected with `400 missing_role`, the live-event stream silently breaks, and the SPA's fallback "refetch on connection close" behaviour goes into a tight reconnect loop. **Mitigation:** Decision 3's test in `routes/events_test.ts` covers this path explicitly.
- **Risk:** A future contributor adds a new REST route group at `/foo` and remembers to update `REST_PREFIXES` but forgets to mount the `/api/foo` alias. The bare form works, the prefixed form 404s, the SPA breaks for that endpoint only. **Mitigation:** the route-group mounting block becomes a single loop over a `const` array (Decision 1's snippet); the array is the single source of truth for "every REST group". A new entry is one line, mounted twice for free.
- **Risk:** The `/api/health` alias is exposed unauthenticated alongside `/health`. **Mitigation:** This is the documented behaviour for `/health` per the orchestration-server spec; mirroring it under `/api` does not change the trust model (loopback-only, no auth). Both URLs return the same `{ status: "ok", project_id, uptime_ms, version }` envelope.
- **Trade-off:** Every endpoint now has two URLs in the public surface. A future API-rename or breaking change would have to evolve both. **Acceptance:** The duplication is at the routing layer, not at the handler layer; renaming a route is still a one-line change to the loop entry. The cost is bounded.
- **Trade-off:** `GET /api/<typo>` now returns `404 store_not_found` instead of HTML. This is technically a behaviour change for any caller that was relying on the HTML response. **Acceptance:** No documented caller does that; the existing behaviour was an unintended bug, not a feature.

## Migration Plan

The change is wire-additive — every existing URL keeps working, every existing test stays green, every existing caller (curl, MCP, role-runtime, dev-mode Vite proxy) is unaffected. There is nothing to migrate; the alias is available the moment `createServer` runs.

The README's "End-to-end smoke test" section's current four-step runbook starts working as documented after this change ships. No reader-facing edits are strictly required, but a small explanatory note under "Run the orchestration server" clarifying the alias is a worthwhile docs follow-up (covered in `tasks.md`).

## Open Questions

None — the design is fully closed on the wire shape, the test surface, and the spec deltas. Implementation is straightforward.
