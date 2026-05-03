## 1. Workspace plumbing

- [x] 1.1 Verify the `@keni/role-runtimes` package member exists in the root `deno.json` workspace array (it does, from step 01) and that its `packages/role-runtimes/deno.json` declares `"exports": "./src/main.ts"`. No edits expected — this is a precondition check.
- [x] 1.2 Verify the workspace baseline is green before any new code lands: `deno install --frozen` exits 0, `deno task fmt:check` exits 0, `deno task lint` exits 0, `deno task check` exits 0, `deno task test` exits 0. Records the post-step-06 baseline test count for the post-state assertion in step 12. **Baseline: 653 passing tests.**
- [x] 1.3 Create the directory layout under `packages/role-runtimes/src/common/` matching `design.md` Decision 1: empty subfolders `prompts/`, `fakes/`, and a sibling `tests/fixtures/` under `packages/role-runtimes/`. No files yet — directory creation is a precondition for the per-module task groups below.

## 2. Core types — `packages/role-runtimes/src/common/types.ts`

- [x] 2.1 Create `packages/role-runtimes/src/common/types.ts` exporting:
  - `import type { Role, AgentId } from "@keni/shared";` (the role union and the agent-id brand are reused verbatim, never re-declared).
  - `interface BundledPrompt { readonly name: string; readonly body: string; }` — the role's prompt return shape.
  - `interface CyclePrepCtx { readonly role: Role; readonly agentId: AgentId; readonly projectName: string; readonly workspacePath: string | null; readonly serverUrl: string; }` — the precheck / prompt-resolver argument bag.
  - `type PrecheckResult = { kind: "skip"; reason: string } | { kind: "proceed"; roleContext?: { summary?: string | null } };` — the precheck's return shape.
  - `interface CodingAgentInvocation { readonly promptBody: string; readonly role: Role; readonly agentId: AgentId; readonly projectName: string; readonly workspacePath: string | null; readonly mcpServerConfig: McpServerConfig; readonly resumeSessionId: string | null; readonly envAllowlist: readonly string[]; }` — the value the cycle passes to the invoker.
  - `interface McpServerConfig { readonly command: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>>; }` — the `mcpServers` entry shape (matches the documented coding-agent CLI convention).
  - `interface CodingAgentLifecycle { readonly onStdoutLine: (line: string) => void | Promise<void>; readonly onStderrLine: (line: string) => void | Promise<void>; readonly onSpawn?: (info: { pid: number }) => void; readonly abortSignal?: AbortSignal; }` — the callback bag the cycle hands the invoker.
  - `type CodingAgentOutcome = { kind: "completed"; exitCode: number } | { kind: "terminated"; exitCode: number; terminatedBy: "sigterm" | "sigkill" };` — the invoker's resolved outcome.
  - `interface CodingAgentInvoker { invoke(invocation: CodingAgentInvocation, lifecycle: CodingAgentLifecycle): Promise<CodingAgentOutcome>; }` — the seam.
  - `interface RoleCycleParams { readonly role: Role; readonly agentId: AgentId; readonly serverUrl: string; readonly projectName: string; readonly workspacePath?: string; readonly mcpServerConfig: McpServerConfig; readonly precheck: (ctx: CyclePrepCtx) => Promise<PrecheckResult> | PrecheckResult; readonly promptResolver: (ctx: CyclePrepCtx) => BundledPrompt; readonly expectedPromptName?: string; readonly codingAgentInvoker: CodingAgentInvoker; readonly resumeSessionId?: string; readonly signal?: AbortSignal; readonly idleThresholdMs?: number; readonly terminationGraceMs?: number; readonly maxLinesPerStream?: number; readonly envAllowlist?: readonly string[]; }`.
  - `type RoleCycleResult = | { outcome: "completed"; sessionId: string; exitCode: number; summary: string | null } | { outcome: "idle"; sessionId: string } | { outcome: "precheck_skipped"; reason: string } | { outcome: "terminated"; sessionId: string; terminatedBy: "sigterm" | "sigkill"; exitCode: number } | { outcome: "spawn_failed"; sessionId: string; error: Error };`.
  - `class RoleRuntimeError extends Error { readonly code: "empty_prompt_body" | "prompt_name_mismatch" | "invalid_resume_session_id"; constructor(code, message); }` — the typed error class for cycle-internal validation failures.
  - `class RoleRuntimeHttpError extends Error { readonly code: string; readonly details: Record<string, unknown> | undefined; readonly httpStatus: number; constructor(code, message, details, httpStatus); }` — the typed error for activity-log HTTP failures.
- [x] 2.2 Create `packages/role-runtimes/src/common/types_test.ts` with type-level assertions only (using `Expect<Equal<X, Y>>` matching the workspace convention from `packages/server/src/wire/agents_test.ts`):
  - `RoleCycleResult` is a union of exactly five members.
  - `CodingAgentOutcome` is a union of exactly two members.
  - `RoleCycleParams.role` is typed as `Role` (not `string`).
  - `RoleCycleParams.agentId` is typed as `AgentId` (the branded type).
  - `BundledPrompt` has exactly the fields `name` and `body`.
- [x] 2.3 Verify: `deno task check` exits 0; `deno test -A packages/role-runtimes/src/common/types_test.ts` exits 0.

## 3. Summary-line extractor — `packages/role-runtimes/src/common/summaryLine.ts`

- [x] 3.1 Create `packages/role-runtimes/src/common/summaryLine.ts` exporting `extractSummaryLine(buffer: readonly string[]): string | null` — pure function returning the last entry of `buffer` whose `trimEnd()`-ed value is non-empty, or `null` when the buffer is empty / all entries are empty. The returned string is the raw entry (no trim applied to the returned value; only used for the empty check).
- [x] 3.2 Create `packages/role-runtimes/src/common/summaryLine_test.ts` covering: an empty buffer returns `null`; a single non-empty line returns that line verbatim; a trailing whitespace-only line is skipped (the previous non-empty line wins); an all-whitespace buffer returns `null`; leading whitespace on the chosen line is preserved (`"  hello"` → `"  hello"`).
- [x] 3.3 Verify: `deno test -A packages/role-runtimes/src/common/summaryLine_test.ts` exits 0; `deno task check` exits 0.

## 4. Prompt resolver — `packages/role-runtimes/src/common/promptResolver.ts`

- [x] 4.1 Create `packages/role-runtimes/src/common/promptResolver.ts` exporting `resolveBundledPrompt(prompt: BundledPrompt, expectedName?: string): BundledPrompt`. Implements `design.md` Decision 3:
  - Throws `new RoleRuntimeError("empty_prompt_body", \`Prompt "\${prompt.name}" has an empty body — bundled prompts must be non-empty TS string constants.\`)` when `prompt.body.length === 0`.
  - Throws `new RoleRuntimeError("prompt_name_mismatch", \`Expected bundled prompt "\${expectedName}" but received "\${prompt.name}".\`)` when `expectedName` is supplied and `prompt.name !== expectedName`.
  - Returns the validated `prompt` verbatim on success.
