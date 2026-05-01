## 1. Dependency and workspace plumbing

- [x] 1.1 Add `"@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1"` to the `imports` map in the root `deno.json`. Run `deno install` (without `--frozen`) to regenerate `deno.lock` against the new entry; commit both files.
- [x] 1.2 Verify: `deno install --frozen` exits 0, `deno task fmt:check` exits 0, `deno task lint` exits 0, `deno task check` exits 0 against the unmodified workspace (no new code yet — this gate proves the new dep does not break anything before any new file lands).
- [x] 1.3 Verify the SDK exports we depend on resolve at type-check time by writing a temporary scratch file (`packages/server/src/mcp/_scratch.ts`) that does `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"` and `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"`; run `deno check`; delete the scratch file. Catches a transitive-dep / import-path mismatch before any real code is written.

## 2. zod input schemas — `packages/server/src/mcp/wire/`

- [x] 2.1 Create `packages/server/src/mcp/wire/tickets.ts` exporting four zod schemas (zod v4):
  - `ListTicketsInputSchema: z.ZodType<ListTicketsInput>` — `{ status?: TicketStatus | TicketStatus[], assignee?: string | null, priorityMin?: number, priorityMax?: number, change_request?: string | null }`. Reuses `TicketStatusSchema` and the `TICKET_STATUSES` enum from `@keni/shared`.
  - `ReadTicketInputSchema: z.ZodType<ReadTicketInput>` — `{ id: string }` matching `/^ticket-\d{4,}$/`.
  - `UpdateTicketBodyInputSchema: z.ZodType<UpdateTicketBodyInput>` — `{ id: string, body: string }`. Use `.strict()` to reject unknown keys (this is what enforces "no sneaked-in `status`").
  - `TransitionTicketInputSchema: z.ZodType<TransitionTicketInput>` — `{ id: string, from: TicketStatus, to: TicketStatus }`.
  Each interface lives in the same file (TypeScript-only, internal to `@keni/server`).
- [x] 2.2 Create `packages/server/src/mcp/wire/activity.ts` exporting two zod schemas:
  - `AppendActivityInputSchema: z.ZodType<AppendActivityInput>` — `{ session_id: string (min 1), event: string (min 1), summary?: string (max 500), refs?: Record<string, string> }`. Use `.strict()` so attempts to pass `agent` or `role` fail. (Note: the spec table named `ActivityEventName`, but the underlying `ActivityEntryInput.event` is documented as a free-form string; a closed enum is deferred to a later step.)
  - `QueryActivityInputSchema: z.ZodType<QueryActivityInput>` — `{ agent?: string, role?: string, from?: string (ISO 8601), to?: string (ISO 8601), limit?: number (int, min 1, max 1000) }`. The 200 default is applied in the tool handler (so the parsed type stays assignable to `QueryActivityInput`); the schema only enforces the bounds. Constants `QUERY_ACTIVITY_DEFAULT_LIMIT` and `QUERY_ACTIVITY_MAX_LIMIT` are exported alongside.
- [x] 2.3 Create `packages/server/src/mcp/wire/workspace.ts` exporting `GetWorkspacePathInputSchema: z.ZodType<GetWorkspacePathInput>` — `z.object({}).strict()` (no parameters). Also exports the return type `WorkspacePathResponse = { path: string }` as a TypeScript interface (server-internal — Decision 13 in `design.md`).
- [x] 2.4 Create `packages/server/src/mcp/wire/mod.ts` barrel re-exporting every schema and every input/return type from the three files above.
- [x] 2.5 Create `packages/server/src/mcp/wire/tickets_test.ts` covering: each schema accepts a documented good example; `ListTicketsInputSchema` accepts both `status: "open"` and `status: ["open", "in_progress"]`; `UpdateTicketBodyInputSchema` rejects `{ id, body, status }` with a `validation_failed`-shaped issue; `TransitionTicketInputSchema` rejects an unknown status string; `expectType<z.infer<typeof Schema>>().toEqual<Input>()` for each schema.
- [x] 2.6 Create `packages/server/src/mcp/wire/activity_test.ts` covering: `AppendActivityInputSchema` rejects `{ session_id, event, agent: "bob" }`; rejects `{ session_id, event, role: "po" }`; accepts the documented happy path; `QueryActivityInputSchema` accepts an empty filter (handler defaults to 200 — see step 5.5) and rejects 1001; rejects 0 / negative limits.
- [x] 2.7 Create `packages/server/src/mcp/wire/workspace_test.ts` covering: empty input accepted; any non-empty input rejected.
- [x] 2.8 Verify: `deno test -A packages/server/src/mcp/wire/` exits 0; `deno task check` exits 0.

## 3. Typed HTTP client — `packages/server/src/mcp/httpClient.ts`

- [x] 3.1 Create `packages/server/src/mcp/httpClient.ts` exporting:
  - The `McpHttpClient` interface (six methods: `listTickets`, `readTicket`, `updateTicketBody`, `transitionTicket`, `appendActivity`, `queryActivity`) — return types are the existing `@keni/shared/wire/` `TicketResponse`, `TicketSummaryResponse[]`, `ActivityEntryResponse`, `ActivityEntryResponse[]`.
  - `createMcpHttpClient(opts: { serverUrl: string; agentId: string }): McpHttpClient` — closure-captures the role / agent / URL; every method composes URL + headers + body, calls `fetch`, parses the `{ data, project_id }` envelope on 2xx, throws `McpHttpError` on non-2xx, throws `McpHttpError("internal_error", …, 0)` on a network-level failure.
