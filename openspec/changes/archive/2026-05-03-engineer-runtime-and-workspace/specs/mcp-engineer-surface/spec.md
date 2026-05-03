## RENAMED Requirements

- FROM: ### Requirement: Errors map to the MCP `isError: true` shape via a single central function; the orchestration server's `ErrorCode` enum is reused verbatim with no new codes
- TO: ### Requirement: Errors map to the MCP `isError: true` shape via a single central function; the orchestration server's `ErrorCode` enum is reused verbatim

(Renamed because the engineer-runtime-and-workspace change adds `merge_conflict` to the closed `ErrorCode` enum via the orchestration-server delta. The "with no new codes" claim is no longer true; the MODIFIED entry below replaces the requirement body to acknowledge the addition.)

## ADDED Requirements

### Requirement: An eighth engineer MCP tool `merge_pr` is registered and delegates to `POST /prs/:id/merge`

`createMcpServer` SHALL register an eighth engineer-facing tool `merge_pr` in addition to the seven previously-documented tools. The tool's `description` SHALL be a single literal string of at most two sentences that names the PR-id input, the fast-forward semantics, the engineer-only authorisation, and the returned merge commit SHA. The tool's zod v4 `inputSchema` SHALL be exactly `{ pr_id: string }`, with `pr_id` constrained to match the documented PR id pattern (`/^pr-\d{4,}$/`). The handler SHALL delegate to a new `httpClient.mergePr(prId): Promise<{ merge_commit_sha: string }>` method on the typed HTTP client, which issues `POST /prs/:id/merge` with the standard `X-Keni-Role: engineer` and `X-Keni-Agent: <agentId>` headers and an empty request body, and returns the response envelope's `data` field. On a non-2xx response the handler SHALL surface the error through the existing central `mapHttpErrorToToolResult` so the result has `isError: true` and the `content[0].text` starts with `[<code>]` (e.g., `[merge_conflict]`, `[role_not_owner]`, `[store_not_found]`).

#### Scenario: `merge_pr` is registered with the documented name and input schema

- **WHEN** `createMcpServer` is constructed with a fake HTTP client
- **AND** the resulting server's tool list is queried
- **THEN** the names contain `"merge_pr"` (in addition to the seven previously-documented names)
- **AND** the `merge_pr` tool's `inputSchema` declares exactly the field `pr_id` (typed as a string matching `/^pr-\d{4,}$/`)
- **AND** the `merge_pr` tool's `description` is a non-empty string of at most 240 characters

#### Scenario: `merge_pr` delegates to `POST /prs/:id/merge` with the engineer headers

- **WHEN** the tool is invoked with `{ pr_id: "pr-0001" }`
- **AND** the orchestration server captures inbound request headers
- **THEN** exactly one `POST /prs/pr-0001/merge` request is issued
- **AND** the captured request carries `X-Keni-Role: engineer` and `X-Keni-Agent: <agentId from boot config>`
- **AND** the captured request body is the empty string (no body)

#### Scenario: A successful merge returns the SHA wrapped in the standard MCP success envelope

- **WHEN** the tool is invoked with `{ pr_id: "pr-0001" }`
- **AND** the orchestration server responds 200 with `{ data: { merge_commit_sha: "abc1234..." }, project_id: "<uuid>" }`
- **THEN** the tool result has no `isError` key (or has `isError: false`)
- **AND** the `content[0].text` (when parsed as JSON) equals `{ "merge_commit_sha": "abc1234..." }`

#### Scenario: A `merge_conflict` HTTP error becomes an MCP `isError: true` result

- **WHEN** the tool is invoked with `{ pr_id: "pr-0001" }`
- **AND** the orchestration server responds 409 with `{ error: { code: "merge_conflict", message: "Branch is not a fast-forward of main", details: { branch: "ticket-0001", base: "main" } }, project_id: "<uuid>" }`
- **THEN** the tool result has `isError: true`
- **AND** the `content[0].text` starts with `[merge_conflict]`
- **AND** the rendered text includes the substring `"branch"` and `"main"` (from the details block)

#### Scenario: A `role_not_owner` HTTP error becomes an MCP `isError: true` result

