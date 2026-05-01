## ADDED Requirements

### Requirement: `@keni/server` exposes a runnable stdio MCP server for engineer subprocesses

The `@keni/server` package SHALL expose, from `packages/server/src/mcp/`, a runnable stdio MCP server whose entry-point is composed of three layered functions: `createMcpServer(deps: McpServerDeps): McpServer` (pure factory, returns a fully-configured `McpServer` instance from `@modelcontextprotocol/sdk` with all engineer tools registered, performs no I/O), `runMcpServer(args: string[]): Promise<number>` (CLI-style entry that parses argv, validates, instantiates the typed HTTP client, calls `createMcpServer`, attaches a `StdioServerTransport`, awaits shutdown, and returns an exit code: 0 on clean shutdown, 1 on runtime failure, 2 on usage error), and `packages/server/src/mcp/main.ts` (re-exports the two functions plus the `McpServerDeps` and `McpHttpClient` types, and invokes `Deno.exit(await runMcpServer(Deno.args))` only when run as a script via `import.meta.main`). The `@keni/server` package's main barrel (`packages/server/src/main.ts`) SHALL re-export `runMcpServer`, `createMcpServer`, `McpServerDeps`, and `McpHttpClient` so the role runtime in step 07 can `import { … } from "@keni/server"` without reaching into the `mcp/` subdirectory.

#### Scenario: `createMcpServer` returns a configured `McpServer` without performing I/O

- **WHEN** a caller invokes `createMcpServer({ httpClient: fakeClient, agentId: "alice", workspacePath: "/tmp/ws" })`
- **THEN** the call resolves synchronously without making any HTTP request, file read, or other I/O
- **AND** the returned value is an `McpServer` instance whose registered-tool list contains exactly the seven documented tools (`list_tickets`, `read_ticket`, `update_ticket_body`, `transition_ticket_status`, `append_activity_entry`, `query_activity`, `get_workspace_path`)

#### Scenario: `runMcpServer` exits 0 on a clean shutdown

- **WHEN** `runMcpServer(["--agent=alice", "--server-url=http://127.0.0.1:<port>", "--workspace=<existingDir>"])` is invoked against a running orchestration server
- **AND** the transport's stdin is then closed
- **THEN** the function resolves with exit code 0
- **AND** the connected `StdioServerTransport` has been disconnected exactly once

#### Scenario: `runMcpServer` exits 2 when a required argument is missing

- **WHEN** `runMcpServer([])` is invoked with no arguments
- **THEN** the function returns exit code 2
- **AND** stderr names the missing required arguments (`--agent`, `--server-url`, `--workspace`) and lists the documented flag names

#### Scenario: `runMcpServer` exits 2 when an argument is malformed

- **WHEN** `runMcpServer(["--agent=Bad Agent!", "--server-url=not-a-url", "--workspace=/abs/path"])` is invoked
- **THEN** the function returns exit code 2
- **AND** stderr names which argument failed validation and the validation rule that was violated (e.g. `agent must match /^[a-z0-9_-]+$/`)

#### Scenario: `runMcpServer` exits 1 when `--workspace` does not exist on disk

- **WHEN** `runMcpServer(["--agent=alice", "--server-url=http://127.0.0.1:1", "--workspace=/does/not/exist"])` is invoked
- **THEN** the function returns exit code 1
- **AND** stderr names the missing path and the failure mode (e.g. `workspace path does not exist or is not a directory`)

#### Scenario: `main.ts` exports the documented public surface