- [x] 3.2 Implement `listTickets(filter)` — serialise filter to `URLSearchParams`; for `status` accept either a single value or an array (joined with comma per the REST contract).
- [x] 3.3 Implement `readTicket(id)` — `GET /tickets/<encodeURIComponent(id)>`.
- [x] 3.4 Implement `updateTicketBody(id, body)` — `PATCH /tickets/<id>` with body `{ body }`.
- [x] 3.5 Implement `transitionTicket(id, from, to)` — `POST /tickets/<id>/transition` with body `{ from, to }`.
- [x] 3.6 Implement `appendActivity(input)` — `POST /activity` with body `{ ...input, agent: <agentId>, role: "engineer" }`. The `agent` / `role` stamping happens here (closure-captured), not in the tool handler.
- [x] 3.7 Implement `queryActivity(filter, limit)` — `GET /activity?<filters>`; the orchestration server has no native `limit`, so the client trims the response to `limit` entries before returning.
- [x] 3.8 Create `packages/server/src/mcp/httpClient_test.ts` against a `Deno.serve`-backed mock server (port 0, OS-assigned) covering: each method composes the right URL; each method stamps `X-Keni-Role: engineer` and `X-Keni-Agent: <agentId>`; success body is unwrapped from the envelope; non-2xx body throws `McpHttpError` with the correct `code` / `httpStatus` / `details`; network failure (mock server killed mid-call) throws `McpHttpError("internal_error", …, 0)` whose message names the URL; `listTickets({ status: ["open", "in_progress"] })` produces `?status=open,in_progress` (single comma-joined param, not two `?status=` params).
- [x] 3.9 Verify: `deno test -A packages/server/src/mcp/httpClient_test.ts` exits 0; `deno task check` exits 0.

## 4. Error mapping — `packages/server/src/mcp/errors.ts`

- [x] 4.1 Create `packages/server/src/mcp/errors.ts` exporting:
  - `class McpHttpError extends Error` with public `readonly code: string`, `readonly details: Record<string, unknown> | undefined`, `readonly httpStatus: number`. Override `name = "McpHttpError"`.
  - `mapHttpErrorToToolResult(err: unknown): { content: [{ type: "text"; text: string }]; isError: true }` per Decision 8 in `design.md` — `[<code>] <message> (HTTP <status>)\nDetails: <pretty-printed JSON>` for `McpHttpError`; `[internal_error] Unexpected error in MCP tool handler: <message>` otherwise.
  - `wrapToolSuccess<T>(value: T): { content: [{ type: "text"; text: string }] }` — convenience helper that wraps a successful result as `{ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }` with no `isError` key.
- [x] 4.2 Create `packages/server/src/mcp/errors_test.ts` covering: every `McpHttpError` `code` value (the 10 closed `ErrorCode` values from step 04 plus `"internal_error"`); each maps to `[<code>]` prefix in the content text; `details` is rendered as indented JSON when defined and omitted otherwise; an unknown thrown value (`new TypeError("...")`) produces the `internal_error` shape; `wrapToolSuccess` returns a result with no `isError` key.
- [x] 4.3 Verify: `deno test -A packages/server/src/mcp/errors_test.ts` exits 0; `deno task check` exits 0.

## 5. Tool registration — `packages/server/src/mcp/tools/`

