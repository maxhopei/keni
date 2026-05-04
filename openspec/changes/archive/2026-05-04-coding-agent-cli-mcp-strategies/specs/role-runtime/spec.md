## ADDED Requirements

### Requirement: The default subprocess invoker spawns the CLI with `cwd` set to the per-agent workspace

The default subprocess invoker SHALL pass `cwd: invocation.workspacePath` to `new Deno.Command(...)` when `invocation.workspacePath !== null`. When `invocation.workspacePath === null`, the invoker SHALL omit the `cwd` option (the spawned child inherits the parent process's cwd — today's behaviour).

This requirement matches the existing semantics of the `KENI_MCP_WORKSPACE` env-var mandate (only set when `workspacePath !== null`) and gives file-discovery-based CLIs (e.g. `cursor-agent`'s `<cwd>/.cursor/mcp.json` discovery, `codex`'s `<cwd>/.codex/config.toml` discovery) a stable, per-agent root.

#### Scenario: Production engineer cycle spawns with `cwd` set to the workspace

- **WHEN** the cycle is invoked with `workspacePath: "/Users/alice/.keni/workspaces/p1/alice"` and a fake binary that prints `Deno.cwd()` to stdout and exits
- **THEN** the captured stdout line is `"/Users/alice/.keni/workspaces/p1/alice"`

#### Scenario: Test path with `workspacePath: null` falls through to the parent's cwd

- **WHEN** the cycle is invoked with `workspacePath: null` (the test-only path)
- **AND** the parent process's `Deno.cwd()` is `"/tmp/parent-cwd"`
- **THEN** the spawned child's `cwd` is `"/tmp/parent-cwd"` (no override)

### Requirement: The default invoker materialises the MCP-config per the entry's `mcpConfigStrategy` discriminated union

The default invoker SHALL accept `opts.mcpConfigStrategy: McpConfigStrategy` and execute the strategy before spawn. The closed set of strategies and their semantics:

- `{ kind: "tempfile-json" }`: Create a temp file via `Deno.makeTempFile({ prefix: "keni-mcp-", suffix: ".json" })`. Write `JSON.stringify({ mcpServers: { keni: invocation.mcpServerConfig } })`. Pass the path to `buildArgs` as `mcpConfigPath`. Register a `try`/`finally` cleanup so the file is removed on cycle exit (success, idle, terminated, or spawn_failed).

- `{ kind: "workspace-json", relativePath, mergeKey, entryName }`: Compute `path = joinPath(invocation.workspacePath, relativePath)`. The invoker SHALL throw `RoleRuntimeError("workspace_required_for_strategy", { kind: "workspace-json" })` when `invocation.workspacePath === null`. Read the existing file (treat `Deno.errors.NotFound` as `{}`), parse via `JSON.parse`. The parsed value SHALL be a plain object (not `null`, not an array, not a primitive); otherwise throw `RoleRuntimeError("mcp_config_corrupt", { path, kind })`. Ensure `parsed[mergeKey]` is a plain object (create it if absent; throw `mcp_config_corrupt` if it exists with a non-object type). Set `parsed[mergeKey][entryName] = invocation.mcpServerConfig`. Ensure the parent directory exists via `Deno.mkdir(dirname(path), { recursive: true })`. Write the file back via `Deno.writeTextFile(path, JSON.stringify(parsed, null, 2))`. Pass `path` to `buildArgs` as `mcpConfigPath` (the per-CLI `buildArgs` may ignore it — `cursor-agent` does). No cleanup is registered.

- `{ kind: "workspace-toml", relativePath, tableHeader, entryName }`: Compute `path = joinPath(invocation.workspacePath, relativePath)`. The invoker SHALL throw `RoleRuntimeError("workspace_required_for_strategy", { kind: "workspace-toml" })` when `invocation.workspacePath === null`. Read the existing file (treat `Deno.errors.NotFound` as `""`), parse via `@std/toml`'s `parse`. The parsed value SHALL be a plain object; otherwise throw `RoleRuntimeError("mcp_config_corrupt", { path, kind })`. Ensure `parsed[tableHeader]` is a plain object. Set `parsed[tableHeader][entryName] = invocation.mcpServerConfig`. Ensure the parent directory exists. Write the file back via `Deno.writeTextFile(path, stringify(parsed))`. Pass `path` to `buildArgs` as `mcpConfigPath`. No cleanup is registered.

The strategy executor SHALL be a pure function over `(invocation, strategy)` returning `Promise<{ path: string; cleanup: () => Promise<void> }>`. The factory SHALL invoke the executor exactly once per cycle, before constructing `Deno.Command`, and SHALL `await cleanup()` in a `try`/`finally` after `child.status` resolves.

#### Scenario: `tempfile-json` writes to `${TMPDIR}` and removes on cycle exit