- **WHEN** a downstream module (e.g. step 07's role runtime) imports `runMcpServer`, `createMcpServer`, `McpServerDeps`, and `McpHttpClient` from `@keni/server`
- **THEN** the imports resolve without error
- **AND** no internal MCP module path (`@keni/server/mcp/...`) needs to be referenced

### Requirement: The MCP server is engineer-only — the role is hard-coded at the factory boundary, never exposed as a parameter

The `createMcpServer` factory SHALL hard-code the role identity to `engineer`. The `--role` CLI flag SHALL NOT exist on `runMcpServer`. The HTTP client created at startup SHALL stamp `X-Keni-Role: engineer` on every outbound request without checking any input. Tool input schemas SHALL NOT include a `role` parameter. A future PO MCP server (step 16) SHALL be implemented as a sibling factory (e.g. `createPoMcpServer`) that hard-codes `"po"`; both factories SHALL share the boot-time-CLI shape but SHALL NOT be parameterised by a runtime `role` argument. This MUST guarantee that no contributor can hand the engineer surface to a non-engineer subprocess by passing a flag.

#### Scenario: No tool input schema includes a `role` field

- **WHEN** the seven registered tool input schemas are inspected
- **THEN** none of them declares a `role` parameter
- **AND** none of them declares an `agent` parameter
- **AND** none of them declares a `workspace` parameter

#### Scenario: Outbound HTTP requests carry `X-Keni-Role: engineer`

- **WHEN** any tool handler calls the typed HTTP client
- **AND** the HTTP client issues the `fetch`
- **THEN** the request carries the header `X-Keni-Role: engineer`
- **AND** the request carries the header `X-Keni-Agent: <agentId from boot config>`

#### Scenario: The CLI does not accept `--role`

- **WHEN** `runMcpServer(["--agent=alice", "--server-url=http://127.0.0.1:1", "--workspace=<existingDir>", "--role=po"])` is invoked
- **THEN** the function returns exit code 2
- **AND** stderr names `--role` as an unknown flag

### Requirement: The seven engineer tools are registered with the documented names, descriptions, and zod input schemas

`createMcpServer` SHALL register exactly these tools, each with a non-empty `description`, a zod v4 `inputSchema`, and a handler that delegates to the typed HTTP client (or, for `get_workspace_path`, returns the boot-time `workspacePath`):

| Tool name | Description (≤2 sentences) | Input schema (zod v4) | HTTP delegate |
| --- | --- | --- | --- |
| `list_tickets` | Lists tickets in the project, optionally filtered by status, assignee, priority range, or change-request id. Returns a summary view per ticket; use `read_ticket` for the full body. | `{ status?: string \| string[], assignee?: string \| null, priorityMin?: number, priorityMax?: number, change_request?: string \| null }` | `GET /tickets?<filters>` |
| `read_ticket` | Reads a single ticket by id. Returns the full ticket including its markdown body. | `{ id: string }` | `GET /tickets/:id` |
| `update_ticket_body` | Updates the markdown body of a ticket. Cannot change the ticket's status, title, assignee, priority, or change-request link; use `transition_ticket_status` to move statuses. | `{ id: string, body: string }` | `PATCH /tickets/:id` |
| `transition_ticket_status` | Transitions a ticket from `from` to `to`, where `to` must be in the engineer-owned subset of the status graph. Returns the updated ticket on success; the orchestration server enforces the §4.1 status graph and §4.2 owning-role rule. | `{ id: string, from: TicketStatus, to: TicketStatus }` | `POST /tickets/:id/transition` |
| `append_activity_entry` | Appends one entry to the project's activity log under the calling agent's identity. The `agent` and `role` fields are stamped server-side and cannot be overridden. | `{ session_id: string, event: ActivityEventName, summary?: string, refs?: Record<string, string> }` | `POST /activity` |
| `query_activity` | Queries the activity log with optional filters and a per-call limit (default 200, hard ceiling 1000). Use a narrow `from`/`to` window to keep results focused. | `{ agent?: string, role?: string, from?: string, to?: string, limit?: number }` | `GET /activity?<filters>` |
| `get_workspace_path` | Returns the absolute filesystem path of this engineer's workspace clone. The path is read once at startup and is constant for the life of this MCP-server process. | `{}` (no input) | (none — reads boot-time CLI arg) |

Each tool's `description` SHALL be a single literal string in the source code (no template interpolation). The descriptions SHALL be matched verbatim by a string-stability test in `createMcpServer_test.ts` so a silent edit fails CI.

#### Scenario: All seven tools are registered with the documented names

- **WHEN** `createMcpServer` is constructed with a fake HTTP client
- **AND** the resulting server's tool list is queried
- **THEN** the names exactly equal `["list_tickets", "read_ticket", "update_ticket_body", "transition_ticket_status", "append_activity_entry", "query_activity", "get_workspace_path"]` (order is implementation-defined)

#### Scenario: Each tool registers with a non-empty description

- **WHEN** the registered tool list is inspected
- **THEN** every tool's `description` field is a non-empty string
- **AND** every tool's `description` is at most 2 sentences (≤ 240 characters as a soft cap)

#### Scenario: `update_ticket_body`'s schema rejects sneaked-in fields

- **WHEN** `update_ticket_body` is invoked with input `{ id: "ticket-0001", body: "new body", status: "in_progress" }`
- **THEN** the input schema rejects the call before any HTTP request is made
- **AND** the tool result has `isError: true`
- **AND** the error message names `validation_failed`

#### Scenario: `append_activity_entry`'s schema rejects identity overrides

- **WHEN** `append_activity_entry` is invoked with input `{ session_id: "s1", event: "summary", agent: "bob" }`
- **THEN** the input schema rejects the call before any HTTP request is made
- **AND** no entry is appended to the activity log

### Requirement: Identity propagation — three CLI flags validated at startup, stamped on every outbound request, never overridable via tool input

`runMcpServer` SHALL accept exactly three required CLI flags: `--agent <agent-id>` (must match `/^[a-z0-9_-]+$/`), `--server-url <http url>` (must parse as a `URL` and have an `http:` or `https:` protocol; in the prototype the host SHOULD be `127.0.0.1` but no validation enforces this — the role runtime is responsible), and `--workspace <abs path>` (must exist on disk as a directory at startup, validated via `Deno.stat`). After validation, all three values SHALL be captured as constants for the life of the MCP-server process. The HTTP client SHALL use `agentId` and `serverUrl` to stamp every outbound request with `X-Keni-Role: engineer`, `X-Keni-Agent: <agentId>`, and the resolved URL. Tool input SHALL have no surface for an LLM to override any of these values.

#### Scenario: Argument validation runs before any I/O

- **WHEN** `runMcpServer` is invoked with malformed arguments
- **THEN** validation fails before the HTTP client is instantiated
- **AND** validation fails before `Deno.stat(workspacePath)` is called when the malformed argument is `--agent` or `--server-url`

#### Scenario: `--workspace` is validated as an existing directory at startup

- **WHEN** `runMcpServer(["--agent=alice", "--server-url=http://127.0.0.1:1", "--workspace=<file-not-dir>"])` is invoked against a path that exists but is a regular file
- **THEN** the function returns exit code 1
- **AND** stderr names the validation failure (`workspace path is not a directory`)

#### Scenario: Boot-time identity is stamped on every outbound HTTP call

- **WHEN** any of the seven tools is invoked against a real HTTP backend
- **AND** the HTTP backend captures the inbound request headers
- **THEN** every captured request has `X-Keni-Role: engineer`
- **AND** every captured request has `X-Keni-Agent` equal to the value passed via `--agent`
- **AND** the server URL (origin) of every captured request equals the value passed via `--server-url`

### Requirement: Every tool delegates to an existing orchestration-server REST endpoint via a typed HTTP client; no tool reads or writes `.keni/` directly

`packages/server/src/mcp/httpClient.ts` SHALL export `createMcpHttpClient(opts: { serverUrl: string; agentId: string }): McpHttpClient` returning an object with one method per delegated endpoint: `listTickets(filter)`, `readTicket(id)`, `updateTicketBody(id, body)`, `transitionTicket(id, from, to)`, `appendActivity(input)`, `queryActivity(filter, limit)`. Each method SHALL: (1) compose the URL using `URLSearchParams` for query strings; (2) set `Content-Type: application/json` for write methods; (3) set `X-Keni-Role: engineer` and `X-Keni-Agent: <agentId>`; (4) issue `await fetch(...)`; (5) on a 2xx response, parse the `{ data, project_id }` envelope and return `data`; (6) on a non-2xx response, parse the `{ error: { code, message, details? } }` envelope and throw `new McpHttpError(code, message, details, status)`; (7) on a network-level rejection (`fetch` rejects, e.g. ECONNREFUSED), throw `new McpHttpError("internal_error", `Network error talking to ${url}: ${cause.message}`, ..., 0)`. No method SHALL read or write any path under `.keni/` directly; every state-changing operation flows through the orchestration-server REST endpoint that owns it.

#### Scenario: A successful response is unwrapped from the envelope

- **WHEN** `httpClient.listTickets({})` is called
- **AND** the orchestration server responds 200 with `{ data: [{ id: "ticket-0001", … }], project_id: "<uuid>" }`
- **THEN** the method's return value is the `data` array (not the envelope)

#### Scenario: A non-2xx response surfaces as a typed `McpHttpError`

- **WHEN** `httpClient.readTicket("ticket-9999")` is called
- **AND** the orchestration server responds 404 with `{ error: { code: "store_not_found", message: "..." }, project_id: "<uuid>" }`
- **THEN** the method rejects with an `McpHttpError`
- **AND** the error's `code` is `"store_not_found"`
- **AND** the error's `httpStatus` is `404`

#### Scenario: A network-level failure surfaces as `internal_error`

- **WHEN** `httpClient.listTickets({})` is called
- **AND** the orchestration-server URL refuses the TCP connection (or the call times out)
- **THEN** the method rejects with an `McpHttpError`
- **AND** the error's `code` is `"internal_error"`
- **AND** the error's `message` names the URL that was being targeted

#### Scenario: No tool reads `.keni/` directly

- **WHEN** the source code under `packages/server/src/mcp/` is grepped for `Deno.readTextFile`, `Deno.writeTextFile`, `Deno.readFile`, `Deno.writeFile`, or any path beginning with `.keni/`
- **THEN** no occurrence is found in any tool handler or HTTP-client method (test files MAY use `Deno.stat` against the workspace path passed via `--workspace`, which is itself outside `.keni/`)

### Requirement: Errors map to the MCP `isError: true` shape via a single central function; the orchestration server's `ErrorCode` enum is reused verbatim with no new codes

`packages/server/src/mcp/errors.ts` SHALL export `class McpHttpError extends Error` with public readonly fields `code: string`, `details: Record<string, unknown> | undefined`, and `httpStatus: number`. It SHALL also export `mapHttpErrorToToolResult(err: unknown): { content: [{ type: "text"; text: string }]; isError: true }` whose behaviour is: (a) when `err instanceof McpHttpError`, return content with text `[<code>] <message> (HTTP <status>)` plus an indented `Details:` block when `details` is defined; (b) when `err` is any other thrown value, return content with text `[internal_error] Unexpected error in MCP tool handler: <message>`; in all cases `isError` is `true`. Every tool handler SHALL wrap its HTTP-client call in `try`/`catch` and pass any thrown value through `mapHttpErrorToToolResult`. Successful tool results SHALL be wrapped as `{ content: [{ type: "text", text: JSON.stringify(record, null, 2) }] }` with no `isError` key. The codes a tool may surface SHALL be drawn from the closed `ErrorCode` enum defined in `@keni/shared/wire/errors.ts` (`store_not_found`, `stale_state`, `duplicate_id`, `invalid_artifact`, `status_in_patch`, `status_graph_violation`, `role_not_owner`, `missing_role`, `validation_failed`, `internal_error`); no new code SHALL be added to the enum by this change.

#### Scenario: A `store_not_found` HTTP error becomes an MCP `isError: true` result

- **WHEN** `read_ticket` is invoked with id `ticket-9999` against an empty project
- **AND** the orchestration server responds with 404 `store_not_found`
- **THEN** the tool result has `isError: true`
- **AND** the `content[0].text` starts with `[store_not_found]`
- **AND** the result is **not** thrown — it is returned per the MCP SDK's tool-handler contract

#### Scenario: A `role_not_owner` HTTP error becomes an MCP `isError: true` result

- **WHEN** `transition_ticket_status` is invoked with `{ id: "ticket-0001", from: "tested", to: "done" }` (PO-owned target)
- **AND** the on-disk status is `tested`
- **THEN** the tool result has `isError: true`
- **AND** the `content[0].text` starts with `[role_not_owner]`
- **AND** the on-disk ticket status is unchanged

#### Scenario: A `status_graph_violation` HTTP error becomes an MCP `isError: true` result

- **WHEN** `transition_ticket_status` is invoked with `{ id: "ticket-0001", from: "open", to: "merged" }` (graph violation)
- **AND** the on-disk status is `open`
- **THEN** the tool result has `isError: true`
- **AND** the `content[0].text` starts with `[status_graph_violation]`

#### Scenario: A network-level failure becomes an `[internal_error]` MCP result naming the URL

- **WHEN** any tool is invoked
- **AND** the orchestration server is unreachable
- **THEN** the tool result has `isError: true`
- **AND** the `content[0].text` starts with `[internal_error]`
- **AND** the `content[0].text` names the URL that was being targeted

#### Scenario: An unknown thrown value becomes an `[internal_error]` MCP result

- **WHEN** a tool handler internal helper throws a non-`McpHttpError` value (e.g. a `TypeError` from a JSON parse failure)
- **THEN** the tool result has `isError: true`
- **AND** the `content[0].text` starts with `[internal_error]`
- **AND** the original message is preserved

#### Scenario: The `ErrorCode` enum is unchanged from step 04

- **WHEN** the value of `ERROR_CODES` in `@keni/shared/wire/errors.ts` is read after this change lands
- **THEN** the array equals the closed list from step 04 (`store_not_found`, `stale_state`, `duplicate_id`, `invalid_artifact`, `status_in_patch`, `status_graph_violation`, `role_not_owner`, `missing_role`, `validation_failed`, `internal_error`)
- **AND** no new code has been added by this change

### Requirement: `list_tickets`, `read_ticket`, `update_ticket_body`, `transition_ticket_status` cover the engineer's ticket surface end-to-end

The four ticket tools SHALL together cover read, partial-update, and status-transition. `list_tickets` SHALL accept the same filter shape as `GET /tickets` (`status` as a single value or comma-separated list, `assignee` as a string id or the literal `null`, `priorityMin` / `priorityMax` integers, `change_request` as a CR id or `null`); the tool SHALL serialise the filter into the same query-string convention the REST endpoint uses. `read_ticket` SHALL accept `{ id: string }`. `update_ticket_body` SHALL accept `{ id: string, body: string }` and SHALL reject any input shape with extra keys (zod's `.strict()` semantics). `transition_ticket_status` SHALL accept `{ id, from, to }` where `from` and `to` are the closed `TicketStatus` enum from `@keni/shared/wire/tickets.ts`; the orchestration server's existing `TICKET_STATUS_TRANSITIONS` graph and `TICKET_STATUS_OWNING_ROLES` table SHALL govern reachability and ownership; the MCP tool SHALL NOT pre-validate either (the REST endpoint is the single source of truth).

#### Scenario: `list_tickets` against an empty project returns an empty list

- **WHEN** `list_tickets({})` is invoked against a freshly initialised project
- **THEN** the tool result's `content[0].text` parses as JSON `[]`
- **AND** `isError` is absent (success path)

#### Scenario: `list_tickets` filter on `status` honours a single value

- **WHEN** `list_tickets({ status: "open" })` is invoked against a project containing tickets in three statuses
- **THEN** the result contains only tickets whose status is `open`

#### Scenario: `list_tickets` filter on `status` honours an array

- **WHEN** `list_tickets({ status: ["open", "in_progress"] })` is invoked against a project containing tickets in three statuses
- **THEN** the result contains only tickets whose status is `open` or `in_progress`

#### Scenario: `read_ticket` returns the full ticket body

- **WHEN** `read_ticket({ id: "ticket-0001" })` is invoked against an existing ticket
- **THEN** the tool result's text contains the ticket's full markdown body (not just the YAML header)

#### Scenario: `update_ticket_body` updates the on-disk file

- **WHEN** `update_ticket_body({ id: "ticket-0001", body: "Updated body content" })` is invoked
- **AND** the orchestration server is running against a real `.keni/` directory
- **THEN** the response is a successful `TicketResponse` with `body === "Updated body content"`
- **AND** the on-disk file `.keni/tickets/ticket-0001.md` reflects the new body

#### Scenario: `update_ticket_body` rejects an attempt to set `status`

- **WHEN** `update_ticket_body({ id: "ticket-0001", body: "x", status: "in_progress" })` is invoked
- **THEN** the input schema rejects the call before any HTTP request is made
- **AND** the tool result has `isError: true` with `[validation_failed]`

#### Scenario: `transition_ticket_status` succeeds for a legal engineer-owned transition

- **WHEN** `transition_ticket_status({ id: "ticket-0001", from: "open", to: "in_progress" })` is invoked
- **AND** the on-disk status is `open`
- **THEN** the tool result is a successful `TicketResponse` with `status === "in_progress"`
- **AND** the on-disk file's YAML header reflects `status: in_progress`
- **AND** the orchestration server emits exactly one `ticket.updated` frame on its `EventBus` with `payload.kind === "transition"`

#### Scenario: `transition_ticket_status` is refused with `role_not_owner` for a QA-owned target

- **WHEN** `transition_ticket_status({ id: "ticket-0001", from: "in_testing", to: "tested" })` is invoked
- **THEN** the tool result has `isError: true` with `[role_not_owner]`
- **AND** the on-disk file is unchanged

#### Scenario: `transition_ticket_status` is refused with `status_graph_violation` for an unreachable target

- **WHEN** `transition_ticket_status({ id: "ticket-0001", from: "open", to: "merged" })` is invoked
- **THEN** the tool result has `isError: true` with `[status_graph_violation]`
- **AND** the on-disk file is unchanged

#### Scenario: `transition_ticket_status` retried with the same `from` after success surfaces `stale_state`

- **WHEN** `transition_ticket_status({ id: "ticket-0001", from: "open", to: "in_progress" })` is invoked twice in succession
- **AND** the first invocation succeeds
- **THEN** the second invocation's tool result has `isError: true` with `[stale_state]`
- **AND** the error's details name the expected and actual status

### Requirement: `append_activity_entry` and `query_activity` cover the engineer's activity-log surface; identity is server-stamped, query results are bounded by a tool-level `limit`

`append_activity_entry` SHALL accept `{ session_id: string, event: ActivityEventName, summary?: string, refs?: Record<string, string> }` and SHALL delegate to `POST /activity` with the body `{ session_id, event, summary, refs, agent: <boot-time agentId>, role: "engineer" }`. The `agent` and `role` body fields SHALL be stamped from boot-time configuration and SHALL NOT be exposed as tool input. `query_activity` SHALL accept `{ agent?: string, role?: string, from?: string, to?: string, limit?: number }`; `limit` SHALL default to 200 and SHALL be capped at a hard ceiling of 1000 (a tool input above the ceiling SHALL be rejected with `[validation_failed]` before any HTTP call is made). The tool SHALL forward the filters to `GET /activity` and SHALL return at most `limit` entries from the response, regardless of how many the orchestration server returned.

#### Scenario: `append_activity_entry` writes to the date-partitioned activity log

- **WHEN** `append_activity_entry({ session_id: "s1", event: "session_start", summary: "starting" })` is invoked
- **THEN** the tool result is a successful `ActivityEntryResponse`
- **AND** `data.agent` equals the boot-time agent id
- **AND** `data.role` equals `"engineer"`
- **AND** the on-disk file `.keni/activity/<UTC-date>.jsonl` contains exactly one new line for the appended entry

#### Scenario: `append_activity_entry` rejects an attempt to override `agent`

- **WHEN** `append_activity_entry({ session_id: "s1", event: "summary", agent: "bob" })` is invoked
- **THEN** the input schema rejects the call before any HTTP request is made
- **AND** no entry is appended to the activity log

#### Scenario: `append_activity_entry` rejects an attempt to override `role`

- **WHEN** `append_activity_entry({ session_id: "s1", event: "summary", role: "po" })` is invoked
- **THEN** the input schema rejects the call before any HTTP request is made
- **AND** no entry is appended to the activity log

#### Scenario: `query_activity` with no `limit` returns at most 200 entries

- **WHEN** the activity log contains 500 entries
- **AND** `query_activity({})` is invoked
- **THEN** the tool result contains exactly 200 entries
- **AND** the entries are the first 200 in the orchestration server's documented response order (id-increasing)

#### Scenario: `query_activity` with an explicit `limit: 5` returns at most 5 entries

- **WHEN** the activity log contains 50 entries
- **AND** `query_activity({ limit: 5 })` is invoked
- **THEN** the tool result contains exactly 5 entries

#### Scenario: `query_activity` rejects a `limit` above the hard ceiling

- **WHEN** `query_activity({ limit: 1001 })` is invoked
- **THEN** the input schema rejects the call before any HTTP request is made
- **AND** the tool result has `isError: true` with `[validation_failed]`

#### Scenario: `query_activity` honours `agent`, `role`, `from`, and `to` filters

- **WHEN** the activity log contains entries from `alice` and `bob` across two days
- **AND** `query_activity({ agent: "alice", from: "2026-04-30T00:00:00Z", to: "2026-04-30T23:59:59Z" })` is invoked
- **THEN** the result contains only `alice`'s entries from `2026-04-30`

### Requirement: `get_workspace_path` returns the boot-time `--workspace` value verbatim and is invariant for the life of the MCP-server process

The `get_workspace_path` tool SHALL accept no input parameters (its zod schema is `z.object({})`) and SHALL return `{ path: <boot-time workspacePath> }` on every call. The path SHALL be read once at MCP-server startup from the `--workspace` CLI flag, validated against `Deno.stat` (must exist, must be a directory) before tool registration, and SHALL be captured as a closure constant for the life of the process. The tool SHALL NOT re-stat or re-read the path on subsequent calls. The path SHALL be returned verbatim — the MCP server SHALL NOT canonicalise, resolve symlinks, or otherwise transform it (any normalisation is the role runtime's responsibility before passing the flag).

#### Scenario: `get_workspace_path` returns the boot-time path verbatim

- **WHEN** the MCP server is started with `--workspace=/Users/alice/work/keni-ws`
- **AND** `get_workspace_path({})` is invoked
- **THEN** the tool result's content parses as JSON `{ path: "/Users/alice/work/keni-ws" }`

#### Scenario: `get_workspace_path` is invariant across calls

- **WHEN** the MCP server is started with a valid `--workspace`
- **AND** `get_workspace_path({})` is invoked three times in succession
- **THEN** all three results have identical `path` values
- **AND** no `Deno.stat` call is made between invocations (caches the boot-time check)

#### Scenario: `get_workspace_path` rejects any input

- **WHEN** `get_workspace_path({ path: "/some/other/path" })` is invoked
- **THEN** the input schema rejects the call (extra keys are not allowed)
- **AND** the tool result has `isError: true` with `[validation_failed]`

### Requirement: The MCP server uses stdio transport via the official `@modelcontextprotocol/sdk` v1.x; HTTP transport is not provided in this step

The MCP server SHALL use `StdioServerTransport` from `@modelcontextprotocol/sdk@^1`. No HTTP transport (Streamable HTTP, SSE, or otherwise) SHALL be exposed in this step. The transport SHALL be injected by `runMcpServer` (one line) so a future change can add HTTP transport additively without touching the tool registration code. The `createMcpServer` factory SHALL be transport-agnostic — it SHALL return a configured `McpServer` instance ready to `await server.connect(transport)` against any compatible transport.

#### Scenario: The runnable entry point connects a stdio transport

- **WHEN** the MCP server is started via `runMcpServer`
- **THEN** the SDK's `StdioServerTransport` is the only transport instantiated
- **AND** no HTTP listener is opened by the MCP server itself

#### Scenario: `createMcpServer` does not bind a transport

- **WHEN** `createMcpServer(deps)` is invoked
- **THEN** the returned `McpServer` instance has no transport attached
- **AND** the caller is responsible for `await server.connect(transport)` against any compatible transport

### Requirement: The MCP layer is a transport adapter for the orchestration-server REST surface; no business logic is duplicated, and no orchestration-server endpoint is added by this change

Every MCP tool handler SHALL be a thin transport adapter: validate parameters → stamp identity headers (already captured at boot) → call REST → map response. No tool handler SHALL re-implement the §4.1 status graph, the §4.2 owning-role rule, the storage atomicity contract, or the activity-log size cap. No new endpoint SHALL be added to the orchestration server by this change. The `EventBus` and `AgentRuntimeStateStore` from step 05 SHALL be unaffected — the MCP layer does not subscribe to events, does not directly mutate runtime state, and does not introduce a parallel event taxonomy.

#### Scenario: No status-graph or role-owner check lives in the MCP layer

- **WHEN** the source code under `packages/server/src/mcp/` is grepped for `TICKET_STATUS_TRANSITIONS`, `TICKET_STATUS_OWNING_ROLES`, `isTransitionReachable`, `isRoleOwner`, or any direct enumeration of the §4.1 / §4.2 tables
- **THEN** no occurrence is found in any tool handler or HTTP-client method
- **AND** every status-graph and role-owner refusal observed in tests originates from an HTTP error (`status_graph_violation` or `role_not_owner`) returned by the orchestration server

#### Scenario: No new orchestration-server endpoint is introduced

- **WHEN** the orchestration server's mounted routes are listed (e.g. via `createServer`'s tests) after this change lands
- **THEN** the route list is identical to the post-step-05 baseline (`/tickets`, `/prs`, `/activity`, `/agents`, `/events`)
- **AND** no MCP-specific HTTP endpoint has been added

### Requirement: The MCP-server process has no persistent state; each role-runtime cycle spawns a fresh process per the §6 fresh-session rule

The MCP server SHALL hold no state across invocations beyond its three boot-time CLI arguments. The server SHALL NOT cache HTTP responses, SHALL NOT batch tool calls across cycles, SHALL NOT maintain a tool-call history, and SHALL NOT persist any data to disk. When the transport's stdin closes (the standard MCP shutdown signal sent by the coding-agent CLI on subprocess exit), the server SHALL `await server.close()` exactly once and exit. Step 26 (multi-engineer) SHALL be supported by spawning multiple MCP-server processes (one per engineer) without changing this requirement; the `--agent` flag is what differentiates them.

#### Scenario: Closing stdin shuts the server down cleanly

- **WHEN** the MCP server is connected to a `StdioServerTransport`
- **AND** the transport's stdin is closed
- **THEN** the server's `connect` promise resolves
- **AND** `runMcpServer` returns exit code 0
- **AND** any in-flight tool call rejects per the SDK's documented shutdown semantics

#### Scenario: Two engineers spawn two independent MCP-server processes

- **WHEN** the role runtime spawns one MCP-server process for `alice` and one for `bob` in parallel
- **THEN** the two processes have independent stdin / stdout streams
- **AND** the two processes carry different `X-Keni-Agent` headers on their outbound HTTP calls
- **AND** neither process has any visibility into the other's tool calls or activity entries

### Requirement: The capability spec documents the trust model and the explicit out-of-scope tool list

This capability SHALL document, in this spec file, that (a) the MCP server inherits the orchestration server's local-only / no-auth / role-headers-trusted trust model verbatim, with the additional caveat that the role runtime is the only legitimate spawner of the MCP-server binary; (b) the engineer surface explicitly excludes PO-specific tools (chat, ticket-create-from-CR, PR-read — step 16), tools that read or write `.keni/de-facto-spec/` or `.keni/changes/` (PO-direct per §5.3), tools for editing PR records (engineers create PRs through the role runtime's git/PR handling in step 09), and WebSocket-style streaming tools (MCP is request/response).

#### Scenario: Trust-model section names the spawn-trust caveat

- **WHEN** this capability spec file is read
- **THEN** the requirement above (or a sibling section) explicitly names "the role runtime is the only legitimate spawner of the MCP-server binary"
- **AND** the trust model in step 04 (local-only, no auth, role headers trusted) is referenced rather than re-stated

#### Scenario: Out-of-scope list explicitly names PO tools, spec / CR tools, PR-write tools, and WS tools

- **WHEN** this capability spec file is read
- **THEN** the out-of-scope items above are each named verbatim
- **AND** for each item the deferral target is named (step 16, §5.3 PO-direct, step 09, MCP request/response semantics)

### Requirement: `npm:@modelcontextprotocol/sdk@^1` is added to the workspace `deno.json` imports map; no other workspace dependency is changed

The workspace `deno.json` SHALL gain exactly one new entry in the `imports` map: `"@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1"`. The `deno.lock` file SHALL be regenerated and committed. No other entry in the imports map SHALL be added, removed, or modified by this change. No package's own `deno.json` SHALL be touched (the SDK is consumed only from `packages/server/src/mcp/` and is internal to `@keni/server`).

#### Scenario: Only one new import entry is added

- **WHEN** the diff of `deno.json` against the post-step-05 baseline is inspected
- **THEN** the only addition is the `@modelcontextprotocol/sdk` line
- **AND** no other entry is removed, replaced, or version-bumped

#### Scenario: The lockfile is regenerated and frozen

- **WHEN** `deno install --frozen` is run against the post-change workspace
- **THEN** the command exits 0
- **AND** the only new lock entries are those introduced by `@modelcontextprotocol/sdk` and its transitive deps

### Requirement: An end-to-end integration test exercises every tool against a real orchestration server, including role-owner and status-graph refusals

`packages/server/src/mcp/integration_test.ts` SHALL exercise the full tool surface end-to-end: it SHALL provision a temp directory via `Deno.makeTempDir()`, invoke `keni init` (or the equivalent helper from step 03's tests) to produce a real `.keni/` project, start the orchestration server on a random port via `runServer`, spawn the MCP server as a `Deno.Command` subprocess piping stdio, attach an in-process `Client` from `@modelcontextprotocol/sdk/client` over `StdioClientTransport`, and assert each of the following:

- The tool list returned by the SDK's `listTools()` contains exactly the seven tools.
- `list_tickets({})` against the empty board returns `[]`.
- `read_ticket({ id: "ticket-9999" })` returns `isError: true` with `[store_not_found]`.
- After creating a ticket via the orchestration server's REST surface (`POST /tickets` as `X-Keni-Role: user`), `list_tickets({})` returns it.
- `update_ticket_body` updates the body on disk.
- `transition_ticket_status` with a legal engineer-owned `open → in_progress` succeeds.
- `transition_ticket_status` with `tested → done` (PO-owned) returns `isError: true` with `[role_not_owner]`.
- `transition_ticket_status` with a graph violation (e.g. `open → merged`) returns `isError: true` with `[status_graph_violation]`.
- `append_activity_entry` writes to `.keni/activity/<date>.jsonl` and the on-disk file grows.
- `query_activity({})` returns the appended entry; `query_activity({ limit: 5 })` returns at most 5 entries.
- `get_workspace_path({})` returns exactly the temp directory passed via `--workspace`.

The test SHALL clean up the spawned MCP-server subprocess (closing stdin, awaiting exit) and the orchestration server (`abort()`) in every code path, including error paths.

#### Scenario: All eleven assertion points pass on a clean run

- **WHEN** `deno test -A packages/server/src/mcp/integration_test.ts` is invoked against the post-change workspace
- **THEN** the command exits 0
- **AND** every assertion point above is exercised in at least one test case

#### Scenario: Test cleanup is deterministic

- **WHEN** any single integration test fails partway through
- **THEN** the spawned MCP-server subprocess has its stdin closed and is awaited within the test's teardown
- **AND** the orchestration server's `abort()` is called within the test's teardown
- **AND** no orphan process or open port persists after the test run completes
