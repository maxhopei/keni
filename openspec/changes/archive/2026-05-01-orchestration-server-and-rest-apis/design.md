## Context

Steps 01–03 have landed: `@keni/shared` exposes the four storage interfaces, their file-backed and in-memory adapters, the centralised id module, the typed error model, the atomic-write helper, and the path resolvers; `@keni/cli`'s `keni init` produces the on-disk `.keni/` and `~/.keni/` layouts that `spec.md` §5.1 / §5.2 prescribe; every project carries a stable UUIDv4 `project_id` written via `ConfigStore.writeProjectConfig`. `@keni/server` exists as a workspace member but ships only a placeholder constant — no router, no routes, no middleware, no real entry point. Building the orchestration server on top is greenfield: every architectural choice is open, and a small number of decisions (framework, validation library, role-identity transport, status-graph encoding, error mapping, request-logging shape) ripple into every later step.

Several spec principles drive this design:

- **§2#1 — Environment as communication bus.** The HTTP server is structurally that bus for the SPA, role runtimes, MCP layer, and the user (curl in the prototype). If a state change does not flow through this server, `spec.md` §5.3 is violated.
- **§2#3 — Status drives behaviour.** Transitions are the only legitimate state changes, and they live in one place: the server's `transition` endpoint. The status-machine graph is encoded once, server-side, and reused by every layer that needs to reason about reachability.
- **§4.1 — Ticket lifecycle.** The full `open → in_progress → ready_for_review → in_review → has_comments / approved → merged → ready_for_test → in_testing → tested / test_failed → done` graph is the source of truth. The server-side constant tracks it 1:1 and the API surface refuses any transition that the graph does not authorise.
- **§4.2 — Owning role rule.** Only the owning role may transition into its own statuses (engineer for `in_progress` → `merged`; QA for `in_testing` / `tested` / `test_failed`; PO for `done`). The user can override (with a confirmation flow logged as `manual_override`); but that confirmation flow is step 25, not this one. This step wires the role guard so it cannot be bypassed and leaves a clearly-marked TODO at the override seam.
- **§5.3 — `.keni/` write boundary.** The server is the gatekeeper for `.keni/` writes. Every legitimate write to tickets, PRs, or the activity log on `main` flows through this API; this is the architectural reason the role guard cannot live anywhere else (no role runtime, no MCP layer, no SPA can be trusted to enforce it on its own).
- **§7.1 — One server, one project.** One `keni start` invocation manages one project; the server reads `project_id` once at bootstrap from `.keni/project.yaml` and stamps it on every response. A future multi-project server is purely additive — the wire shapes already carry `project_id`, so the request shape does not change when multi-project lands.
- **§11#5 — Files first, storage abstracted.** The server consumes the storage interfaces, never `Deno.readTextFile` against `.keni/`. The composition root binds `FileTicketStore`, `FilePRStore`, `FileActivityLogStore`, `FileConfigStore` once; routes consume the interface types.

Constraints and givens:

- Runtime is Deno 2.7+ (from step 01). All server code targets Deno; no Node-specific shims, no `node_modules`. The server runs under `deno run -A` (or, post-step-13, under `keni start`, which is itself a `deno run` invocation in development and a packaged binary later).
- The `@std/*` libraries pinned in earlier steps are sufficient for path/fs work. New runtime dependencies: `jsr:@hono/hono` (router), `npm:zod` (validation). Both are stable, idiomatic for Deno, and have wide ecosystem support.
- The server is local-only: no auth, no TLS, no CORS, binds to `127.0.0.1` by default. Headers are trusted (the role identity arrives in `X-Keni-Role`).
- The wire shapes the SPA and role runtimes consume must be importable as TypeScript types from `@keni/shared` so consumers can use them without pulling zod into their bundle.

Non-constraints (explicitly free to choose):

