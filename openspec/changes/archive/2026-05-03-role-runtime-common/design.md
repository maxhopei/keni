## Context

Steps 01–06 have landed: `@keni/shared` exposes the four storage interfaces and their file-backed adapters; `keni init` produces the on-disk `.keni/` and `~/.keni/` layouts; `@keni/server` is a Hono-based orchestration server that owns the only legitimate write path to `.keni/` on `main`, exposes `/tickets`, `/prs`, `/activity`, `/agents`, and a `/events` WebSocket, and stamps `project_id` on every response; the engineer MCP server is a separate stdio process spawned per cycle that delegates every tool to the orchestration server. What is missing is the **execution loop** — the deterministic wrapper that, given a precheck function, a bundled prompt, and a coding-agent invoker, runs *one* role cycle end-to-end. This step builds that loop in `@keni/role-runtimes`.

The starting state of `@keni/role-runtimes` is a one-line `packageName` stub; this change is the first real surface. Building it is greenfield: every architectural choice — where the cycle algorithm lives, how prompts are resolved, how subprocesses are spawned, how the activity log is reached, how `--resume` is plumbed, how termination works — is open, and a small number of decisions ripple into every later step (08 cron scheduler, 09 engineer specialisation, 13 end-to-end smoke, 17 PO mode selection, 18 PO prompts bundle, 19 PO chat-mode CLI proxy).

Several `spec.md` principles drive this design:

- **§6.1 / §6.2 — deterministic precheck and the seven-step cycle.** The runtime must skip the entire cycle (no `POST /activity`, no subprocess) when the role's precheck returns "no work". The tick interval is short (5 seconds for the PO); burning even a single LLM token on an idle cycle is the failure case. The precheck is therefore the *first* step of the cycle, not the second.
- **§6.4 — agent-runner agnosticism.** The cycle must not hard-code `claude` or any other CLI. The seam is the `CodingAgentInvoker` interface; the binary name and argument shape are passed in.
- **§11#3 — prompts as code, not files.** The prompt body must arrive at the cycle as a TypeScript string constant compiled into the binary. There is no file-IO seam — no `Deno.readTextFile`, no path-based loader, nothing that could in principle resolve a `.keni/`-relative prompt.
- **§11#2 — fresh session per run.** A cycle holds no state across invocations; each cycle generates a new `session_id` and spawns a fresh subprocess.
- **§5.3 — `.keni/` write boundary.** The runtime must reach the activity log through `POST /activity`, not by writing `.keni/activity/<date>.jsonl` directly. The orchestration server is the single writer.
- **§2#4 / §2#5 — thin wrapper, one concern per session.** The runtime never decides what the agent works on, never tells it which status to pick, and never interprets output beyond the summary line.

Constraints and givens:

- Runtime is Deno 2.7+ (from step 01). `Deno.Command` is the subprocess primitive; `fetch` is the HTTP primitive; `crypto.randomUUID()` is the uuid v4 source for request ids; `@std/uuid@^1` provides `v7` for `session_id`.
- The orchestration server is local-only (`127.0.0.1`), no auth, no TLS, role headers trusted; the runtime inherits the same trust model when it acts as an HTTP client of `POST /activity`.
- The activity-log storage layer (step 02) caps each entry at 4 KB serialised JSON and rejects oversized entries with `InvalidArtifactError("size_exceeded")` → HTTP 422. The runtime is responsible for client-side line truncation so a chatty subprocess does not crash a cycle.
- The agents-API runtime-state store (step 05) flips an agent's `status` to `running` on `session_start` and back to `idle` on `session_end` / `session_interrupted` / `session_timeout` / `idle`. The runtime piggybacks on this rather than calling a "set status" endpoint (no such endpoint exists, by design).
- The MCP server (step 06) is spawned by the *coding-agent CLI* via its `mcpServers` config, not by the role runtime. The runtime's job is to write the `mcpServers` config the CLI consumes (a small JSON file under a temp dir) and to pass the right CLI flag (e.g., `--mcp-config <path>` for `claude`).
- `ResolvedConfig` (from `@keni/shared/storage/config/interface.ts`) already carries `coding_agent_cli` (global) and a per-agent `cli` override. The cycle does not need to invent a new field.

Non-constraints (explicitly free to choose):

- Internal layout under `packages/role-runtimes/src/`. Picking `common/` to match the project's pattern (Decision 1 below).
- Whether the activity-log adapter is its own module or lives inside the cycle. Splitting it is cleaner for testing (Decision 5).
- Whether streaming is per-line, per-chunk, or periodic-flush. Per-line is the only choice that keeps the activity log human-readable (Decision 6).
- How the summary line is identified. Last non-empty line of stdout is the obvious convention (Decision 7).
- How `CodingAgentInvoker` interacts with the cycle's lifecycle. A callback-based "lifecycle bag" keeps the invoker decoupled from activity-log concerns (Decision 4).
- How `--resume` is forwarded. Plumbed through verbatim with a configurable flag name (Decision 9).

## Goals / Non-Goals

**Goals:**

- A single `startCycle(params)` function in `@keni/role-runtimes` runs the deterministic seven-step cycle end-to-end and returns a typed `RoleCycleResult` discriminated union covering all five outcomes (`completed`, `idle`, `precheck_skipped`, `terminated`, `spawn_failed`).
- The cycle calls `params.precheck` before any I/O; a `skip` outcome short-circuits the entire cycle (no `POST /activity`, no subprocess) so a 5-second PO tick can run hundreds of times without burning tokens.
- Bundled-prompt resolution is enforced by construction: prompts are TS string constants compiled in; the cycle's prompt-resolver helper rejects empty bodies and name mismatches; no path-based loader exists in the source code.
- A subprocess utility wraps `Deno.Command` with the documented graceful-termination contract (SIGTERM → grace → SIGKILL, default 5 s grace, configurable per cycle), exit-code mapping, and env-allowlist filtering.
- A typed activity-log adapter (`createActivityLogClient(opts)`) speaks `POST /activity`, stamps `X-Keni-Role` and `X-Keni-Agent` from cycle params, parses the success envelope, and throws a typed `RoleRuntimeHttpError` on non-2xx.
- A `CodingAgentInvoker` interface decouples "spawn the binary" from "drive the cycle"; a default `createSubprocessCodingAgentInvoker(opts)` factory drives `Deno.Command` and the subprocess utility; tests inject a fake invoker.
- `resume_session_id` is a first-class cycle parameter — plumbed through `RoleCycleParams` → `CodingAgentInvocation` → the invoker — even though only step 19 will exercise the real `--resume` semantics.
- An end-to-end integration test using a real orchestration server and a Deno-script "coding agent" proves the cycle's activity-log emission contract: every line ends up on disk under the expected agent / role / session id; idle cycles emit only `idle`; terminated cycles emit `session_end` with the captured terminate reason.
- The `role-runtime` capability spec exists, names the cycle algorithm step-by-step, and is the document step 09 reads to plug in the engineer prompt and step 17 reads to plug in PO mode selection.