- **WHEN** the factory is invoked with `mcpConfigStrategy: { kind: "tempfile-json" }`
- **AND** the cycle resolves (success, idle, terminated, or spawn_failed)
- **THEN** the file passed to `buildArgs` does not exist on disk after the cycle resolves
- **AND** no orphan temp files remain in the configured temp dir for this cycle

#### Scenario: `workspace-json` merges into existing file under `mergeKey.entryName`

- **WHEN** `<workspacePath>/.cursor/mcp.json` exists and contains `{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp"] } } }`
- **AND** the factory is invoked with `mcpConfigStrategy: { kind: "workspace-json", relativePath: ".cursor/mcp.json", mergeKey: "mcpServers", entryName: "keni" }` and an `invocation.mcpServerConfig` with `command: "deno"`
- **THEN** after the executor runs, `<workspacePath>/.cursor/mcp.json` contains both keys: `mcpServers.playwright` (verbatim) and `mcpServers.keni` (the new config)
- **AND** the file is well-formed JSON with `JSON.stringify(_, null, 2)` formatting
- **AND** no cleanup runs at cycle exit (the file persists)

#### Scenario: `workspace-json` creates the parent directory and the file when both are absent

- **WHEN** `<workspacePath>/.cursor/` does not exist and the strategy is `workspace-json` with `relativePath: ".cursor/mcp.json"`
- **THEN** the executor creates the directory recursively
- **AND** writes the file with content `{ "mcpServers": { "keni": <config> } }`

#### Scenario: `workspace-toml` merges into existing file under `tableHeader.entryName`

- **WHEN** `<workspacePath>/.codex/config.toml` exists with `[mcp_servers.playwright]\ncommand = "npx"\n`
- **AND** the factory is invoked with `mcpConfigStrategy: { kind: "workspace-toml", relativePath: ".codex/config.toml", tableHeader: "mcp_servers", entryName: "keni" }`
- **THEN** the file after executor execution contains both `[mcp_servers.playwright]` (verbatim) and `[mcp_servers.keni]` (the new config)
- **AND** no cleanup runs at cycle exit

#### Scenario: `workspace-json` rejects null `workspacePath`

- **WHEN** the factory is invoked with `mcpConfigStrategy: { kind: "workspace-json", ... }` and `invocation.workspacePath: null`
- **THEN** the executor throws `RoleRuntimeError("workspace_required_for_strategy", { kind: "workspace-json" })`
- **AND** the cycle catches the throw and returns `{ outcome: "spawn_failed", sessionId, error }`

#### Scenario: `workspace-json` rejects a corrupt existing file

- **WHEN** `<workspacePath>/.cursor/mcp.json` contains `[1, 2, 3]` (a JSON array, not a plain object)
- **AND** the factory runs the `workspace-json` strategy against that path
- **THEN** the executor throws `RoleRuntimeError("mcp_config_corrupt", { path, kind: "workspace-json" })`

## MODIFIED Requirements

### Requirement: The role's `promptResolver` returns a TS-constant `BundledPrompt`; the helper validates name and non-empty body

The role's `promptResolver` SHALL return a `BundledPrompt = { name: string, body: string }` whose `body` is a TypeScript string constant compiled into the binary. The `resolveBundledPrompt(prompt, expectedName?)` helper SHALL: (a) throw `RoleRuntimeError("empty_prompt_body", ...)` when `prompt.body.length === 0`; (b) when `expectedName` is supplied and `prompt.name !== expectedName`, throw `RoleRuntimeError("prompt_name_mismatch", ...)` whose message names both the expected and the received name; (c) on success, return the validated `BundledPrompt` verbatim. The package's source code under `packages/role-runtimes/src/common/` SHALL NOT contain any path-based prompt-loading function (no `loadPromptFromPath`, no `import.meta.resolve` resolving a `.keni/`-prefixed path) — every prompt is reachable only as a TS constant. A structural test SHALL assert this by walking source files and rejecting any path literal beginning with `.keni/` / `~/.keni/`. Filesystem read primitives (`Deno.readTextFile`, `Deno.readFile`) and write primitives (`Deno.writeTextFile`, `Deno.writeFile`) SHALL be forbidden in every file under `common/` EXCEPT the explicitly-sanctioned strategy-executor file `codingAgentInvoker.ts`, which materialises the keni MCP-server config per the entry's `mcpConfigStrategy` (per the new requirement "The default invoker materialises the MCP-config per the entry's `mcpConfigStrategy` discriminated union"). Even in the sanctioned file, no `.keni/`-prefixed path literal is permitted; workspace paths are computed via `joinPath(invocation.workspacePath, relativePath)` from the strategy.

#### Scenario: Empty prompt body is rejected