- [x] 4.2 Create `packages/role-runtimes/src/common/prompts/placeholder.ts` exporting `export const PLACEHOLDER_PROMPT_BODY = "PLACEHOLDER PROMPT — used by the role-runtime-common integration test only. Replace per role in steps 09 / 18.\\n";` and `export const PLACEHOLDER_PROMPT_NAME = "placeholder";`. The integration test (step 9 below) imports both.
- [x] 4.3 Create `packages/role-runtimes/src/common/promptResolver_test.ts` covering: an empty body throws `RoleRuntimeError("empty_prompt_body", ...)`; a name mismatch throws `RoleRuntimeError("prompt_name_mismatch", ...)`; a valid prompt is returned verbatim; the `expectedName` parameter is genuinely optional (no name-match check when omitted).
- [x] 4.4 Verify: `deno test -A packages/role-runtimes/src/common/promptResolver_test.ts` exits 0; `deno task check` exits 0.

## 5. Subprocess utility — `packages/role-runtimes/src/common/subprocess.ts`

- [x] 5.1 Create `packages/role-runtimes/src/common/subprocess.ts` exporting:
  - `interface SubprocessTerminateOpts { readonly graceMs: number; readonly killTimeoutMs?: number; }` — defaults `killTimeoutMs: 1000`.
  - `interface SubprocessTerminateResult { readonly exitCode: number; readonly terminatedBy: "exit" | "sigterm" | "sigkill"; }`.
  - `async function terminate(child: Deno.ChildProcess, opts: SubprocessTerminateOpts): Promise<SubprocessTerminateResult>` — implements `design.md` Decision 8: race `child.status` against a SIGTERM-then-grace-then-SIGKILL ladder. On Windows, skip SIGTERM and call `child.kill()` directly; emit a one-line warning to stderr the first time the utility runs on Windows (use a module-level `let warned = false` flag).
  - `function buildChildEnv(allowlist: readonly string[], runtimeMandated: Readonly<Record<string, string>>): Record<string, string>` — implements `design.md` Decision 8 env-allowlist: read each name in `allowlist` via `Deno.env.get(name)` and include it only when set; merge `runtimeMandated` on top; never call `Deno.env.toObject()`.
  - `function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void | Promise<void>, onClose?: () => void | Promise<void>): Promise<void>` — pipes the stream through `TextDecoderStream`, splits on `\n`, holds trailing partials, emits non-empty trimmed lines, calls `onClose` when the stream ends.
