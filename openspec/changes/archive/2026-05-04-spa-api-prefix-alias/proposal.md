## Why

The bundled-SPA wire is broken in production-mode `keni start`. The SPA's `apiClient` issues every REST request under the `/api/...` prefix (e.g. `GET /api/agents`), which the Vite dev-server proxy strips to `/agents` before forwarding. In production-mode `keni start` (the default — the orchestration server serves both the SPA bundle and the REST API on a single same-origin port), there is no Vite proxy and no path rewrite: the orchestration server mounts REST at `/agents`, `/tickets`, `/prs`, `/activity`, `/health`, `/events`, and the static SPA fallthrough swallows `/api/*` into `index.html` because `/api` is not in `REST_PREFIXES`. The SPA loads but every API call returns the SPA's own HTML, so the dashboard is empty and unusable. This blocks the `spec.md` §8 exit-criterion runbook (the four-step "create a ticket and watch alice work it" smoke test the README's "End-to-end smoke test" section documents) — step 3 of that runbook fails the moment the browser tries to render the agent roster.

## What Changes

- The orchestration server SHALL accept `/api/<rest>` as an alias for every documented REST and WebSocket route under `/<rest>`. `/api/agents`, `/api/tickets/:id`, `/api/prs/:id/merge`, `/api/activity`, `/api/health`, and `/api/events` (WS upgrade) become equivalent to their non-prefixed counterparts. Both the prefixed and the non-prefixed forms are served by the same handlers (no duplicated routing, no behavioural drift).
- `REST_PREFIXES` SHALL gain `/api` so the static SPA fallthrough no longer swallows `/api/*` GETs into `index.html`. The closed-allowlist contract (every REST prefix is added in lock-step) is preserved.
- The same-origin production-mode SPA wire becomes the canonical path. The dev-mode SPA wire (separate Vite dev server with its `/api` → `/` rewrite) keeps working unchanged — Vite still strips the prefix on its way to the orchestration server, which then matches the non-prefixed routes as before.
- Existing bare-prefix REST callers (`curl http://127.0.0.1:7777/tickets`, the engineer MCP server's `httpClient`, the role-runtime `activityClient`, every existing test) are NOT broken. The change is additive: every URL that worked before still works; `/api/<x>` URLs that returned `index.html` before now return the documented JSON envelope.
- The `spa-shell` capability spec's "dev-server proxies `/api/*`" requirement gains an explicit production-mode clause: "in production, the orchestration server's `/api/*` alias means the same `apiClient` URLs work without a proxy." The orchestration-server spec gains the `/api/*` alias requirement and an updated `REST_PREFIXES` literal.

## Capabilities

### New Capabilities

<!-- None — no new capability is introduced; the alias is a delta on existing capabilities. -->

### Modified Capabilities

- `orchestration-server`: Add a documented `/api/<x>` alias for every REST and WS route. Update the `REST_PREFIXES` literal to include `/api`. Update the static SPA route group's "REST prefixes are excluded from the SPA fallthrough" requirement to reflect the new entry.
- `spa-shell`: Document that in production-mode SPA serving (same-origin Hono app hosting both bundle and API), the `apiClient`'s `/api/<x>` URLs work without a proxy because the orchestration server aliases them. The dev-mode Vite-proxy requirement is unchanged.

## Impact

- **Code:** `packages/server/src/restPrefixes.ts` (allowlist literal grows by one entry); `packages/server/src/createServer.ts` (a small alias-mounting middleware or a per-route-group `app.route("/api/<x>", ...)` second registration); `packages/server/src/restPrefixes_test.ts` (literal-equality assertion updates). No SPA, MCP, or role-runtime code changes.
- **Wire surface:** Every REST and WS endpoint becomes reachable under two URLs (`/x` and `/api/x`). The `X-Keni-Role` header / `?role=` query semantics, the response-envelope shape, the WS protocol-ping behaviour, and the role-allowed-method matrix are unchanged on both URLs.
- **Specs:** `openspec/specs/orchestration-server/spec.md` and `openspec/specs/spa-shell/spec.md` gain delta spec files in this change. The `cli-start` spec is unaffected (no flag changes; the boot output line stays byte-for-byte stable).
- **Tests:** `packages/server/src/createServer_test.ts` and `packages/server/src/routes/static_test.ts` gain alias-coverage cases (one per route group asserting the prefixed form returns the same envelope as the bare form; one asserting the SPA fallthrough no longer swallows `/api/*`). The existing SPA, MCP, and role-runtime tests remain green without modification.
- **Runbook:** The README's "End-to-end smoke test" section now actually completes — step 3 (open the printed URL, see the agent roster) and step 4 (create a ticket, watch the engineer drive it) both work against `keni start <path>` after `deno task build`.
- **Docs:** A small README addition under "Run the orchestration server" calling out that every REST URL has an `/api/`-prefixed alias for SPA same-origin use.