**Non-Goals:**

- **No tick loop / scheduler.** Step 08 owns that. The cycle is invoked once per scheduler tick.
- **No engineer-specific prompt or precheck.** Step 09. The placeholder prompt and a no-op precheck are stand-ins for tests only.
- **No PO mode selection.** Step 17 plugs mode selection *into* the precheck function; the cycle itself never knows about modes.
- **No CLI-specific argument shape.** The runtime's invoker takes a small `opts` bag (`cliBinary`, `mcpConfigFlag`, `mcpConfigPathBuilder`, `promptInjection`, `resumeFlag`) — every coding-agent CLI's quirks slot into that bag without changing the cycle.
- **No `Deno.env` reads from the cycle.** Env-var propagation is allowlist-only via the subprocess utility; the cycle does not pull from `Deno.env` at all (only the invoker, and only for the allowlist).
- **No `.keni/` direct reads or writes.** Every state change goes through `POST /activity`. A structural test in the integration suite asserts no source file under `packages/role-runtimes/src/` mentions `Deno.readTextFile`, `Deno.writeTextFile`, or any `.keni/`-prefixed path literal.
- **No retries.** A `spawn_failed` returns to the caller; the cycle does not retry.
- **No live SPA push.** Activity-log entries flow through the existing event bus; the runtime does not subscribe to `/events`.
- **No new orchestration-server endpoints.** Every emission goes through `POST /activity`.
- **No persistent state across cycles.** Each cycle is fresh per `spec.md` §11#2.
- **No stale-prompt cache.** Prompts are TS constants resolved per cycle; there is no "prompt cache" data structure.

## Decisions

### Decision 1: Package layout — flat `common/` subdir under `@keni/role-runtimes`, with `prompts/` and `fakes/` siblings; co-located tests

**Why:** the role-runtimes package will eventually host three concrete role implementations (engineer in step 09, QA in a future step, PO in steps 17–22). Putting the *common* lifecycle code in a dedicated subdirectory at the root of the package — `packages/role-runtimes/src/common/` — leaves room for `engineer/`, `qa/`, `po/` siblings without restructuring. Every new file lives next to its tests, matching the pattern the rest of the workspace uses.

```
packages/role-runtimes/src/
├── main.ts                              # barrel: re-exports the public surface
├── main_test.ts                         # presence test
└── common/
    ├── startCycle.ts + _test.ts         # the cycle algorithm
    ├── types.ts                         # RoleCycleParams / Result / etc.
    ├── subprocess.ts + _test.ts         # SIGTERM/SIGKILL, exit-code mapping, env allowlist
    ├── codingAgentInvoker.ts + _test.ts # interface + default subprocess invoker
    ├── activityClient.ts + _test.ts     # POST /activity adapter
    ├── promptResolver.ts + _test.ts     # bundled-prompt resolution helper
    ├── summaryLine.ts + _test.ts        # pure helper
    ├── prompts/
    │   └── placeholder.ts               # placeholder prompt body for the integration test
    ├── fakes/
    │   └── fakeCodingAgentInvoker.ts    # test-only fake invoker
    └── integration_test.ts              # end-to-end with a real orchestration server
```

`main.ts` is a tiny barrel:

```ts
export { startCycle } from "./common/startCycle.ts";
export type {
  RoleCycleParams,
  RoleCycleResult,
  CodingAgentInvocation,
  CodingAgentLifecycle,
  CodingAgentOutcome,
  CodingAgentInvoker,
  BundledPrompt,
} from "./common/types.ts";
export { createSubprocessCodingAgentInvoker } from "./common/codingAgentInvoker.ts";
export { resolveBundledPrompt } from "./common/promptResolver.ts";
export { RoleRuntimeHttpError } from "./common/types.ts";

export const packageName = "@keni/role-runtimes";
```

**Alternatives considered:**

- **Flat under `src/` (no `common/` subdir).** Works for now but fights against the engineer / QA / PO siblings the package will grow. Rejected.
- **Separate workspace package `@keni/role-runtime-common`.** Adds a workspace entry, a `deno.json`, and forces an export contract for what is naturally a sibling of `engineer/` / `po/`. The README already names `@keni/role-runtimes` as the home of role runtimes — common code stays with concrete code. Rejected.
- **Inline everything in `startCycle.ts`.** ~400 lines in one file; harder to test the subprocess utility independently. Rejected.

### Decision 2: Cycle algorithm — `startCycle(params)` is the cycle, not a class; precheck is the first step; idle and precheck-skipped are different outcomes