- **WHEN** `resolveBundledPrompt({ name: "engineer", body: "" })` is invoked
- **THEN** the helper throws `RoleRuntimeError`
- **AND** the error's `code` is `"empty_prompt_body"`
- **AND** the error's `message` names the prompt's `name` field

#### Scenario: Name mismatch is rejected when `expectedName` is supplied

- **WHEN** `resolveBundledPrompt({ name: "po-chat", body: "..." }, "engineer")` is invoked
- **THEN** the helper throws `RoleRuntimeError`
- **AND** the error's `code` is `"prompt_name_mismatch"`
- **AND** the error's `message` names both `"engineer"` (expected) and `"po-chat"` (received)

#### Scenario: Validated prompt is returned verbatim

- **WHEN** `resolveBundledPrompt({ name: "engineer", body: "ENGINEER PROMPT BODY" }, "engineer")` is invoked
- **THEN** the helper returns the same object with `name: "engineer"` and `body: "ENGINEER PROMPT BODY"`

#### Scenario: Source code under `packages/role-runtimes/src/common/` contains no path-based prompt loader

- **WHEN** the source files under `packages/role-runtimes/src/common/` (excluding `*_test.ts` and `tests/fixtures/`) are scanned
- **THEN** no occurrence of `import.meta.resolve("./prompts/` followed by a `.txt` / `.md` extension is found in any production file
- **AND** no path literal beginning with `.keni/` or `~/.keni/` appears in any production file
- **AND** every prompt body in the package is a TS string constant exported from a file under `packages/role-runtimes/src/common/prompts/` (or, post-step-09, under `packages/role-runtimes/src/engineer/`, `qa/`, `po/`)
- **AND** `Deno.readTextFile` / `Deno.readFile` appears only in the explicitly-sanctioned strategy-executor file `codingAgentInvoker.ts`

### Requirement: The cycle reaches the activity log only through `POST /activity`; no direct `.keni/` read or write

The cycle SHALL emit every activity entry by issuing `POST /activity` against `params.serverUrl`, carrying `Content-Type: application/json`, `X-Keni-Role: <params.role>`, and `X-Keni-Agent: <params.agentId>` on every request. The cycle SHALL NOT call any storage interface from `@keni/shared` directly, SHALL NOT read or write any path under `.keni/` or `~/.keni/`, and SHALL NOT bypass the orchestration server's role-identity middleware (the headers are stamped by the activity-log adapter, not by tool input). On a 2xx response, the adapter SHALL discard the response body (the cycle does not need the persisted entry's id). On a non-2xx response, the adapter SHALL parse the documented `{ error: { code, message, details? } }` envelope and throw `new RoleRuntimeHttpError(code, message, details, status)`. On a network-level failure (`fetch` rejects), the adapter SHALL throw `new RoleRuntimeHttpError("internal_error", `Network error talking to ${url}: ${cause.message}`, ..., 0)`. A throw from any activity-log call inside the cycle SHALL abort the cycle and surface as `{ outcome: "spawn_failed", sessionId, error }` with no further `POST` attempts (the server is unreachable; further calls would also fail).

#### Scenario: Every `POST /activity` carries the role and agent headers

- **WHEN** the cycle issues any `POST /activity` request
- **AND** the orchestration server captures inbound request headers
- **THEN** every captured request carries `X-Keni-Role` equal to `params.role`
- **AND** every captured request carries `X-Keni-Agent` equal to `params.agentId`

#### Scenario: Source code under `packages/role-runtimes/src/common/` contains no `.keni/` reads or writes

- **WHEN** the source files under `packages/role-runtimes/src/common/` (excluding `*_test.ts` and integration-test fixtures) are scanned for any path literal beginning with `.keni/` or `~/.keni/`
- **THEN** no occurrence is found
- **AND** in every file other than the sanctioned strategy-executor file `codingAgentInvoker.ts`, no occurrence of `Deno.readTextFile` or `Deno.readFile` is found
- **AND** in every file other than `codingAgentInvoker.ts`, the only filesystem-write primitive that may appear is `Deno.writeTextFile` against a `Deno.makeTempFile`-derived path
- **AND** `codingAgentInvoker.ts` itself MAY use `Deno.readTextFile`, `Deno.writeTextFile`, and `Deno.mkdir` to materialise the entry's `mcpConfigStrategy` against `joinPath(invocation.workspacePath, <relativePath>)` — never against a `.keni/`-prefixed literal

#### Scenario: A non-2xx response surfaces as `RoleRuntimeHttpError`

- **WHEN** the activity-log adapter issues a `POST /activity` and the server responds with `400 missing_role`
- **THEN** the adapter throws `new RoleRuntimeHttpError("missing_role", <message>, <details>, 400)`

### Requirement: `CodingAgentInvoker` decouples spawn-mechanics from the cycle; the default factory drives `Deno.Command` with documented opts