- [x] 5.2 Create `packages/role-runtimes/src/common/subprocess_test.ts` covering:
  - **Graceful termination on a slow child.** Spawn a Deno-script that sleeps for 30 s, call `terminate(child, { graceMs: 200 })`, assert `terminatedBy: "sigkill"` and the cycle resolves within ~1.5 s wall time.
  - **Already-exited child.** Spawn a child that exits immediately, await `child.status`, then call `terminate`; assert `terminatedBy: "exit"` and no signal was sent (this is harder to assert directly; test by ensuring the child's already-resolved status is honoured).
  - **SIGTERM-then-exit (graceful).** Spawn a Deno-script that handles SIGTERM and exits with code 0 within ~50 ms; call `terminate(child, { graceMs: 5000 })`; assert `terminatedBy: "sigterm"`, `exitCode: 0`.
  - **`buildChildEnv` allowlist filtering.** Set a temporary env var via `Deno.env.set("FOO_ALLOWED", "x")`; call `buildChildEnv(["FOO_ALLOWED", "BAR_NEVER_SET"], { KENI_MCP_AGENT: "alice" })`; assert the result is `{ FOO_ALLOWED: "x", KENI_MCP_AGENT: "alice" }` (no `BAR_NEVER_SET`); clean up the env var.
  - **`readLines` on a chunked stream.** Construct a manual `ReadableStream<Uint8Array>` that emits `"a\nb"`, then `"c\n"`, then closes; assert the callback was invoked with `"a"`, `"bc"` in that order; on close `onClose` was called once.
  - **`readLines` skips empty lines.** Stream emits `"\n\nhello\n\n"`; callback sees only `"hello"`.
- [x] 5.3 Skip Windows-specific tests in CI (CI runs on macOS/Linux); document the Windows path in the source's leading comment.
- [x] 5.4 Verify: `deno test -A packages/role-runtimes/src/common/subprocess_test.ts` exits 0; `deno task check` exits 0.

## 6. Activity-log adapter — `packages/role-runtimes/src/common/activityClient.ts`

- [x] 6.1 Create `packages/role-runtimes/src/common/activityClient.ts` exporting:
  - `interface ActivityLogClientOpts { readonly serverUrl: string; readonly agentId: AgentId; readonly role: Role; }`.
  - `interface ActivityLogClient { appendSessionStart(input): Promise<void>; appendSessionEnd(input): Promise<void>; appendIdle(input): Promise<void>; appendSubprocessOutput(input): Promise<void>; appendSubprocessOutputTruncated(input): Promise<void>; appendRaw(input: ActivityAppendRequest): Promise<void>; }` — methods per `design.md` Decision 5.
  - `function createActivityLogClient(opts): ActivityLogClient` — factory.
  - Constants: `SUMMARY_HARD_CAP_BYTES = 3072` (3 KB), `TRUNCATION_MARKER = (n: number) => \`... [truncated \${n} bytes]\``.
- [x] 6.2 Implement each typed method as a thin wrapper that calls `appendRaw` with the right `event` value:
  - `appendSessionStart({ sessionId, summary, refs })` → `appendRaw({ session_id: sessionId, agent: opts.agentId, role: opts.role, event: "session_start", summary: summary ?? null, refs })`.
  - `appendSessionEnd({ sessionId, exitCode, summary, terminatedBy?, refs? })` → `appendRaw({ session_id: sessionId, agent, role, event: "session_end", summary: summary ?? null, refs: { ...(refs ?? {}), exit_code: String(exitCode), ...(terminatedBy ? { terminated_by: terminatedBy } : {}) } })`.
  - `appendIdle({ sessionId, refs? })` → `appendRaw({ session_id: sessionId, agent, role, event: "idle", summary: null, refs })`.
  - `appendSubprocessOutput({ sessionId, streamKind, line })` → `appendRaw({ session_id: sessionId, agent, role, event: streamKind === "stdout" ? "subprocess_stdout" : "subprocess_stderr", summary: truncateLine(line), refs: { stream_kind: streamKind, ...(wasTruncated ? { truncated: "true" } : {}) } })`.
  - `appendSubprocessOutputTruncated({ sessionId, streamKind, droppedCount })` → `appendRaw({ session_id: sessionId, agent, role, event: "subprocess_output_truncated", summary: \`Dropped \${droppedCount} \${streamKind} lines (per-stream cap reached)\`, refs: { stream_kind: streamKind, dropped_count: String(droppedCount) } })`.
  - `appendRaw(input)` → `fetch(\`\${serverUrl}/activity\`, { method: "POST", headers: { "Content-Type": "application/json", "X-Keni-Role": role, "X-Keni-Agent": agentId }, body: JSON.stringify(input) })`. On 2xx: discard the response body. On non-2xx: parse the envelope, throw `RoleRuntimeHttpError`. On `fetch` rejection: throw `RoleRuntimeHttpError("internal_error", ...)`.
- [x] 6.3 Implement client-side line truncation (`truncateLine(line)`): when the line exceeds `SUMMARY_HARD_CAP_BYTES` byte length (UTF-8 encoded via `new TextEncoder()`), truncate to `SUMMARY_HARD_CAP_BYTES - <marker length>` bytes and append the marker. Round down to a UTF-8 boundary so the marker is appended cleanly.
- [x] 6.4 Create `packages/role-runtimes/src/common/activityClient_test.ts` against a `Deno.serve`-backed mock server (port 0) covering:
  - Each typed method composes the right URL (`POST /activity`) and headers (`X-Keni-Role`, `X-Keni-Agent`, `Content-Type`).
  - Each method's request body has the documented `event` value; `session_end` carries `refs.exit_code` and (when supplied) `refs.terminated_by`; `subprocess_stdout` carries `refs.stream_kind: "stdout"`.
  - A 2xx response unwraps cleanly; the method resolves with `void`.
  - A non-2xx response (e.g., 422 `invalid_artifact`) throws `RoleRuntimeHttpError` with the right `code`, `httpStatus`, `details`.
  - A network failure (mock server killed mid-call) throws `RoleRuntimeHttpError("internal_error", <message naming the URL>, ..., 0)`.
  - A 5 KB single line is truncated by `appendSubprocessOutput`: the request body's `summary` is at most 3 KB plus the marker; the marker substring `[truncated` is present.
  - A multi-byte UTF-8 character at the truncation boundary is not split (the truncation rounds down to a boundary).
- [x] 6.5 Verify: `deno test -A packages/role-runtimes/src/common/activityClient_test.ts` exits 0; `deno task check` exits 0.

## 7. Coding-agent invoker — `packages/role-runtimes/src/common/codingAgentInvoker.ts`

- [x] 7.1 Create `packages/role-runtimes/src/common/codingAgentInvoker.ts` exporting:
  - The `CodingAgentInvoker` interface (re-exported from `types.ts` for ergonomics).
  - `interface SubprocessCodingAgentInvokerOpts { readonly cliBinary: string; readonly buildArgs: (invocation: CodingAgentInvocation, mcpConfigPath: string) => readonly string[]; readonly promptInjection: "stdin" | "arg"; readonly mcpConfigPathBuilder?: (invocation: CodingAgentInvocation) => Promise<string>; readonly graceMs?: number; readonly resumeFlag?: string; readonly envAllowlist?: readonly string[]; }`.
  - `function createSubprocessCodingAgentInvoker(opts: SubprocessCodingAgentInvokerOpts): CodingAgentInvoker` — implements `design.md` Decision 4:
    - Resolves the mcp-config path: when `opts.mcpConfigPathBuilder` is supplied, calls it; otherwise writes a JSON file under `Deno.makeTempDir({ prefix: "keni-mcp-" })` containing the documented `{ mcpServers: { keni: invocation.mcpServerConfig } }` shape.
    - Builds the `Deno.Command` from `opts.cliBinary` and the result of `opts.buildArgs(invocation, mcpConfigPath)`. When `opts.promptInjection === "stdin"`, the args do not need to include the prompt; when `"arg"`, the args are expected to have already incorporated the prompt (typical via `buildArgs`).
    - Configures `stdin: opts.promptInjection === "stdin" ? "piped" : "null"`, `stdout: "piped"`, `stderr: "piped"`.
    - Builds env via `buildChildEnv(opts.envAllowlist ?? [], { KENI_MCP_AGENT: invocation.agentId, KENI_MCP_SERVER_URL: <derived from mcpServerConfig if not present elsewhere>, ...(invocation.workspacePath ? { KENI_MCP_WORKSPACE: invocation.workspacePath } : {}) })`. (The `KENI_MCP_SERVER_URL` derivation is documented; the prototype reads it from `invocation.mcpServerConfig.env?.KENI_MCP_SERVER_URL` or falls back to a sentinel; the integration test passes it explicitly.)
    - Spawns the child via `command.spawn()`. Calls `lifecycle.onSpawn?.({ pid: child.pid })`.
    - When `promptInjection === "stdin"`: writes `invocation.promptBody` to `child.stdin`, closes stdin.
    - Concurrently: `readLines(child.stdout, lifecycle.onStdoutLine, ...)` and `readLines(child.stderr, lifecycle.onStderrLine, ...)`.
    - Wires `lifecycle.abortSignal?.addEventListener("abort", () => terminate(child, { graceMs: opts.graceMs ?? 5000 }).then(...).catch(...))` — captures the eventual `SubprocessTerminateResult` and uses it to construct the `CodingAgentOutcome` returned from `invoke`.
    - Awaits `child.status`; resolves with `{ kind: terminated ? "terminated" : "completed", exitCode, terminatedBy }`.
    - `try`/`finally` removes the mcp-config temp file (when the factory wrote it).
    - Throws synchronously on `Deno.Command.spawn()` failure (e.g., binary not found); the cycle catches and surfaces as `spawn_failed`.
- [x] 7.2 Create the test fixture `packages/role-runtimes/tests/fixtures/fake-coding-agent.ts` — a tiny Deno script that:
  - Reads `KENI_FAKE_AGENT_LINES` (default 0), `KENI_FAKE_AGENT_SUMMARY` (default `"placeholder summary"`), `KENI_FAKE_AGENT_EXIT_CODE` (default 0), `KENI_FAKE_AGENT_SLEEP_MS` (default 0), `KENI_FAKE_AGENT_STDERR_LINES` (default 0).
  - Optionally reads its prompt from stdin (drains and discards; the fixture asserts that the prompt is non-empty when `KENI_FAKE_AGENT_REQUIRE_PROMPT=1`).
  - Sleeps for `SLEEP_MS` ms (interruptible — the fixture installs a SIGTERM handler that exits with code 143).
  - Prints `LINES` lines to stdout (e.g., `"line N"` per line).
  - Prints `STDERR_LINES` lines to stderr.
  - Prints the summary line as the final stdout line.
  - Exits with `EXIT_CODE`.
  - Handles SIGTERM by exiting cleanly with code 143 within ~50 ms.
- [x] 7.3 Create `packages/role-runtimes/src/common/codingAgentInvoker_test.ts` covering (using the fixture):
  - **Happy path.** `cliBinary: Deno.execPath()`, `buildArgs: () => ["run", "-A", <fixture path>]`, `promptInjection: "stdin"`, `KENI_FAKE_AGENT_LINES=2`, summary `"hello"`. Lifecycle records two `onStdoutLine` calls (`"line 0"`, `"line 1"` plus the summary as the last); the invoker resolves with `{ kind: "completed", exitCode: 0 }`.
  - **Stderr lines.** `KENI_FAKE_AGENT_STDERR_LINES=1`. Lifecycle records one `onStderrLine` call.
  - **Missing binary.** `cliBinary: "/no/such/binary"`. `invoke` rejects synchronously with an `Error` whose message names the missing binary.
  - **Abort signal.** Fixture sleeps 30 s. The test fires `controller.abort()` after 100 ms; the invoker resolves with `{ kind: "terminated", terminatedBy: "sigterm", exitCode: 143 }`.
  - **MCP-config temp file cleanup.** Capture the temp path from a custom `mcpConfigPathBuilder` (or by listing the temp dir before / after); after the invoker resolves, the file does not exist.
  - **`promptInjection: "stdin"` writes the prompt.** The fixture asserts the prompt is non-empty (via `KENI_FAKE_AGENT_REQUIRE_PROMPT=1`); the invoker call resolves cleanly.
- [x] 7.4 Verify: `deno test -A packages/role-runtimes/src/common/codingAgentInvoker_test.ts` exits 0; `deno task check` exits 0.

## 8. Fake invoker (test-only) — `packages/role-runtimes/src/common/fakes/fakeCodingAgentInvoker.ts`

- [x] 8.1 Create `packages/role-runtimes/src/common/fakes/fakeCodingAgentInvoker.ts` exporting `createFakeCodingAgentInvoker(opts: FakeOpts): { invoker: CodingAgentInvoker; capturedInvocation: () => CodingAgentInvocation | null; pushStdoutLine: (line: string) => Promise<void>; pushStderrLine: (line: string) => Promise<void>; resolveCompleted: (exitCode: number) => void; resolveTerminated: (exitCode: number, terminatedBy: "sigterm" | "sigkill") => void; throwOnInvoke: (err: Error) => void; }`. The fake records the invocation, exposes line-pushing helpers (which call the lifecycle's `onStdoutLine` / `onStderrLine`), and lets the test resolve the outcome explicitly. A "throw on invoke" mode covers the spawn-failure scenario.
- [x] 8.2 Create a tiny `fakeCodingAgentInvoker_test.ts` smoke test asserting the fake itself: pushing lines invokes the lifecycle callbacks; resolving completed yields the right outcome; throw-on-invoke surfaces on the next `invoke` call.
- [x] 8.3 Verify: `deno test -A packages/role-runtimes/src/common/fakes/` exits 0; `deno task check` exits 0.

## 9. The cycle — `packages/role-runtimes/src/common/startCycle.ts`

- [x] 9.1 Create `packages/role-runtimes/src/common/startCycle.ts` exporting `async function startCycle(params: RoleCycleParams): Promise<RoleCycleResult>`. Implements the seven-step algorithm from `spec.md` §6.2 / `design.md` Decision 2 / the `role-runtime` capability spec:
  - **Step 1.** `const prepCtx: CyclePrepCtx = { role, agentId, projectName, workspacePath: workspacePath ?? null, serverUrl };` then `const precheck = await params.precheck(prepCtx);`. If `precheck.kind === "skip"`, return `{ outcome: "precheck_skipped", reason: precheck.reason };`.
  - **Step 2.** `const sessionId = generateSessionIdV7();` (use `@std/uuid/v7`'s `generate`). Construct `activity = createActivityLogClient({ serverUrl, agentId, role });`. Build `sessionStartRefs` including `resume_session_id` when `params.resumeSessionId` is supplied. Validate `params.resumeSessionId` (when present) is a non-empty string; throw `RoleRuntimeError("invalid_resume_session_id", ...)` otherwise. Call `await activity.appendSessionStart({ sessionId, summary: precheck.roleContext?.summary ?? null, refs: sessionStartRefs });`. Wrap the entire post-precheck block in `try`/`catch`: a throw from any subsequent step causes the cycle to attempt a final `appendSessionEnd` with `refs.spawn_failed: true` (when applicable) before returning `spawn_failed`.
  - **Step 3.** `const prompt = resolveBundledPrompt(params.promptResolver(prepCtx), params.expectedPromptName);`. (Throws are caught by the surrounding `try`/`catch`.)
  - **Step 4.** Build the invocation: `const invocation: CodingAgentInvocation = { promptBody: prompt.body, role, agentId, projectName, workspacePath: params.workspacePath ?? null, mcpServerConfig: params.mcpServerConfig, resumeSessionId: params.resumeSessionId ?? null, envAllowlist: params.envAllowlist ?? [] };`.
  - **Step 5.** Build buffers: `const stdoutBuffer: string[] = []; const stderrBuffer: string[] = []; let stdoutEmittedCount = 0; let stderrEmittedCount = 0;` (the buffer is unbounded for summary extraction; the emitted count enforces `maxLinesPerStream`). Build the lifecycle bag: `onStdoutLine` pushes to `stdoutBuffer` *and* (when `stdoutEmittedCount < maxLinesPerStream`) calls `activity.appendSubprocessOutput({ sessionId, streamKind: "stdout", line })` then increments `stdoutEmittedCount`; on the line that crosses the cap, calls `activity.appendSubprocessOutputTruncated(...)` once and stops emitting further lines for stdout. `onStderrLine` is symmetric. `abortSignal: params.signal`. Track `cycleStartTime = performance.now()`; set `cycleEndTime = performance.now()` immediately after the invoker resolves. Wrap `params.codingAgentInvoker.invoke(invocation, lifecycle)` in `try`/`catch` so a synchronous throw is treated as `spawn_failed`.
  - **Step 6.** Compute `wallTimeMs = cycleEndTime - cycleStartTime;`. If `outcome.kind === "completed" && outcome.exitCode === 0 && wallTimeMs < (params.idleThresholdMs ?? 250) && stdoutBuffer.every(line => line.trimEnd() === "")`, call `await activity.appendIdle({ sessionId });` and return `{ outcome: "idle", sessionId };`.
  - **Step 7.** Otherwise, extract `const summary = extractSummaryLine(stdoutBuffer);`, build `sessionEndRefs = { exit_code: String(outcome.exitCode), ...(outcome.kind === "terminated" ? { terminated_by: outcome.terminatedBy } : {}) }`, call `await activity.appendSessionEnd({ sessionId, exitCode: outcome.exitCode, summary, terminatedBy: outcome.kind === "terminated" ? outcome.terminatedBy : undefined, refs: sessionEndRefs });`. Return `{ outcome: outcome.kind === "terminated" ? "terminated" : "completed", sessionId, exitCode: outcome.exitCode, ...(outcome.kind === "terminated" ? { terminatedBy: outcome.terminatedBy } : { summary }) };`.
  - On a caught throw inside the post-`session_start` block: try to call `activity.appendSessionEnd({ sessionId, exitCode: -1, summary: null, refs: { spawn_failed: "true", exit_code: "-1" } })` (best-effort; if this also fails, swallow). Return `{ outcome: "spawn_failed", sessionId, error: <wrapped Error> }`.
- [x] 9.2 Create `packages/role-runtimes/src/common/startCycle_test.ts` against the fake invoker (step 8) and a fake activity-log client (a small in-memory test double). Cover every outcome from the capability spec's "five outcomes" requirement:
  - **Completed.** Push 5 lines, resolve completed with exit code 0; assert the result and the activity-log client's call sequence (`appendSessionStart`, 5× `appendSubprocessOutput`, `appendSessionEnd`).
  - **Idle.** Resolve completed with exit code 0 within 50 ms (use `vi.useFakeTimers`-equivalent — actually since we expose `idleThresholdMs`, the test sets a high threshold and the fake invoker resolves quickly); assert `appendSessionStart`, `appendIdle`, no `appendSessionEnd`.
  - **Precheck skipped.** Precheck returns `{ kind: "skip", reason: "no_work" }`; assert no activity-log calls were made and the result is `{ outcome: "precheck_skipped", reason: "no_work" }`.
  - **Terminated.** Resolve terminated with `terminatedBy: "sigterm", exitCode: 143`; assert `appendSessionEnd` with `refs.terminated_by: "sigterm"`.
  - **Spawn failed.** Configure the fake invoker to throw on invoke; assert `{ outcome: "spawn_failed", sessionId, error }` and a final `appendSessionEnd` with `refs.spawn_failed: "true"`.
  - **Resume id plumbed.** Pass `resumeSessionId: "abc"`; assert the invoker's captured invocation has `resumeSessionId: "abc"` and the `appendSessionStart` call's `refs` include `resume_session_id: "abc"`.
  - **Empty resumeSessionId rejected.** Pass `resumeSessionId: ""`; assert the result is `{ outcome: "spawn_failed", ..., error }` whose error names the validation rule.
  - **Per-stream cap.** Push 1500 stdout lines via the fake invoker (each `pushStdoutLine` call returns a promise); assert the activity-log client received exactly 1000 `appendSubprocessOutput` calls plus exactly one `appendSubprocessOutputTruncated` call with `droppedCount: 500`. The summary extracted is the actual 1500th line (genuine last non-empty line).
  - **No mutation of params.** Call `startCycle(params)` twice with the same `params` object; assert the object is structurally identical between calls (use deep equality and / or capture key properties).
- [x] 9.3 Verify: `deno test -A packages/role-runtimes/src/common/startCycle_test.ts` exits 0; `deno task check` exits 0.

## 10. Main barrel — `packages/role-runtimes/src/main.ts`

- [x] 10.1 Modify `packages/role-runtimes/src/main.ts` (currently the one-line `export const packageName = "@keni/role-runtimes";` stub) to additionally export the public surface:
  - `export { startCycle } from "./common/startCycle.ts";`
  - `export type { RoleCycleParams, RoleCycleResult, CodingAgentInvocation, CodingAgentLifecycle, CodingAgentOutcome, CodingAgentInvoker, BundledPrompt, McpServerConfig, CyclePrepCtx, PrecheckResult } from "./common/types.ts";`
  - `export { createSubprocessCodingAgentInvoker } from "./common/codingAgentInvoker.ts";`
  - `export type { SubprocessCodingAgentInvokerOpts } from "./common/codingAgentInvoker.ts";`
  - `export { resolveBundledPrompt } from "./common/promptResolver.ts";`
  - `export { RoleRuntimeError, RoleRuntimeHttpError } from "./common/types.ts";`
  - Preserve the `export const packageName = "@keni/role-runtimes";` line verbatim.
- [x] 10.2 Modify `packages/role-runtimes/src/main_test.ts` (currently a one-line presence test) to additionally assert that every named export resolves and is the right runtime kind: `typeof startCycle === "function"`, `typeof createSubprocessCodingAgentInvoker === "function"`, `typeof resolveBundledPrompt === "function"`, `RoleRuntimeError.prototype instanceof Error`, `RoleRuntimeHttpError.prototype instanceof Error`. Preserve the existing `packageName` assertion.
- [x] 10.3 Verify: `deno test -A packages/role-runtimes/src/main_test.ts` exits 0; `deno task check` exits 0; `deno task lint` exits 0.

## 11. End-to-end integration test — `integration_test.ts`

- [x] 11.1 Create `packages/role-runtimes/src/common/integration_test.ts`. Set up helpers (one per test or a shared `setup()` returning a teardown closure):
  - Provision a `Deno.makeTempDir({ prefix: "keni-rr-it-" })` project root.
  - Run the existing `keni init` helper (or the route-test helper used in step 06's integration test) to produce `.keni/project.yaml` with `agents: [{ id: "alice", role: "engineer" }]`.
  - Start the orchestration server via `startServer({ project: <root>, port: 0 })`; capture the `url`.
  - Make a sibling `Deno.makeTempDir({ prefix: "keni-rr-it-ws-" })` to act as the engineer's workspace.
  - Build a `CodingAgentInvoker` via `createSubprocessCodingAgentInvoker({ cliBinary: Deno.execPath(), buildArgs: (_inv, _mcp) => ["run", "-A", <fixture path>], promptInjection: "stdin", graceMs: 1000 })`.
  - Build `RoleCycleParams` with `role: "engineer"`, `agentId: "alice" as AgentId`, `serverUrl: <captured url>`, `projectName: "test"`, `workspacePath: <ws dir>`, `mcpServerConfig: { command: "deno", args: ["run", "-A", "packages/server/src/mcp/main.ts", "--agent=alice", "--server-url=" + url, "--workspace=" + wsDir] }`, `precheck: () => ({ kind: "proceed" })`, `promptResolver: () => ({ name: "placeholder", body: PLACEHOLDER_PROMPT_BODY })`.
- [x] 11.2 Implement the documented test cases (one assertion per test, named for the spec scenario):
  - **`happy-path cycle gains the documented activity entries on disk`** — fixture configured for 5 stdout lines + summary `"happy summary"` + exit 0. Invoke `startCycle(params)`. Assert `result === { outcome: "completed", sessionId, exitCode: 0, summary: "happy summary" }`. Read the on-disk activity log file `.keni/activity/<UTC date>.jsonl` and assert exactly seven lines for this `session_id` in the documented order. (Implementation note: the fixture appends one summary line on top of `LINES` content lines, so `LINES=4` produces 5 stdout lines total, matching the spec.)
  - **`idle cycle gains exactly two activity entries`** — fixture configured for 0 lines, sleep 0 ms, exit 0. Assert `result.outcome === "idle"`. Assert the on-disk file gained exactly `session_start` and `idle` for this `session_id`.
  - **`graceful termination produces session_end with terminated_by: sigterm`** — fixture configured for sleep 30 000 ms. Pass `signal: <AbortController().signal>`. After 100 ms, fire `abort()`. Assert `result.outcome === "terminated"`, `result.terminatedBy === "sigterm"`. Assert the on-disk `session_end` line carries `refs.terminated_by: "sigterm"`.
- [x] 11.3 Implement teardown for every test: stop the orchestration server (`abort()`), wait for shutdown, remove the temp dirs (`Deno.remove(rootDir, { recursive: true })`, `Deno.remove(wsDir, { recursive: true })`). Wrap setup/teardown in a `using` block or an `afterEach`-style helper so a failure halfway through does not leak processes or directories.
- [x] 11.4 Add a "no `.keni/` reads" structural assertion: a test that walks `packages/role-runtimes/src/common/` (excluding `*_test.ts`, `tests/fixtures/`) and asserts no occurrence of `Deno.readTextFile`, `Deno.readFile`, or any path literal starting with `.keni/` or `~/.keni/`. Filesystem writes are permitted only when paired with a `Deno.makeTempFile` (the default invoker's mcp-config tempfile per Decision 4); the spec scenario was relaxed during implementation (see `specs/role-runtime/spec.md` "no `.keni/` reads or writes" scenario). Comments are stripped before scanning so doc-comments referencing `.keni/` do not trigger false positives. Mirrors the analogous test in step 06's `mcp/integration_test.ts`.
- [x] 11.5 Add a "no role-keyed conditionals" structural assertion: walk the same source files; assert no occurrence of `=== "engineer"`, `=== "qa"`, `=== "po"`, `=== "writer"`, `=== "user"` in production source (test fixtures may use them). Pins the engineer/QA/PO-agnostic invariant.
- [x] 11.6 Add a "no MCP SDK import" structural assertion: walk the same source files; assert no occurrence of `@modelcontextprotocol/sdk`. Pins the dependency invariant.
- [x] 11.7 Verify: `deno test -A packages/role-runtimes/src/common/integration_test.ts` exits 0 with all tests passing.

## 12. Documentation

- [x] 12.1 Update root `README.md`. Add a paragraph in the architecture section (or near the existing "Run the orchestration server" / "Run the engineer MCP server" subsections) titled "Role runtimes (common)". Document: the role-runtime layer's purpose (`spec.md` §6.2 cycle algorithm), the package location (`packages/role-runtimes/src/common/`), the four invariants (single cycle, stateless across cycles, activity-log only via `POST /activity`, role-agnostic), and the fact that step 09 (engineer specialisation) is the first concrete consumer.
- [x] 12.2 Update root `README.md` "Repository layout" subsection: amend the `packages/role-runtimes/` description to mention the new `common/` subdirectory: `# @keni/role-runtimes — common cycle wrapper plus per-role specialisations (engineer/QA/PO).`
- [x] 12.3 Verify no changes were made to `initial-implementation-plan/`: `git status --short -- initial-implementation-plan/` and `git diff --name-only -- initial-implementation-plan/` are both empty.

## 13. Capability-spec verification (the spec walk)

- [x] 13.1 Walk every requirement in `openspec/changes/role-runtime-common/specs/role-runtime/spec.md` and map each scenario to the test (or structural artefact) that satisfies it. Record the table at the bottom of this file under "Spec walk verification" (mirror the format `mcp-server-for-engineers/tasks.md` used).
- [x] 13.2 Drift check — outcome shape: temporarily comment out one branch of the `RoleCycleResult` discriminated union (e.g., remove `terminated`). Run `deno task check`. Confirm the check fails because consumers no longer have the union shape they import. Revert. **Verified — `deno task check` reported 10 errors across `startCycle.ts`, `startCycle_test.ts`, and `types_test.ts` (TS2367, TS2339, TS2344, TS2322, TS2678) when the `terminated` variant was deleted; reverted clean.**
- [x] 13.3 Drift check — empty prompt: temporarily change a test's `BundledPrompt` to `{ name: "x", body: "" }` and run `deno test -A packages/role-runtimes/src/common/promptResolver_test.ts`. Confirm `RoleRuntimeError("empty_prompt_body", ...)` is thrown. Revert. **Verified — the "valid prompt is returned verbatim" test failed with `RoleRuntimeError: Prompt "engineer" has an empty body — bundled prompts must be non-empty TS string constants.`; reverted clean.**
- [x] 13.4 Drift check — role-keyed conditional: temporarily add `if (params.role === "engineer") { /* noop */ }` to `startCycle.ts`. Run the structural test from 11.5. Confirm it fails. Revert. **Verified — `structural — packages/role-runtimes/src/common/ has no role-keyed conditionals` failed with `startCycle.ts: contains forbidden role-keyed conditional ` `=== "engineer"` `; reverted clean.**
- [x] 13.5 Drift check — MCP SDK import: temporarily add `import "@modelcontextprotocol/sdk/server/mcp.js";` (a no-op import) to `startCycle.ts`. Run the structural test from 11.6. Confirm it fails. Revert. **Verified — `structural — packages/role-runtimes/src/common/ does not import the MCP SDK` failed with `startCycle.ts: imports forbidden ` `@modelcontextprotocol/sdk` `; reverted clean.**

## 14. End-to-end verification

- [x] 14.1 `deno install --frozen` exits 0 — no new deps were added; the lockfile is reproducible.
- [x] 14.2 `deno task fmt:check` exits 0.
- [x] 14.3 `deno task lint` exits 0.
- [x] 14.4 `deno task check` exits 0 across the workspace — every new type's annotation type-checks; `RoleCycleResult`'s union type-narrows correctly under `verbatimModuleSyntax`.
- [x] 14.5 `deno task test` exits 0 with the new tests counted in (record the post-state test count and the delta against the post-step-06 baseline captured in 1.2). The runtime contributes ~6 unit-test files (~40 tests) plus 1 integration-test file (~6 tests) — expected delta ~46 tests. **Post-state: 728 passed (delta +75 over the 653 baseline). The runtime contributes more tests than originally estimated because each spec scenario maps to a dedicated single-assertion test.**
- [x] 14.6 End-to-end smoke verified: hand-rolled smoke that runs `startCycle` against a fresh `mktemp -d` project, the orchestration server launched via `deno run -A packages/server/src/main.ts --project <tempDir> --port 0`, and the fixture script as the "coding agent". The smoke prints the `RoleCycleResult` and asserts the on-disk activity log gained the documented entries. Capture the transcript under "End-to-end smoke transcript". **Smoke passed; transcript captured below.**

## 15. CI and hand-off

- [x] 15.1 Local CI dry-run all green: `deno install --frozen`, `deno task fmt:check`, `deno task lint`, `deno task check`, `deno task test`. All exit 0. **728 passed (+75 over the 653 baseline).**
- [x] 15.2 `git status --short` matches the documented file set:
  - **Added** files: `openspec/changes/role-runtime-common/{proposal,design,tasks}.md`, `openspec/changes/role-runtime-common/.openspec.yaml`, `openspec/changes/role-runtime-common/specs/role-runtime/spec.md`; under `packages/role-runtimes/src/common/`: `types.ts`, `types_test.ts`, `summaryLine.ts`, `summaryLine_test.ts`, `promptResolver.ts`, `promptResolver_test.ts`, `prompts/placeholder.ts`, `subprocess.ts`, `subprocess_test.ts`, `activityClient.ts`, `activityClient_test.ts`, `codingAgentInvoker.ts`, `codingAgentInvoker_test.ts`, `fakes/fakeCodingAgentInvoker.ts`, `fakes/fakeCodingAgentInvoker_test.ts`, `startCycle.ts`, `startCycle_test.ts`, `integration_test.ts`; under `packages/role-runtimes/tests/fixtures/`: `fake-coding-agent.ts`.
  - **Modified**: `packages/role-runtimes/src/main.ts` (extended barrel), `packages/role-runtimes/src/main_test.ts` (extended presence test), `README.md` (two amended subsections).
- [x] 15.3 `openspec validate role-runtime-common` reports `Change 'role-runtime-common' is valid`.
- [x] 15.4 `openspec status --change role-runtime-common --json` reports `"isComplete": true` with all four artifacts (`proposal`, `design`, `specs`, `tasks`) at `"status": "done"`.
- [x] 15.5 `git status --short -- initial-implementation-plan/` and `git diff --name-only -- initial-implementation-plan/` are both empty — this change is strictly additive on top of the plan input.
- [x] 15.6 Record the hand-off block at the bottom of this file (see "Hand-off to downstream steps"). The hand-off authored during 13.1 covers steps 08, 09, 13, 17, 18, 19, and 26.

## Hand-off to downstream steps

### What downstream steps inherit from this change

**Step 08 (cron scheduler).** The scheduler is the *invoker* of the cycle. It inherits:

- `startCycle(params)` — called once per scheduler tick per non-paused agent. The scheduler reads `paused` from the agents API, builds `RoleCycleParams` from project config + agent roster + the running orchestration server's URL + the role's precheck (provided by the role's `RoleSpec` from step 09 / 17), and invokes the cycle. The scheduler does *not* re-implement subprocess lifecycle or activity-log emission.
- `RoleCycleResult` — the scheduler `switch`es on `outcome` to decide telemetry, retry, or back-off. A `precheck_skipped` is the no-cost happy path; `idle` increments a per-agent "consecutive idles" counter; `terminated` may schedule a follow-up `session_interrupted` activity entry; `spawn_failed` triggers an alert.
- `AbortSignal` plumbing — the scheduler creates an `AbortController` per cycle and fires `abort()` after the per-role timeout (default tens of minutes per `spec.md` §7.5). The cycle's graceful-termination procedure handles the rest.
- `agent.state_changed` events for free — the cycle emits the right activity events; the orchestration server's `applyActivityEvent` flips the agent's runtime state and broadcasts.

**Step 09 (engineer specialisation + workspace + prompt).** The engineer specialisation owns engineer specifics. It inherits:

- The cycle's parameter bag — the engineer plugs in a precheck (`is there a ticket I can pick up?`), a prompt resolver (returns `{ name: "engineer", body: ENGINEER_PROMPT }` from a new `packages/role-runtimes/src/engineer/prompt.ts`), a workspace path (from the engineer's workspace-provisioning logic), and an `mcpServerConfig` matching step 06's MCP server.
- The default subprocess invoker — the engineer configures it with `cliBinary: <from project config>`, `buildArgs: (inv, mcp) => ["--mcp-config", mcp, ...]` (the exact shape depends on the chosen CLI; `claude` and `cursor-agent` both accept `--mcp-config`).
- The "no `.keni/` reads from the runtime" structural assertion — engineer code in `packages/role-runtimes/src/engineer/` is added to the structural test's scan list.
- The `expectedPromptName: "engineer"` defence-in-depth — wires the engineer cycle to fail loudly if the wrong prompt is plugged in.

**Step 13 (`keni start`).** Unchanged. The cycle is invoked by the scheduler (step 08), not by `keni start`. The CLI launches the orchestration server; the scheduler runs in the same process; the cycle is the inner-loop.

**Step 17 (PO mode selection).** The PO runtime layers the four-mode arbiter into the precheck:

- The precheck inspects the conversation-to-CR queue / CR statuses / ticket statuses on every tick (via `GET /tickets`, `GET /activity`, etc.) and returns either `{ kind: "skip", reason: "no_mode_applicable" }` or `{ kind: "proceed", roleContext: { mode: "verify_and_fold" | "cr_to_tickets" | "conversation_to_cr" | "chat", ... } }`.
- The prompt resolver picks the bundled prompt for the chosen mode (one of the four PO prompts shipped in step 18).
- Zero changes to `startCycle`'s shape — mode selection is encapsulated entirely in the precheck and prompt resolver.
- "Atomic post-subprocess commit" (the verify-and-fold mode's atomic file moves) is *not* the cycle's concern; the PO runtime in step 17 wraps `startCycle` with the post-subprocess commit logic.

**Step 18 (PO prompts bundle).** Lands the four PO prompts as TS string constants under `packages/role-runtimes/src/po/prompts/`. The structural assertion that prompts are TS constants only is preserved; the prompts module list is extended.

**Step 19 (PO chat-mode CLI proxy).** The chat handler consumes `resumeSessionId` end-to-end:

- Reads the active CLI session id from `state.json`.
- Invokes `startCycle(params)` with `params.resumeSessionId: <id>`.
- The cycle plumbs the id verbatim to the invoker, which adds `--resume <id>` to the args.
- The chat handler captures the agent's structured-output session id from the activity log's `session_end` entry (refs.cli_session_id, when the agent emits it) and persists it back to `state.json`.
- The cycle itself does not parse structured output — it just streams stdout / stderr to the activity log; the chat handler reads from there.

**Step 26 (multi-engineer).** Multi-engineer is a deployment change:

- The cycle is stateless; concurrent invocations against different `agentId` values are safe by construction.
- The orchestration server's request-level guards (status-graph + role-owner + storage atomicity from step 04) handle the cross-engineer race conditions.
- No changes to the cycle.

### What downstream steps must NOT do

- **Do not loop inside `startCycle`.** The cycle runs *one* cycle per invocation. Looping is the scheduler's job.
- **Do not introduce role-keyed conditionals in `packages/role-runtimes/src/common/`.** Every role-shaped concern is a parameter, not a code path. The structural test catches violations.
- **Do not read `.keni/` directly from any role runtime.** The cycle's activity-log adapter is the only legitimate write path; reads go through MCP for engineers (step 06) or through the orchestration server's REST surface for PO (step 16).
- **Do not import `@modelcontextprotocol/sdk` from `@keni/role-runtimes`.** The runtime is MCP-protocol-agnostic; the CLI talks MCP via its own subprocess (the MCP server from step 06).
- **Do not load prompts from any path under `.keni/` or `~/.keni/`.** Prompts ship with the binary as TS string constants.
- **Do not bypass the `RoleCycleResult` discriminated union.** Callers that need a richer result shape add fields to the existing variants via an additive OpenSpec change; they do not return raw values.
- **Do not assume MCP-server lifetime spans cycles.** The runtime's `mcpServerConfig` describes how to spawn an MCP server; the coding-agent CLI does the actual spawning per cycle. No cross-cycle state.

## Spec walk verification

One row per scenario in `specs/role-runtime/spec.md`. Test paths are relative to the repo root.

| Spec scenario | Test (or structural artefact) |
| --- | --- |
| `startCycle` runs the full happy-path cycle end-to-end | `packages/role-runtimes/src/common/startCycle_test.ts` — "completed: pushes 5 lines, resolves with summary" + `integration_test.ts` "happy-path cycle gains the documented activity entries on disk" |
| `startCycle` does not mutate the params bag | `packages/role-runtimes/src/common/startCycle_test.ts` — "no mutation of params" |
| `startCycle` returns one of the five documented outcomes — no others | `packages/role-runtimes/src/common/types_test.ts` — `RoleCycleResult` union exhaustiveness test |
| Public surface is reachable through `@keni/role-runtimes`'s main barrel | `packages/role-runtimes/src/main_test.ts` — "every named export resolves" |
| Precheck returns `skip` and the cycle short-circuits without any side effects | `packages/role-runtimes/src/common/startCycle_test.ts` — "precheck skipped: no activity-log calls" |
| Idle cycle emits `session_start` and `idle` only — no `session_end`, no `subprocess_stdout` | `packages/role-runtimes/src/common/startCycle_test.ts` — "idle: appendSessionStart + appendIdle, no appendSessionEnd" + `integration_test.ts` "idle cycle gains exactly two activity entries" |
| Completed cycle emits `session_start` + N `subprocess_stdout` + `session_end` in arrival order | `integration_test.ts` "happy-path cycle ..." |
| Terminated cycle emits `session_end` with `terminated_by: "sigterm"` | `packages/role-runtimes/src/common/startCycle_test.ts` — "terminated" + `integration_test.ts` "graceful termination produces session_end with terminated_by: sigterm" |
| Spawn failure produces a final `session_end` and `outcome: "spawn_failed"` | `packages/role-runtimes/src/common/startCycle_test.ts` — "spawn failed: final session_end with refs.spawn_failed: true" |
| Empty prompt body is rejected | `packages/role-runtimes/src/common/promptResolver_test.ts` — "empty body throws RoleRuntimeError" |
| Name mismatch is rejected when `expectedName` is supplied | `packages/role-runtimes/src/common/promptResolver_test.ts` — "name mismatch throws RoleRuntimeError" |
| Validated prompt is returned verbatim | `packages/role-runtimes/src/common/promptResolver_test.ts` — "valid prompt is returned verbatim" |
| Source code under `packages/role-runtimes/src/common/` contains no path-based prompt loader | `packages/role-runtimes/src/common/integration_test.ts` — structural "no `.keni/` reads from the runtime" |
| Every `POST /activity` carries the role and agent headers | `packages/role-runtimes/src/common/activityClient_test.ts` — "headers stamped on every method" |
| Source code under `packages/role-runtimes/src/common/` contains no `.keni/` reads | `packages/role-runtimes/src/common/integration_test.ts` — structural "no `.keni/` reads from the runtime" |
| A non-2xx response surfaces as `RoleRuntimeHttpError` | `packages/role-runtimes/src/common/activityClient_test.ts` — "non-2xx throws RoleRuntimeHttpError" |
| A network-level failure surfaces as `internal_error` naming the URL | `packages/role-runtimes/src/common/activityClient_test.ts` — "network failure throws RoleRuntimeHttpError(internal_error, ...)" |
| Two stdout lines produce two `subprocess_stdout` entries in arrival order | `packages/role-runtimes/src/common/startCycle_test.ts` — "completed" + `integration_test.ts` "happy-path cycle ..." |
| An empty line is skipped | `packages/role-runtimes/src/common/subprocess_test.ts` — "readLines skips empty lines" |
| A 5 KB single line is truncated to ~3 KB plus a truncation marker | `packages/role-runtimes/src/common/activityClient_test.ts` — "5 KB line truncated with marker" |
| A 1500-line stdout cycle truncates emission to 1000 plus a `subprocess_output_truncated` entry | `packages/role-runtimes/src/common/startCycle_test.ts` — "per-stream cap" |
| stderr lines emit `subprocess_stderr` entries — independent of stdout | `packages/role-runtimes/src/common/codingAgentInvoker_test.ts` — "stderr lines" + activity-log adapter test |
| Last non-empty line wins | `packages/role-runtimes/src/common/summaryLine_test.ts` — "last non-empty line wins" |
| Trailing whitespace lines are skipped | `packages/role-runtimes/src/common/summaryLine_test.ts` — "trailing whitespace skipped" |
| All-empty buffer returns `null` | `packages/role-runtimes/src/common/summaryLine_test.ts` — "all-empty buffer returns null" |
| Stderr lines do not contribute to summary | `packages/role-runtimes/src/common/startCycle_test.ts` — "stderr does not contribute to summary" |
| SIGTERM exit before grace expires returns `terminatedBy: "sigterm"` | `packages/role-runtimes/src/common/subprocess_test.ts` — "graceful SIGTERM" |
| SIGTERM ignored, SIGKILL after grace, returns `terminatedBy: "sigkill"` | `packages/role-runtimes/src/common/subprocess_test.ts` — "SIGKILL after grace" |
| Already-exited child returns `terminatedBy: "exit"` | `packages/role-runtimes/src/common/subprocess_test.ts` — "already-exited child" |
| Windows path emits the documented warning and goes direct to kill | Documented in `subprocess.ts` source (CI does not run Windows) |
| Empty allowlist gives the child only the runtime-mandated variables | `packages/role-runtimes/src/common/subprocess_test.ts` — "buildChildEnv allowlist" |
| Allowlisted variable is forwarded when set on the host | `packages/role-runtimes/src/common/subprocess_test.ts` — "buildChildEnv allowlist" |
| Allowlisted-but-unset variable is omitted | `packages/role-runtimes/src/common/subprocess_test.ts` — "buildChildEnv allowlist" |
| Default factory produces an invoker that runs an actual subprocess and emits stdout lines | `packages/role-runtimes/src/common/codingAgentInvoker_test.ts` — "happy path" |
| Invoker throws on missing binary; cycle surfaces as `spawn_failed` | `packages/role-runtimes/src/common/codingAgentInvoker_test.ts` — "missing binary" |
| AbortSignal during spawn triggers graceful termination | `packages/role-runtimes/src/common/codingAgentInvoker_test.ts` — "abort signal" |
| MCP-config temp file is cleaned up on cycle exit | `packages/role-runtimes/src/common/codingAgentInvoker_test.ts` — "MCP-config temp file cleanup" |
| Resume flag is injected when `resumeSessionId` is present | `packages/role-runtimes/src/common/startCycle_test.ts` — "resume id plumbed" + `codingAgentInvoker_test.ts` |
| Resume id appears in the `session_start` activity entry's refs | `packages/role-runtimes/src/common/startCycle_test.ts` — "resume id plumbed" |
| No resume id ⇒ no flag and no ref | `packages/role-runtimes/src/common/startCycle_test.ts` — "no resume id" |
| Empty-string resume id is rejected at the cycle boundary | `packages/role-runtimes/src/common/startCycle_test.ts` — "empty resumeSessionId rejected" |
| Completed shape is exhaustive | `packages/role-runtimes/src/common/types_test.ts` — type-level assertion |
| Idle shape carries `sessionId` but no `exitCode` | `packages/role-runtimes/src/common/types_test.ts` — type-level assertion |
| `precheck_skipped` carries no session id | `packages/role-runtimes/src/common/types_test.ts` — type-level assertion |
| Exhaustive switch type-checks | `packages/role-runtimes/src/common/types_test.ts` — type-level assertion + `deno task check` step 14.4 |
| Happy-path cycle gains the documented activity entries on disk | `integration_test.ts` "happy-path cycle ..." |
| Idle cycle gains exactly two activity entries | `integration_test.ts` "idle cycle ..." |
| Graceful termination produces a `session_end` with `terminated_by: "sigterm"` | `integration_test.ts` "graceful termination ..." |
| Test cleanup is deterministic | `integration_test.ts` teardown helper |
| `deno.json` is unchanged by this change | step 15.2 `git status --short` + step 14.1 `deno install --frozen` |
| The package does not import the MCP SDK | `integration_test.ts` structural "no MCP SDK import" |
| Source contains no role-keyed conditional logic | `integration_test.ts` structural "no role-keyed conditionals" |
| Same cycle code path runs for any role | `packages/role-runtimes/src/common/startCycle_test.ts` — runs the same fake invoker with `role: "engineer"` and `role: "po"`; assert identical call patterns |
| Documentation names the in-process / stateless / single-cycle invariants | step 12.1 README amendment |
| The runtime's `session_id` is distinct from the resumed CLI session id | `packages/role-runtimes/src/common/startCycle_test.ts` — "resume id plumbed" (asserts `result.sessionId !== params.resumeSessionId`) |

## End-to-end smoke transcript

Hand-rolled smoke from task 14.6: a temporary script at the workspace root
(`./.role-runtime-smoke.ts`, deleted after the run) which spawned
`packages/server/src/main.ts` as a real `deno run` subprocess against a
`Deno.makeTempDir()` project root, then invoked `startCycle(...)` with the
fake-coding-agent fixture as the "coding agent" via the default subprocess
invoker. Configuration: `KENI_FAKE_AGENT_LINES=4` (4 content lines + 1
summary line ⇒ 5 stdout lines), `KENI_FAKE_AGENT_SUMMARY="smoke summary"`,
exit code 0. Output:

```
# project: /var/folders/.../keni-rr-smoke-ca2699394f300982
# home:    /var/folders/.../keni-rr-smoke-home-64e9410675e498df
# ws:      /var/folders/.../keni-rr-smoke-ws-ebe2db2593d784f
# server: http://127.0.0.1:55856
# invoking startCycle(...)
# result: {
  "outcome": "completed",
  "sessionId": "019ded31-a3e7-705d-ab35-9ab12cfe0df5",
  "exitCode": 0,
  "summary": "smoke summary"
}
# activity entries for session 019ded31-a3e7-705d-ab35-9ab12cfe0df5: 7
#   session_start: (null)
#   subprocess_stdout: line 0
#   subprocess_stdout: line 1
#   subprocess_stdout: line 2
#   subprocess_stdout: line 3
#   subprocess_stdout: smoke summary
#   session_end: smoke summary
# OK — smoke passed
```

Asserts: `result.outcome === "completed"`, `result.summary === "smoke summary"`,
`result.exitCode === 0`, exactly seven activity entries in the documented order
(`session_start` → 5× `subprocess_stdout` → `session_end`), `session_end.refs.exit_code === "0"`,
`session_end.summary === "smoke summary"`. The smoke confirms the cycle works
against a real out-of-process orchestration server (not just the in-process
`runServer` shape used by the integration test).