- **WHEN** the tool is invoked from a non-engineer subprocess (a contrived test where the HTTP client's `X-Keni-Role` header is forged to `"qa"`)
- **AND** the orchestration server responds 403 with `{ error: { code: "role_not_owner", … } }`
- **THEN** the tool result has `isError: true`
- **AND** the `content[0].text` starts with `[role_not_owner]`

#### Scenario: A malformed `pr_id` is rejected by the input schema before any HTTP request

- **WHEN** the tool is invoked with `{ pr_id: "ticket-0001" }` (a ticket id, not a PR id, failing the `/^pr-\d{4,}$/` pattern)
- **THEN** no HTTP request is issued
- **AND** the tool result has `isError: true`
- **AND** the `content[0].text` names `validation_failed`

## MODIFIED Requirements

### Requirement: The seven engineer tools are registered with the documented names, descriptions, and zod input schemas

`createMcpServer` SHALL register exactly **eight** tools, each with a non-empty `description`, a zod v4 `inputSchema`, and a handler that delegates to the typed HTTP client (or, for `get_workspace_path`, returns the boot-time `workspacePath`):

| Tool name | Description (≤2 sentences) | Input schema (zod v4) | HTTP delegate |
| --- | --- | --- | --- |
| `list_tickets` | Lists tickets in the project, optionally filtered by status, assignee, priority range, or change-request id. Returns a summary view per ticket; use `read_ticket` for the full body. | `{ status?: string \| string[], assignee?: string \| null, priorityMin?: number, priorityMax?: number, change_request?: string \| null }` | `GET /tickets?<filters>` |
| `read_ticket` | Reads a single ticket by id. Returns the full ticket including its markdown body. | `{ id: string }` | `GET /tickets/:id` |
| `update_ticket_body` | Updates the markdown body of a ticket. Cannot change the ticket's status, title, assignee, priority, or change-request link; use `transition_ticket_status` to move statuses. | `{ id: string, body: string }` | `PATCH /tickets/:id` |
| `transition_ticket_status` | Transitions a ticket from `from` to `to`, where `to` must be in the engineer-owned subset of the status graph. Returns the updated ticket on success; the orchestration server enforces the §4.1 status graph and §4.2 owning-role rule. | `{ id: string, from: TicketStatus, to: TicketStatus }` | `POST /tickets/:id/transition` |
| `append_activity_entry` | Appends one entry to the project's activity log under the calling agent's identity. The `agent` and `role` fields are stamped server-side and cannot be overridden. | `{ session_id: string, event: ActivityEventName, summary?: string, refs?: Record<string, string> }` | `POST /activity` |
| `query_activity` | Queries the activity log with optional filters and a per-call limit (default 200, hard ceiling 1000). Use a narrow `from`/`to` window to keep results focused. | `{ agent?: string, role?: string, from?: string, to?: string, limit?: number }` | `GET /activity?<filters>` |
| `get_workspace_path` | Returns the absolute filesystem path of this engineer's workspace clone. The path is read once at startup and is constant for the life of this MCP-server process. | `{}` (no input) | (none — reads boot-time CLI arg) |
| `merge_pr` | Fast-forward merges the PR's source branch onto `main` via the orchestration server. Returns the merge commit SHA on success; surfaces `merge_conflict` as an MCP error when the branch is not a fast-forward. | `{ pr_id: string }` (matches `/^pr-\d{4,}$/`) | `POST /prs/:id/merge` |

Each tool's `description` SHALL be a single literal string in the source code (no template interpolation). The descriptions SHALL be matched verbatim by a string-stability test in `createMcpServer_test.ts` so a silent edit fails CI.

#### Scenario: All eight tools are registered with the documented names

- **WHEN** `createMcpServer` is constructed with a fake HTTP client
- **AND** the resulting server's tool list is queried
- **THEN** the names exactly equal `["list_tickets", "read_ticket", "update_ticket_body", "transition_ticket_status", "append_activity_entry", "query_activity", "get_workspace_path", "merge_pr"]` (order is implementation-defined)

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

#### Scenario: `merge_pr`'s schema rejects non-PR ids

- **WHEN** `merge_pr` is invoked with input `{ pr_id: "ticket-0001" }`
- **THEN** the input schema rejects the call before any HTTP request is made
- **AND** the tool result has `isError: true`

### Requirement: Every tool delegates to an existing orchestration-server REST endpoint via a typed HTTP client; no tool reads or writes `.keni/` directly

`packages/server/src/mcp/httpClient.ts` SHALL export `createMcpHttpClient(opts: { serverUrl: string; agentId: string }): McpHttpClient` returning an object with one method per delegated endpoint: `listTickets(filter)`, `readTicket(id)`, `updateTicketBody(id, body)`, `transitionTicket(id, from, to)`, `appendActivity(input)`, `queryActivity(filter, limit)`, **and `mergePr(prId): Promise<{ merge_commit_sha: string }>`**. Each method SHALL: (1) compose the URL using `URLSearchParams` for query strings; (2) set `Content-Type: application/json` for write methods (the `mergePr` method's request body is empty so `Content-Type` MAY be omitted); (3) set `X-Keni-Role: engineer` and `X-Keni-Agent: <agentId>`; (4) issue `await fetch(...)`; (5) on a 2xx response, parse the `{ data, project_id }` envelope and return `data`; (6) on a non-2xx response, parse the `{ error: { code, message, details? } }` envelope and throw `new McpHttpError(code, message, details, status)`; (7) on a network-level rejection (`fetch` rejects, e.g. ECONNREFUSED), throw `new McpHttpError("internal_error", `Network error talking to ${url}: ${cause.message}`, ..., 0)`. No method SHALL read or write any path under `.keni/` directly; every state-changing operation flows through the orchestration-server REST endpoint that owns it.

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

#### Scenario: `mergePr` issues an empty-bodied POST and unwraps `merge_commit_sha`

- **WHEN** `httpClient.mergePr("pr-0001")` is called
- **AND** the orchestration server responds 200 with `{ data: { merge_commit_sha: "abc1234..." }, project_id: "<uuid>" }`
- **THEN** the method's return value is `{ merge_commit_sha: "abc1234..." }`
- **AND** the captured request body is the empty string

#### Scenario: `mergePr` surfaces `merge_conflict` as a typed `McpHttpError`

- **WHEN** `httpClient.mergePr("pr-0001")` is called
- **AND** the orchestration server responds 409 with `{ error: { code: "merge_conflict", message: "...", details: { branch, base } }, project_id }`
- **THEN** the method rejects with an `McpHttpError`
- **AND** the error's `code` is `"merge_conflict"`
- **AND** the error's `details` carries `branch` and `base` fields

#### Scenario: No tool reads `.keni/` directly

- **WHEN** the source code under `packages/server/src/mcp/` is grepped for `Deno.readTextFile`, `Deno.writeTextFile`, `Deno.readFile`, `Deno.writeFile`, or any path beginning with `.keni/`
- **THEN** no occurrence is found in any tool handler or HTTP-client method (test files MAY use `Deno.stat` against the workspace path passed via `--workspace`, which is itself outside `.keni/`)

### Requirement: Errors map to the MCP `isError: true` shape via a single central function; the orchestration server's `ErrorCode` enum is reused verbatim

`packages/server/src/mcp/errors.ts` SHALL export `class McpHttpError extends Error` with public readonly fields `code: string`, `details: Record<string, unknown> | undefined`, and `httpStatus: number`. It SHALL also export `mapHttpErrorToToolResult(err: unknown): { content: [{ type: "text"; text: string }]; isError: true }` whose behaviour is: (a) when `err instanceof McpHttpError`, return content with text `[<code>] <message> (HTTP <status>)` plus an indented `Details:` block when `details` is defined; (b) when `err` is any other thrown value, return content with text `[internal_error] Unexpected error in MCP tool handler: <message>`; in all cases `isError` is `true`. Every tool handler SHALL wrap its HTTP-client call in `try`/`catch` and pass any thrown value through `mapHttpErrorToToolResult`. Successful tool results SHALL be wrapped as `{ content: [{ type: "text", text: JSON.stringify(record, null, 2) }] }` with no `isError` key. The codes a tool may surface SHALL be drawn from the closed `ErrorCode` enum defined in `@keni/shared/wire/errors.ts` (`store_not_found`, `stale_state`, `duplicate_id`, `invalid_artifact`, `status_in_patch`, `status_graph_violation`, `role_not_owner`, `missing_role`, `validation_failed`, `internal_error`, **`merge_conflict`**); the `merge_conflict` code is added by the engineer-runtime-and-workspace change's orchestration-server delta and SHALL be the only addition this change makes to the enum.

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

#### Scenario: A `merge_conflict` HTTP error becomes an MCP `isError: true` result

- **WHEN** `merge_pr` is invoked with `{ pr_id: "pr-0001" }` against a PR whose branch is not a fast-forward of `main`
- **AND** the orchestration server responds with 409 `merge_conflict`
- **THEN** the tool result has `isError: true`
- **AND** the `content[0].text` starts with `[merge_conflict]`
- **AND** the rendered text includes the `details` block naming `branch` and `base`