The package SHALL export a `CodingAgentInvoker` interface whose only method is `invoke(invocation: CodingAgentInvocation, lifecycle: CodingAgentLifecycle): Promise<CodingAgentOutcome>`. The cycle SHALL call exactly this method exactly once per cycle (after `session_start` is logged). The package SHALL also export a default factory `createSubprocessCodingAgentInvoker(opts)` whose options bag is `{ cliBinary: string, buildArgs: (invocation, mcpConfigPath) => readonly string[], promptInjection: "stdin" | "arg", mcpConfigStrategy: McpConfigStrategy, graceMs?: number, envAllowlist?: readonly string[], resumeFlag?: string, killTimeoutMs?: number }`.

The factory SHALL produce an invoker that: (a) invokes the strategy executor for `opts.mcpConfigStrategy` to obtain `{ path: string; cleanup: () => Promise<void> }` and registers the cleanup in a `try`/`finally`; (b) constructs `Deno.Command(cliBinary, { args: buildArgs(invocation, path), env, stdin, stdout: "piped", stderr: "piped", cwd: invocation.workspacePath ?? undefined })`; (c) writes the prompt to stdin (when `promptInjection === "stdin"`) and closes stdin once written, or relies on the args constructed by `buildArgs` (when `promptInjection === "arg"`); (d) reads stdout / stderr line-by-line and calls `lifecycle.onStdoutLine` / `onStderrLine`; (e) honours `lifecycle.abortSignal` by calling the subprocess utility's `terminate` with the configured `graceMs`; (f) resolves with `{ kind: "completed", exitCode } | { kind: "terminated", exitCode, terminatedBy }`. The invoker SHALL throw on synchronous spawn failures (e.g., binary not found, strategy executor errors); the cycle catches and surfaces as `spawn_failed`.

The options bag's `mcpConfigStrategy` field SHALL be required (no default). The pre-existing `mcpConfigPathBuilder?` field is REMOVED. A test seam `tempfilePathOverrideForTesting?: (invocation) => Promise<string>` MAY be added to the strategy executor (not to the factory's opts bag) so `tempfile-json`-strategy unit tests can route the temp path to a controlled location without polluting production opts.

#### Scenario: Default factory produces an invoker that runs an actual subprocess and emits stdout lines

- **WHEN** `createSubprocessCodingAgentInvoker({ cliBinary: <path to a Deno-script fixture>, buildArgs: () => [], promptInjection: "stdin", mcpConfigStrategy: { kind: "tempfile-json" } })` is invoked
- **AND** the cycle runs against a Deno-script fixture that prints `"line 1"\n"line 2"\n` and exits 0
- **THEN** the cycle's lifecycle bag observed exactly two `onStdoutLine` calls (`"line 1"` then `"line 2"`)
- **AND** the cycle resolved with `{ kind: "completed", exitCode: 0 }`

#### Scenario: Invoker throws on missing binary; cycle surfaces as `spawn_failed`

- **WHEN** the default factory is invoked with `cliBinary: "/no/such/binary"` and `mcpConfigStrategy: { kind: "tempfile-json" }`
- **AND** the cycle calls the invoker
- **THEN** the invoker throws `Error` whose message names the missing binary
- **AND** the cycle catches the throw and returns `{ outcome: "spawn_failed", sessionId, error }`

#### Scenario: AbortSignal during spawn triggers graceful termination

- **WHEN** the cycle is invoked with `params.signal` from an `AbortController` and the fixture sleeps for 30 s
- **AND** the test fires `controller.abort()` 100 ms into the cycle
- **THEN** the invoker calls the subprocess utility's `terminate` with the configured grace ms
- **AND** the cycle resolves with `{ outcome: "terminated", sessionId, terminatedBy: "sigterm", exitCode: <signal exit code> }`

#### Scenario: MCP-config temp file is cleaned up on cycle exit (tempfile-json strategy only)

- **WHEN** the default factory writes an `mcpServers` JSON to a temp file at cycle start (`mcpConfigStrategy.kind === "tempfile-json"`)
- **AND** the cycle resolves (success, idle, terminated, or spawn_failed)
- **THEN** the temp file does not exist on disk after the cycle resolves
- **AND** no orphan temp files remain in the configured temp dir for this cycle

#### Scenario: Workspace-strategy file persists after cycle exit (no cleanup)

- **WHEN** the default factory runs the `workspace-json` strategy against `<workspacePath>/.cursor/mcp.json`
- **AND** the cycle resolves (success, idle, terminated, or spawn_failed)
- **THEN** the file at `<workspacePath>/.cursor/mcp.json` continues to exist on disk after the cycle resolves
- **AND** the file's contents include the keni entry under `mcpServers.keni`