- [x] 5.1 Create `packages/server/src/mcp/tools/tickets.ts` exporting `registerTicketTools(server: McpServer, deps: McpServerDeps): void`. Registers four tools:
  - `list_tickets` — input `ListTicketsInputSchema`; handler calls `deps.httpClient.listTickets(input)` inside `try`/`catch`; on success wraps via `wrapToolSuccess(records)`; on throw passes to `mapHttpErrorToToolResult`.
  - `read_ticket` — input `ReadTicketInputSchema`; handler calls `deps.httpClient.readTicket(input.id)`.
  - `update_ticket_body` — input `UpdateTicketBodyInputSchema`; handler calls `deps.httpClient.updateTicketBody(input.id, input.body)`.
  - `transition_ticket_status` — input `TransitionTicketInputSchema`; handler calls `deps.httpClient.transitionTicket(input.id, input.from, input.to)`.
  Each `description` is a single literal string ≤ 240 characters per Decision 5 (verbatim copy from the capability spec's tool table). Description constants are exported (`LIST_TICKETS_DESCRIPTION`, etc.) so the drift-detector test can pin them. Handlers receive `rawInput: unknown` and cast to the validated input type — workaround for the SDK V1's generic-inference issue when `outputSchema` is omitted (see `tools/tickets.ts` leading comment).
- [x] 5.2 Create `packages/server/src/mcp/tools/activity.ts` exporting `registerActivityTools(server, deps)`. Registers two tools:
  - `append_activity_entry` — input `AppendActivityInputSchema`; handler calls `deps.httpClient.appendActivity({...input, agent: deps.agentId, role: "engineer"})` so identity is stamped at the handler boundary too (defense-in-depth alongside the HTTP client's stamp).
  - `query_activity` — input `QueryActivityInputSchema`; handler calls `deps.httpClient.queryActivity({ agent, role, from, to }, limit ?? 200)`.
  Description strings verbatim from the spec table; pinned constants exported.
- [x] 5.3 Create `packages/server/src/mcp/tools/workspace.ts` exporting `registerWorkspaceTools(server, deps)`. Registers one tool:
  - `get_workspace_path` — input `GetWorkspacePathInputSchema` (empty object); handler returns `wrapToolSuccess({ path: deps.workspacePath })` synchronously. No `try`/`catch` (no I/O, no failure mode).
- [x] 5.4 Create `packages/server/src/mcp/tools/tickets_test.ts` against a fake `McpHttpClient` (an in-memory test double that records calls and returns canned responses) covering: each tool's happy path delegates to the right HTTP-client method with the right arguments; each tool funnels `McpHttpError` through `mapHttpErrorToToolResult` and returns `isError: true`. (Schema-level rejection of sneaked-in `status` is verified at the SDK protocol layer in `wire/tickets_test.ts` and the integration test — the SDK throws JSON-RPC `InvalidParams` rather than returning `isError: true` for input-schema failures.)
- [x] 5.5 Create `packages/server/src/mcp/tools/activity_test.ts` against a fake `McpHttpClient` covering: `append_activity_entry` happy path stamps `agent`/`role` from boot-time deps regardless of input; `query_activity` defaults `limit` to 200 (the call args show `limit: 200` even when input omits it); `query_activity` honours an explicit `limit: 5`; `query_activity` forwards documented filters. (Schema-level rejection of `agent`/`role` overrides and `limit > 1000` is verified in `wire/activity_test.ts`.)
- [x] 5.6 Create `packages/server/src/mcp/tools/workspace_test.ts` covering: returns the `deps.workspacePath` verbatim; multiple invocations return identical paths and never invoke the HTTP client (the fake throws on any method call). (Schema-level rejection of non-empty input is verified in `wire/workspace_test.ts`.)
- [x] 5.7 Verify: `deno test -A packages/server/src/mcp/tools/` exits 0; `deno task check` exits 0.

## 6. Composition root — `createMcpServer.ts`

- [x] 6.1 Create `packages/server/src/mcp/createMcpServer.ts` exporting:
  - `interface McpServerDeps { readonly httpClient: McpHttpClient; readonly agentId: string; readonly workspacePath: string; }`
  - `interface McpServerOptions { readonly serverName: string; readonly serverVersion: string; }` (defaults: `"keni-engineer-mcp"` / `"0.1.0"`).
  - `createMcpServer(deps: McpServerDeps, opts?: McpServerOptions): McpServer` — constructs `new McpServer({ name, version })`, calls each `register<Group>Tools(server, deps)` in order (tickets → activity → workspace), returns the server. Pure, synchronous, no I/O.
- [x] 6.2 Create `packages/server/src/mcp/createMcpServer_test.ts` covering: a fake-deps construction registers exactly seven tools with the documented names; each tool's `description` matches a hand-encoded copy from the spec (string-stability assertion, the drift detector for tool descriptions per Decision 11); `createMcpServer` performs no I/O during construction (assert via a `Deno.permissions.query`-shaped assertion or a manual code review checked by the lint that test files not perform `fetch` outside marked sections).
- [x] 6.3 Add a separate test in `createMcpServer_test.ts` that programmatically invokes each registered tool against a fake `McpHttpClient` and asserts the per-tool happy-path result shape (`{ content: [{ type: "text", text }] }` with no `isError`). This is the cross-cutting smoke that catches "the registration worked but the handler is wrong".
- [x] 6.4 Verify: `deno test -A packages/server/src/mcp/createMcpServer_test.ts` exits 0; `deno task check` exits 0.

## 7. CLI bootstrap — `runMcpServer.ts`

- [x] 7.1 Create `packages/server/src/mcp/runMcpServer.ts` exporting `runMcpServer(args: readonly string[]): Promise<number>`. The function:
  - Parses argv with a small flag parser (the same shape `runServer` uses in step 04). Required: `--agent <id>`, `--server-url <url>`, `--workspace <abs path>`.
  - On any parse failure (missing arg, unknown flag like `--role`), writes a usage message naming the missing/extra flag and the documented flags to stderr, returns `2`.
  - Validates `--agent` against `/^[a-z0-9_-]+$/`; if it fails, returns `2` with a stderr message naming the validation rule.
  - Validates `--server-url` parses as a `URL` with `http:` or `https:` protocol; on failure returns `2`.
  - Validates `--workspace` exists via `Deno.stat(workspacePath)` and `stat.isDirectory`; if either is false, returns `1` with a stderr message naming the path.
  - Constructs `httpClient = createMcpHttpClient({ serverUrl, agentId })`, then `server = createMcpServer({ httpClient, agentId, workspacePath })`, then `transport = new StdioServerTransport()`.
  - `await server.connect(transport)`; awaits the SDK's documented stdin-EOF / `transport.close` signal; returns `0`.
  - On any uncaught error after argument validation, writes a stderr message naming the error class and message, returns `1`.
- [x] 7.2 Create `packages/server/src/mcp/runMcpServer_test.ts` covering:
  - `runMcpServer([])` → `2`; stderr names every required flag.
  - `runMcpServer(["--agent=Bad Agent!", …])` → `2`; stderr names the validation rule.
  - `runMcpServer(["--agent=alice", "--server-url=not-a-url", "--workspace=" + tempDir])` → `2`.
  - `runMcpServer(["--agent=alice", "--server-url=http://127.0.0.1:1", "--workspace=/does/not/exist"])` → `1`.
  - `runMcpServer(["--agent=alice", "--server-url=http://127.0.0.1:1", "--workspace=" + tempFile (regular file, not dir)])` → `1` with a "not a directory" message.
  - `runMcpServer([…, "--role=po"])` → `2` (unknown flag).
  - Happy path: `runMcpServer` is invoked with valid args and an in-memory `StdioServerTransport` swap (use the SDK's in-process transport pair OR run `runMcpServer` in a `Deno.Command` subprocess and assert clean exit when stdin is closed). Document the chosen approach in the test file's leading comment.
- [x] 7.3 Verify: `deno test -A packages/server/src/mcp/runMcpServer_test.ts` exits 0; `deno task check` exits 0.

## 8. Main barrel — `main.ts`

- [x] 8.1 Create `packages/server/src/mcp/main.ts` re-exporting:
  - `createMcpServer`, `McpServerDeps`, `McpServerOptions` from `./createMcpServer.ts`.
  - `runMcpServer` from `./runMcpServer.ts`.
  - `createMcpHttpClient`, `McpHttpClient` from `./httpClient.ts`.
  - `McpHttpError` from `./errors.ts`.
  And the `import.meta.main` block: `if (import.meta.main) { Deno.exit(await runMcpServer(Deno.args)); }`.
- [x] 8.2 Create `packages/server/src/mcp/main_test.ts` smoke test: imports each named export and asserts that the import resolves (a presence test — type-check coverage gives the rest).
- [x] 8.3 Modify `packages/server/src/main.ts` (the orchestration server's main barrel) to additionally re-export `runMcpServer`, `createMcpServer`, `McpServerDeps`, `McpHttpClient`, and `McpHttpError` from `./mcp/main.ts`. The existing exports (`createServer`, `startServer`, `runServer`, `EventBus`, `AgentRuntimeStateStore`, `createInMemoryEventBus`, `createInMemoryAgentRuntimeStateStore`, `captureBusBuffer`, `emitFrame`) are preserved verbatim.
- [x] 8.4 Extend `packages/server/src/main_test.ts` (the orchestration server's existing smoke test) with one new case: `import { runMcpServer, McpHttpError } from "./main.ts"` resolves and the imports are functions / classes (`typeof runMcpServer === "function"`, `McpHttpError.prototype instanceof Error`).
- [x] 8.5 Verify: `deno test -A packages/server/src/main_test.ts packages/server/src/mcp/main_test.ts` exits 0; `deno task check` exits 0.

## 9. End-to-end integration test — `integration_test.ts`

- [x] 9.1 Create `packages/server/src/mcp/integration_test.ts`. Set up helpers (one per test or a shared `setup()` returning a teardown closure):
  - Provision a `Deno.makeTempDir({ prefix: "keni-mcp-it-" })` project root.
  - Run the existing `keni init` helper used by other route tests (or invoke the CLI directly via `Deno.Command` if no in-process helper exists yet) to produce `.keni/project.yaml` with a seeded `agents: [{ id: "alice", role: "engineer" }]`.
  - Start the orchestration server via `startServer` on `port: 0`; capture the `url`.
  - Make a sibling `Deno.makeTempDir({ prefix: "keni-mcp-it-ws-" })` to act as the engineer's workspace.
  - Spawn the MCP server as a `Deno.Command` subprocess: `Deno.Command("deno", { args: ["run", "-A", "packages/server/src/mcp/main.ts", "--agent=alice", `--server-url=${serverUrl}`, `--workspace=${wsDir}`], stdin: "piped", stdout: "piped", stderr: "piped" })`.
  - Attach an in-process MCP `Client` from `@modelcontextprotocol/sdk/client/index.js` over `StdioClientTransport({ command: "deno", args: [...] })` — the SDK's client transport handles the subprocess spawn for us; prefer that to avoid double-spawning. Decide between the manual `Deno.Command` route and the SDK's `StdioClientTransport` and document the choice in the test file's leading comment.
- [x] 9.2 Implement the documented test cases (one assertion per test, named for the spec scenario):
  - `tool list contains exactly the seven engineer tools` — calls `client.listTools()`; asserts names equal the documented set; asserts each has a non-empty description.
  - `list_tickets returns [] on a fresh project`.
  - `read_ticket returns isError: true with [store_not_found] for an unknown id`.
  - `list_tickets returns a created ticket` — first creates one via `fetch(serverUrl + "/tickets", { method: "POST", headers: { "X-Keni-Role": "user" }, body: JSON.stringify({ title: "X", priority: 100 }) })`; then asserts MCP `list_tickets({})` returns it.
  - `update_ticket_body updates the on-disk file` — invoke the tool; assert success; read `.keni/tickets/ticket-0001.md` and assert the body section reflects the new content.
  - `transition_ticket_status succeeds for engineer-owned open → in_progress` — assert the result envelope, the on-disk YAML header, and (via a WS subscriber on the orchestration server's `/events`) the emitted `ticket.updated` frame.
  - `transition_ticket_status fails with [role_not_owner] for tested → done` — pre-set the on-disk status to `tested` (via direct REST calls walking the graph), invoke the MCP tool, assert `isError: true` with `[role_not_owner]`.
  - `transition_ticket_status fails with [status_graph_violation] for open → merged`.
  - `transition_ticket_status retried after success returns [stale_state]`.
  - `append_activity_entry writes a date-partitioned line` — assert the on-disk file `.keni/activity/<UTC date>.jsonl` grew by exactly one line containing the expected `agent: "alice"`, `role: "engineer"`.
  - `query_activity returns the appended entry` — and `query_activity({ limit: 5 })` returns at most 5; with a hand-seeded log of 250 entries, the default `limit: 200` is honoured.
  - `get_workspace_path returns the boot-time --workspace value verbatim` — asserts the parsed JSON equals `{ path: <wsDir> }`.
- [x] 9.3 Implement teardown for every test: `client.close()` (closes the subprocess's stdin via the SDK), wait up to 5 s for the subprocess to exit, force-kill if it hasn't, `serverHandle.abort()`, `Deno.remove(rootDir, { recursive: true })`. Wrap setup/teardown in a `using` block or an `afterEach`-style helper so a failure halfway through does not leak processes.
- [x] 9.4 Add a "negative" smoke test that proves the trust seam holds end-to-end: spawn the MCP server with `--agent=alice`; from inside a tool call, attempt to inject `agent: "bob"` into `append_activity_entry`'s input; assert `isError: true` with `[validation_failed]`; assert no entry with `agent: "bob"` ever lands on disk. (The schema rejection makes this near-trivial; the test exists to catch a future contributor who adds `agent` to the tool input by mistake.) (Implementation note: the SDK actually surfaces zod-strict rejection as a thrown JSON-RPC error rather than `isError: true`; the test accepts either outcome and the load-bearing invariant — no `agent: "bob"` entry on disk — is asserted directly.)
- [x] 9.5 Add a "no `.keni/` reads from MCP" structural assertion: a test that grep / file-read of every file under `packages/server/src/mcp/**/*.ts` (excluding `*_test.ts` and `integration_test.ts`) finds no occurrence of `Deno.readTextFile`, `Deno.writeTextFile`, `Deno.readFile`, `Deno.writeFile`, or any path literal starting with `.keni/`. Implemented as a small helper test that walks `packages/server/src/mcp/` (excluding tests) and asserts each file's source string does not contain the forbidden substrings. (Comments are stripped before scanning so doc-comments referencing `.keni/` to explain the rule do not trigger false positives.)
- [x] 9.6 Verify: `deno test -A packages/server/src/mcp/integration_test.ts` exits 0 with all tests passing (3 outer tests, 12 inner steps, total 14 verifications).

## 10. Documentation

- [x] 10.1 Update root `README.md` "Run the orchestration server" subsection: add a paragraph immediately after the WebSocket invocation, titled "Run the engineer MCP server (development only)". Document the invocation `deno run -A packages/server/src/mcp/main.ts --agent=alice --server-url=http://127.0.0.1:<port> --workspace=$HOME/.keni/workspaces/<project-id>/alice`. Note that step 07 will wire this into the engineer subprocess's `mcpServers` config block; for now developers run it directly to attach a manual MCP client (e.g. the SDK's `mcp-cli` debugger or a coding-agent CLI's MCP debug mode).
- [x] 10.2 Update root `README.md` "Repository layout" subsection: amend the `packages/server/` description to mention the new `mcp/` subdirectory: `# @keni/server — orchestration server (REST + WebSocket APIs) and engineer MCP server (stdio)`.
- [x] 10.3 Verify no changes were made to `initial-implementation-plan/`: `git status --short -- initial-implementation-plan/` and `git diff --name-only -- initial-implementation-plan/` are both empty.

## 11. Capability-spec verification (the spec walk)

- [x] 11.1 Walk every requirement in `openspec/changes/mcp-server-for-engineers/specs/mcp-engineer-surface/spec.md` and map each scenario to the test (or structural artefact) that satisfies it. Record the table at the bottom of this file under "Spec walk verification" (mirror the format `agents-api-and-websocket/tasks.md` used).
- [x] 11.2 Drift check — tool descriptions: temporarily change one tool's `description` in `tools/tickets.ts` (e.g. drop a word from `update_ticket_body`'s description). Run `deno test -A packages/server/src/mcp/createMcpServer_test.ts`. Confirm the description-stability test fails. Revert. (Verified: dropping "full ticket including its" from `READ_TICKET_DESCRIPTION` produced a failed `assertEquals` on the verbatim spec copy + the source-vs-spec inversion check; reverted in the same step.)
- [x] 11.3 Drift check — tool count: temporarily comment out one `server.registerTool(...)` call in `tools/workspace.ts`. Run `deno test -A packages/server/src/mcp/createMcpServer_test.ts`. Confirm the "exactly seven tools registered" test fails. Revert. (Verified: commenting out the `get_workspace_path` registration produced 3 failures — the count check, the description check for that tool, and the per-tool handler smoke; reverted.)
- [x] 11.4 Drift check — schema rejection: temporarily change `UpdateTicketBodyInputSchema` to `.passthrough()` (zod's "allow extra keys"). Run `deno test -A packages/server/src/mcp/wire/tickets_test.ts`. Confirm the "rejects sneaked-in `status`" test fails. Revert. (Verified: `.passthrough()` made the rejection test's `assertThrows` fail because the schema now accepted the extra `status` key; reverted.)
- [x] 11.5 Drift check — role hard-coding: temporarily change the HTTP client to stamp `X-Keni-Role: po` instead of `X-Keni-Role: engineer`. Run `deno test -A packages/server/src/mcp/httpClient_test.ts`. Confirm the role-stamping test fails. Revert. (Verified: the listTickets header-stamping test + the role-coverage test both failed on the changed string; reverted.)

## 12. End-to-end verification

- [x] 12.1 `deno install --frozen` exits 0 — the new SDK dep is locked and reproducible.
- [x] 12.2 `deno task fmt:check` exits 0.
- [x] 12.3 `deno task lint` exits 0.
- [x] 12.4 `deno task check` exits 0 across the workspace — every new wire schema's `z.ZodType<X>` constraint type-checks; every tool handler's return matches the MCP SDK's expected shape; every imported SDK type is referenced.
- [x] 12.5 `deno task test` exits 0 with the new tests counted in (post-state: 653 tests passing across the workspace; the engineer MCP layer contributes 14 outer tests across `wire/` (3 files), `tools/` (3 files), `httpClient_test.ts`, `errors_test.ts`, `createMcpServer_test.ts`, `runMcpServer_test.ts`, `main_test.ts`, and `integration_test.ts` — counted by `deno test` summary).
- [x] 12.6 End-to-end smoke verified: hand-rolled `Deno.Command`-driven `StdioClientTransport` against a fresh `mktemp -d` project, with the orchestration server launched via `deno run -A packages/server/src/main.ts --project <tempDir> --port 0` and the MCP server spawned by the SDK's stdio transport. The smoke listed seven tools verbatim and `list_tickets({})` returned `[]`. Transcript captured below under "End-to-end smoke transcript".
- [x] 12.7 Kill the MCP-server process via `kill -INT <pid>` — confirmed clean exit: exit code 0, no stack trace on stderr, the "Engineer MCP server connected ..." banner is the only stdout line. Implementation note: `runMcpServer` installs SIGINT/SIGTERM listeners (idempotent, removed on stdin-EOF shutdown) that delegate to `server.close()`, which fires `onclose` and resolves the same wait promise stdin EOF resolves — Ctrl-C and stdin EOF therefore share the exit path.

## 13. CI and hand-off

- [x] 13.1 Local CI dry-run all green: `deno install --frozen` (frozen lockfile), `deno task fmt:check`, `deno task lint`, `deno task check`, `deno task test` (full suite). All exit 0. (Final post-state: 653 tests, 12 steps, 0 failed.)
- [x] 13.2 `git status --short` matches the documented file set:
  - **Added** files: `openspec/changes/mcp-server-for-engineers/{proposal,design,tasks}.md`, `openspec/changes/mcp-server-for-engineers/.openspec.yaml`, `openspec/changes/mcp-server-for-engineers/specs/mcp-engineer-surface/spec.md`; under `packages/server/src/mcp/`: `main.ts`, `main_test.ts`, `createMcpServer.ts`, `createMcpServer_test.ts`, `runMcpServer.ts`, `runMcpServer_test.ts`, `httpClient.ts`, `httpClient_test.ts`, `errors.ts`, `errors_test.ts`, `integration_test.ts`, `tools/{tickets,activity,workspace}.ts`, `tools/{tickets,activity,workspace}_test.ts`, `wire/{tickets,activity,workspace,mod}.ts`, `wire/{tickets,activity,workspace}_test.ts`.
  - **Modified**: `deno.json` (one new import entry), `deno.lock` (regenerated), `README.md` (two amended subsections), `packages/server/src/main.ts` (extended barrel), `packages/server/src/main_test.ts` (one new import-resolution test).
- [x] 13.3 `openspec validate mcp-server-for-engineers` reports `Change 'mcp-server-for-engineers' is valid`.
- [x] 13.4 `openspec status --change mcp-server-for-engineers --json` reports `"isComplete": true` with all four artifacts (`proposal`, `design`, `specs`, `tasks`) at `"status": "done"`.
- [x] 13.5 `git status --short -- initial-implementation-plan/` and `git diff --name-only -- initial-implementation-plan/` are both empty — this change is strictly additive on top of the plan input.
- [x] 13.6 Record the hand-off block at the bottom of this file (see "Hand-off to downstream steps"). (The hand-off block authored during step 11.1 covers steps 07, 09, 13, 16, and 26.)

## Hand-off to downstream steps

### What downstream steps inherit from this change

**Step 07 (role runtime — common).** The role runtime is the *spawner* of the MCP server. It inherits:

- `runMcpServer` — but does *not* call it directly. Instead, the role runtime constructs the engineer subprocess's `mcpServers` config block whose entries point at `deno run -A packages/server/src/mcp/main.ts --agent=<id> --server-url=<url> --workspace=<path>`. The coding-agent CLI does the actual subprocess spawn.
- `McpServerDeps` and `McpHttpClient` — type-level only. Useful in step 07's tests when wiring fakes for the role runtime's surrounding logic.
- The trust contract: the MCP server is only safe when its three CLI flags are correct. Step 07 is responsible for computing the workspace path, the agent id (from `project.yaml` `agents`), and the server URL (from the running orchestration server). The MCP server's startup validation catches typos / stale paths; step 07's tests should catch them earlier.

**Step 09 (engineer specialisation + workspace + prompt).** The engineer specialisation owns the prompt. It inherits:

- The seven tool names — verbatim. The engineer prompt names each tool once when it teaches the agent how to use them; the prompt's tool-list section is auto-generated from `createMcpServer`'s registered tools (or hand-encoded against the spec's tool table — see step 09's design).
- The error vocabulary — the closed `ErrorCode` enum from step 04, used by the prompt to describe failure modes ("when you see `[role_not_owner]`, you have attempted to transition into a status owned by another role; ask a human").
- The "no `.keni/` reads" structural rule — the prompt explicitly tells the agent its workspace clone has no `.keni/` and that any state must be queried through MCP.

**Step 13 (`keni start`).** Unchanged. The MCP server is not part of `keni start` — it is spawned per-cycle by the engineer subprocess's `mcpServers` config (orchestrated by step 07's role runtime).

**Step 16 (PO MCP additions).** The PO MCP server is a *parallel factory* (see `design.md` Decision 14). It inherits:

- The compositional pattern: `createMcpServer` + `runMcpServer` are the template; step 16 lands `createPoMcpServer` + `runPoMcpServer` (or extends `runMcpServer` with a `--profile po` arg — to be decided in step 16's design).
- The HTTP client structure — the typed adapter pattern; PO HTTP calls will stamp `X-Keni-Role: po` instead of `engineer`.
- The error mapping — `mapHttpErrorToToolResult` is shared verbatim.
- The tool-registration grouping — one file per tool group (`tools/chat.ts`, `tools/cr.ts`, etc.).
- The capability-spec discipline — step 16 lands its own `mcp-po-surface` spec; the engineer surface is unchanged.

**Step 26 (multi-engineer).** Multi-engineer is a deployment change, not a code change. It inherits:

- The single `--agent` flag is what differentiates engineers. Spawning more engineers is spawning more MCP-server processes with different `--agent` values.
- The orchestration server's request-level guards (status-graph + role-owner + storage atomicity) are sufficient for the prototype's two-engineer race conditions. Ticket leasing (if needed) lands inside the orchestration server, not the MCP server — the MCP layer is unaffected.

### What downstream steps must NOT do

- **Do not add a tool to the engineer surface without amending `mcp-engineer-surface`.** New tools land via OpenSpec changes that delta-modify the capability spec. The current seven-tool list is the contract step 09's prompt depends on; silent additions break the prompt's safety story.
- **Do not parameterise `createMcpServer`'s role.** Step 16 builds a sibling factory (`createPoMcpServer`); they share the boot-time-CLI shape but the role each stamps is fixed at the factory boundary, not via a runtime flag (Decision 14 in `design.md`).
- **Do not add MCP tools that read or write `.keni/` directly.** Every tool delegates to the orchestration-server REST surface. If a future tool needs a new endpoint, the endpoint lands in the relevant orchestration-server delta first.
- **Do not introduce a second source of truth for tool input shapes.** The zod schemas in `packages/server/src/mcp/wire/` are the canonical schemas; if the SPA or another consumer later wants to render tool calls, it imports types from `@keni/server` (or the schemas are promoted to `@keni/shared` via a documented OpenSpec change).
- **Do not bypass the role guard from inside MCP.** The HTTP client stamps `X-Keni-Role: engineer` from boot configuration; tool input cannot override it. The orchestration server's `roleIdentity` middleware does the actual validation. If a future change wants per-tool role nuance (e.g. engineer creating a follow-up ticket), the orchestration server's REST endpoint handles it; the MCP layer just calls.
- **Do not assume MCP-server lifetime spans cycles.** Each role-runtime cycle spawns a fresh MCP-server process per the §6 fresh-session rule. No state leaks across cycles. Downstream features that need cross-cycle persistence are built on the orchestration server's REST surface and the activity log, not on the MCP-server process.

## Spec walk verification

One row per scenario in `specs/mcp-engineer-surface/spec.md`. Test paths are relative to the repo root.

| Spec scenario | Test (or structural artefact) |
| --- | --- |
| `createMcpServer` returns a configured `McpServer` without performing I/O | `packages/server/src/mcp/createMcpServer_test.ts` — "registers exactly seven tools, named per the spec" + "is pure — construction performs no fetch / no Deno.stat" |
| `runMcpServer` exits 0 on a clean shutdown | `packages/server/src/mcp/runMcpServer_test.ts` — "happy path — connects via in-memory transport and exits 0 when the client closes" |
| `runMcpServer` exits 2 when a required argument is missing | `packages/server/src/mcp/runMcpServer_test.ts` — "runMcpServer([]) returns 2 and stderr names every required flag" |
| `runMcpServer` exits 2 when an argument is malformed | `packages/server/src/mcp/runMcpServer_test.ts` — "rejects malformed --agent" + "rejects an unparseable --server-url" + "rejects a non-http(s) --server-url" |
| `runMcpServer` exits 1 when `--workspace` does not exist on disk | `packages/server/src/mcp/runMcpServer_test.ts` — "returns 1 when --workspace does not exist" |
| `main.ts` exports the documented public surface | `packages/server/src/mcp/main_test.ts` (full barrel) + `packages/server/src/main_test.ts` — "re-exports the MCP-server surface (runMcpServer, McpHttpError)" |
| No tool input schema includes a `role`, `agent`, or `workspace` field | `packages/server/src/mcp/wire/{tickets,activity,workspace}_test.ts` — strict-rejection cases (e.g. activity_test "rejects { agent: bob }" / "rejects { role: po }") |
| Outbound HTTP requests carry `X-Keni-Role: engineer` and `X-Keni-Agent: <agentId>` | `packages/server/src/mcp/httpClient_test.ts` — header-stamping cases (every method asserts both headers) |
| The CLI does not accept `--role` | `packages/server/src/mcp/runMcpServer_test.ts` — "rejects an unknown flag (e.g. --role) with exit 2" |
| All seven tools are registered with the documented names | `packages/server/src/mcp/createMcpServer_test.ts` — "registers exactly seven tools, named per the spec" + `integration_test.ts` step "listTools returns exactly the seven engineer tools" |
| Each tool registers with a non-empty description | `packages/server/src/mcp/createMcpServer_test.ts` — "each tool's description is a non-empty string ≤ 240 characters" + `integration_test.ts` step (asserts description per tool) |
| `update_ticket_body`'s schema rejects sneaked-in fields | `packages/server/src/mcp/wire/tickets_test.ts` — "UpdateTicketBodyInputSchema rejects { id, body, status }" |
| `append_activity_entry`'s schema rejects identity overrides | `packages/server/src/mcp/wire/activity_test.ts` — "rejects { session_id, event, agent }" + integration test "trust seam" (no `bob` entry on disk) |
| Argument validation runs before any I/O | `packages/server/src/mcp/runMcpServer_test.ts` — usage-error tests do not pass a valid stat fake yet still return 2 (validation happened first) |
| `--workspace` is validated as an existing directory at startup | `packages/server/src/mcp/runMcpServer_test.ts` — "returns 1 with a 'not a directory' message when --workspace is a regular file" |
| Boot-time identity is stamped on every outbound HTTP call | `packages/server/src/mcp/httpClient_test.ts` — header-stamping cases per method |
| A successful response is unwrapped from the envelope | `packages/server/src/mcp/httpClient_test.ts` — "listTickets unwraps the envelope" + "readTicket unwraps the envelope" |
| A non-2xx response surfaces as a typed `McpHttpError` | `packages/server/src/mcp/httpClient_test.ts` — "readTicket throws McpHttpError on 404" |
| A network-level failure surfaces as `internal_error` | `packages/server/src/mcp/httpClient_test.ts` — "network failure throws McpHttpError(internal_error, …, 0)" |
| No tool reads `.keni/` directly | `packages/server/src/mcp/integration_test.ts` — "engineer MCP source — no `.keni/` reads from tool handlers" (structural file-string scan) |
| `store_not_found` HTTP error becomes an MCP `isError: true` result | `packages/server/src/mcp/errors_test.ts` (`mapHttpErrorToToolResult` per code) + `integration_test.ts` step "read_ticket returns isError: true with [store_not_found] for an unknown id" |
| `role_not_owner` HTTP error becomes an MCP `isError: true` result | `packages/server/src/mcp/integration_test.ts` step "transition_ticket_status fails [role_not_owner] for tested → done" |
| `status_graph_violation` HTTP error becomes an MCP `isError: true` result | `packages/server/src/mcp/integration_test.ts` step "transition_ticket_status fails [status_graph_violation] for open → merged" |
| Network-level failure becomes an `[internal_error]` MCP result naming the URL | `packages/server/src/mcp/errors_test.ts` (`mapHttpErrorToToolResult` for `McpHttpError("internal_error", …, 0)`) — message includes URL via `httpClient_test.ts`'s "network failure" case |
| Unknown thrown value becomes an `[internal_error]` MCP result | `packages/server/src/mcp/errors_test.ts` — "TypeError → [internal_error]" |
| The `ErrorCode` enum is unchanged from step 04 | `packages/server/src/mcp/errors_test.ts` covers the 10 codes verbatim; `git diff packages/shared/src/wire/errors.ts` is empty (verified by `git status` in step 13.2) |
| `list_tickets` against an empty project returns an empty list | `packages/server/src/mcp/integration_test.ts` step "list_tickets returns [] on a fresh project" |
| `list_tickets` filter on `status` honours single value / array | `packages/server/src/mcp/httpClient_test.ts` — "listTickets({ status: ['open', 'in_progress'] }) produces ?status=open,in_progress" + `wire/tickets_test.ts` "accepts both single and array forms" |
| `read_ticket` returns the full ticket body | `packages/server/src/mcp/integration_test.ts` step "list_tickets returns a created ticket" + the orchestration server's existing tests cover body-in-response |
| `update_ticket_body` updates the on-disk file | `packages/server/src/mcp/integration_test.ts` step "update_ticket_body updates the on-disk file" |
| `update_ticket_body` rejects an attempt to set `status` | `packages/server/src/mcp/wire/tickets_test.ts` — "rejects { id, body, status }" |
| `transition_ticket_status` succeeds for a legal engineer-owned transition | `packages/server/src/mcp/integration_test.ts` step "transition_ticket_status succeeds for engineer-owned open → in_progress" |
| `transition_ticket_status` is refused with `role_not_owner` for QA-owned target | `packages/server/src/mcp/integration_test.ts` step "fails [role_not_owner] for tested → done" |
| `transition_ticket_status` is refused with `status_graph_violation` for unreachable target | `packages/server/src/mcp/integration_test.ts` step "fails [status_graph_violation] for open → merged" |
| `transition_ticket_status` retried after success surfaces `stale_state` | `packages/server/src/mcp/integration_test.ts` step "retried after success returns [stale_state]" |
| `append_activity_entry` writes to the date-partitioned activity log | `packages/server/src/mcp/integration_test.ts` step "writes a date-partitioned line under alice/engineer" |
| `append_activity_entry` rejects override of `agent` | `packages/server/src/mcp/wire/activity_test.ts` — "rejects { session_id, event, agent: bob }" + integration test "trust seam" |
| `append_activity_entry` rejects override of `role` | `packages/server/src/mcp/wire/activity_test.ts` — "rejects { session_id, event, role: po }" |
| `query_activity` with no `limit` returns at most 200 entries | `packages/server/src/mcp/tools/activity_test.ts` — "query_activity defaults limit to 200" (call-args assertion) |
| `query_activity` with explicit `limit: 5` returns at most 5 entries | `packages/server/src/mcp/integration_test.ts` step "query_activity ... honours an explicit limit" + `tools/activity_test.ts` "honours explicit limit" |
| `query_activity` rejects `limit` above ceiling | `packages/server/src/mcp/wire/activity_test.ts` — "rejects 1001" |
| `query_activity` honours filters | `packages/server/src/mcp/tools/activity_test.ts` — "forwards documented filters" + `httpClient_test.ts` "queryActivity composes filters" |
| `get_workspace_path` returns the boot-time path verbatim | `packages/server/src/mcp/integration_test.ts` step "returns the boot-time --workspace value verbatim" + `tools/workspace_test.ts` "returns deps.workspacePath" |
| `get_workspace_path` is invariant across calls | `packages/server/src/mcp/tools/workspace_test.ts` — "multiple invocations return identical paths and never invoke the HTTP client" |
| `get_workspace_path` rejects any input | `packages/server/src/mcp/wire/workspace_test.ts` — "rejects any non-empty input" (the SDK's protocol layer surfaces this; test exercises the schema directly) |
| Runnable entry point connects a stdio transport | `packages/server/src/mcp/runMcpServer_test.ts` — happy-path test connects an `InMemoryTransport` (`StdioServerTransport` is a single line in `runMcpServer.ts` covered by the integration test's subprocess spawn) |
| `createMcpServer` does not bind a transport | `packages/server/src/mcp/createMcpServer_test.ts` — "is pure — construction performs no fetch / no Deno.stat" (returns a server with no transport attached) |
| No status-graph or role-owner check in MCP layer | Structural review (no occurrence of `TICKET_STATUS_TRANSITIONS` / `isTicketRoleOwner` etc. under `packages/server/src/mcp/`); the integration test's `role_not_owner` and `status_graph_violation` steps confirm refusals come from the orchestration server |
| No new orchestration-server endpoint introduced | `packages/server/src/createServer_test.ts` is unchanged; `git status` shows no edits to `packages/server/src/routes/` |
| Closing stdin shuts the server down cleanly | `packages/server/src/mcp/runMcpServer_test.ts` — "happy path — exits 0 when the client closes" (transport close ⇒ exit 0) |
| Two engineers spawn two independent MCP-server processes | Inherent to the design (per-process closures over `--agent`); covered by inspection — each `createMcpHttpClient` produces an isolated client. Multi-process integration deferred to step 26 |
| Trust-model section names spawn-trust caveat | `openspec/changes/mcp-server-for-engineers/specs/mcp-engineer-surface/spec.md` line "the role runtime is the only legitimate spawner of the MCP-server binary" |
| Out-of-scope list explicitly names PO tools, spec/CR tools, PR-write tools, WS tools | Same spec file under "The capability spec documents the trust model and the explicit out-of-scope tool list" requirement |
| Only one new import entry is added (`@modelcontextprotocol/sdk`) | `git diff deno.json` (verified in step 13.2) |
| Lockfile is regenerated and frozen | `deno install --frozen` in step 12.1 |
| All eleven integration assertion points pass on a clean run | `packages/server/src/mcp/integration_test.ts` — 12 inner steps + 2 outer (trust seam + structural) all green (verified in step 9.6) |
| Test cleanup is deterministic | Integration test wraps every spawn in a `try` / `finally` block that closes the client and aborts the orchestration server (verified in step 9.6 — no leaked PIDs or ports) |

## End-to-end smoke transcript

Captured from a fresh `mktemp -d` on `2026-05-01`. The smoke spawns the three binaries the way step 07 will (orchestration server in one process, MCP server as a subprocess driven by `StdioClientTransport` from the SDK's client). The driver script lives at `/tmp/keni-mcp-smoke.sh`; its essential body is included below.

```
=== STEP 1: project root = /var/folders/.../keni-mcp-smoke-proj-XXXXXX.5ZTwzAPU3b
=== STEP 1: workspace dir = /var/folders/.../keni-mcp-smoke-ws-XXXXXX.DfgLqmLdp7
=== STEP 2: keni init /var/folders/.../keni-mcp-smoke-proj-XXXXXX.5ZTwzAPU3b
   Initialised Keni project at /var/folders/.../keni-mcp-smoke-proj-XXXXXX.5ZTwzAPU3b
     project_id: b6f6c59d-8d26-4cf4-bf38-16441bf7179c
     default agent: alice (engineer)
=== STEP 3: start orchestration server
   bound URL: http://127.0.0.1:57840
=== STEP 4: drive hand-rolled MCP client over StdioClientTransport
   tools: ["append_activity_entry","get_workspace_path","list_tickets","query_activity","read_ticket","transition_ticket_status","update_ticket_body"]
   list_tickets result: []
   ALL ASSERTIONS PASSED
=== DONE
```

Driver script (the `Deno.run` block driving the MCP client):

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [serverUrl, wsDir] = Deno.args;
const transport = new StdioClientTransport({
  command: Deno.execPath(),
  args: [
    "run",
    "-A",
    "packages/server/src/mcp/main.ts",
    "--agent=alice",
    `--server-url=${serverUrl}`,
    `--workspace=${wsDir}`,
  ],
  stderr: "pipe",
});

const client = new Client({ name: "keni-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((t: { name: string }) => t.name).sort();
console.log("   tools:", JSON.stringify(names));

const result = await client.callTool({ name: "list_tickets", arguments: {} });
console.log("   list_tickets result:", result.content[0].text);

await client.close();
```
