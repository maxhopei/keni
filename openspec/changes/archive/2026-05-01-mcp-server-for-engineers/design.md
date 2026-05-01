## Context

Steps 01–05 have landed: `@keni/shared` exposes the four storage interfaces and their file-backed adapters; `keni init` produces the on-disk `.keni/` and `~/.keni/` layouts; `@keni/server` is a real Hono-based orchestration server that owns the only legitimate write path to `.keni/` on `main`, enforces the §4.1 status graph and the §4.2 owning-role rule, exposes a typed REST surface (`/tickets`, `/prs`, `/activity`, `/agents`) plus a server-push `/events` WebSocket, and stamps `project_id` on every response. Building the engineer's MCP surface on top is greenfield in `packages/server/src/mcp/` — every architectural choice is open, and a small number of decisions (where the MCP server runs, how it identifies itself, how it talks to the orchestration server, which tools it exposes, how errors flow) ripple into every later step (07 role runtime, 09 engineer specialisation, 13 end-to-end smoke, 16 PO MCP additions, 26 multi-engineer).

Several spec principles drive this design:

- **§5.3 — `.keni/` write boundary.** The MCP server is the engineer subprocess's *only* legitimate write surface beyond its own workspace clone. No tool reads or writes `.keni/` directly; every state change goes through the orchestration server's REST endpoints. This is the architectural reason the MCP layer must be a transport adapter and not a duplicate of the API.
- **§5.4 — "All other reads and writes happen through MCP tools exposed by Keni."** This is the literal contract. The orchestration server's REST surface is what the SPA and curl consume; MCP is what the engineer subprocess consumes. Both bind to the same wire shapes and the same role-identity middleware — there is *no* second source of truth.
- **§4.2 — Owning-role rule.** Only the owning role may transition into its own statuses. The MCP server stamps `X-Keni-Role: engineer` on every outbound HTTP call; the orchestration server's existing `roleIdentity` middleware does the validation. The MCP layer adds nothing here.
- **§6.4 — Subprocess agnosticism.** Claude Code, Cursor agent, and OpenCode all speak MCP natively; pinning the engineer's API to MCP is what makes "swap the coding agent" a config change rather than a rewrite. The seven tools defined here are what every supported coding agent's runtime will see.
- **§11#3 — Prompts as code, not files.** The engineer prompt (step 09) names these tools by their MCP names. The prompt ships with Keni's binary; this step ships only the verbs the prompt will name.
- **§2#4 — Thin wrapper, agentic decisions.** The MCP server's tool handlers are thin: validate parameters → stamp identity headers → call REST → map response. No business logic; no decisions; no caching beyond the boot-time CLI args.

Constraints and givens:

- Runtime is Deno 2.7+ (from step 01). All MCP-server code targets Deno; no Node-specific shims, no `node_modules`. The MCP server runs as `deno run -A packages/server/src/mcp/main.ts ...`.
- The official MCP TypeScript SDK (`npm:@modelcontextprotocol/sdk@^1`) explicitly supports Deno (per its README). Stable line is v1.x (current 1.29.0); v2 is in pre-alpha and not yet on the `npm` `latest` tag. Both `McpServer` and `StdioServerTransport` are exported from the SDK.
- The project pins `npm:zod@^4` in the workspace `deno.json`; the MCP SDK v1.x supports zod v4 schema bindings via Standard Schema.
- The orchestration server is local-only (`127.0.0.1`), no auth, no TLS, role headers trusted; the MCP server inherits the same trust model when it acts as an HTTP client.
- The engineer subprocess (Claude Code, Cursor agent, OpenCode) is the *consumer* of the MCP server; the SDK's stdio transport is what it speaks. The role runtime is the *spawner* of both — it spawns the coding agent, which in turn spawns the MCP server per its `mcpServers` config.

Non-constraints (explicitly free to choose):

- Internal layout under `packages/server/src/mcp/`.
- Whether tool handlers share a single HTTP client instance or each holds its own.
- Whether the workspace-path tool reads the path from `--workspace` or computes it from `--agent` + `<project_id from /tickets>` (the former is simpler; the latter would couple to a server round-trip).
- The exact tool names — within constraint that they are lowercase snake_case and verb-shaped (Decision 6 below pins them).
- Whether tool input schemas live in their own `wire/` folder under `mcp/` or co-located with each tool. Co-location chosen for proximity (Decision 7).

## Goals / Non-Goals

**Goals:**

- A runnable stdio MCP server exists at `packages/server/src/mcp/main.ts` that, given `--agent <id> --server-url <url> --workspace <path>`, exposes the seven engineer tools over JSON-RPC and stays alive until its stdin closes (the standard MCP shutdown signal).
- Every tool delegates to an existing orchestration-server endpoint via a typed HTTP client; no tool re-implements role-graph, status-graph, or atomicity logic; no tool reads or writes `.keni/` directly.
- Identity propagation is correct by construction: the MCP server stamps `X-Keni-Role: engineer` and `X-Keni-Agent: <agent-id>` from boot-time CLI arguments on every outbound request; tool input *cannot* override either.
- The error envelope is uniform: every non-2xx HTTP response is mapped to an MCP tool result with `isError: true` and a human-readable `content` payload that names the orchestration server's `ErrorCode`. No new error codes; no codes are weakened or relaxed.
- The engineer-only role guard is enforced at MCP-server startup: the server refuses to start under any role other than `engineer` (the role is hard-coded today; step 16 will fork a parallel PO factory rather than parameterise this one).
- An end-to-end integration test using the SDK's `StdioClientTransport` proves every tool against a real orchestration server in a temp project, including the role-owner refusal (engineer cannot transition `tested → done`) and the status-graph refusal (engineer cannot skip `in_progress → ready_for_review`).
- The `mcp-engineer-surface` capability spec exists, names every tool with parameters / return / errors / idempotency, and is the document step 09 reads to write the engineer prompt.

**Non-Goals:**

- **No HTTP transport for MCP.** Stdio only, per the input file. HTTP is a future-additive extension; the transport is injected so swapping is one line.
- **No PO-specific tools.** Step 16 owns those — and the design choice in this step (a hard-coded `engineer` role at boot) ensures no contributor can accidentally hand the engineer surface to a PO subprocess.
- **No `.keni/de-facto-spec/` or `.keni/changes/` tools.** PO-direct per §5.3.
- **No PR-write MCP tools.** Engineer-initiated PR records flow through the role runtime's git/PR handling in step 09.
- **No WS / streaming tools.** MCP is request/response.
- **No event-bus integration in the MCP server.** The MCP server is a stateless transport adapter; live updates flow over `/events` to the SPA, not to the engineer subprocess.
- **No locking or leasing on tickets.** Prototype scope; step 26 owns multi-engineer concurrency.
- **No auth on the MCP layer.** Local-only; trust headers; future auth lives on the orchestration server, in front of role-identity middleware.
- **No persistent MCP state.** Each role-runtime cycle (per §6 fresh-session rule) spawns a new MCP-server process.
- **No workspace path computation.** The role runtime (step 07 / 09) provides the path explicitly via `--workspace`; the MCP server does not derive it from `--agent` + project id.
- **No new orchestration-server endpoints.** Every tool delegates to an endpoint that already exists.