**Why:** the cycle has no state to carry across invocations (`spec.md` §11#2 fresh-session rule), so a class with `start()` / `dispose()` / etc. adds ceremony without value. A single function compiles cleanly under `verbatimModuleSyntax`, gets type-narrowed cleanly when callers `switch` on the result's `outcome`, and matches the orchestration server's `runServer` / `createServer` pattern (functions, not classes). The cycle's pseudocode:

```ts
export async function startCycle(params: RoleCycleParams): Promise<RoleCycleResult> {
  // Step 1: precheck
  const precheck = await params.precheck(buildPrepCtx(params));
  if (precheck.kind === "skip") {
    return { outcome: "precheck_skipped", reason: precheck.reason };
  }

  const sessionId = generateSessionId();
  const activity = createActivityLogClient({ ... });
  const promptBody = resolveBundledPrompt(params.promptResolver(buildPrepCtx(params)), params.expectedPromptName);

  // Step 2: log session start
  await activity.appendSessionStart({ sessionId, summary: precheck.roleContext.summary ?? null, ... });

  // Step 3 + 4: build invocation + spawn
  const invocation = buildInvocation(params, promptBody, precheck.roleContext);
  const buffers = createOutputBuffers();  // captures stdout / stderr lines for summary extraction
  const lifecycle = buildLifecycle(activity, sessionId, buffers, params.signal);

  let outcome: CodingAgentOutcome;
  try {
    outcome = await params.codingAgentInvoker.invoke(invocation, lifecycle);
  } catch (err) {
    return { outcome: "spawn_failed", error: err instanceof Error ? err : new Error(String(err)) };
  }

  // Step 6/7 (and idle short-circuit)
  const isIdle = isIdleOutcome(outcome, buffers, params.idleThresholdMs ?? 250);
  if (isIdle) {
    await activity.appendIdle({ sessionId });
    return { outcome: "idle", sessionId };
  }
  if (outcome.kind === "terminated") {
    await activity.appendSessionEnd({ sessionId, exitCode: outcome.exitCode, summary: extractSummary(buffers), terminatedBy: outcome.terminatedBy });
    return { outcome: "terminated", sessionId, terminatedBy: outcome.terminatedBy, exitCode: outcome.exitCode };
  }
  await activity.appendSessionEnd({ sessionId, exitCode: outcome.exitCode, summary: extractSummary(buffers) });
  return { outcome: "completed", sessionId, exitCode: outcome.exitCode, summary: extractSummary(buffers) };
}
```

**Two design points worth pinning:**

1. **`precheck_skipped` is *not* the same as `idle`.** A `precheck_skipped` cycle never logs anything (no `session_start`, no `idle`, no `session_end`) — it is invisible to the activity log. That is correct: §6.1 says "no LLM tokens are spent" and an idle entry would still pollute the feed every 5 seconds for the PO. An `idle` cycle, by contrast, *does* log a single `idle` entry — the agent ran, found nothing, and exited fast; that is worth surfacing in the activity feed because a stuck agent producing many `idle` entries is a debug signal.
2. **The idle threshold is configurable per role.** Default 250 ms. The PO has a 5-second tick; an "idle" subprocess that takes 4.9 s is effectively a hung cycle, not idle. Roles can pass a custom `idleThresholdMs` if they need a tighter bound; the cycle does not assume one.

**Alternatives considered:**

- **Class-based `RoleRuntime`.** `class EngineerRuntime extends BaseRuntime { ... }` — more ceremony than value; the cycle is stateless. Rejected.
- **Combine `precheck_skipped` and `idle` into one outcome.** Loses the §6.1 "no tokens spent" / "tokens spent but nothing happened" distinction. Rejected.
- **Emit the `idle` event from the precheck.** Couples the precheck (a cheap, agentic-decision-free function) to the activity-log adapter and the session id. Rejected; the cycle owns emission.

### Decision 3: Bundled-prompt resolution — TS string constants, the resolver enforces non-empty body and name match, no file-IO seam

**Why:** §11#3 says prompts ship with the binary. The cleanest enforcement is structural: prompts are `export const PROMPT_BODY = \`...\`` in `packages/role-runtimes/src/common/prompts/<name>.ts` (or under the role's directory once that exists — `packages/role-runtimes/src/engineer/prompt.ts` in step 09). A role's `promptResolver` is a function that returns a `BundledPrompt = { name: string, body: string }`; the cycle calls `resolveBundledPrompt(prompt, expectedName?)` which:

1. Asserts `body.length > 0` (a non-empty body is the only thing the cycle cares about; the role decides what "empty" means semantically).
2. When `expectedName` is provided, asserts `prompt.name === expectedName` (defence in depth — the engineer cycle expects the engineer prompt, not the PO chat prompt).
3. Returns the validated `BundledPrompt`.

There is no file-loading helper. There is no `loadPromptFromPath(...)` function. There is no path argument anywhere in the public surface. A future contributor wanting to load a prompt from `.keni/` has nowhere to plug it in — the surface forces them to add a TS constant.

**Why not an environment variable / config field?** A naïve `prompt: process.env.KENI_ENGINEER_PROMPT` would be a hidden seam through which a `.env` file effectively becomes a prompt source. The runtime never reads `Deno.env` for prompts (the env-allowlist for the *subprocess* is a separate concern; that allowlist is for env vars the agent process needs, not for the prompt body). This invariant is enforced by structural review (the integration test's "no `.keni/` reads" assertion is extended to also forbid `Deno.env.get` in any prompt-resolution code).

**Why a `name` field on `BundledPrompt`?** Cheap defensive cross-check. A role's `promptResolver` returns `{ name: "engineer", body: ENGINEER_PROMPT }`; the engineer cycle passes `expectedPromptName: "engineer"`. If a contributor accidentally wires the PO chat prompt into the engineer cycle, the assertion fires and the test fails loudly.

**Alternatives considered:**

- **Plain string parameter.** `params.prompt: string`. Loses the structural check; a contributor wiring the wrong prompt would not get caught. Rejected.
- **Lazy resolver returning a `Promise<string>`.** Allows async prompt loading. Async opens the door to file-IO seams; rejected.
- **Embedded resources via `import.meta.resolve("./prompts/engineer.txt")`.** Works on Deno but pulls in path-based resolution; same risk surface as file-IO. Rejected — TS strings are simpler and still bundle-time.

### Decision 4: `CodingAgentInvoker` interface — callback-based lifecycle, decouples spawn-mechanics from activity-log emission

**Why:** the cycle needs to own activity-log emission (because the session id is generated in the cycle and the streaming-per-line contract belongs to the cycle), but the *spawn mechanics* — what binary, what args, how the prompt is injected, what flag the MCP config uses, what `--resume` looks like — vary per CLI. The seam is a tiny callback-bag interface:

```ts
export interface CodingAgentInvoker {
  invoke(
    invocation: CodingAgentInvocation,
    lifecycle: CodingAgentLifecycle,
  ): Promise<CodingAgentOutcome>;
}

export interface CodingAgentLifecycle {
  readonly onStdoutLine: (line: string) => void | Promise<void>;
  readonly onStderrLine: (line: string) => void | Promise<void>;
  readonly onSpawn?: (spawnInfo: { pid: number }) => void;
  readonly abortSignal?: AbortSignal;
}

export type CodingAgentOutcome =
  | { kind: "completed"; exitCode: number }
  | { kind: "terminated"; exitCode: number; terminatedBy: "sigterm" | "sigkill" };
```

The cycle constructs a lifecycle bag whose `onStdoutLine` / `onStderrLine` callbacks (a) push the line into an in-memory buffer used for summary extraction and (b) call the activity-log adapter to `POST /activity` with `event: "subprocess_stdout"` (or `subprocess_stderr`) carrying the line as `summary`. The invoker reads / decodes the subprocess's stdout / stderr streams line-by-line and calls the callbacks as lines arrive. This factoring means:

- **The invoker has zero knowledge of the activity log.** The default subprocess invoker depends only on `Deno.Command` and the subprocess utility; it does not import `activityClient.ts`. Tests can plug in a fake invoker that *never* calls `POST /activity` and the cycle still produces a coherent `RoleCycleResult`.
- **The cycle has zero knowledge of `Deno.Command`.** It receives `stdout_line` / `stderr_line` callbacks and a final outcome; the spawn mechanism could be `Deno.Command`, an in-process Worker, or a hand-rolled fake.
- **Termination is the invoker's concern.** When `lifecycle.abortSignal` fires, the invoker calls into the subprocess utility's `terminate(child, { graceMs })` and resolves with `{ kind: "terminated", terminatedBy, exitCode }`. The cycle just sees the outcome and emits the right activity entry.

**Default invoker — `createSubprocessCodingAgentInvoker(opts)`.** Factory shape:

```ts
export interface SubprocessCodingAgentInvokerOpts {
  readonly cliBinary: string;                                  // e.g., "claude"
  readonly buildArgs: (invocation: CodingAgentInvocation,
                       mcpConfigPath: string) => readonly string[];
  readonly promptInjection: "stdin" | "arg";                    // default "stdin"
  readonly mcpConfigPathBuilder?: (invocation) => Promise<string>; // default writes JSON to a temp file
  readonly graceMs?: number;                                    // default 5000
  readonly envAllowlist?: readonly string[];                    // default []
}
```

Step 09 will configure this with `cliBinary: <from config>`, `buildArgs: (inv, mcp) => ["--mcp-config", mcp, ...]`, etc. The factory is concrete enough to be useful out of the box (the integration test uses it against a Deno-script "coding agent" that ignores all CLI flags) and abstract enough that a CLI with a different shape (e.g., one that wants the prompt as `--prompt-file <path>` instead of stdin) is a one-line `buildArgs` change.

**Alternatives considered:**

- **Make the invoker emit activity entries.** Couples spawn mechanics to HTTP; tests need a fake HTTP layer to drive the invoker; rejected.
- **Have the cycle own `Deno.Command` directly and let invokers be subclasses.** Loses the seam for the in-process / fake invoker. Rejected.
- **Stream raw chunks instead of lines.** Activity log becomes hard to read; chatty stderr can fragment a single log line across multiple entries; rejected.

### Decision 5: Activity-log adapter — typed methods per event kind, never re-implements wire shapes

**Why:** the cycle calls `POST /activity` six times in a worst-case run (`session_start` once, `subprocess_stdout` per line, `subprocess_stderr` per line, `session_end` once, optionally `idle` once instead of `session_end`). Centralising the URL / header / envelope / error-mapping logic in one module keeps the cycle clean. The adapter exposes one method per event kind:

```ts
export interface ActivityLogClient {
  appendSessionStart(input: { sessionId: string; summary: string | null; refs?: Refs }): Promise<void>;
  appendSessionEnd(input: { sessionId: string; exitCode: number; summary: string | null; terminatedBy?: "sigterm" | "sigkill"; refs?: Refs }): Promise<void>;
  appendIdle(input: { sessionId: string; refs?: Refs }): Promise<void>;
  appendSubprocessOutput(input: { sessionId: string; streamKind: "stdout" | "stderr"; line: string }): Promise<void>;
  appendRaw(input: ActivityAppendRequest): Promise<void>; // for tests + unusual cases
}

export function createActivityLogClient(opts: {
  serverUrl: string;
  agentId: string;
  role: Role;
}): ActivityLogClient;
```

Each method composes the right `event` value and calls `appendRaw` which:

1. Composes the URL (`${serverUrl}/activity`).
2. Sets `Content-Type: application/json`, `X-Keni-Role: <role>`, `X-Keni-Agent: <agentId>`.
3. Issues `await fetch(...)`.
4. On 2xx: discards the response body (the cycle does not need the persisted entry's id; activity-log appends are fire-and-forget from the runtime's perspective).
5. On non-2xx: parses the `{ error: { code, message, details? } }` envelope, throws `new RoleRuntimeHttpError(code, message, details, status)`.
6. On a network-level failure: throws `new RoleRuntimeHttpError("internal_error", `Network error talking to ${url}: ${cause.message}`, ..., 0)`.

**Hard line-truncation.** `appendSubprocessOutput` truncates `line` to `4 KB - <envelope overhead>` (a conservative 3 KB ceiling). Truncation is marked with a trailing `... [truncated <N> bytes]` so a parser can detect it. The orchestration server's storage layer caps entries at 4 KB and would otherwise reject a long line with HTTP 422; client-side truncation is the right place to handle this so the cycle does not error on a chatty subprocess.

**Why not just import the orchestration server's HTTP routes in-process?** Two reasons: (a) the runtime may run in a different process from the server in step 13 (`keni start`'s process model), and (b) using the HTTP boundary keeps the runtime testable with a `Deno.serve`-backed mock without mocking the storage layer.

**Alternatives considered:**

- **Inline the HTTP calls in the cycle.** Six call sites, six places to forget a header. Rejected.
- **Reuse the MCP server's `httpClient.ts`.** That client stamps `X-Keni-Role: engineer`; we want the role to be a parameter (the PO runtime stamps `po`). Rejected; a separate adapter per concern is cleaner.
- **Append asynchronously without awaiting.** Non-deterministic; if the cycle returns before the activity entries land, tests have to poll. Rejected.

### Decision 6: Streaming granularity — per-line, not per-chunk, not periodic-flush

**Why:** the activity log is read by humans (in the SPA's "session detail" view) and the orchestration server's WS clients. Per-chunk streaming fragments individual log lines across multiple entries (a `console.log("processing ticket-0001")` becomes `processing ticket` / `-0001\n`), which is unreadable. Periodic flush (every 100 ms, say) batches lines into a single entry, which is also unreadable when the SPA expects one entry per line. Per-line streaming is the only choice that gives the SPA a clean per-line render and the activity log's grep / tail experience.

**Implementation:** the default subprocess invoker reads from `child.stdout.pipeThrough(new TextDecoderStream())` and splits on `\n`, holding any trailing partial line in a buffer until the next chunk arrives. On stream close, any non-empty trailing partial is emitted as a final line. Empty lines are skipped (they would log empty entries which the orchestration server would reject as `validation_failed` for `summary.length < 1` — except the schema actually allows empty summary, but they would still pollute the feed). A configurable `emitEmptyLines: boolean` can turn this off if a future role wants raw passthrough; default `false`.

**Hard cap:** 1 000 lines per stream per cycle (configurable via `maxLinesPerStream`, default 1 000). A cycle that emits more than 1 000 lines on stdout (or stderr) is a runaway; the cycle aborts emission of further lines, logs *one* `subprocess_output_truncated` entry naming the truncated line count, and continues capturing for summary-extraction purposes (the summary line is still extracted from whatever was on stdout, even after the activity-log emission stopped). The runaway protection prevents a malformed agent from filling the activity log on every cycle.

**Alternatives considered:**

- **Per-chunk.** Unreadable; rejected.
- **Periodic flush (every N ms).** Unreadable when the SPA renders one entry per line; rejected.
- **No cap.** A runaway can fill the log indefinitely; rejected.

### Decision 7: Summary line extraction — last non-empty line of stdout, captured *after* the subprocess exits, returned from the cycle

**Why:** §6.3 says "the agent's final stdout line ... captured as the session's headline". The runtime needs an unambiguous rule. "Last non-empty line of stdout" is the obvious one:

- Last non-empty so a trailing `\n` (the convention in shell scripts) does not produce an empty summary.
- Stdout only — stderr lines are not the agent's intentional output; even if the agent prints "ERROR: failed to ..." on stderr, that is not the cycle's summary.
- Captured *after* exit so a long-running agent with multiple `console.log` calls produces the *final* line as the summary, not the first.

**Implementation:** `summaryLine.ts` exports a pure function `extractSummaryLine(stdoutLines: readonly string[]): string | null` that returns the last non-empty entry of the array, or `null` when the array is empty / all lines are empty. The cycle calls this function once at session-end emission time. The function is pure (no I/O, no side effects) so it has its own unit tests with a handful of edge cases (all empty, single line, trailing whitespace).

**Trailing-whitespace handling:** lines are trimmed (right-trim only, not left-trim) before the empty check. `"  hello  \n"` becomes `"  hello"` (preserving leading indent that the agent might use for emphasis); `"   \n"` becomes empty and is skipped. `String.prototype.trimEnd()` is the implementation.

**Truncation:** the captured summary is itself bounded (4 KB minus envelope overhead) by the activity-log adapter's hard line-truncation rule. A multi-megabyte single line would be a malformed agent; the cycle truncates the same way as a streaming line.

**Alternatives considered:**

- **First line.** Loses cycles where the agent emits status updates before its final summary. Rejected.
- **A magic prefix the agent must use (e.g., `SUMMARY: ...`).** Couples the prompt to the wrapper; the prompt would need to teach this discipline; defeats §2#4 "thin wrapper". Rejected.
- **JSON-only output (parse a `{ "summary": "..." }` block).** Forces every coding-agent CLI's prompt to be aware of Keni's output convention; defeats §6.4. Rejected.

### Decision 8: Subprocess utility — SIGTERM-then-SIGKILL with default 5 s grace; env-allowlist; explicit Windows behaviour

**Why:** the cycle needs *one* canonical termination procedure. Three details to pin:

1. **Grace period.** Default 5 000 ms. Long enough for a `claude` agent to finish flushing its stdout / writing a final line; short enough that step 08's per-role timeout (default tens of minutes per the input file's spec) does not get extended by another five seconds. The default is set on `RoleCycleParams.terminationGraceMs` and propagated to the invoker's `graceMs` opt.
2. **SIGKILL after grace.** Sends `child.kill("SIGKILL")`. The subprocess utility's `terminate` returns when the child's `status` resolves; if `status` does not resolve within the kill-timeout (default 1 000 ms after SIGKILL), the utility throws `new Error("subprocess refused to die after SIGKILL")` and the cycle returns `outcome: "spawn_failed"`. (In practice this only triggers when the kernel itself is misbehaving.)
3. **Windows.** Deno's `Deno.Command.kill()` does not accept a signal on Windows; it is effectively `TerminateProcess` (a hard kill). The subprocess utility detects `Deno.build.os === "windows"` and skips the SIGTERM phase, going straight to `kill()`. A one-line warning is logged the first time per process. The graceful-termination contract is therefore honoured "best-effort on Windows"; the prototype's primary platform is macOS / Linux.

**Env allowlist.** `Deno.Command(..., { env: <built object> })` receives only the allowlisted env vars plus the cycle's own variables (`KENI_MCP_AGENT`, `KENI_MCP_SERVER_URL`, `KENI_MCP_WORKSPACE`). When the allowlist is empty, *only* the cycle's variables propagate; this is the default. A role can extend the allowlist via `RoleCycleParams.envAllowlist: readonly string[]` (e.g., engineers may need `PATH`, `HOME`, `LANG`). The subprocess utility never calls `Deno.env.toObject()` (which would leak unrelated env vars); it reads each allowlisted var via `Deno.env.get(name)` and skips any that are unset.

**Stream lifecycle.** The utility owns wiring `child.stdout` and `child.stderr` through `TextDecoderStream` and a `pipeThrough` line splitter (per Decision 6). It also writes the prompt to `child.stdin` (when `promptInjection: "stdin"`) and closes stdin once the prompt is fully written. On termination, the utility cancels both reader streams and waits for `child.status` to resolve.

**Alternatives considered:**

- **Always SIGKILL.** Rejected; some agents need a moment to flush.
- **Configurable per-cycle grace with no default.** Rejected; defaults make tests easy and downstream callers do not need to think about this.
- **No env allowlist (forward everything from `Deno.env`).** Rejected; agent subprocess sees `OPENAI_API_KEY`, `AWS_*`, etc. that have no business in a coding-agent run. The role decides what to forward.

### Decision 9: `resume_session_id` — a first-class cycle parameter, plumbed through the invoker, default flag `--resume`

**Why:** step 19 (PO chat-mode CLI proxy) needs the cycle to forward an existing session id to the coding-agent CLI so the conversation continues. Without this seam in step 07, step 19 would have to refactor the cycle. With it, step 19 is a one-line addition (the chat handler computes the session id from `state.json` and passes it via `RoleCycleParams.resumeSessionId`).

**Plumbing:**

1. `RoleCycleParams.resumeSessionId: string | undefined` — the cycle accepts it, validates it (a non-empty string when present), and forwards it.
2. `CodingAgentInvocation.resumeSessionId: string | null` — the invoker receives `null` when the parameter is absent.
3. The default subprocess invoker's `buildArgs(invocation, mcpConfigPath)` receives the invocation and may include `--resume <id>` (or any flag) in the returned args. The factory's `resumeFlag` opt (default `--resume`) names the flag for roles that don't override `buildArgs`.
4. The activity log records the resume id in `session_start.refs.resume_session_id` so the activity feed shows that this was a resume rather than a fresh session.

**Important non-decision:** the cycle does *not* assert that the resumed session id corresponds to a real prior session. That is the role's responsibility (the PO chat handler reads `state.json`; the engineer cycle never resumes today). The cycle plumbs a string; the CLI fails loudly if the id is wrong.

**Alternatives considered:**

- **Defer entirely to step 19.** Step 19 then has to refactor the cycle's signature (a breaking change to every existing caller). Rejected.
- **Make it required.** Breaks the engineer cycle (which never resumes). Rejected.
- **Pass it via env var.** Hides the seam; surprises a contributor who reads the function signature. Rejected.

### Decision 10: `RoleCycleResult` is a tagged union; five outcomes; type-narrowing at call sites is the default

**Why:** the cycle's caller needs to react differently to each outcome:

- `completed` — log success, possibly trigger downstream effects (step 17's verify-and-fold "atomic post-subprocess commit" hangs off this outcome).
- `idle` — increment a "consecutive idles" counter (step 08 may want to back off scheduling).
- `precheck_skipped` — count it for telemetry, do nothing else.
- `terminated` — surface the terminate reason in logs; possibly schedule a retry (step 08's concern).
- `spawn_failed` — alert; this is rare and a sign of misconfiguration.

A discriminated union forces every caller to handle every outcome (or explicitly fall through with an exhaustive `switch`). The type's shape:

```ts
export type RoleCycleResult =
  | { outcome: "completed";        sessionId: string; exitCode: number; summary: string | null; }
  | { outcome: "idle";             sessionId: string; }
  | { outcome: "precheck_skipped"; reason: string; }
  | { outcome: "terminated";       sessionId: string; terminatedBy: "sigterm" | "sigkill"; exitCode: number; }
  | { outcome: "spawn_failed";     error: Error; };
```

`sessionId` is present on every outcome that emitted at least one activity entry; absent on `precheck_skipped` (which emits nothing) and `spawn_failed` (which emits nothing — a spawn failure happens after `session_start` is logged, but in that case the cycle returns `terminated` with a SIGKILL and an `exitCode: -1`; `spawn_failed` is reserved for "the spawn itself threw before the child was reachable", which today only happens on a missing binary).

Wait — there's a subtle ordering issue. The cycle logs `session_start` *before* calling `params.codingAgentInvoker.invoke`; if the invoker throws synchronously (e.g., binary not found), `session_start` is already logged but no `session_end` follows. The cleanest answer: on `spawn_failed`, the cycle catches the throw and emits one `session_end` with `refs.spawn_failed: true` and `exitCode: -1`, then returns `{ outcome: "spawn_failed", error }` *with* a `sessionId` field. Updating the type:

```ts
| { outcome: "spawn_failed";     sessionId: string; error: Error; };
```

This keeps the activity log self-consistent (`session_start` is always followed by exactly one of `session_end` / `idle`) and gives the caller the session id for cross-referencing.

**Alternatives considered:**

- **Booleans (`completed: true`, `idle: false`, etc.).** Loses exhaustiveness checks. Rejected.
- **Throw on failure.** Forces every caller to wrap in `try`/`catch` and reason about which throws are "failures the scheduler should handle" vs "bugs". Rejected.
- **Single `success: boolean` + `error?: Error`.** Loses the `idle` / `precheck_skipped` / `terminated` distinction. Rejected.

### Decision 11: Test pyramid — fakes for subprocess and HTTP; one end-to-end integration test using a real orchestration server and a Deno-script "coding agent"

**Why:** the cycle has three external dependencies — a subprocess, an HTTP server, and an `AbortSignal`. Each gets a fake in unit tests; the integration test runs against the real things to catch wiring mistakes.

- **Wire / pure tests.** `summaryLine_test.ts`, `promptResolver_test.ts`, `types_test.ts` (type-level only, e.g., `expectType<...>().toEqual<...>()`).
- **Activity-log adapter tests.** `activityClient_test.ts` against a `Deno.serve`-backed mock server (port 0); each method composes the right URL / headers; non-2xx surfaces as `RoleRuntimeHttpError`; network failure surfaces as `RoleRuntimeHttpError("internal_error", ...)`.
- **Subprocess utility tests.** `subprocess_test.ts` against a tiny Deno script (or a `sleep` shell command on POSIX): graceful termination on a slow child, SIGKILL after grace period, exit-code passthrough, env-allowlist filtering. (No Windows-specific tests in CI; the Windows behaviour is documented and a one-line `Deno.build.os` check in the source.)
- **Coding-agent invoker tests.** `codingAgentInvoker_test.ts` against the same kind of Deno script: stdin prompt injection, arg-prompt injection, line-by-line stdout decoding, abort-signal-driven termination, MCP-config temp file write + cleanup.
- **Per-cycle tests.** `startCycle_test.ts` against a fake invoker (the test pushes lines / sets the exit code) and a fake activity-log client (the test inspects what was emitted): every outcome (`completed`, `idle`, `precheck_skipped`, `terminated`, `spawn_failed`); `--resume` plumbing; per-line streaming order; truncation rules; summary extraction.
- **End-to-end integration.** `integration_test.ts` against a real orchestration server (`startServer` on port 0, against a `keni init`-produced temp dir) and a Deno-script coding agent under `tests/fixtures/fake-coding-agent.ts`. The fixture script reads the prompt from stdin, optionally prints `N` stdout lines (controlled via `KENI_FAKE_AGENT_LINES` env var), prints a configurable summary line, then exits with a configurable code. Three integration tests:
  1. **Happy-path completion.** Fixture prints 5 lines + summary; cycle returns `outcome: "completed"`; activity log on disk has `session_start` + 5 `subprocess_stdout` + `session_end` entries; the on-disk `session_end.summary` equals the fixture's summary; the agent's `last_active_at` flips on the agents API.
  2. **Idle cycle.** Fixture prints nothing and exits 0 within < 250 ms; cycle returns `outcome: "idle"`; activity log has *only* the `idle` entry (no `session_start` paired with it — wait, that's wrong; idle still needs `session_start`; the `idle` event replaces `session_end`, not `session_start`). Actually re-reading the cycle pseudocode: `session_start` is logged before the invoker is called, and *if* the outcome turns out to be idle, the `session_end` is replaced by `idle`. So the integration test asserts: `session_start` + `idle` (no `subprocess_stdout`, no `session_end`). The agents API shows the agent's `status: idle` after the cycle returns (it briefly went `running` between `session_start` and `idle`).
  3. **Graceful termination.** Fixture sleeps for 30 s; the test fires `AbortSignal` after 100 ms; cycle returns `outcome: "terminated", terminatedBy: "sigterm"` (the fixture exits cleanly on SIGTERM); activity log has `session_start` + zero or more `subprocess_stdout` (whatever the fixture managed to emit before SIGTERM) + `session_end` with `refs.terminated_by: "sigterm"`.

  The integration test does *not* exercise the SIGKILL path (a Deno script that ignores SIGTERM is fragile under CI) — that's covered by the subprocess utility's unit test against a `sleep infinity` command.

- **No `.keni/` reads from the runtime.** A structural assertion (the same shape as step 06's "no `.keni/` reads from MCP" test) walks every file under `packages/role-runtimes/src/common/` (excluding `*_test.ts` and the integration test's fixtures) and asserts no occurrence of `Deno.readTextFile`, `Deno.writeTextFile`, `Deno.readFile`, `Deno.writeFile`, or any path literal beginning with `.keni/` or `~/.keni/`. The structural test pins the §5.3 / §11#3 invariants in CI.

**Alternatives considered:**

- **Mock `Deno.Command`.** Deno does not provide a clean mocking story; the subprocess utility's unit tests run actual subprocesses (the cost is negligible). Rejected mocking.
- **End-to-end-only tests.** Slow and brittle; failures could be in any layer. Rejected; the layered fakes are the load-bearing safety net.

### Decision 12: Session id — uuidv7, generated fresh per cycle, never reused even on `--resume`

**Why:** §11#2 says fresh session per run. The cycle's `session_id` is uuidv7 (`@std/uuid` already in deno.json) so it sorts in time order in the activity log. On `--resume`, the *coding-agent CLI's session id* is the resumed value — the runtime's session id is still fresh. This separation matters: the activity log's `session_id` is what groups runtime-emitted entries; the CLI's session id is what the CLI uses internally to thread its own conversation. They are *not* the same thing.

The cycle's session id is captured on `RoleCycleResult.sessionId` so step 17 can correlate "the session I just emitted to the activity log" with "the post-subprocess action I'm about to take". Roles that need cross-cycle correlation use the orchestration server's existing event bus (`activity.appended` events carry the `session_id` field).

**Alternatives considered:**

- **Reuse the resumed CLI session id as the runtime session id.** Conflates two distinct identifiers. Rejected.
- **Use the agent id + a counter.** Counters need persistence across processes; adds state for no clear benefit. Rejected.
- **uuidv4 instead of v7.** Loses sort-by-time. v7 is already in `deno.json`. Rejected.

### Decision 13: No new orchestration-server endpoints; agent runtime-state changes piggyback on existing `applyActivityEvent`

**Why:** step 05 already wires the orchestration server to flip an agent's `status` based on activity-log events: `session_start` → `running`; `session_end` / `session_interrupted` / `session_timeout` / `idle` → `idle`. The runtime simply emits the right events; the server takes care of state transitions and `agent.state_changed` event broadcasts.

**Two follow-ups:**

1. **`session_interrupted` and `session_timeout` events are owned by step 08 (the scheduler).** This step emits `session_end` on `terminated` outcomes; the scheduler may decide that a `terminated` outcome whose cause was an external abort should be re-emitted as a `session_interrupted` follow-up activity entry. The cycle does not concern itself with that distinction; it emits `session_end` with `refs.terminated_by` and lets the scheduler decide.
2. **`manual_override` is owned by step 25.** Not relevant to the cycle.

**Alternatives considered:**

- **Add `POST /agents/:id/state` to set state explicitly.** Duplicates `applyActivityEvent`; introduces a second source of truth; rejected.
- **Have the cycle emit `agent.state_changed` directly.** Would require adding a new event in the bus from the runtime; the existing piggyback is structurally cleaner. Rejected.

### Decision 14: `RoleCycleParams` — a single typed bag, no positional arguments, every field readonly

**Why:** the cycle has many parameters (agent id, role, server URL, precheck, prompt resolver, invoker, optional resume id, optional signal, optional grace ms, optional idle threshold). Positional arguments at this fan-out would be unreadable. A single bag with documented fields is what every other top-level function in the workspace uses. Every field is `readonly` to prevent the cycle from mutating its inputs.

```ts
export interface RoleCycleParams {
  readonly role: Role;
  readonly agentId: AgentId;
  readonly serverUrl: string;
  readonly projectName: string;
  readonly workspacePath?: string;
  readonly mcpServerConfig: McpServerConfig;
  readonly precheck: (ctx: CyclePrepCtx) => Promise<PrecheckResult> | PrecheckResult;
  readonly promptResolver: (ctx: CyclePrepCtx) => BundledPrompt;
  readonly expectedPromptName?: string;
  readonly codingAgentInvoker: CodingAgentInvoker;
  readonly resumeSessionId?: string;
  readonly signal?: AbortSignal;
  readonly idleThresholdMs?: number;
  readonly terminationGraceMs?: number;
  readonly maxLinesPerStream?: number;
}
```

**Why `Role` and `AgentId` are typed (not `string`).** Both come from `@keni/shared/wire/role.ts` (already shipped). The brand on `AgentId` surfaces intent in callers; the union on `Role` constrains to the five documented values.

**`CyclePrepCtx`** is a small read-only bag passed to `precheck` and `promptResolver`: `{ role, agentId, projectName, workspacePath, serverUrl }`. Using a separate type so a future field added for prompt resolution does not change the precheck's shape.

**Alternatives considered:**

- **Positional arguments.** Unreadable at this fan-out. Rejected.
- **Class with constructor params.** Same readability problem in JS, plus extra ceremony. Rejected.
- **Optional fields defaulted to functions / undefined inside `startCycle`.** Done for `idleThresholdMs`, `terminationGraceMs`, `maxLinesPerStream`. The rest are mandatory.

### Decision 15: New code lives in `@keni/role-runtimes` only; no SPA / server / shared / CLI changes beyond the README amendment

**Why:** the runtime is a downstream consumer of `@keni/shared` (wire types) and `@keni/server` (HTTP endpoints over fetch). It does not need to modify either. The package's `deno.json` is unchanged (no exports beyond the existing `./src/main.ts`).

**Files touched:**

```
packages/role-runtimes/src/                ← extended
  main.ts                                  ← extended barrel (replaces the one-line stub)
  main_test.ts                             ← extended (replaces the stub presence test)
  common/                                  ← new top-level folder, ~13 new files
README.md                                  ← one new paragraph
openspec/                                  ← this change directory
```

No file in `packages/cli/`, `packages/server/`, `packages/shared/`, or `packages/spa/` is modified.

**Alternatives considered:**

- **Add an exports field to `packages/role-runtimes/deno.json`.** Not needed yet; the package's existing `exports: "./src/main.ts"` is the single export point. The new types and helpers are all reachable through that.
- **Promote the activity-log adapter to `@keni/shared`.** Other packages (the SPA, the CLI) might want to call `POST /activity` someday. The adapter is internal to `@keni/role-runtimes` for now; promoting is purely additive and lands when the second consumer arrives. Rejected for prototype.

## Risks / Trade-offs

- **[The runtime calls `POST /activity` per stdout/stderr line, which can be many hundreds of HTTP calls per cycle.]** A chatty agent (say, 500 stdout lines) means 500 + 2 round-trips to `127.0.0.1`. Each round-trip is ~0.1 ms over loopback; the worst-case wall-time penalty is ~50 ms. → **Mitigation:** acceptable for prototype scope. If telemetry says otherwise, a future change can introduce a per-cycle batched `POST /activity/batch` endpoint additively (the wire shape for `ActivityAppendRequest` is single-entry today, but a batched endpoint is purely additive). The line cap (1 000 per stream per cycle) bounds the worst case.
- **[Per-line emission can race with the SPA's `/events` consumer.]** The orchestration server emits `activity.appended` per `POST /activity`; a chatty cycle floods the WS. → **Mitigation:** the WS handler in step 05 is a fire-and-forget broadcast; no flow control. The SPA already debounces its render; chatty cycles are a UX concern, not a correctness concern. Documented.
- **[A misbehaving agent could emit a stdout line larger than the activity log's 4 KB cap.]** Without truncation, the cycle would error. → **Mitigation:** client-side truncation in `appendSubprocessOutput` (Decision 5). The truncation marker `... [truncated <N> bytes]` is grep-able. Test: `activityClient_test.ts` exercises a 10 KB line and asserts the truncation marker.
- **[The default 250 ms idle threshold is arbitrary.]** A slow filesystem or a cold start could push a no-op cycle over 250 ms; the cycle then logs `session_end` instead of `idle`, polluting the activity feed. → **Mitigation:** the threshold is configurable per cycle (`RoleCycleParams.idleThresholdMs`). The PO runtime in step 17 may want a higher threshold (e.g., 500 ms) when its precheck does multiple HTTP reads. Default suffices for the engineer cycle; documented.
- **[`resumeSessionId` is forwarded verbatim to the CLI without verification.]** A bug in step 19 (PO chat handler) could send a stale id, in which case the CLI fails loudly with its own error. → **Mitigation:** the activity log records the resume id in `session_start.refs.resume_session_id`; a failed resume produces a non-zero `exitCode` in `session_end`; debugging path is "look at the activity log entry, see the wrong id". Acceptable.
- **[The default subprocess invoker writes a temp file for `mcpServers` JSON on every cycle.]** ~200 bytes per cycle, cleaned up via `try`/`finally`. A `Deno.makeTempFile()` failure (e.g., disk full) would surface as `spawn_failed`. → **Mitigation:** the invoker's `try`/`finally` always removes the temp file; a temp-dir leak is impossible by construction. A future optimisation could keep the temp file across cycles; not worth the complexity today.
- **[The cycle can deadlock if the subprocess writes to stdin (e.g., expects an interactive prompt).]** The default invoker writes the prompt and closes stdin; if the subprocess writes more, the cycle hangs waiting for stdout. → **Mitigation:** documented in the capability spec. The `AbortSignal` is the escape hatch; step 08's per-role timeout (default tens of minutes) is the second safety net. Not a problem in practice — every supported coding-agent CLI consumes stdin and prints to stdout.
- **[`session_start` is logged before `params.codingAgentInvoker.invoke` runs.]** A spawn failure (binary not found, permission denied) happens after `session_start` was logged but before any subprocess line is emitted. → **Mitigation:** the cycle catches the throw, emits one `session_end` with `refs.spawn_failed: true` and `exitCode: -1`, returns `outcome: "spawn_failed"`. Activity log invariant ("`session_start` is always followed by exactly one `session_end` or `idle`") is preserved.
- **[The Windows graceful-termination path is degraded.]** SIGTERM is unsupported on Windows; the utility falls back to a hard kill. → **Mitigation:** documented in the capability spec and in `subprocess.ts`'s leading comment. The prototype's primary platforms are macOS / Linux. A future change can add a Windows-specific termination flow (e.g., POSTing to a dedicated shutdown endpoint the agent CLI exposes); not in scope.
- **[The activity-log adapter's network failures bubble up as `RoleRuntimeHttpError` and abort the cycle.]** If the orchestration server is unreachable mid-cycle, the cycle aborts on the first failed `POST`. → **Mitigation:** the cycle catches the error and returns `outcome: "spawn_failed"` with the wrapped error. The cycle does *not* try to log a final `session_end` (it can't — the server is down). Step 08 (the scheduler) sees the `spawn_failed` outcome and decides whether to retry next tick. Documented.
- **[The runtime's session id and the coding-agent CLI's session id are separate identifiers, easy to confuse.]** A future contributor reading the activity log sees `session_id: <uuidv7>` and might assume that's the CLI's id. → **Mitigation:** `session_start.refs.resume_session_id` (when present) names the CLI's id; the activity log's `session_id` is documented in the capability spec as "the runtime's session id, distinct from any underlying CLI session id". The capability spec makes this explicit.
- **[The cycle does not yet enforce per-role timeouts.]** Step 08 owns timeouts, but a misconfigured cycle (no `signal`, runaway agent) could in principle run forever. → **Mitigation:** documented as a non-goal. The cycle accepts an `AbortSignal`; step 08 sets a `setTimeout`-driven abort. The cycle does not add its own timeout to keep responsibility singular.
- **[The integration test depends on a tiny fixture script in `packages/role-runtimes/tests/fixtures/`.]** A failed CI run can leave the fixture in an inconsistent state. → **Mitigation:** the fixture is committed to the repo as a regular file; the integration test reads its path via `import.meta.url`-relative resolution; no state is shared across tests. Standard pattern.

## Migration Plan

Not applicable — additive, greenfield runtime layer. No on-disk artefacts produced or consumed by this step. Rollback is `git revert` of the change's commits; the orchestration server, the storage layer, the SPA, the CLI, the MCP layer, and `~/.keni/` all stay green without modification.

If a contributor in a downstream branch (e.g., a step 09 work-in-progress) has wired an ad-hoc subprocess invocation against the orchestration server, migrating to `startCycle` is a straightforward swap: replace the ad-hoc fetch / `Deno.Command` with a `startCycle({ ... })` call and let the cycle handle the rest. The capability spec is the cheat sheet.

## Open Questions

- **Should the activity-log adapter expose `appendSessionInterrupted` and `appendSessionTimeout` methods now, even though step 08 owns those events?** Two arguments: (a) shipping the methods now means step 08 just calls them — no refactor. (b) shipping unused methods invites confusion ("does the cycle ever call this?"). → **Decision for this step:** ship `appendSessionEnd` and `appendIdle` only; step 08 will add the other two when it lands. The base `appendRaw` is available for any caller that needs an arbitrary event in the meantime.
- **Should `BundledPrompt.body` be a frozen string or mutable?** Frozen would require a `Object.freeze`-like wrapper on a primitive; strings are immutable in JS regardless. → **Decision for this step:** plain `string`. The `readonly` modifier on the field is the only invariant.
- **Should the cycle expose an `onProgress` callback for the scheduler to render live status?** Step 08 might want to update an in-memory "currently running" bookkeeping. → **Decision for this step:** no callback today. The agents-API runtime-state store (step 05) is the canonical source of truth; the scheduler subscribes to `agent.state_changed` events on the WS to know which agent is running.
- **Should the runtime pin a session-id format, or accept any uuidv7?** The orchestration server already validates uuidv7 on the `id` field of `ActivityEntryResponse`; the runtime generates the session id and the server validates. → **Decision for this step:** generate uuidv7 via `@std/uuid/v7`; document the format in the capability spec; no separate validation in the runtime.
- **Should `expectedPromptName` be required?** Argument for: defence-in-depth against prompt mix-ups. Argument against: makes the cycle's parameter set bigger; engineer cycles always expect the engineer prompt, so the check is rarely useful. → **Decision for this step:** optional. Roles that want the check pass it (the engineer cycle in step 09 will pass `expectedPromptName: "engineer"`); the integration test does not.
- **Should we cap concurrent calls to `startCycle` per agent?** Step 08 owns scheduling; the cycle is stateless and can in principle be called concurrently with two agent ids. → **Decision for this step:** no cap. The cycle is stateless; concurrency safety is the scheduler's concern.
- **Should the runtime emit a heartbeat (`session_heartbeat` activity event) for long-running cycles?** A 30-minute cycle with no stdout would otherwise look "frozen" in the SPA. → **Decision for this step:** no. The SPA's "agent roster" already shows `last_active_at`; a heartbeat would be an additive change after the first long-running cycle is observed in practice. Step 09's engineer prompt will tell the agent to print intermediate progress; the activity log captures those lines.
- **Should the activity-log adapter's HTTP client timeout be configurable?** Network failures are rare on loopback. → **Decision for this step:** rely on `fetch`'s default behaviour (no client-side timeout). If a future test reveals stuck cycles waiting on `POST /activity`, add `RoleCycleParams.activityHttpTimeoutMs`.
- **Should the `terminate` utility return promised-or-throw on stuck SIGKILL?** Two ways to model: throw vs. return `{ kind: "spawn_failed", reason: "kernel_refused_kill" }`. → **Decision for this step:** throw. The cycle catches the throw and returns `spawn_failed` with the wrapped error; the surface stays clean.