- Internal layout under `packages/server/src/`.
- Whether `createServer` returns a Hono app or a higher-level wrapper.
- Whether the role-identity middleware caches the parsed role or re-parses per request.
- The exact JSONL field set for request logs (within the documented core: `request_id`, `method`, `path`, `status`, `duration_ms`, `role`, `agent`, `project_id`).
- Whether the status-graph constant ships from `@keni/server` only or is re-exported from `@keni/shared`. Re-export is deferred until a second consumer (the SPA's optimistic-update layer in step 11) actually needs it.

## Goals / Non-Goals

**Goals:**

- An `@keni/server` HTTP server exists and, when bound to file-backed stores rooted at a `keni init`-produced `.keni/`, exposes a stable REST API for tickets, PRs, and the activity log per `spec.md` §5.1 / §4.1 / §4.2.
- Status-machine enforcement (graph + role-owner) lives only in this server, applied uniformly across all transition endpoints, and is impossible to bypass for any agent that respects the §5.3 boundary (i.e., does not edit `.keni/` files directly, which is the boundary the workspace-clone sparseness rule and the storage docs already enforce).
- The error contract is a single, stable envelope (`{ error: { code, message, details? } }`) with a documented enum of `error.code` values, mapped from a small set of typed exceptions by one central function. Every endpoint returns errors via that mapper; no handler constructs an ad-hoc response inline.
- The wire shapes (request bodies, response bodies, error envelope) are TypeScript types in `@keni/shared/wire/` and zod schemas in `@keni/server/src/wire/`. A compile-time `z.ZodType<SharedType>` constraint catches drift. The SPA imports types only and tree-shakes zod from its bundle.
- One server, one project, by construction: `createServer({ configStore, ... })` reads `project_id` once at bootstrap, caches it, and stamps it on every response. An inbound request that names a different `project_id` is rejected.
- Request logging is a single middleware that emits one structured JSONL line per request with the documented core fields, written to stdout in dev and to `~/.keni/logs/server-YYYY-MM-DD.jsonl` when run under `keni start` (the file destination is wired here so step 13 only has to flip the config flag).
- Integration tests exercise every endpoint end-to-end against the Hono app via `app.fetch(new Request(...))`, with file-backed stores rooted at `Deno.makeTempDir()`. No port binding, no real network — but the same code path the production server runs.
- The `orchestration-server` capability spec exists, names the API contract end-to-end, and is the document every later step (05 WS / agents, 06 MCP, 10–12 SPA, 25 manual override) reads to know what they can rely on.

**Non-Goals:**

- **No WebSocket layer.** Step 05 owns `/agents` and the WS upgrade. The Hono app is structured so step 05 just adds the upgrade route without restructuring.
- **No MCP surface.** Step 06 owns the MCP tools. They will reuse the same `statusGraph.ts` constants and the same store interfaces, but they do not flow through the HTTP layer.
- **No chat endpoints.** Step 15 owns `/chat`.
- **No `manual_override` event logging in this step.** The role guard accepts `user` for any transition (so the user can curl through), but the confirmation flow and the activity-log emission are step 25. The server marks this gap with a structured TODO and a corresponding spec scenario.
- **No `keni start` integration.** Step 13 owns the CLI dispatch. This step ships `runServer(args)` so step 13 has a one-line dispatch target, but it does not add a CLI subcommand, does not modify `packages/cli/`, and does not register the server with any process supervisor.
- **No auth, no TLS, no CORS, no rate-limiting.** Local-only, single user, prototype scope. Each of these is an additive change in a later step.
- **No multi-project support.** One server, one project, by design (`spec.md` §7.1). The wire shapes carry `project_id` so a future multi-project server is purely additive.
- **No pagination on `GET /activity`.** Bounded prototype data. Pagination is additive when needed.
- **No request-rate limiting**, **no body-size cap beyond what zod imposes per field**.
- **No prompt embedding or template rendering**. This server has no UI; it is data-only.
- **No upgrade / migration logic** for existing projects. The server reads `project.yaml` as-is. Future schema versions are additive.

## Decisions

### Decision 1: Server framework — Hono (`jsr:@hono/hono@^4`)

**Why:** Hono is the smallest router that gives us first-class TypeScript support, JSR-native publishing (no npm: indirection), zero transitive runtime deps in the Deno target, and the middleware shape we need (request-id, role-identity, error-boundary, request-log). The router compiles to a regex tree at startup so per-request overhead is sub-millisecond. `c.req.json<T>()` and `c.json(body, status)` give us typed request/response handling without boilerplate. Hono's testing pattern is `app.fetch(new Request(...))` against the app instance — no port binding, no extra harness, identical to production code path. The framework's surface area is small enough to read end-to-end in an hour, which matches the "thin wrapper" principle (`spec.md` §2#4).

**Alternatives considered:**

- **Hand-rolled `Deno.serve` + a tiny router function.** Tempting (zero deps), but every endpoint then carries boilerplate for path matching, body parsing, error handling, and middleware ordering. Across ~10 routes plus 4 middlewares, that is ~200 lines of custom plumbing we have to maintain and test. Hono is ~14 KB of well-tested router; the trade-off is clearly in Hono's favour. If we ever outgrow Hono, swapping it out is a single-week refactor (the routes are thin). Rejected.
- **Fastify (`npm:fastify`).** Mature, popular in Node, but pulls in Node-emulation surface area via Deno's npm: layer (event-emitters, stream polyfills, etc.). The footprint is much larger than Hono and the Deno integration is third-class. Rejected.
- **Express (`npm:express`).** Same Node-shim concerns as Fastify, plus a less typed surface. Rejected.
- **`oak` (Deno-native).** Deno-native, similar feature set, but smaller community than Hono and less momentum. Hono works equally well in Deno, Cloudflare Workers, Bun, and Node — which gives us optionality if we ever want to ship the server outside Deno (e.g., as a Cloudflare-hosted preview). Picked Hono.

### Decision 2: Server entry-point shape — three layered functions, one composition root

**Why:** the server is consumed in three ways during the prototype: integration tests need a Hono app to drive via `app.fetch`; a developer running `deno run -A packages/server/src/main.ts --project=<path>` needs a process-level lifecycle; step 13's `keni start` needs a programmatic CLI-style entry that returns an exit code. Splitting these three concerns into three functions makes each easy to test in isolation.

**Layout:**

```
packages/server/src/
├── main.ts                     # exports createServer, startServer, runServer; runs as a script when invoked directly
├── main_test.ts                # smoke tests the composition root
├── createServer.ts             # builds the Hono app, mounts middlewares + routes, returns the app
├── createServer_test.ts        # asserts the app routes the documented surface
├── startServer.ts              # binds Deno.serve, returns { abort, port, url }
├── runServer.ts                # CLI-style: parses args, instantiates stores, calls startServer, returns exit code
├── statusGraph.ts              # §4.1 ticket transitions + §4.2 role-owner map (frozen constants)
├── statusGraph_test.ts         # unit tests over the graph and the owner map
├── errors.ts                   # StatusGraphViolationError, RoleNotOwnerError, MissingRoleError, mapErrorToResponse
├── errors_test.ts              # unit tests for every error → (status, body) mapping
├── middleware/
│   ├── requestId.ts            # assigns X-Keni-Request-Id (UUIDv4) per request
│   ├── requestLog.ts           # emits one JSONL line per request via an injected LogSink
│   ├── roleIdentity.ts         # parses X-Keni-Role / X-Keni-Agent into c.var
│   ├── errorBoundary.ts        # catches throws, calls mapErrorToResponse, formats c.json
│   └── *_test.ts               # unit tests per middleware
├── routes/
│   ├── tickets.ts              # GET /tickets, GET /tickets/:id, POST /tickets, PATCH /tickets/:id, POST /tickets/:id/transition
│   ├── prs.ts                  # GET /prs, GET /prs/:id, POST /prs, PATCH /prs/:id/intent, POST /prs/:id/transition
│   ├── activity.ts             # GET /activity, POST /activity
│   └── *_test.ts               # integration tests per route group, exercising the full middleware stack
└── wire/
    ├── tickets.ts              # zod schemas for ticket request/response shapes
    ├── prs.ts                  # zod schemas for PR shapes
    ├── activity.ts             # zod schemas for activity shapes
    ├── errors.ts               # zod schema for the error envelope
    ├── mod.ts                  # barrel export
    └── *_test.ts               # asserts each schema's z.ZodType<SharedType> alignment
```

**`main.ts`** (single source of truth for what the package exports):

```ts
export { createServer } from "./createServer.ts";
export type { ServerDeps, ServerOptions } from "./createServer.ts";
export { startServer } from "./startServer.ts";
export type { StartedServer, StartServerOptions } from "./startServer.ts";
export { runServer } from "./runServer.ts";

if (import.meta.main) {
  Deno.exit(await runServer(Deno.args));
}
```

**Three layers, one direction of dependency:**

```
runServer  →  startServer  →  createServer  →  Hono app + routes + middlewares + stores
   │              │                │
   └─ argv,        └─ Deno.serve,   └─ pure: deps in, app out
      env             port binding,
                      lifecycle
```

`createServer({ ticketStore, prStore, activityLogStore, configStore, projectId, logSink })` is pure and synchronous — given dependencies, it returns the Hono app. Tests pass in-memory stores; production passes file-backed stores.

`startServer(opts)` calls `createServer`, binds `Deno.serve({ hostname: "127.0.0.1", port: opts.port ?? 0 }, app.fetch)`, and returns `{ abort: () => Promise<void>, port: number, url: string }`. Tests use `port: 0` (OS-assigned) and `abort()` for teardown.

`runServer(args)` parses `--project <path>` and `--port <number>` from argv, validates the project root, instantiates `FileTicketStore` / `FilePRStore` / `FileActivityLogStore` / `FileConfigStore` against it, reads the project id, instantiates a stdout `LogSink` (or a file sink later when step 13 wires `--log-file`), calls `startServer(...)`, prints the URL, and waits for SIGINT. Returns 0 on clean shutdown, 1 on bootstrap failure.

**Alternatives considered:**

- **Single `startServer(opts)` that does everything.** Simpler call site, but tests then need to bind ports, wait for socket-ready, fetch over the loopback, and tear down. The `app.fetch` approach is dramatically faster (no I/O at all) and exercises the same middleware stack. The split lets both worlds work. Picked the split.
- **Class-based server (`new KeniServer(deps).start()`).** No clear benefit over the function trio; functions compose better with the dependency-injection pattern the storage layer already uses. Rejected.
- **No `runServer`; let step 13 build its own.** Possible, but step 13 would then duplicate the argv-parsing and store-instantiation. One shared `runServer` keeps the seam clean. Picked.

### Decision 3: Folder layout — flat under `packages/server/src/`, one file per concern

**Why:** the server has roughly five concerns (composition root, status graph, errors, middleware, routes) plus a wire-shape barrel. Each concern fits in one file (or, for middleware and routes, a small folder of one-file-per-thing). A flat layout keeps imports short and makes it obvious where a new endpoint or middleware lands.

The layout above (Decision 2's tree) reflects this. The only nested folders are `middleware/` (because we have four middlewares and they share a pattern), `routes/` (because we have three route groups), and `wire/` (because we have schemas for three resource types plus the error envelope). Each folder has a `mod.ts` only when external consumers need a barrel; for `routes/` and `middleware/` the consumer is `createServer.ts` and direct file imports are clearer than barrels.

**Alternatives considered:**

- **Resource-oriented folders (`tickets/`, `prs/`, `activity/`) each containing route + wire + tests.** Pulls related code together, but the "one resource per folder" pattern obscures the layered concerns (every folder duplicates "wire schema, route, tests"). With three resources, the duplication is manageable but adds cognitive load. Rejected — the layered split scales better when step 05 / 06 / 15 add WS / MCP / chat (those are not resources, they are surfaces).
- **Everything flat under `src/` (no subfolders).** ~25 files in one directory becomes hard to scan. The 3-level split above keeps each folder under 10 files.

### Decision 4: Role-identity transport — `X-Keni-Role` and `X-Keni-Agent` HTTP headers, trusted

**Why:** the prototype has no auth and binds to `127.0.0.1`. The role identity arrives via two headers and the server trusts them. The SPA sends `X-Keni-Role: user`. The role runtimes (steps 07–09) send `X-Keni-Role: engineer` (or `qa`, `po`) and `X-Keni-Agent: alice` (or `bob`, etc.). A curl invocation acts as whichever role the caller chooses (intentionally — the prototype is designed for the user to inspect and interrupt freely).

**The contract:**

```
X-Keni-Role: user | engineer | qa | po | writer       # required on every request
X-Keni-Agent: <agent-id>                              # optional; required by some endpoints (POST /activity, ticket assignment when role != user)
```

A `roleIdentity` middleware parses both headers into typed `c.var.role: Role` and `c.var.agent: string | null`. Missing or unknown role → 400 with `error.code: "missing_role"`. Unknown values are explicit errors (no silent bypass). The middleware runs before every route handler.

**Owning-role mapping (`statusGraph.ts`, see Decision 7):**

| Target status | Owning role(s) |
| --- | --- |
| `open` | (set on creation only — no transition into `open`) |
| `in_progress` | engineer, user (override) |
| `ready_for_review` | engineer, user (override) |
| `in_review` | engineer, user (override) |
| `has_comments` | engineer, user (override) |
| `approved` | engineer, user (override) |
| `merged` | engineer, user (override) |
| `ready_for_test` | engineer, user (override) |
| `in_testing` | qa, user (override) |
| `tested` | qa, user (override) |
| `test_failed` | qa, user (override) |
| `done` | po, user (override) |

The `user` role is allowed for every transition. In the prototype, the server enforces the role guard but does **not** emit a `manual_override` activity entry — that activity entry, plus the SPA's confirmation modal, lives in step 25. The server marks the gap with a code-level comment (`// TODO(step-25): emit manual_override activity entry when role === "user"`) and a corresponding scenario in the capability spec (named "User override is structurally allowed but does not yet emit `manual_override` (step 25)").

**Why headers and not query parameters / body fields:** headers are the standard place for cross-cutting metadata, are shape-independent (they apply equally to GET / POST / PATCH / DELETE), and are trivial to set from any HTTP client. Query params would pollute every URL; body fields would not work on GET. Picked headers.

**Alternatives considered:**

- **JWT or signed token in `Authorization: Bearer ...`.** Standard for production, overkill for a `127.0.0.1` prototype. Adds key management, signing infrastructure, and a much larger middleware. Defer to a post-MVP auth step.
- **Session cookie.** Requires a session store, login flow, and CSRF handling. Overkill for prototype. Defer.
- **Body field (`{ role: "engineer", from: "open", to: "in_progress" }`).** Only works on bodied requests; would require adding the role to GET request URLs as a query param anyway. Inconsistent. Rejected.
- **No role at all; rely on the calling process to do the right thing.** Rejected — `spec.md` §4.2 is explicit ("the server enforces this"), and once we have the role guard wired now, every later step inherits it; not wiring it now creates a cascading retrofit.

### Decision 5: Validation library — zod, schemas in `@keni/server/wire/`, types in `@keni/shared/wire/`

**Why:** we need runtime validation at the request boundary (because external callers can send anything) and compile-time types throughout the codebase (so the SPA, role runtimes, and server can all bind to the same shapes). zod gives us both: `z.object({...})` produces a runtime parser and a `z.infer<typeof Schema>` TypeScript type from one definition. It runs on Deno via `npm:zod` (well-supported, single dep, frequent releases).

The split between `@keni/shared/wire/` and `@keni/server/wire/` exists because the SPA must import the wire-shape *types* without pulling zod into its bundle. Vite tree-shakes `import type { ... }` perfectly, but the cleanest way to guarantee no zod in the SPA bundle is to put the types in a package that has no zod dependency at all.

**Boundary:**

```
packages/shared/src/wire/
├── tickets.ts        # type TicketCreateRequest, TicketResponse, TicketListResponse, TicketTransitionRequest, TicketHeaderPatchRequest, TicketSummaryResponse
├── prs.ts            # type PRCreateRequest, PRResponse, PRListResponse, PRTransitionRequest, PRIntentPatchRequest
├── activity.ts       # type ActivityAppendRequest, ActivityEntryResponse, ActivityQueryResponse
├── errors.ts         # type ErrorResponse, ErrorCode (union)
├── role.ts           # type Role, AgentId (string brand)
└── mod.ts            # barrel re-exported by @keni/shared

packages/server/src/wire/
├── tickets.ts        # zod schema TicketCreateRequestSchema: z.ZodType<TicketCreateRequest> = z.object({...})
├── prs.ts            # … same pattern
├── activity.ts       # … same pattern
├── errors.ts         # ErrorResponseSchema (used in tests + capability-spec scenarios)
└── mod.ts            # barrel for routes to import from
```

**The drift detector.** Every schema is declared with the explicit constraint:

```ts
import type { TicketCreateRequest } from "@keni/shared";
import { z } from "zod";

export const TicketCreateRequestSchema: z.ZodType<TicketCreateRequest> = z.object({
  title: z.string().min(1).max(200),
  body: z.string().optional(),
  assignee: z.string().nullable().optional(),
  priority: z.number().int(),
  change_request: z.string().nullable().optional(),
});
```

The `z.ZodType<TicketCreateRequest>` annotation forces zod's inferred type to be a *supertype* of `TicketCreateRequest`. If a field is added to the shared type but not to the schema, the type-check fails. (The reverse — field in schema but not in shared type — is structurally allowed by `z.ZodType<X>`, so a unit test in `wire/*_test.ts` runs `expectType<z.infer<typeof TicketCreateRequestSchema>>().toEqual<TicketCreateRequest>()` to lock the equality.)

**Alternatives considered:**

- **typebox (`npm:@sinclair/typebox`).** JSON-schema-first, very fast, but the developer experience is more verbose for our needs and the ecosystem is smaller. zod's `.optional()` / `.nullable()` / `.transform()` chain reads more naturally. Rejected.
- **valibot (`npm:valibot`).** Smaller bundle than zod, similar API, less maturity. Reasonable alternative; zod's larger community and richer error messages tip the balance. Picked zod.
- **Hand-rolled JSON-schema validators.** No dependency, maximum control, but ~50 lines per resource of validation logic that we'd then have to test. Time better spent on routes. Rejected.
- **Put schemas in `@keni/shared` (so the SPA has runtime validation too).** The SPA does not currently need runtime validation of server responses (the server is trusted; if it lies, the bug is fixed once). And it would force `npm:zod` into the SPA's `@keni/shared` import chain, which Vite *should* tree-shake but is not guaranteed for every consumer. Splitting types out keeps the contract explicit. Rejected.

### Decision 6: Wire shape principle — wire ≠ storage

**Why:** the storage records (`Ticket`, `PR`, `ActivityEntry`) carry on-disk concerns: file-implied id, `created_at` / `updated_at` derived from file mtime semantics, the YAML/markdown split (`{ header, body }`). The wire shapes carry HTTP concerns: a flat JSON object the SPA can render directly, a stable `project_id` field on every response, and explicit nullability for optional fields. Decoupling them now means a future on-disk schema change (e.g., adding a `labels` array to tickets) does not force every API response to change too — the wire layer translates.

**Wire shape pattern (illustrated for tickets):**

```ts
// @keni/shared/wire/tickets.ts
export interface TicketResponse {
  readonly id: string;                 // ticket-NNNN
  readonly title: string;
  readonly status: TicketStatus;
  readonly assignee: string | null;
  readonly priority: number;
  readonly change_request: string | null;
  readonly created_at: string;          // ISO 8601
  readonly updated_at: string;          // ISO 8601
  readonly body: string;
}

export interface TicketSummaryResponse {
  readonly id: string;
  readonly title: string;
  readonly status: TicketStatus;
  readonly assignee: string | null;
  readonly priority: number;
  readonly change_request: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TicketListResponse {
  readonly project_id: string;
  readonly data: readonly TicketSummaryResponse[];
}
```

**Mapping (storage → wire):**

```ts
// packages/server/src/routes/tickets.ts
function toTicketResponse(t: Ticket): TicketResponse {
  return { ...t.header, body: t.body };
}
function toTicketSummaryResponse(s: TicketSummary): TicketSummaryResponse {
  return { ...s };
}
```

The mapping is trivial today (the storage and wire shapes are nearly identical) but the seam exists. When the storage layer adds a new field (e.g., `labels`), the wire layer can choose to surface it, hide it, or rename it.

**Why every response carries `project_id`:** `spec.md` §7.1 promises that "every artifact in the data model carries a project id so that a future multi-project server or UI switcher is a pure additive change." The simplest way to keep that promise is to put the id on every response now. Single-project servers populate it from `configStore.readProjectConfig()` once at bootstrap; multi-project servers (post-MVP) populate it per request from the route context.

**Alternatives considered:**

- **Reuse the storage records as wire shapes directly.** Tightest coupling; any storage change immediately breaks the SPA. Rejected.
- **Drop the `{ data, project_id }` envelope and return the record directly.** Cleaner-looking, but the SPA needs `project_id` on every read for its multi-project-future code path, and an envelope is the standard way to add metadata (pagination, request id echo, warnings) without restructuring the response. Picked the envelope.
- **JSON:API or HAL response format.** Heavyweight for prototype, opinionated about relationships we do not yet need. Rejected.

### Decision 7: Status graph — one frozen constant in `statusGraph.ts`, owning-role table alongside

**Why:** `spec.md` §4.1 defines the ticket lifecycle as a directed graph. §4.2 defines the owning role per status. Encoding both as exported constants in one file gives us a single source of truth, makes the file the natural place to look when the spec changes, and lets the `transition` handler compute reachability and authority by table lookup (no `if`/`switch` ladder).

**Shape:**

```ts
// packages/server/src/statusGraph.ts
import type { Role, TicketStatus } from "@keni/shared";

export const TICKET_STATUS_TRANSITIONS = Object.freeze({
  open:              ["in_progress"],
  in_progress:       ["ready_for_review"],
  ready_for_review:  ["in_review"],
  in_review:         ["has_comments", "approved"],
  has_comments:      ["in_progress"],
  approved:          ["merged"],
  merged:            ["ready_for_test"],
  ready_for_test:    ["in_testing"],
  in_testing:        ["tested", "test_failed"],
  tested:            ["done"],
  test_failed:       ["in_progress"],
  done:              [],
}) satisfies Record<TicketStatus, readonly TicketStatus[]>;

export const TICKET_STATUS_OWNING_ROLES = Object.freeze({
  open:              [],                              // set on create only
  in_progress:       ["engineer"],
  ready_for_review:  ["engineer"],
  in_review:         ["engineer"],
  has_comments:      ["engineer"],
  approved:          ["engineer"],
  merged:            ["engineer"],
  ready_for_test:    ["engineer"],
  in_testing:        ["qa"],
  tested:            ["qa"],
  test_failed:       ["qa"],
  done:              ["po"],
}) satisfies Record<TicketStatus, readonly Role[]>;

// The user can override every transition in the prototype. Step 25 layers
// the confirmation flow and `manual_override` activity entry on top.
export const USER_OVERRIDE_ALLOWED: readonly Role[] = ["user"];

export function isTransitionReachable(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_STATUS_TRANSITIONS[from].includes(to);
}

export function isRoleOwner(role: Role, target: TicketStatus): boolean {
  return TICKET_STATUS_OWNING_ROLES[target].includes(role)
    || USER_OVERRIDE_ALLOWED.includes(role);
}
```

PRs follow the same pattern with `PR_STATUS_TRANSITIONS` and `PR_STATUS_OWNING_ROLES`; the engineer owns the entire PR lifecycle so the owning-role table is a single role per status.

**Test discipline:** `statusGraph_test.ts` enumerates every status and asserts: each status has a documented owner; reachability matches the diagram in `spec.md` §4.1 line-for-line; the user-override allowance is uniform. If `spec.md` §4.1 ever changes, the test fails until the constant is updated, which fails until the spec is updated, which fails until the diagram is reviewed.

**Alternatives considered:**

- **Inline switch statements in the route handler.** Trivially correct for the first author, drift-prone after. The single-table approach makes drift a one-line fix and the test catches it. Picked the table.
- **Encode the graph as a YAML/JSON file under `.keni/`.** Spec is in code per `spec.md` §11#3 (prompts as code) — same principle applies to the workflow. The graph is part of Keni's contract, not project data. Rejected.
- **Move the graph into `@keni/shared` so the SPA can also use it.** Possible, deferred until a second consumer (the SPA's optimistic-update layer in step 11) actually needs it. Today only the server reads it; pre-emptive sharing is YAGNI.

### Decision 8: Error model — typed errors + one central mapper, four storage classes + three server classes

**Why:** consistency and testability. Every endpoint's failure path goes through one function (`mapErrorToResponse`); every error class has one place where its (HTTP status, error code) mapping is decided. This makes adding a new error class additive (one row in the mapper, one test case) and keeps handler bodies free of error-formatting noise.

**The classes:**

| Class | Source | HTTP status | `error.code` |
| --- | --- | --- | --- |
| `StoreNotFoundError` | `@keni/shared` | 404 | `store_not_found` |
| `StaleStateError` | `@keni/shared` | 409 | `stale_state` |
| `DuplicateIdError` | `@keni/shared` | 409 | `duplicate_id` |
| `InvalidArtifactError` | `@keni/shared` | 422 | `invalid_artifact` |
| `StatusGraphViolationError` | `@keni/server` | 403 | `status_graph_violation` |
| `RoleNotOwnerError` | `@keni/server` | 403 | `role_not_owner` |
| `MissingRoleError` | `@keni/server` | 400 | `missing_role` |
| `ZodError` (from validation) | `npm:zod` | 400 | `validation_failed` |
| any other | — | 500 | `internal_error` |

**Special case — `InvalidArtifactError("status_in_patch")`:** the storage layer throws this when a `PATCH /tickets/:id` body includes `status`. The server wants this surfaced as a 400 (caller sent a bad request, not 422 unprocessable), so the mapper checks the `reason` field on `InvalidArtifactError` and re-maps `"status_in_patch"` to `(400, "status_in_patch")`. All other reasons stay at 422 with `invalid_artifact`. This is the only special-case in the mapper and lives next to its rationale.

**The mapper:**

```ts
// packages/server/src/errors.ts
import type { ErrorResponse } from "@keni/shared";
import {
  DuplicateIdError, InvalidArtifactError, StaleStateError, StoreNotFoundError,
} from "@keni/shared";
import { z } from "zod";

export class StatusGraphViolationError extends Error {
  override readonly name = "StatusGraphViolationError";
  constructor(readonly from: string, readonly to: string) {
    super(`Transition ${from} → ${to} is not in the status graph`);
  }
}

export class RoleNotOwnerError extends Error {
  override readonly name = "RoleNotOwnerError";
  constructor(readonly role: string, readonly target: string) {
    super(`Role '${role}' may not transition into '${target}'`);
  }
}

export class MissingRoleError extends Error {
  override readonly name = "MissingRoleError";
  constructor(readonly received: string | undefined) {
    super(received === undefined
      ? "X-Keni-Role header is required"
      : `Unknown role '${received}' (expected one of: user, engineer, qa, po, writer)`);
  }
}

export interface MappedResponse {
  readonly status: number;
  readonly body: ErrorResponse;
}

export function mapErrorToResponse(err: unknown): MappedResponse {
  // ... single switch by class with the table above
}
```

The error envelope:

```ts
// @keni/shared/wire/errors.ts
export type ErrorCode =
  | "store_not_found" | "stale_state" | "duplicate_id" | "invalid_artifact"
  | "status_in_patch" | "status_graph_violation" | "role_not_owner"
  | "missing_role" | "validation_failed" | "internal_error";

export interface ErrorResponse {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}
```

The `errorBoundary` is registered via `app.onError(errorBoundary(projectId))`, **not** as a regular middleware. In Hono v4, only the `onError` hook catches errors thrown by route handlers — a `try/catch` around `await next()` inside a regular middleware does **not** see the throw because Hono's `compose()` swallows it onto `c.error` and produces its own default 500 response. The `onError` handler delegates to `mapErrorToResponse`, sets `c.var.error_code` so `requestLog` can pick it up, and returns the documented `ErrorResponse` envelope. Handlers therefore never need a `try`/`catch` themselves.

**Alternatives considered:**

- **Per-handler error mapping.** Repetitive, drifts. Rejected.
- **Result-type pattern (`Result<T, E>`).** No throw-based propagation, more explicit, but heavier syntax and less idiomatic in TypeScript. The single error-boundary middleware delivers the same robustness with less boilerplate. Picked throw-and-catch.
- **HTTP error classes that carry the status (e.g., Hono's `HTTPException`).** Couples error semantics to HTTP, which is a mismatch for storage errors that also need to surface to MCP and (later) WS. Keeping the typed errors transport-agnostic and mapping at the boundary keeps reuse clean.

### Decision 9: Project-id resolution — read once at bootstrap, cached in `c.var.project_id`

**Why:** `spec.md` §7.1 says one server, one project. The simplest implementation that holds that line is to read `project_id` once at startup and cache it. Every response stamps it; every inbound request that names a different `project_id` is rejected with `400 missing_role` (actually a different code; see below).

**Implementation:**

```ts
// packages/server/src/createServer.ts
export interface ServerDeps {
  readonly ticketStore: TicketStore;
  readonly prStore: PRStore;
  readonly activityLogStore: ActivityLogStore;
  readonly configStore: ConfigStore;
  readonly logSink: LogSink;
}

export interface ServerOptions {
  readonly projectId: string;     // resolved by caller from configStore.readProjectConfig()
}

export function createServer(deps: ServerDeps, opts: ServerOptions): Hono {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(requestId());
  app.use(requestLog(deps.logSink, opts.projectId));
  app.use(roleIdentity());
  app.onError(errorBoundary(opts.projectId));
  app.route("/tickets", ticketsRoutes(deps.ticketStore, opts.projectId));
  app.route("/prs", prsRoutes(deps.prStore, opts.projectId));
  app.route("/activity", activityRoutes(deps.activityLogStore, opts.projectId));
  return app;
}
```

`runServer` is the place that calls `configStore.readProjectConfig()` and passes the id in. This means `createServer` itself is synchronous and dependency-free at the I/O level (every dep is injected), which makes tests trivial.

**Multi-project guard:** the wire shapes do not carry `project_id` on *requests* in the prototype (only on responses), so there is nothing to validate yet. When multi-project lands (post-MVP), the request shapes gain `project_id` and the server checks `request.project_id === opts.projectId` (or, in the multi-project case, dispatches by id). The capability spec documents this as a forward-compatibility note.

**Alternatives considered:**

- **Read `project_id` per request from the config store.** Wasteful (file read per request) and risks inconsistency mid-request. Rejected.
- **Pass `configStore` into the routes and let them read it lazily.** Same problem. Rejected.
- **Cache with a TTL or file-watcher invalidation.** YAGNI for prototype; `project_id` does not change for the life of the process. Rejected.

### Decision 10: Request logging — one middleware, one JSONL line per request, injected `LogSink`

**Why:** structured logs are the primary debug surface for a local server. Emitting one JSONL line per request, with the documented core fields, makes both human (`cat | jq`) and tool (Vector / Datadog ingestion later) inspection trivial. Injecting a `LogSink` interface lets tests capture log lines directly and lets step 13 wire either stdout or the file destination without changing the middleware.

**The shape:**

```ts
// packages/shared/src/wire/log.ts (or @keni/server/log.ts — see below)
export interface RequestLogLine {
  readonly request_id: string;
  readonly timestamp: string;          // ISO 8601 UTC
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly duration_ms: number;
  readonly role: string | null;        // null when the role header was missing/invalid
  readonly agent: string | null;
  readonly project_id: string;
  readonly error_code?: string;        // present only on non-2xx
}
```

The `RequestLogLine` type lives in `@keni/server` (not `@keni/shared`) because no other package consumes it; if a future log-aggregator package needs it, it can be promoted to `@keni/shared` then.

**The sink interface:**

```ts
// packages/server/src/middleware/requestLog.ts
export interface LogSink {
  write(line: RequestLogLine): void | Promise<void>;
}

export function stdoutLogSink(): LogSink {
  return { write(line) { console.log(JSON.stringify(line)); } };
}

export function captureLogSink(buffer: RequestLogLine[]): LogSink {
  return { write(line) { buffer.push(line); } };
}

// File sink lives in step 13 (or right here if it's trivial — see Open Questions).
```

The middleware:

```ts
export function requestLog(sink: LogSink, projectId: string) {
  return async (c: Context, next: Next) => {
    const start = performance.now();
    await next();
    await sink.write({
      request_id: c.var.request_id,
      timestamp: new Date().toISOString(),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Math.round(performance.now() - start),
      role: c.var.role ?? null,
      agent: c.var.agent ?? null,
      project_id: projectId,
      error_code: c.res.status >= 400 ? c.var.error_code : undefined,
    });
  };
}
```

The `error_code` is set by the `errorBoundary` middleware on `c.var.error_code` so the request log can emit it without duplicating the mapper logic.

**Alternatives considered:**

- **Console.log inline in every handler.** Inconsistent, drifts, hard to mute in tests. Rejected.
- **A logging framework (`npm:pino`).** Heavier than a 30-line middleware that does exactly what we need. Rejected.
- **Two middlewares (one for request, one for response).** No clear benefit over a single `start–await next–end` middleware. Rejected.
- **Synchronous file write in the middleware path.** Blocks the request response. The stdout sink is fine for prototype; the file sink (step 13) will use `Deno.openSync` + a background-flushed buffer if perf becomes an issue. For the prototype, even a synchronous file write of ~200 bytes is sub-millisecond. Acceptable.

### Decision 11: Activity log query response — single-page in prototype, no pagination

**Why:** the storage layer's `query` returns an `AsyncIterable`. The server materialises it into a single `ActivityEntryResponse[]` and returns the whole array in one response body. This is fine for prototype because the activity log is brand new on a fresh project, the date partitioning bounds per-day file size, and a typical prototype project produces tens to low hundreds of entries per day.

When pagination is needed (likely in MVP once the PO chat starts producing activity), a `?cursor=<entry-id>&limit=<n>` query-string addition is purely additive: the wire shape gains `next_cursor`, the response stays envelope-shaped (`{ data, project_id, next_cursor }`), and existing callers continue to work because they ignore unknown fields.

**Alternatives considered:**

- **Page from day one.** Not needed; YAGNI. Rejected.
- **Stream the response (chunked transfer, NDJSON in the body).** Requires the SPA to write a streaming parser. YAGNI for prototype. Rejected.
- **Cap the response size (e.g., max 1000 entries) with a 422 if the filter selects more.** Surprises the caller. Picked plain materialisation; revisit when MVP data volume hits limits.

### Decision 12: Test layout — middleware unit tests, route integration tests, wire schema unit tests, composition-root smoke test

**Why:** four concentric circles, each catching what the next layer in cannot.

- **Wire schema tests** (`packages/server/src/wire/*_test.ts`): one test per schema asserting it accepts a documented good example, rejects each documented bad example, and (via `expectType`) infers the expected TypeScript shape. Fast.
- **Status-graph tests** (`packages/server/src/statusGraph_test.ts`): every transition in the graph is covered; every status has an owning role; the user-override row is uniform. Fast.
- **Error-mapper tests** (`packages/server/src/errors_test.ts`): every error class is mapped to its documented (status, body) pair. The `InvalidArtifactError("status_in_patch")` special-case is asserted. Fast.
- **Middleware unit tests** (`packages/server/src/middleware/*_test.ts`): each middleware is exercised against a mock `Context`. Fast.
- **Route integration tests** (`packages/server/src/routes/*_test.ts`): one file per route group, exercising every endpoint via `app.fetch(new Request(...))` against a temp-dir-backed Hono app. Each test asserts on response status, headers (including `X-Keni-Request-Id`), body shape, and on-disk side-effects (e.g., `POST /tickets` produces a `ticket-0001.md`). Slower (file I/O) but no port binding.
- **Composition-root smoke test** (`packages/server/src/main_test.ts`): imports `createServer`, builds it with file-backed stores in a temp dir, fetches `/tickets`, asserts a 200 with an empty `data` array. Catches wiring bugs that the layered tests miss.
- **End-to-end wire-flow test** (one): `runServer(["--project=<tempDir>", "--port=0"])` actually binds a socket, fetches over loopback, and tears down. One test, to prove the `runServer → startServer → createServer` chain holds with real `Deno.serve`. (Optional; covered conceptually by the smoke test plus `startServer_test.ts` if we keep it lean.)

**Coverage informal target:** every endpoint has at least one happy-path test, one role-guard refusal test, one storage-error mapping test, and one validation-refusal test. Plus the middleware and wire layers have their own dedicated tests.

**Alternatives considered:**

- **Only end-to-end tests.** Slow and brittle (one failure could be in any layer). Rejected.
- **Only unit tests with mocked stores.** Misses wiring bugs. The integration tests against the real Hono app + real file stores are essential.
- **Snapshot tests of full JSON responses.** Overly tight coupling to whitespace and field ordering. Picked field-by-field assertions instead.

### Decision 13: Where new code lives in the workspace

**Why:** the change is mostly in `@keni/server` with a small additive piece in `@keni/shared` (the wire-shape types). Both are existing workspace members; no new package.

**Files touched:**

```
packages/server/src/
  main.ts                             (rewritten — barrel of three exports + import.meta.main)
  main_test.ts                        (extended — composition-root smoke test)
  createServer.ts                     (new)
  createServer_test.ts                (new)
  startServer.ts                      (new)
  startServer_test.ts                 (new — port=0 binding smoke test)
  runServer.ts                        (new)
  runServer_test.ts                   (new — args parsing + bootstrap-failure tests)
  statusGraph.ts                      (new)
  statusGraph_test.ts                 (new)
  errors.ts                           (new)
  errors_test.ts                      (new)
  middleware/
    requestId.ts                      (new)
    requestId_test.ts                 (new)
    requestLog.ts                     (new — includes stdoutLogSink, captureLogSink)
    requestLog_test.ts                (new)
    roleIdentity.ts                   (new)
    roleIdentity_test.ts              (new)
    errorBoundary.ts                  (new)
    errorBoundary_test.ts             (new)
  routes/
    tickets.ts                        (new)
    tickets_test.ts                   (new — full endpoint coverage)
    prs.ts                            (new)
    prs_test.ts                       (new)
    activity.ts                       (new)
    activity_test.ts                  (new)
  wire/
    tickets.ts                        (new — zod schemas)
    prs.ts                            (new)
    activity.ts                       (new)
    errors.ts                         (new)
    mod.ts                            (new — barrel)
    *_test.ts                         (new — schema acceptance/rejection + type alignment)

packages/shared/src/
  wire/
    tickets.ts                        (new — TS types only)
    prs.ts                            (new)
    activity.ts                       (new)
    errors.ts                         (new)
    role.ts                           (new — Role, AgentId)
    log.ts                            (new — RequestLogLine, optional)
    mod.ts                            (new — barrel)
  main.ts                             (extended — `export * from "./wire/mod.ts";`)
  storage/README.md                   (extended — short paragraph on the wire boundary)

deno.json                             (extended — add jsr:@hono/hono and npm:zod to imports)
deno.lock                             (regenerated)
README.md                             (extended — "Run the orchestration server" subsection)
openspec/                             (new change directory + capability spec)
```

No file outside this set is modified. `packages/cli/`, `packages/spa/`, `packages/role-runtimes/` stay untouched.

**Alternatives considered:**

- **New `@keni/wire` package for the wire shapes.** Adds workspace setup overhead for what is currently 5 small files; the `@keni/shared/wire/` subdirectory delivers the same separation with less ceremony. Revisit if `wire/` grows beyond ~15 files.
- **Move `statusGraph.ts` into `@keni/shared`.** Premature; only the server reads it today. Move it when the SPA needs it (step 11) or when the MCP layer needs it (step 06, possibly).

### Decision 14: Dev-mode bootstrap — `deno run -A packages/server/src/main.ts --project=<path> [--port=<n>]`

**Why:** developers and integration tests need a way to run the server before step 13's `keni start` lands. The simplest path is to make `main.ts` runnable directly via `import.meta.main` (which Deno already supports), with a tiny `--project=<path>` argument parser. This is *not* a CLI subcommand of `@keni/cli`; it is a direct `deno run` invocation. The README documents it as "for development; `keni start` lands in step 13."

`runServer(args)` is the function step 13 will call from its `keni start` arm. In this step, `runServer` is also the entry point for `deno run -A packages/server/src/main.ts ...`. Step 13 deletes nothing — it just adds a CLI-level dispatcher that calls `runServer` with the same args.

**Args:**

```
--project <path>     Path to a Keni project (containing .keni/). Required.
--port <number>      TCP port to bind. Defaults to 0 (OS-assigned).
--host <hostname>    Hostname to bind. Defaults to 127.0.0.1.
```

Exit codes follow the same convention as `keni init`: 0 success, 1 runtime error (missing `.keni/`, port-bind failure), 2 usage error (missing `--project`, unknown flag). `runServer` returns the exit code; `main.ts` calls `Deno.exit(await runServer(Deno.args))` only when `import.meta.main`.

**Alternatives considered:**

- **Add `keni server` as a CLI subcommand now.** Encroaches on step 13's scope; risks `keni start` and `keni server` diverging. Rejected.
- **No CLI at all; tests use `createServer` only.** Then a developer who wants to curl against the server has to write their own bootstrap. Friction. The 50-line `runServer` is worth it.

### Decision 15: The override-flow gap is structurally explicit, not a TODO comment hidden in the code

**Why:** `spec.md` §7.4 and §4.2 promise that user overrides are confirmed and logged as `manual_override` in the activity log. Step 25 owns the confirmation flow and the activity-log emission; this step is structurally responsible only for "the role guard does not silently bypass the user." The cleanest way to make sure step 25 is not forgotten is to mark the gap in three places:

1. **Code (`packages/server/src/routes/tickets.ts`)**: a `// TODO(step-25): when role === "user", emit a manual_override activity entry before the transition lands.` comment at the seam.
2. **Capability spec**: a dedicated requirement and scenario named "User override is allowed but does not yet emit `manual_override` (step 25)" that asserts the seam exists and explicitly defers the emission.
3. **Tests**: the `role_not_owner` refusal test for the `engineer` role attempting `done` is paired with a "role=user can transition into `done` and the response succeeds" test, with a comment pointing at step 25 for the activity-log emission.

This makes it impossible for a later contributor to accidentally remove the `user` allowance (the test fails) and impossible to ship step 25 without grepping for the TODO comment.

**Alternatives considered:**

- **Reject `user` for transitions in this step, force step 25 to add the allowance.** Simpler today, but creates an artificial gap (the SPA cannot test transitions until step 25 lands, even though the SPA depends only on the role guard, not the activity-log emission). Rejected.
- **Emit a no-op `manual_override` activity entry now.** The entry would be missing the confirmation context the SPA collects. Rejected — half-implementing the contract is worse than deferring it cleanly.

## Risks / Trade-offs

- **[Trusted role headers in the prototype.]** Anyone who can connect to `127.0.0.1` (which on a single-user dev machine is just the user) can claim any role. → **Mitigation:** the prototype is local-only and §7.1 already assumes a single user per server. Auth is a post-MVP concern; when it lands, it sits *in front of* the role guard (the guard does not change). The risk is documented in the capability spec ("Trust model: local-only, no auth") so a reader is not surprised.
- **[Dropping zod into `@keni/shared`'s indirect dep tree.]** Even with types-only consumption, a contributor accidentally `import { schema } from "@keni/server/wire"` from the SPA would pull zod into the bundle. → **Mitigation:** the wire-shape types live in `@keni/shared/wire/`; the schemas live in `@keni/server/wire/`. The SPA imports from `@keni/shared` only. A future lint rule (`no-cross-package-import-of-server-internals` or the equivalent) can enforce this; for now the boundary is documented.
- **[Compile-time `z.ZodType<X>` does not catch every drift.]** Adding a field to the shared type that the schema does not include is caught; adding a field to the schema not in the type is allowed (covariant). → **Mitigation:** every `wire/*_test.ts` runs `expectType<z.infer<typeof Schema>>().toEqual<SharedType>()` as the locking assertion (Decision 5). If a contributor adds a schema field without a shared-type field, the type-test fails.
- **[Status graph drift relative to `spec.md` §4.1.]** A change to the graph in the spec would not automatically update the constant. → **Mitigation:** `statusGraph_test.ts` asserts the graph against a hand-encoded copy of §4.1's diagram (one assertion per outgoing edge). The CI failure points at the line that changed.
- **[Single-process project-id resolution.]** The cached `project_id` is read once at startup; a runtime edit of `project.yaml` (extremely unusual but possible) would not take effect until restart. → **Mitigation:** documented in the capability spec ("Restart the server to pick up `project.yaml` changes."). For prototype scope this is acceptable; multi-project (post-MVP) would naturally re-read per request.
- **[`Deno.serve` port binding races in tests.]** Concurrent integration tests on the same OS can race for port allocation if any test hardcodes a port. → **Mitigation:** every `startServer` test passes `port: 0` (OS-assigned) and every `app.fetch` test bypasses port binding entirely.
- **[Hono major-version upgrades.]** Hono is on v4 today; a v5 upgrade may change the middleware signature. → **Mitigation:** pin `^4` in `deno.json`; document the upgrade path in the capability spec ("Replace per the Hono v5 migration guide; the server's middleware contract is documented in `middleware/*.ts` JSDoc and re-implementable on any router."). Risk is low: the routes / wire / errors modules do not depend on Hono's surface.
- **[zod major-version upgrades.]** zod v4 is in beta as of writing; upgrading from v3 to v4 may require schema rewrites. → **Mitigation:** pin `^3.23` and revisit after v4 is stable. The wire schemas are localised in `packages/server/src/wire/`; a migration is a single-folder change.
- **[Activity log `query` materialisation cost.]** Materialising the entire `AsyncIterable` into an array before responding could spike memory if a project somehow accumulates a giant activity log. → **Mitigation:** prototype-scope data is bounded; pagination is the documented next step (Decision 11). Memory spike risk is low for any realistic prototype.
- **[Request-log middleware on the critical path.]** Synchronous stdout writes are sub-millisecond, but a hostile or paused stdout consumer could backpressure the response. → **Mitigation:** stdout sink is the prototype default; step 13's file sink is buffered. Risk is academic for local-only dev.
- **[Composition-root order matters.]** The middleware order — request-id → request-log → role-identity → routes (with error-boundary registered via `app.onError`) — is load-bearing. `requestId` must run first so every other layer can read `c.var.request_id`. `requestLog` must run *before* `roleIdentity` so it observes every request, including those that fail role validation. `roleIdentity` runs after `requestLog` and before the routes so handlers see `c.var.role`. Drift is silent. → **Mitigation:** `createServer_test.ts` includes a "middleware order is preserved" assertion that fakes each middleware to record its position and verifies the order on a sample request, plus a "missing role still emits a request-log line with `error_code: missing_role`" assertion.
- **[Zero auth means tests can spoof any role.]** This is by design (the prototype trusts the network boundary), but it means a leaked screenshot of a curl invocation from a contributor's machine could appear to "authorise" anything. → **Mitigation:** documented; not a real security concern at prototype scope.
- **[The override gap is documented in three places.]** A future refactor that consolidates documentation could lose one of the three (Decision 15). → **Mitigation:** the capability spec is the canonical source; the code TODO and the test comment are reminders. The CI grep for `TODO(step-25)` could be enforced as a lint rule when step 25 lands (it would fail the build until the TODO is removed).

## Migration Plan

Not applicable — additive to a greenfield server. No existing HTTP surface to migrate. Rollback is `git revert` of the change's commits; no on-disk artefacts are produced or consumed by this step.

If a contributor has been driving Keni against the in-memory `InMemoryTicketStore` directly (e.g., in a downstream branch), migrating to the HTTP API is a straightforward swap: replace `await store.create(...)` with `await fetch("/tickets", { method: "POST", headers: { "X-Keni-Role": "user" }, body: JSON.stringify(...) })`.

## Open Questions

- **File-sink for request logs in this step or in step 13?** The capability spec promises that the middleware *can* write to `~/.keni/logs/server-YYYY-MM-DD.jsonl`, but the prototype's `runServer` only wires the stdout sink. The file sink is ~30 lines (date-partitioned filename, append-mode write, daily roll). → **Decision for this step:** ship the file-sink helper (`fileLogSink(dir)`) so step 13 only has to flip a config flag. Stdout remains the default for `deno run` invocations.
- **Should `startServer` accept a TLS config?** Out-of-scope for prototype, but the signature could leave room. → **Decision for this step:** no TLS plumbing; `Deno.serve` defaults to HTTP. A future TLS additive change extends `StartServerOptions` with `tls?: { cert, key }`.
- **Should the role guard accept `engineer` for `POST /tickets` (engineer-created tickets)?** `spec.md` §4.3 says "in the prototype, the user creates tickets directly. There is no PO." So strictly the prototype only needs `user` for `POST /tickets`. But the role runtimes (step 09) may want to write tickets as `engineer` (e.g., to spawn a follow-up ticket). → **Decision for this step:** accept `user` *and* `engineer` for `POST /tickets`. PO is reserved for MVP; QA and Writer cannot create tickets. Document in the capability spec.
- **JSON casing convention — `snake_case` or `camelCase`?** Storage records use `snake_case` (matching YAML conventions); the SPA tends toward `camelCase`. → **Decision for this step:** wire shapes use `snake_case` to match the storage record fields, so the mapping is identity-shaped. The SPA can adapt at its presentation layer if `camelCase` is preferred there. Documented in the capability spec.
- **Should the error-boundary middleware re-throw or eat unknown errors?** Unknown errors today map to 500 + `internal_error`; the stack trace goes to the log line. → **Decision for this step:** map and log, do not re-throw. A re-throw would crash the server on a single bad request, which violates §7.5 (the runtime should isolate failures).
- **Should responses include an `etag` for caching?** YAGNI for prototype; the SPA polls or (post-step-05) subscribes to WS. → **Decision for this step:** no etags. Additive in a future change if needed.
- **`POST /activity` rate limiting.** Activity entries are bounded by §spec to 4 KB each; at "1 req/ms" a single agent could fill a day partition fast. Realistic? → **Decision for this step:** no rate limit. The 4 KB cap from the storage layer is enough for prototype.
- **Should `runServer` accept `--cwd` or always use `--project`?** Two ways to spell the same thing. → **Decision for this step:** `--project <path>` only; defaulting to `Deno.cwd()` is a one-line additive change if a contributor finds the always-explicit form annoying.