## Decisions

### Decision 1: MCP framework — `@modelcontextprotocol/sdk@^1` (the official TypeScript SDK)

**Why:** the SDK is the only first-party implementation of the MCP spec; it ships `McpServer`, `StdioServerTransport`, and `Client` (the test harness uses the client side). Its README explicitly names Deno as a supported runtime via the `npm:` specifier. v1.x is the recommended stable line (current `1.29.0` per the npm `latest` tag); v2 is in pre-alpha as of this change's date. The SDK supports zod v4 for tool input schemas via Standard Schema, which matches the project's pinned `npm:zod@^4`. The runtime cost is ~25 KB of JS plus its transitive deps; on Deno's `npm:` shim layer this is the same ballpark as the rest of the npm-shaped imports in the workspace.

**Alternatives considered:**

- **Hand-rolled JSON-RPC over stdio.** The MCP wire protocol is JSON-RPC 2.0 with a small extension for tool / resource / prompt registration. Implementing it from scratch is ~300 lines plus version negotiation plus capability advertisement plus the surrounding test harness. Across one tool group it is tempting; across seven tools and a forward roadmap to PO tools (step 16) it is a maintenance liability. Rejected.
- **`@hono/mcp` middleware.** A community-driven Hono integration that mounts MCP on an HTTP route. The input file rejects HTTP transport ("Pick stdio for now and document"), and even if we revisited that, `@hono/mcp` ties MCP to the orchestration server's lifecycle — defeating the §6 fresh-session-per-cycle rule. Rejected for prototype scope; revisit if a future change wants HTTP MCP.
- **`mark2` or other community Deno ports.** The official SDK ships ESM and works on Deno today; community ports add another point of drift. Rejected.

### Decision 2: MCP-server topology — separate stdio process per role-runtime cycle, spawned by the engineer subprocess via its `mcpServers` config

**Why:** the role runtime spawns the coding-agent subprocess once per cycle (§6.2). Every supported coding-agent CLI accepts an `mcpServers` configuration block whose entries are `{ command, args, env }` — the CLI spawns each MCP server as a child process and connects via stdio. The natural mapping is therefore:

```
role runtime (Deno)
    └── coding-agent subprocess (claude-code | cursor-agent | opencode)
            └── @keni/server MCP server (Deno)
                  → HTTP client → orchestration server (REST + WS already running)
```

Three properties fall out of this topology:

1. **Single-writer-through-API holds.** The MCP server is an HTTP client of the orchestration server; the orchestration server is the only thing that writes `.keni/`. §5.3 is preserved by construction.
2. **Fresh session per cycle (§6 / §11#2) is preserved.** Each MCP-server process starts when the cycle starts and dies when the cycle ends. No shared memory across cycles, no leaked subscriptions, no surprise state.
3. **Multi-engineer (step 26) is one extra process, not a code change.** Each engineer's role-runtime cycle spawns its own coding-agent subprocess, which spawns its own MCP-server process with `--agent <its-id>`. The orchestration server already enforces per-agent guards.

**Alternatives considered:**

- **Embed MCP in the orchestration server (single process, HTTP transport).** Gives one process to manage; conflicts with the input file's stdio choice and with §6's fresh-session rule. Rejected.
- **Long-lived MCP daemon (one per project, persistent across cycles).** Saves spawn cost (~hundreds of ms per cycle); breaks §6 / §11#2; introduces a third process to lifecycle. Spawn cost is irrelevant on a 1-minute engineer tick. Rejected.
- **Embed MCP directly in the role runtime (skip the coding-agent's `mcpServers` config and pipe stdio ourselves).** Couples the role runtime to MCP-protocol bookkeeping that `mcpServers` already handles. Rejected — the coding-agent CLI is the natural place to attach MCP servers; we should use the seam each CLI already provides.

### Decision 3: Entry-point shape — three layered functions, mirroring the orchestration server

**Why:** the MCP server is consumed in three ways: integration tests need the configured `McpServer` instance to drive via the SDK's in-process client transport pair; a developer running `deno run -A packages/server/src/mcp/main.ts ...` needs a process-level entry; step 07's role runtime needs a programmatic CLI-style entry that returns an exit code. Splitting these three concerns into three functions makes each easy to test and matches the orchestration server's pattern (`createServer` / `startServer` / `runServer` from step 04). The shape:

```
packages/server/src/mcp/
├── main.ts                # exports createMcpServer, runMcpServer + main_test.ts; runs as a script under import.meta.main
├── main_test.ts           # smoke test the composition root
├── createMcpServer.ts     # builds the McpServer instance, registers tools, returns it; pure, synchronous
├── createMcpServer_test.ts
├── runMcpServer.ts        # CLI-style: parses args, validates, instantiates HTTP client, calls createMcpServer, connects StdioServerTransport, awaits shutdown
├── runMcpServer_test.ts
├── httpClient.ts          # typed HTTP adapter; one method per delegated endpoint; throws McpHttpError on non-2xx
├── httpClient_test.ts
├── errors.ts              # McpHttpError + mapHttpErrorToToolResult (the central failure mapper)
├── errors_test.ts
├── tools/
│   ├── tickets.ts         # registerTicketTools(server, deps) — list_tickets, read_ticket, update_ticket_body, transition_ticket_status
│   ├── tickets_test.ts
│   ├── activity.ts        # registerActivityTools — append_activity_entry, query_activity
│   ├── activity_test.ts
│   ├── workspace.ts       # registerWorkspaceTools — get_workspace_path
│   └── workspace_test.ts
├── wire/                  # zod input schemas for tool params (zod v4)
│   ├── tickets.ts
│   ├── activity.ts
│   ├── workspace.ts
│   ├── mod.ts
│   └── *_test.ts
└── integration_test.ts    # spawns a real orchestration server + the MCP server as Deno.Command, exercises every tool through StdioClientTransport
```

`main.ts` is a tiny barrel:

```ts
export { createMcpServer } from "./createMcpServer.ts";
export type { McpServerDeps, McpServerOptions } from "./createMcpServer.ts";
export { runMcpServer } from "./runMcpServer.ts";

if (import.meta.main) {
  Deno.exit(await runMcpServer(Deno.args));
}
```

`createMcpServer({ httpClient, agentId, workspacePath })` is pure and synchronous: given dependencies, it returns a fully-configured `McpServer` instance. Tests pass an in-memory `httpClient` fake; production passes the real one.

`runMcpServer(args)` parses argv (`--agent <id>`, `--server-url <url>`, `--workspace <abs path>`), validates each (agent id matches `/^[a-z0-9_-]+$/`, server URL parses as `http://` and has a port, workspace path exists on disk via `Deno.stat`), instantiates `createMcpHttpClient({ serverUrl, agentId })`, calls `createMcpServer(...)`, attaches a `StdioServerTransport`, and awaits the SDK's `server.connect(transport)` then `server.close()` on stdin EOF. Returns 0 on clean shutdown, 1 on runtime failure (e.g. `--workspace` does not exist), 2 on usage error (missing or malformed arg).

**Alternatives considered:**

- **Single `runMcpServer` that does everything.** Tests then must spawn a subprocess to exercise tool registration; we lose fast unit testing. The split lets in-process tests drive `createMcpServer` directly with a fake HTTP client.
- **Class-based `McpServer` wrapper.** No clear benefit; functions compose better with the dependency-injection pattern and the SDK is already `class McpServer`.

### Decision 4: Identity propagation — three CLI flags, validated at startup, stamped on every HTTP call, never overridable via tool input

**Why:** the engineer subprocess receives an MCP-server process whose identity is fixed at boot. The role runtime knows which engineer this is (it spawned the coding agent for `alice`); the MCP server inherits that knowledge through three CLI flags:

```
--agent <agent-id>           # required; matches /^[a-z0-9_-]+$/
--server-url <http url>      # required; must parse as http://host:port
--workspace <abs path>       # required; must exist as a directory
```

The MCP server's `runMcpServer` validates all three at startup; any failure exits with code 2 and a stderr message naming the missing or malformed argument. After validation, all three are constants for the life of the process: `agentId` is stamped on every outbound `X-Keni-Agent` header; `serverUrl` is the base URL of the typed HTTP client; `workspacePath` is what `get_workspace_path` returns. **Tool input cannot override any of these.** This is enforced by *not exposing* `agent_id`, `role`, `agent`, or `workspace` as parameters on any tool — the MCP layer has no surface through which the agent could attempt to forge identity. The orchestration server's `roleIdentity` middleware does the actual validation; the MCP layer's job is to make sure the headers are correct, not to enforce them.

**The role is hard-coded to `engineer`.** This step ships an engineer-only factory. Step 16 will ship a sibling factory for PO (`createPoMcpServer`) with a different tool set; both factories share the boot-time CLI structure, but the role each stamps is decided at the factory boundary, not via a runtime flag. This makes it impossible for a contributor to accidentally hand the engineer surface to a PO subprocess by passing `--role po`.

**Alternatives considered:**

- **Pass identity via env vars instead of CLI flags.** Equivalent expressively; CLI flags are easier to inspect with `ps`, easier to log, and idiomatic for `deno run`. The role runtime spawning the coding-agent subprocess writes the `mcpServers` config block — flags are clearer there. Rejected env vars; CLI flags chosen.
- **Pass identity inside MCP via a `register_self` tool the agent calls first.** Defeats the whole "the agent cannot forge identity" goal. Rejected.
- **Resolve `workspacePath` from `--agent` + a server round-trip to `/agents` for the project_id.** Coupling: if the orchestration server is unreachable at startup the MCP server cannot boot; even with caching it adds round-trip latency. The role runtime already knows the path; passing it explicitly is simpler and decouples startup from the orchestration server's availability. Rejected.
- **Single flag — a JSON config blob.** Higher ceremony, no clear win for three values. Rejected.

### Decision 5: Tool selection and granularity — seven focused tools (one verb per tool), no aggregate `update_ticket`

**Why:** focused tools are easier for an LLM to reason about, easier to register a precise zod schema for, and easier to assert on in tests. An aggregate `update_ticket(partial)` tool would require the agent to fold "what fields can I change?" and "what's a status transition?" into one call, conflating two very different orchestration-server endpoints (`PATCH /tickets/:id` for header / body and `POST /tickets/:id/transition` for status). Splitting them makes the engineer prompt cleaner, the schema strict, and the failure mode obvious (status-graph refusal returns from `transition_ticket_status`, never from `update_ticket_body`).

The seven tools and their REST mappings:

| Tool                       | Delegates to                          | Input (zod)                                                                            | Output                                  |
| -------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| `list_tickets`             | `GET /tickets?<filters>`              | `{ status?, assignee?, priorityMin?, priorityMax?, change_request? }`                  | `TicketSummary[]`                       |
| `read_ticket`              | `GET /tickets/:id`                    | `{ id }`                                                                               | `TicketResponse`                        |
| `update_ticket_body`       | `PATCH /tickets/:id`                  | `{ id, body }`                                                                         | `TicketResponse`                        |
| `transition_ticket_status` | `POST /tickets/:id/transition`        | `{ id, from, to }`                                                                     | `TicketResponse`                        |
| `append_activity_entry`    | `POST /activity`                      | `{ session_id, event, summary?, refs? }` (`agent` / `role` stamped server-side)        | `ActivityEntryResponse`                 |
| `query_activity`           | `GET /activity?<filters>&limit=<n>`   | `{ agent?, role?, from?, to?, limit? (default 200, hard ceiling 1000) }`               | `ActivityEntryResponse[]`               |
| `get_workspace_path`       | (none; reads boot-time CLI arg)       | `{}` (no input)                                                                        | `{ path: string }`                      |

Tool descriptions (the `description` field shown to the LLM) are written in plain English, ≤ 2 sentences each, and explicitly name what the tool *cannot* do (e.g. "`update_ticket_body` cannot change `status`; use `transition_ticket_status` for that"). The descriptions are part of the engineer's prompt-time context and are intentionally short — Decision 13 in step 04's design doc calls out that tool descriptors must "fit in a system prompt without burning tokens", and the engineer prompt is constrained, so each description's word count matters.

**Alternatives considered:**

- **Aggregate `update_ticket(partial: { title?, body?, priority?, status? })`.** Conflates `PATCH` and `transition`; the orchestration server already rejects `status` in a `PATCH` body via `InvalidArtifactError("status_in_patch")` → 400, so the aggregate would have to pre-route. Rejected — split tools mirror the REST surface 1:1.
- **Separate `list_tickets_by_status` / `list_tickets_assigned_to_me`.** Convenience helpers; the single `list_tickets` with optional filters covers both with one schema. Rejected.
- **`comment_on_ticket` as a first-class tool.** The activity log is the comment thread for now (every ticket-related entry has `refs: { ticket_id }`); a dedicated comment tool is a future-additive change once the spec calls for one. Rejected for prototype.
- **`get_my_tickets` (filters by `agent_id` automatically).** Would require the MCP layer to fold the boot-time agent id into the call; doable, but `list_tickets({ assignee: "<agent-id>" })` from the prompt is one extra parameter and keeps the tool surface uniform. Rejected — the engineer prompt can pass `assignee` explicitly. Revisit if step 09 finds the prompt repeats `assignee: alice` constantly.

### Decision 6: Tool input schemas — zod v4, expressed against the existing `@keni/shared/wire/` types, with the same `z.ZodType<X>` drift detector step 04 introduced

**Why:** the orchestration server already exposes zod schemas (in `packages/server/src/wire/`) bound to the shared TS types (in `packages/shared/src/wire/`). The MCP server's tool input is a *subset* of those request shapes (e.g. `update_ticket_body` accepts only `{ id, body }`, not the full `TicketHeaderPatchRequest` with `title`, `assignee`, `priority`). For each tool we define a fresh zod schema that re-uses the underlying field validators (`z.string().min(1).max(200)` for title-shaped fields, the `TICKET_STATUSES` enum from `@keni/shared` for status-shaped fields, etc.) and is annotated `z.ZodType<McpToolInputType>` so a future drift between the input shape and the underlying REST request shape fails the type check.

The MCP SDK's `registerTool(name, { description, inputSchema }, handler)` accepts a Standard Schema-compatible input; zod v4 satisfies that. The handler receives the *parsed* arguments typed as `z.infer<typeof schema>`.

The tool *output* shape is whatever the underlying REST endpoint returns, mapped via the existing `Ticket(Summary)Response` / `ActivityEntryResponse` types from `@keni/shared/wire/`. The MCP SDK requires content to be wrapped in `{ content: [{ type, text | json | ... }] }`; we return a single `{ type: "text", text: JSON.stringify(record, null, 2) }` block per call, which keeps the LLM's parser happy and lets us evolve to richer content blocks (e.g. resource links) additively later.

**Alternatives considered:**

- **No zod — accept `unknown`, cast inside the handler.** Defeats the whole point of typed MCP; the SDK warns when no input schema is registered. Rejected.
- **Re-use the orchestration server's zod schemas verbatim.** They accept a superset of fields (e.g. `TicketHeaderPatchRequestSchema` accepts `title`, `assignee`, `priority`); we want stricter MCP schemas (e.g. `update_ticket_body` should reject `title`). Defining tool-specific schemas keeps the surface tight and the LLM's reasoning easier. Rejected.
- **JSON Schema directly.** zod is already in the project; rendering zod to JSON Schema (which the MCP SDK does internally for clients that ask for it) preserves a single source of truth. Rejected.

### Decision 7: HTTP client — typed adapter at `httpClient.ts`, one method per delegated endpoint, throws typed `McpHttpError` on non-2xx

**Why:** every tool handler does the same shape of work — serialise input, set `X-Keni-Role: engineer`, set `X-Keni-Agent: <agent-id>`, send a `fetch`, parse the response envelope, throw a typed error on non-2xx. Wrapping that in one adapter (`createMcpHttpClient({ serverUrl, agentId })`) eliminates ~50 lines of boilerplate per tool, makes the role / agent stamping a single seam (no opportunity to forget it on a new tool), and provides a clean injection point for tests.

```ts
// packages/server/src/mcp/httpClient.ts
export interface McpHttpClient {
  listTickets(filter: TicketListFilter): Promise<TicketSummaryResponse[]>;
  readTicket(id: string): Promise<TicketResponse>;
  updateTicketBody(id: string, body: string): Promise<TicketResponse>;
  transitionTicket(id: string, from: TicketStatus, to: TicketStatus): Promise<TicketResponse>;
  appendActivity(input: ActivityAppendInput): Promise<ActivityEntryResponse>;
  queryActivity(filter: ActivityQueryFilter, limit: number): Promise<ActivityEntryResponse[]>;
}

export function createMcpHttpClient(opts: { serverUrl: string; agentId: string }): McpHttpClient { /* ... */ }
```

Each method:

1. Composes the URL (encodes path params, serialises query strings via `URLSearchParams`).
2. Sets `Content-Type: application/json` for write methods.
3. Sets `X-Keni-Role: engineer` and `X-Keni-Agent: <agent-id>` from the closure-captured options.
4. `await fetch(...)`.
5. On 2xx: parses `{ data, project_id }` envelope, returns `data`.
6. On non-2xx: parses `{ error: { code, message, details? } }`, throws `new McpHttpError(code, message, details, status)`.
7. On a network-level failure (`fetch` rejects, e.g. ECONNREFUSED): throws `new McpHttpError("internal_error", `Network error talking to ${url}: ${cause.message}`, ..., 0)`.

The client uses the global `fetch` (Deno's built-in). No new dep. Tests inject a fake (test-only) `McpHttpClient` directly into `createMcpServer`, so the integration test is the only place `fetch` actually runs.

**Alternatives considered:**

- **Each tool handler builds its own `fetch` call.** Repetition; high risk of forgetting the role / agent header on a new tool. Rejected.
- **Bring in `@hono/hono`'s test client (`testClient(app)`).** Couples the MCP server to an in-process Hono instance; conflicts with Decision 2 (separate process). Rejected.
- **Generate the client from an OpenAPI spec.** No OpenAPI today; would force a new artefact. Rejected.

### Decision 8: Error mapping — central function maps `McpHttpError` and unknown errors to MCP `isError: true` content; reuse the `ErrorCode` enum verbatim

**Why:** the orchestration server already defines a closed `ErrorCode` enum (10 codes, locked in step 04) and a stable `ErrorResponse` envelope. The MCP layer should *reuse* those, not re-invent them. One central function (`mapHttpErrorToToolResult`) takes any thrown value and returns `{ content: [{ type: "text", text: <human-readable> }], isError: true }` — the shape MCP `registerTool` handlers must return on failure.

```ts
// packages/server/src/mcp/errors.ts
export class McpHttpError extends Error {
  constructor(
    readonly code: string,            // one of the orchestration-server ErrorCode values, or "internal_error"
    message: string,
    readonly details: Record<string, unknown> | undefined,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

export function mapHttpErrorToToolResult(err: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  if (err instanceof McpHttpError) {
    const detailsBlock = err.details
      ? `\nDetails: ${JSON.stringify(err.details, null, 2)}`
      : "";
    return {
      content: [{
        type: "text",
        text: `[${err.code}] ${err.message} (HTTP ${err.httpStatus})${detailsBlock}`,
      }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{
      type: "text",
      text: `[internal_error] Unexpected error in MCP tool handler: ${message}`,
    }],
    isError: true,
  };
}
```

Every tool handler funnels its `await this.httpClient.*(...)` through a single `try`/`catch` that calls `mapHttpErrorToToolResult` on any throw. Successful results wrap into `{ content: [{ type: "text", text: JSON.stringify(record, null, 2) }] }` with no `isError` flag.

**No new error codes.** The 10 codes from step 04 cover everything the engineer can hit:

- `store_not_found` (404) — `read_ticket`, `update_ticket_body`, `transition_ticket_status` against an unknown id
- `stale_state` (409) — `transition_ticket_status` with a `from` that does not match disk
- `status_graph_violation` (403) — `transition_ticket_status` with a `from→to` not in the graph
- `role_not_owner` (403) — engineer attempting a QA-owned or PO-owned status (e.g. `tested → done`)
- `validation_failed` (400) — tool input fails the zod schema, OR the orchestration server's request schema fails
- `invalid_artifact` (422) — activity entry exceeds the 4 KB limit
- `status_in_patch` (400) — sneaked-in status field on a `PATCH` body (cannot happen via `update_ticket_body` because the schema does not expose status, but the code is documented for completeness)
- `missing_role` (400) — should never occur (the MCP layer always stamps the header), documented as a "this is a bug, file an issue" failure
- `duplicate_id` (409) — currently only `POST /tickets` triggers this; engineers cannot create tickets via MCP today, so this is documented for future-additive completeness
- `internal_error` (500) — orchestration server unreachable, JSON parse failure, or unknown error class

**Alternatives considered:**

- **Throw the `McpHttpError` and let the SDK turn it into an MCP error.** The SDK's behaviour on a thrown handler is to surface a generic "tool handler errored" message — we lose the structured `code` / `details`. Rejected.
- **Add MCP-specific error codes on top.** Splits the vocabulary the agent and the SPA see; defeats the whole "one source of truth for error codes" goal of step 04. Rejected.
- **Return `isError: false` and put the failure in a custom field.** Misuses the MCP protocol. Rejected.

### Decision 9: Workspace-path resolution — read once at startup from `--workspace`, cached, returned verbatim; existence is validated at boot

**Why:** the workspace path is what `get_workspace_path` returns. Two ways to know it:

1. **The role runtime tells us via `--workspace <abs path>`.** Trivial; one `Deno.stat(path)` at startup to fail loudly if the path does not exist.
2. **The MCP server derives it from `<HOME>/.keni/workspaces/<project-id>/<agent-id>/`.** Requires a round-trip to the orchestration server to read `project_id` (or to read `.keni/project.yaml` directly, which violates §5.3 from inside the MCP server).

Option 1 wins on every axis: simpler code, no startup round-trip, no §5.3 violation, no coupling to "where does the role runtime put workspaces today". Step 07 (role runtime) and step 09 (engineer specialisation) own workspace provisioning; they are the natural place to know the path. The MCP server is told.

The path is *frozen* at boot — it is not re-read on every `get_workspace_path` call. This makes the tool deterministic for the life of the cycle and removes any opportunity for the agent to "trick" the MCP server (no tool input touches the path; the `get_workspace_path` schema is `z.object({})`).

The startup validation runs `Deno.stat(workspacePath)` and refuses to start (exit code 1, message on stderr) if the path is not a directory. This protects the engineer subprocess from a tool that returns a stale or bogus path: if the path is wrong at boot, the role runtime's startup phase fails fast before the coding agent is ever invoked.

**Alternatives considered:**

- **No validation; trust the flag.** Tool then returns a path that does not exist; the agent might `cd` into nothing, or worse, into a stale directory. Validation costs one syscall at boot. Rejected.
- **Re-read on every call.** Pointless (the path is invariant); adds latency. Rejected.

### Decision 10: Tool-side defaulting and limits — `query_activity` defaults `limit` to 200, hard ceiling 1000; `append_activity_entry` does not require `agent` or `role` (server-stamped)

**Why two specific defaults:**

1. **`query_activity` cap.** A chatty day partition can carry thousands of entries (one per session start / end / summary / etc. per agent per minute). Returning all of them would burn LLM context. A 200-entry default is large enough to surface a debug-relevant slice and small enough to fit comfortably in the engineer prompt's context budget. The hard ceiling (1000) is a guard against a tool input typo that would otherwise pass through to the orchestration server unchanged. The orchestration server itself has *no* pagination today (per step 04 Decision 11) — the limit lives in the MCP layer because that is where the LLM-context constraint applies. Limits are tool-level concerns, not orchestration concerns.
2. **`append_activity_entry` identity stamping.** The orchestration server's `ActivityAppendRequest` schema requires `agent` and `role`. The MCP layer fills them from the boot-time CLI args, *not* from tool input. This means the agent cannot append an entry attributed to another agent or another role; the surface simply does not let it.

The MCP SDK's tool-input schema for `append_activity_entry` therefore omits `agent` and `role`:

```ts
const AppendActivityInputSchema = z.object({
  session_id: z.string().min(1),
  event: ActivityEventNameSchema,    // reuse the @keni/shared enum
  summary: z.string().max(500).optional(),
  refs: z.record(z.string(), z.string()).optional(),
});
```

Inside the handler, the HTTP client method signature accepts the parsed input plus the captured `agentId`:

```ts
await httpClient.appendActivity({
  ...input,
  agent: agentId,
  role: "engineer",
});
```

**Alternatives considered:**

- **Let the agent pass `agent` and `role` and trust the orchestration server's role guard.** The role guard rejects an `engineer` request whose body claims `role: po` only if the orchestration server validates the body's `role` against the header (it does not — see step 04 Decision 4: "role identity arrives via two headers"; the body's `role` is a separate field used for activity attribution). So letting the agent pass an arbitrary `role` would break attribution. Rejected.
- **Return 200 entries as a string, but also a structured field with a `truncated: true` boolean if more existed.** Useful, but the orchestration server has no efficient `count_only` mode; we'd be making two round-trips per query. Defer; the engineer prompt can re-query with a tighter time window if 200 is hit.

### Decision 11: Test pyramid — unit tests per layer, one end-to-end integration test using the SDK's `StdioClientTransport`, mirror the orchestration server's pattern

**Why:** four concentric circles of safety, each catching what the next layer in cannot.

- **Wire-schema tests (`mcp/wire/*_test.ts`)**: every input schema accepts a documented good example, rejects each documented bad example, and `expectType<z.infer<typeof Schema>>().toEqual<McpToolInput>()` aligns the inferred type with the declared interface. Fast.
- **Error-mapper tests (`errors_test.ts`)**: every `McpHttpError` shape and every "unknown thrown value" shape maps to the documented `{ content, isError: true }` payload. Fast.
- **HTTP-client tests (`httpClient_test.ts`)**: each method against a `Deno.serve`-backed mock server (port 0, OS-assigned) — assert URL composition, header stamping, success body parsing, error body parsing, `internal_error` on network failure. Medium speed.
- **Per-tool handler tests (`tools/*_test.ts`)**: each tool's handler is exercised against a fake `McpHttpClient` (test-only implementation that records calls and returns canned responses). Asserts the handler maps input to the right HTTP-client call, wraps success into the documented MCP content shape, and funnels failures through `mapHttpErrorToToolResult`. Fast.
- **Composition-root tests (`createMcpServer_test.ts`)**: assert that `createMcpServer({ httpClient: fake, agentId, workspacePath })` registers exactly seven tools with the documented names, that `get_workspace_path` returns the boot-time `workspacePath`, and that the registered descriptions match the documented strings (a string-stability assertion makes accidental description drift visible).
- **CLI bootstrap tests (`runMcpServer_test.ts`)**: `runMcpServer(["--agent=alice", "--server-url=http://127.0.0.1:1", "--workspace=" + tempDir])` validates and either runs (drives an in-memory transport pair from the SDK) or fails loudly. Negative tests for missing args, malformed agent id, missing workspace, malformed URL.
- **End-to-end integration test (`integration_test.ts`, ~10 tests)**: spins up a real orchestration server in a `Deno.makeTempDir()`-backed `keni init`-produced project, then spawns the MCP server as a `Deno.Command` subprocess piping stdio, attaches an in-process MCP `Client` from `@modelcontextprotocol/sdk/client` over `StdioClientTransport`, and exercises:
  - Tool list (assert exactly seven tools, names, schemas)
  - `list_tickets` against an empty board (assert `[]`)
  - `read_ticket` against an unknown id (assert `isError: true`, `[store_not_found]`)
  - Create a ticket via the orchestration server's REST surface (the user role); `list_tickets` from MCP returns it; `read_ticket` returns it.
  - `update_ticket_body` updates the body on disk (asserts `.keni/tickets/ticket-0001.md` reflects the change).
  - `transition_ticket_status` with a legal `open → in_progress` succeeds and emits an event (asserts via the orchestration server's `/events` WS the test listens on).
  - `transition_ticket_status` with `tested → done` (PO-owned) returns `isError: true`, `[role_not_owner]`.
  - `transition_ticket_status` with a status-graph violation returns `isError: true`, `[status_graph_violation]`.
  - `append_activity_entry` writes to `.keni/activity/<date>.jsonl` and triggers the on-disk file to grow.
  - `query_activity` returns the appended entry; default limit of 200 honoured; explicit `limit: 5` honoured.
  - `get_workspace_path` returns exactly the temp directory passed via `--workspace`.

**Coverage informal target:** every tool has at least one happy-path test, one error-mapping test, and one schema-rejection test (input schema rejects bad input before the HTTP call ever fires); plus the full integration round-trip.

**Alternatives considered:**

- **Only end-to-end tests against the subprocess.** Slow and brittle; a single failure could be in any layer. Rejected.
- **Mock the MCP SDK's transport and assert on JSON-RPC frames directly.** Coupling to the SDK's wire format; the SDK does this internally. Rejected.

### Decision 12: Folder layout — flat under `packages/server/src/mcp/`, with `tools/` and `wire/` subfolders; co-located tests

**Why:** the MCP server has roughly five concerns (composition root, HTTP client, errors, tools, wire schemas). Each fits in one file (or a small folder). A flat layout under `mcp/` keeps imports short, makes it obvious where a new tool lands, and matches the orchestration server's pattern. The orchestration server's `routes/` and `wire/` subfolders inspired the same shape here. Co-located tests (`*_test.ts` next to source) match the rest of the workspace.

```
packages/server/src/mcp/                  # 1 new top-level folder
  main.ts + main_test.ts                  # composition root, barrel exports
  createMcpServer.ts + _test.ts
  runMcpServer.ts + _test.ts
  httpClient.ts + _test.ts
  errors.ts + _test.ts
  tools/                                  # 3 files, ~50 lines each
    tickets.ts + _test.ts
    activity.ts + _test.ts
    workspace.ts + _test.ts
  wire/                                   # 3 files, zod schemas only
    tickets.ts + _test.ts
    activity.ts + _test.ts
    workspace.ts + _test.ts
    mod.ts                                # barrel
  integration_test.ts                     # end-to-end
```

The MCP code is internal to `@keni/server`; only `runMcpServer`, `createMcpServer`, `McpServerDeps`, and `McpHttpClient` (the type) leak through `packages/server/src/main.ts`. The role runtime in step 07 imports those by their re-exports.

**Alternatives considered:**

- **Promote `mcp/` to its own workspace member (`@keni/mcp-server`).** Adds a workspace entry, a `deno.json`, and forces an export contract for what is otherwise internal to `@keni/server`. The README already names `@keni/server` as "orchestration server, REST + WebSocket APIs, MCP surface" — staying inside `@keni/server` matches that documented intent. Revisit when the MCP code grows past one folder.
- **Inline tool registration in `createMcpServer.ts` instead of `tools/*`.** All seven tools in one file would be ~250 lines; splitting by group keeps each file under 100 lines and leaves room for step 16 (PO tools) to grow alongside without bloating one file.

### Decision 13: zod schemas for tool input live next to the tools (`mcp/wire/`), not promoted to `@keni/shared/wire/`

**Why:** the SPA, the orchestration server's REST handlers, and the role runtime do not need to know what the engineer's MCP tool input shapes look like. Promoting these schemas to `@keni/shared` would force every type-only consumer to pull a contract they never use. Keeping them in `packages/server/src/mcp/wire/` is the same boundary the orchestration server already maintains for its REST schemas, and it leaves room for a future change to either lift them up (when the SPA wants to mirror tool calls in a debug surface) or fork them when step 16 adds PO tools (PO input shapes will probably differ).

The TS interface a type-only consumer might want — `WorkspacePathResponse = { path: string }` — is small enough that it lives inline in the `workspace.ts` tool file and is not exported beyond `@keni/server`. If a future change exposes "workspace info" to the SPA, the type can be promoted to `@keni/shared/wire/` then.

**Alternatives considered:**

- **Promote everything to `@keni/shared`.** Pollutes the SPA's import surface for no current consumer. Rejected for prototype.
- **Co-locate in each `tools/*.ts` file.** Mixes schema and handler concerns; harder to assert the drift detector (`z.ZodType<X>`) at a glance. The split keeps schemas testable on their own.

### Decision 14: The MCP server is engineer-only; PO MCP forks a sibling factory in step 16, not a parameter on this one

**Why:** the design tension is: should `createMcpServer` accept a `role` argument and register tools conditionally, or should there be one factory per role? Two-line summary of the decision: **one factory per role; no shared-tools-with-conditional-registration code path.**

Reasoning:

1. **Tool sets diverge.** The PO never calls `transition_ticket_status` (PO owns only `done`, and §5.3 means the PO writes ticket creates differently — see step 16's spec for `ticket_create_from_cr`). The engineer never calls a chat tool. A unified factory would have ten branches; two factories have zero.
2. **The role guard is at the factory boundary.** The engineer factory hard-codes `"engineer"`; the PO factory will hard-code `"po"`. There is no "what role is this MCP server today" runtime question. A future contributor cannot accidentally hand the engineer surface to a PO subprocess via `--role po` because the flag does not exist.
3. **Step 16's spec will land alongside its own factory.** That spec will describe the PO tool surface, naming each tool with parameters / errors / idempotency just like this step's spec describes the engineer surface. Two specs; two factories. Consistency.

**Code shape for this step:**

```ts
// packages/server/src/mcp/createMcpServer.ts
export interface McpServerDeps {
  readonly httpClient: McpHttpClient;
  readonly agentId: string;       // matches the X-Keni-Agent header value
  readonly workspacePath: string;  // boot-time absolute path
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({
    name: "keni-engineer-mcp",
    version: "0.1.0",  // matches the prototype
  });
  registerTicketTools(server, deps);
  registerActivityTools(server, deps);
  registerWorkspaceTools(server, deps);
  return server;
}
```

Every tool registration is a single function call; the per-role hard-coding lives inside the HTTP client (`X-Keni-Role: engineer`) and the activity-event stamping (`role: "engineer"`).

**Alternatives considered:**

- **One factory, `role` argument.** Conditional tool registration; runtime question; risk of surface leakage. Rejected.
- **Tool-set "profiles" (e.g. enum `engineer | po`).** Same problem as a `role` argument with an extra layer. Rejected.

### Decision 15: New code lives in `@keni/server` only; no new workspace package; no SPA / role-runtime / shared changes beyond the noted dep additions

**Why:** the input file describes the MCP surface as "hosted by the orchestration server"; the README already names the server package as the home of "REST + WebSocket APIs, MCP surface". Putting the MCP code inside `@keni/server` matches that documented intent and keeps the workspace small. The role runtime (step 07) imports `runMcpServer` from `@keni/server`'s main barrel — a cross-package import, but a thin one (one function and a couple of types).

**Files touched:**

```
packages/server/src/mcp/                  ← new top-level folder, ~25 new files
packages/server/src/main.ts               ← extended barrel; re-export runMcpServer + McpServerDeps + McpHttpClient
deno.json                                 ← add npm:@modelcontextprotocol/sdk@^1
deno.lock                                 ← regenerated
README.md                                 ← extended with the MCP forward-reference subsection
openspec/                                 ← this change directory
```

No file in `packages/cli/`, `packages/spa/`, `packages/role-runtimes/`, or `packages/shared/` is modified.

**Alternatives considered:**

- **New `@keni/mcp-server` package.** Workspace overhead; rejected (Decision 12).
- **Add wire types to `@keni/shared`.** Rejected (Decision 13).

## Risks / Trade-offs

- **[Trusted role headers in the prototype.]** A malicious caller who can spawn the MCP server binary directly with `--agent <victim-id>` could impersonate that engineer and write to the activity log under a wrong identity. → **Mitigation:** the prototype is local-only and `127.0.0.1`-bound (per step 04's trust model); the role runtime is the only legitimate spawner of the MCP server in the engineer subprocess's `mcpServers` config. Documented in this `design.md` and in the capability spec.
- **[SDK v1 → v2 migration cost.]** v2 is in pre-alpha as of this change's date; when it stabilises, the SDK splits into `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, requires Node 20+, drops CommonJS, and moves HTTP framework integrations to separate middleware packages. → **Mitigation:** pin `^1` in `deno.json`; the MCP code is localised in `packages/server/src/mcp/` (~25 files); a v2 migration is a single-folder change. The migration playbook is one paragraph in the SDK's `docs/migration.md`. Risk is low for prototype scope.
- **[zod v4 / SDK schema-binding drift.]** The SDK supports zod v4 today via Standard Schema; if the SDK's schema-binding contract changes in a v1.x patch (unlikely) or in v2 (more likely), tool registration could fail at startup. → **Mitigation:** integration tests exercise tool registration on every CI run; a startup-level mismatch is caught immediately. The schemas are simple `z.object({...})` / `z.string()` / `z.enum(...)` shapes, the most stable subset of zod's API.
- **[Token leak from chatty activity logs.]** A `query_activity` call without a `from`/`to` window could return thousands of entries, blowing the LLM's context. → **Mitigation:** default `limit: 200` (Decision 10), hard ceiling 1000. The engineer prompt (step 09) will document the recommended pattern: "narrow with `from` / `to` first; lift `limit` only if a smaller window does not surface the right entry."
- **[Race between two engineers on the same ticket (post-step-26).]** Two engineers in MVP could pick up the same ticket if the prompt allows (e.g. both look at "highest-priority `open`"). The MCP server itself has no leasing or claim mechanism. → **Mitigation:** today's mitigation is the orchestration server's atomic file writes (`StaleStateError` from step 02 on a transition with a stale `from`) + the §4.2 owning-role rule + status-machine enforcement. One engineer wins the `open → in_progress` transition; the other gets `409 stale_state`. Step 26 will introduce ticket leasing if that is not enough; the MCP layer is unaffected by that change because the leasing logic lives in the orchestration server.
- **[Network-level failures in a tool call.]** If the orchestration server is killed mid-cycle, the MCP server's next HTTP call rejects with a network error. → **Mitigation:** every tool returns `isError: true` with `[internal_error] Network error talking to ${url}: ${cause.message}`. The role runtime captures the engineer subprocess's stdout / stderr to the activity log; the failure is visible. The runtime then logs `session_end` and the next cycle's tick will retry. Documented in the capability spec.
- **[`Deno.stat` race on `--workspace`.]** Between startup validation and the first `get_workspace_path` call, the workspace directory could be deleted (e.g. an aggressive cleanup in another shell). → **Mitigation:** the path-frozen-at-boot Decision (9) is a deliberate trade-off — checking on every call would mask a real bug (the role runtime promised the path; if it lied, the boot validation catches it; if the path disappears mid-cycle, the agent's next file-system read in the workspace will fail anyway). The cycle-level error (likely a build / test failure inside the agent) is a more honest signal than a tool that returns "the workspace I was told about no longer exists."
- **[MCP SDK transitive dependencies on Deno's `npm:` shim.]** The SDK pulls a small number of transitive npm packages (notably an `eventsource-parser` for HTTP transport and a Standard-Schema binding). On Deno's `npm:` shim layer some packages misbehave. → **Mitigation:** the integration test exercises the actual SDK in a real Deno subprocess; any shim-layer issue surfaces immediately. We use only the stdio transport, so the HTTP-transport-only deps are tree-shaken at module-resolution time. If a specific transitive blocks the shim, there is a documented escape hatch: pin a known-good SDK patch version in `deno.json`.
- **[MCP server lifetime tied to the coding agent's spawn behaviour.]** Some coding-agent CLIs reuse MCP-server processes across multiple sessions; others spawn fresh per session. The §6 fresh-session rule says we want fresh per cycle. → **Mitigation:** stdio MCP servers terminate when their stdin closes, which the coding-agent CLI does on subprocess exit. Step 07 will document the configuration knob (`mcpServers.<name>.terminateOn`) per coding-agent CLI to ensure fresh-per-cycle behaviour. Risk is low: every supported CLI defaults to fresh-per-spawn for stdio servers.
- **[Tool description drift relative to the engineer prompt (step 09).]** The engineer prompt names the seven tools; if a tool description changes here without a matching prompt update, the prompt's behaviour drifts. → **Mitigation:** `createMcpServer_test.ts` includes a string-stability assertion on each registered tool's description (a hand-encoded copy of the description is compared verbatim). When step 09 lands, the prompt builder will reference the same constants, so changing a description is a coordinated edit.
- **[The `agent` and `role` body fields on `POST /activity` are still accepted by the orchestration server today.]** Per Decision 10, the MCP layer hard-codes them. If a future contributor accidentally piped tool input through to the body, an engineer could attribute an entry to `bob`. → **Mitigation:** the tool input schema does not include `agent` or `role` fields; the HTTP-client method's signature does not accept them as inputs (it composes the body from the parsed tool input plus the closure-captured `agentId`). A unit test in `tools/activity_test.ts` asserts that an attempt to inject `agent` or `role` into the input is rejected by the schema.
- **[The capability spec promises a contract step 09's prompt depends on.]** A drift between the spec and the registered tools is a silent landmine. → **Mitigation:** `createMcpServer_test.ts` asserts each registered tool's name, description, and parameter schema against a hand-encoded copy of the spec's tool table. CI is the long-term mechanism; the spec walk verification block in `tasks.md` is the short-term one.

## Migration Plan

Not applicable — additive, greenfield MCP layer. No on-disk artefacts produced or consumed by this step. Rollback is `git revert` of the change's commits; the orchestration server, the storage layer, the SPA, the CLI, and `~/.keni/` all stay green without modification.

If a contributor in a downstream branch has been driving the engineer subprocess against the orchestration server's REST surface directly (e.g. via `curl` from inside the coding-agent's tool list), migrating to the MCP server is a straightforward swap: replace the curl tool with an `mcpServers` entry pointing at `deno run -A packages/server/src/mcp/main.ts ...`, and replace each curl invocation in the prompt with the corresponding MCP tool call (which is the whole point — the prompt becomes simpler).

## Open Questions

- **Should the SDK be pinned to v1 or to a specific patch?** v1.x is the stable line per the npm `latest` tag, currently `1.29.0`. → **Decision for this step:** `^1` in `deno.json`. If a v1.x patch breaks our integration test, pin to a known-good `~1.<minor>` then.
- **Should `WorkspacePathResponse` (or any tool's return shape) be promoted to `@keni/shared`?** The SPA does not consume MCP today; the role runtime is internal to `@keni/role-runtimes`. → **Decision for this step:** keep server-internal (Decision 13). Promote when (and if) the SPA wants a "what is alice working on, on disk?" surface.
- **Should engineer-initiated PR record creation get an MCP tool?** The input file calls this out as a flag for `design.md`: "engineer-initiated PR record creation can go through a future MCP tool if needed." → **Decision for this step:** no. Step 09 will wire PR creation through the role runtime's git layer (the runtime watches the workspace for a new branch + push, then `POST /prs` on behalf of the engineer). If that proves awkward in step 09 — e.g. the engineer prompt has trouble communicating PR intent — a `create_pr` MCP tool is an additive change and lands in a new OpenSpec change that delta-modifies `mcp-engineer-surface`.
- **Should we expose tool-level idempotency keys?** MCP tools are conceptually idempotent (a `transition_ticket_status` retried after a network failure should land the same transition or fail with `stale_state`). The orchestration server has no idempotency-key surface today. → **Decision for this step:** no idempotency keys. The server's `stale_state` plus `from`/`to` body fields *are* the idempotency mechanism: a retry with the original `from` either succeeds (the first attempt did not land) or returns `409 stale_state` (the first attempt did land, the state moved on). Documented in the capability spec.
- **Should `query_activity`'s `limit` parameter be renamed to `max_entries` to match a possible future MCP convention?** `limit` is the convention the orchestration server's REST surface uses (none today, but a future paginated `GET /activity?limit=` would use it). → **Decision for this step:** `limit`. Forward-compatible with future REST pagination (Decision 11 in step 04's design).
- **Should the MCP server reject tool calls during shutdown?** The SDK's `server.close()` rejects in-flight calls. → **Decision for this step:** rely on SDK behaviour. Documented for clarity.
- **Should the integration test exercise the heartbeat / liveness of the MCP transport?** MCP stdio has no heartbeat (the transport is "alive" iff stdin is open). → **Decision for this step:** no heartbeat tests. The integration test exercises shutdown by closing stdin; the SDK handles the rest.
- **Should we cap parallel tool calls?** The MCP SDK serialises tool calls per connection by default. → **Decision for this step:** rely on SDK default. No custom concurrency control.
