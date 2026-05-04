## Context

The `engineer-runner-production-wiring` change shipped a closed `codingAgentCliRegistry` with three entries (`claude`, `cursor-agent`, `codex`) that all share one MCP-config-materialisation strategy: write `{ mcpServers: { keni: ... } }` to `Deno.makeTempFile(...)` and pass the path via `--mcp-config <file>`. This was modelled against `claude`'s documented contract and assumed the other two CLIs accept the same flag spelling. They don't:

- `cursor-agent` (verified `v2026.04.15-dccdccd` on the maintainer's machine; [Cursor CLI MCP docs](https://cursor.com/docs/cli/mcp)) reads MCP servers from `<workspace>/.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global), with project taking precedence. Headless approval-prompt skipping is `--approve-mcps`. The CLI accepts `--workspace <path>` to override the discovery root.
- `codex` ([OpenAI Codex CLI MCP docs](https://developers.openai.com/codex/mcp); [openai/codex#9550](https://github.com/openai/codex/issues/9550) "not_planned") reads MCP servers from `~/.codex/config.toml` or `<project>/.codex/config.toml` under a `[mcp_servers.<name>]` table header. The documented per-session `-c key=value` overrides have known bugs ([openai/codex#16045](https://github.com/openai/codex/issues/16045) — `-c 'mcp_servers={}'` silently no-ops). The non-interactive subcommand is `codex exec`.
- `claude` ([Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference.md); installed `v1.0.2` verified locally) accepts `--mcp-config <file or string>`. The `v2.x` parser changed `--mcp-config` to variadic and the prompt-as-positional pattern broke; we use stdin so we're insulated, but the JSDoc should document the version-skew risk.

The user-visible failure surfaced when a maintainer set `coding_agent_cli: cursor-agent` globally and saw the engineer cycle exit immediately:

```
session_start ticket-0002 (in-flight)
subprocess_stderr   error: unknown option '--mcp-config'   stream_kind: stderr
session_end         exit_code: 1
```

The original change explicitly tagged `cursor-agent` and `codex` `coverage: "best-effort"` and tracked the integration-test follow-up in `engineer-runner-production-wiring/tasks.md#6.1` and `#6.2` exactly to bound this risk. This change closes the substantive bug in the entries and lays the seam needed for any future CLI whose MCP-config contract is "discover from a known path inside the workspace" rather than "accept an arbitrary path on argv".

The maintainer also asked for a structural cleanup: with three entries and no shared logic, putting each entry inline in `codingAgentCliRegistry.ts` makes the file rigid against fourth-CLI additions (and reading any one entry's argv shape requires scrolling through the others). One file per CLI keeps the abstract types in one place and the per-CLI config in single-purpose modules.

## Goals / Non-Goals

**Goals:**

- A `keni start` against a project whose `coding_agent_cli` is `cursor-agent` actually runs an engineer cycle: the subprocess spawns, loads the keni MCP server, executes a tick, and the activity log shows the documented frames (no `unknown option '--mcp-config'` stderr).
- The same fix shape covers `codex` modulo binary availability — a future user configuring `codex` does not hit a class of failure we already know how to fix.
- The registry's per-CLI logic is a single-file diff per CLI; adding a fourth CLI is a four-step contract: add a per-CLI module, register it in `codingAgentCliRegistry.ts`, extend `KnownCli`, add a registry test scenario.
- The MCP-config-materialisation seam is a value-typed discriminated union (no closures inside the entry) so the registry stays declarative and a structural test can pin the closed set of strategies.
- The default subprocess invoker spawns the engineer's CLI with `cwd` set to the per-agent workspace, matching the existing `KENI_MCP_WORKSPACE` env-var semantics and giving file-discovery-based CLIs (cursor-agent, codex) a stable root.
- A user with their own `<workspace>/.cursor/mcp.json` (committed in the project repo, present in the per-agent sparse-checkout clone) keeps their MCP servers — the keni entry is merged, not stomped.
- One real integration test against the `cursor-agent` binary lands in this change (gated on binary availability) so CI without the binary still passes and the maintainer's local run exercises the full path.

**Non-Goals:**

- A real integration test against the `codex` binary. Out of scope here for the same reason `engineer-runner-production-wiring/tasks.md#6.2` deferred it: the binary is not on the maintainer's machine and acquiring an OpenAI account / billing for a CI integration test is its own concern. The structural test pins the modelled argv and the strategy `kind`; the JSDoc documents the doc-source the entry was modelled against.
- Hot-reloading the registry when `~/.keni/config.yaml` changes after `keni start`. Same posture as the prior change.
- Restoring the prior contents of `<workspace>/.cursor/mcp.json` / `<workspace>/.codex/config.toml` after the engineer cycle exits. The per-agent workspace is keni-managed (`~/.keni/workspaces/<project>/<agent>/`), not user-edited. Leaving the merged file in place across cycles is correct: the next cycle re-merges idempotently and the user never reads from the workspace directly.
- Supporting `cursor-agent`'s `~/.cursor/mcp.json` global path. Touching the user's home directory is invasive; the workspace-scoped strategy is sufficient and isolates per-agent state.
- A SPA UI for editing the per-CLI MCP config or for selecting the strategy. The strategy is bound at registry-entry time, not at config time — there is nothing to surface.
- Auto-detecting the CLI version at runtime to pick a strategy variant (e.g. claude v1 vs v2). The variadic-argument issue is sidestepped by stdin; future skew, if it matters, is a JSDoc change in the per-CLI module.

## Decisions

### Decision 1: A value-typed `McpConfigStrategy` discriminated union, not a closure on the entry

The CLI registry entry's MCP-config strategy is a value type:

```ts
export type McpConfigStrategy =
  | { readonly kind: "tempfile-json" }
  | {
      readonly kind: "workspace-json";
      readonly relativePath: string;
      readonly mergeKey: string;
      readonly entryName: string;
    }
  | {
      readonly kind: "workspace-toml";
      readonly relativePath: string;
      readonly tableHeader: string;
      readonly entryName: string;
    };

export interface CodingAgentCliEntry {
  readonly cliBinary: string;
  readonly buildArgs: (
    invocation: CodingAgentInvocation,
    mcpConfigPath: string,
  ) => readonly string[];
  readonly promptInjection: "stdin" | "arg";
  readonly resumeFlag: string;
  readonly envAllowlist: readonly string[];
  readonly mcpConfigStrategy: McpConfigStrategy;
}
```

The strategy executor lives in the invoker module (`codingAgentInvoker.ts`), not in the entry. Per-strategy behaviour:

| `kind` | Path | Write | Cleanup | Notes |
|---|---|---|---|---|
| `tempfile-json` | `Deno.makeTempFile({ prefix: "keni-mcp-", suffix: ".json" })` | `JSON.stringify({ mcpServers: { keni: invocation.mcpServerConfig } })` | `Deno.remove` in `finally` | Existing default; used by `claude`. |
| `workspace-json` | `joinPath(invocation.workspacePath, relativePath)` | Read existing file (or empty `{}`); ensure `parsed[mergeKey]` is an object; set `parsed[mergeKey][entryName] = invocation.mcpServerConfig`; pretty-print via `JSON.stringify(parsed, null, 2)`; `Deno.writeTextFile` | None — file is in keni's per-agent workspace and re-merged idempotently. | Used by `cursor-agent`. |
| `workspace-toml` | `joinPath(invocation.workspacePath, relativePath)` | Read existing TOML (or empty `""`); parse via `@std/toml`; set `parsed[tableHeader][entryName] = invocation.mcpServerConfig`; serialize via `@std/toml`; `Deno.writeTextFile` | None — same rationale as workspace-json. | Used by `codex`. |

The two workspace strategies share a precondition: `invocation.workspacePath !== null`. The strategy executor SHALL throw `RoleRuntimeError("workspace_required_for_strategy", { kind })` when this precondition is violated; the engineer runner's existing precondition (every engineer cycle has a workspace) means this is unreachable in production but is exercised by the unit test for the strategy executor.

Why a value type and not a closure?

- Auditability: every CLI's strategy is visible at a glance in its module, no `() => Promise<...>` to read.
- Testability: a structural test enumerates the closed set of `kind`s; adding a fourth strategy is a deliberate type-system change.
- Decoupling: the per-CLI module imports nothing from the role-runtime cycle; the strategy executor lives next to `Deno.Command`. This matches the existing "registry entry is a strict subset of `SubprocessCodingAgentInvokerOpts`" property.

**Alternatives considered:**

- *Closure-on-entry (`materializeMcpConfig: (invocation) => Promise<{ path; cleanup; }>`).* Rejected: opaque to readers (every entry's strategy hidden behind a function body), harder to test exhaustively (must call the closure to know what it does), and entries would diverge in invariants we'd then have to re-check at every read site (the structural test would have to spawn a fake invocation).
- *A `match`-style sum type on the strategy kind only (`kind: "tempfile" | "workspace-json" | ...`) with the rest of the config in entry-level fields.* Rejected: the per-strategy fields (`relativePath`, `mergeKey`, `tableHeader`) only make sense for one strategy; conflating them on the entry leaks irrelevant fields. The discriminated union is the precise tool.

### Decision 2: Per-CLI modules under `codingAgentClis/`, registry as the assembly point

The new layout is:

```
packages/role-runtimes/src/common/
├── codingAgentCliRegistry.ts        # types, KnownCli union, isKnownCli, registry constant
├── codingAgentCliRegistry_test.ts   # registry-shape and structural tests
├── codingAgentClis/
│   ├── claude.ts                    # claudeEntry constant + JSDoc
│   ├── cursorAgent.ts               # cursorAgentEntry constant + JSDoc
│   └── codex.ts                     # codexEntry constant + JSDoc
├── codingAgentInvoker.ts            # createSubprocessCodingAgentInvoker + strategy executor
└── ...
```

`codingAgentCliRegistry.ts` keeps:

- The `McpConfigStrategy` discriminated union.
- The `CodingAgentCliEntry` interface.
- The `KnownCli` literal union (`"claude" | "cursor-agent" | "codex"`).
- The `isKnownCli` type guard.
- The `codingAgentCliRegistry` constant — assembled by importing each per-CLI module and binding it to its `KnownCli` key.

Per-CLI modules export exactly one `CodingAgentCliEntry` constant. They SHALL NOT import each other. They MAY import the abstract types from `codingAgentCliRegistry.ts` and primitive helpers from `@std/path` (for any `joinPath` they want to do at construction time, though the strategy union is value-only and discourages this). The structural test in `codingAgentCliRegistry_test.ts` SHALL assert that `Object.keys(codingAgentCliRegistry).sort() === ["claude", "codex", "cursor-agent"]` and that each entry shape conforms to `CodingAgentCliEntry`.

**Alternatives considered:**

- *Keep everything inline in `codingAgentCliRegistry.ts`.* Rejected by the maintainer's explicit ask. Three entries are already at the threshold where reading any one of them requires scrolling past the others.
- *One file per CLI plus a barrel `codingAgentClis/mod.ts` that re-exports.* Rejected as ceremony: the registry constant is the only place that aggregates the entries, and it already imports each per-CLI module by name; an intermediate barrel adds an indirection with no benefit.
- *Generate the registry from a directory scan (`for (const file of Deno.readDirSync("./codingAgentClis"))`).* Rejected: dynamic registry assembly defeats the closed-table property and breaks `isKnownCli`'s exhaustiveness.

### Decision 3: Set the subprocess `cwd` to the per-agent workspace

The default subprocess invoker SHALL pass `cwd: invocation.workspacePath ?? undefined` to `new Deno.Command(...)`. When `workspacePath` is `null` (the test-only path; production engineer cycles always set it), `cwd` falls through to the parent's cwd (today's behaviour).

Why:

- `cursor-agent` discovers `<cwd>/.cursor/mcp.json` from its working directory (and from `--workspace <path>` when supplied). We use the explicit flag for cursor-agent, but setting `cwd` matches the spirit of the discovery contract and avoids a class of "discovered the wrong file" surprises.
- `codex` discovers `<cwd>/.codex/config.toml` from its working directory. There is no `--workspace`-equivalent flag we trust on `codex` (the `-c` overrides are buggy), so `cwd` is the only seam.
- The engineer's filesystem operations (the LLM's edits) land in the per-agent workspace by default, matching the existing `KENI_MCP_WORKSPACE` env-var contract and the `WorkspaceProvisioner.workspacePathFor(...)` semantics.

**Alternatives considered:**

- *Leave `cwd` to the parent process and require every CLI to support an explicit "use this dir as the project" flag.* Rejected: `codex` has no such flag.
- *Per-CLI `cwd` in the strategy union.* Rejected: every supported CLI wants the workspace as cwd, so the per-strategy field would be redundant. If a future CLI needs a different cwd (unlikely), promote `cwd` into the entry shape at that time.

### Decision 4: Merge into existing `<workspace>/.cursor/mcp.json` (and `.codex/config.toml`), don't restore on cleanup

The user's per-agent workspace is a sparse-checkout clone of the project repo (see `engineer-runtime` spec, `WorkspaceProvisioner`). The sparse-checkout pattern excludes `.keni/`, not `.cursor/` or `.codex/`. So if the user has committed `.cursor/mcp.json` to their project repo, the per-agent workspace ships with it.

The strategy executor SHALL:

- Read the existing file via `Deno.readTextFile`. If `Deno.errors.NotFound`, treat as empty (`{}` for JSON, `""` for TOML).
- Parse the contents (`JSON.parse` / `parseToml`).
- Validate that the parsed value is a plain object (not `null`, not an array). If validation fails, throw `RoleRuntimeError("mcp_config_corrupt", { path, kind })` so the cycle surfaces it as `spawn_failed` and the user sees a clear message.
- Ensure `parsed[mergeKey]` (or `parsed[tableHeader]` for TOML) is a plain object; create it if absent, error if it exists with a non-object type.
- Set `parsed[mergeKey][entryName] = invocation.mcpServerConfig` (overwriting any prior `keni` entry — this is intentional; the prior entry is from a previous keni run and is necessarily stale).
- Write the file back via `Deno.writeTextFile`. JSON output uses `JSON.stringify(parsed, null, 2)` to keep diffs readable; TOML output uses `@std/toml`'s default serializer.

Cleanup is a no-op for both workspace strategies. Rationale:

- The merged file lives in keni's per-agent workspace, which is not user-visible (lives at `~/.keni/workspaces/<projectId>/<agentId>/`).
- Re-running the cycle re-merges idempotently — the keni entry is overwritten with itself plus the latest `serverUrl` / `agentId` (which can change if the orchestration server moves ports across `keni start` invocations).
- Restoring would require capturing the prior file contents in memory and writing them back on `finally`, which has subtle race conditions with concurrent cycles for sibling agents (rare, but the engineer-runner factory runs once per agent at boot — a future change introducing a per-agent cycle queue could violate this).

**Alternatives considered:**

- *Overwrite the file with only the keni entry.* Rejected: a user committing `.cursor/mcp.json` with their own MCP servers (e.g. a team-wide playwright MCP) loses them in the per-agent workspace. Even though the per-agent workspace is keni-managed, the user expects committed config to flow through to the engineer.
- *Restore prior contents on cycle exit.* Rejected as above.
- *Write to a sibling path (`<workspace>/.cursor/mcp.keni.json`) and configure `cursor-agent` to read from it.* Rejected: `cursor-agent` does not support arbitrary MCP-config paths (the whole reason for this change).

### Decision 5: Skip-when-binary-absent integration test for `cursor-agent` only

The integration test under `packages/role-runtimes/tests/integration/cursorAgent_test.ts` SHALL:

- Detect `cursor-agent` on `PATH` via `Deno.Command("which", { args: ["cursor-agent"] })` (or `where` on Windows). If absent, register the test via `Deno.test.ignore("...", ...)` with a clear ignore-reason.
- When present: spin up a tiny in-process MCP server that records every `tools/list` call (via a Deno `serveHttp` listener bound to `127.0.0.1:0`).
- Override `HOME` to a fresh `Deno.makeTempDir({ prefix: "keni-cursor-it-home-" })` so the test does not touch the maintainer's real `~/.cursor/`.
- Provision a fake per-agent workspace under that fake `HOME`, write a stub `.cursor/mcp.json` that already contains a sibling entry (to exercise the merge), then drive the registry entry through `createSubprocessCodingAgentInvoker(...)` with a one-shot prompt that asks the agent to call `tools/list`.
- Assert the in-process MCP server saw the keni `tools/list` call within a documented timeout, and assert the post-run `<workspace>/.cursor/mcp.json` contains both the sibling entry and the keni entry (merge worked).

The same shape SHALL NOT land for `codex` — the binary is not on the maintainer's machine and the OpenAI billing dependency makes CI gating impractical. The follow-up `engineer-runner-production-wiring/tasks.md#6.2` remains open.

**Alternatives considered:**

- *Always require `cursor-agent` on `PATH` and fail the test suite when absent.* Rejected: would break CI on any machine without the binary, including the existing CI we already run for the other tests.
- *Use a sandboxed mock binary for the integration test.* Rejected: defeats the purpose of an integration test against the real CLI; the unit tests already exercise the modelled argv shape against fakes.

### Decision 6: Migration for the existing `mcpConfigPathBuilder` opt

`createSubprocessCodingAgentInvoker(opts)` today exposes an optional `mcpConfigPathBuilder?: (invocation) => Promise<string>` that lets a caller override the tempfile path. No production caller uses it; only the test in `codingAgentInvoker_test.ts` does (it injects a fake builder so the test doesn't write to `${TMPDIR}`).

The migration:

- Drop `mcpConfigPathBuilder` from `SubprocessCodingAgentInvokerOpts`. Add `mcpConfigStrategy: McpConfigStrategy` instead.
- The unit test that injected `mcpConfigPathBuilder` is rewritten to inject a `tempfile-json` strategy and assert the executor calls `Deno.makeTempFile` exactly once. The structural-test wedge `tempfilePathOverrideForTesting?: (invocation) => Promise<string>` is added as an explicit test seam to the strategy executor (not to the registry entry) so the test path doesn't pollute the production opt shape.

This is a breaking change to `SubprocessCodingAgentInvokerOpts`, but the type is exported only from `@keni/role-runtimes` and is consumed by exactly two call sites (`createSubprocessCodingAgentInvoker` itself and the test). No external consumer of the package exists yet.

**Alternatives considered:**

- *Keep `mcpConfigPathBuilder` and add `mcpConfigStrategy` alongside.* Rejected: two seams with overlapping responsibilities is exactly the trap that produced the cursor-agent bug. The strategy is sufficient for every supported and forseeable CLI.

## Risks / Trade-offs

- **Risk:** `cursor-agent v2026.04.15-dccdccd`'s `--workspace <path>` flag could be removed or renamed in a future version. → **Mitigation:** the integration test asserts the flag against the actually-installed binary; a future CLI update that breaks this surfaces as a failing test on the maintainer's machine before it hits any user. Document the version the entry was modelled against in the per-CLI module's JSDoc (we already have `coverage` tags from the prior change).

- **Risk:** A user's existing `<workspace>/.cursor/mcp.json` may have an `mcpServers` field that is not a plain object (an array, a primitive). The merge strategy errors loudly, but the user's first experience is `RoleRuntimeError("mcp_config_corrupt", ...)`. → **Mitigation:** the error message names the file path and the offending shape; the error surfaces in the activity log as `spawn_failed` per the existing role-runtime contract, and the README's "Configure the coding-agent CLI" section gets a note about expected `.cursor/mcp.json` shape.

- **Risk:** `@std/toml`'s serializer might re-format the user's existing TOML in a way that changes whitespace / ordering. → **Mitigation:** the workspace `.codex/config.toml` lives in keni's per-agent workspace, not the user's project repo. Re-formatting there is invisible to the user. The integration test follow-up (deferred) will cover round-trip fidelity if it matters in practice.

- **Risk:** Setting `cwd` to the per-agent workspace changes a behaviour that has not been pinned in tests. Existing `claude`-based smoke tests assumed the cwd was the parent process's cwd. → **Mitigation:** the existing engineer-runner integration test (`integration_test.ts`) uses a `Deno.makeTempDir`-backed workspace and a fake CLI binary that is cwd-agnostic; the change is observable only via a new `cwd: ...` assertion in `codingAgentInvoker_test.ts`. The README documents the cwd contract under "Configure the coding-agent CLI".

- **Risk:** Two engineer cycles for sibling agents could race on the same `~/.keni/workspaces/<projectId>/<other-agent>/.cursor/mcp.json` if a future change ever shares workspaces. → **Mitigation:** the current `WorkspaceProvisioner.workspacePathFor(projectId, agentId)` contract guarantees a per-agent path; sharing workspaces across agents is a non-goal of the project. The per-CLI module's JSDoc cross-references this guarantee.

- **Trade-off:** This change touches two capability specs (`engineer-runtime`, `role-runtime`) where the prior change touched only `engineer-runtime` and `cli-start`. The blast radius is acceptable because both deltas are purely additive (per-CLI argv shapes; an explicit strategy union and a `cwd` requirement) and the existing test seams stay intact.

## Migration Plan

1. Land the modular registry refactor (Decision 2) without changing semantics: split the existing inline entries into per-CLI modules, keep the same (broken) argv shapes for `cursor-agent` and `codex`. Tests stay green.
2. Land the `McpConfigStrategy` plumbing (Decision 1) with `claude` switched to `tempfile-json` (the default; semantic-equivalent). Tests stay green.
3. Land the `cwd` plumbing (Decision 3). Tests stay green; the new test asserts the cwd value.
4. Switch `cursor-agent` to `workspace-json` and the new argv shape (Decision 4). The unit test for the cursor-agent entry is updated. The integration test (Decision 5) is added.
5. Switch `codex` to `workspace-toml` and the new argv shape. The unit test is updated; no integration test lands.

The five steps could collapse into one PR but are listed in order so a reviewer can follow the diff. There is no production rollback path other than `git revert` — `keni` ships from a single binary built from a single commit; the registry is compiled in.

## Open Questions

- **OQ-1:** Should the per-CLI modules also pin a minimum `--version` of their CLI and emit a warn-level log line at boot when the resolved binary's version is older? This is a quality-of-life follow-up; the prior change deferred it explicitly. Current answer: no, defer (resolves naturally via `keni doctor` post-MVP).

- **OQ-2:** Does `cursor-agent`'s `--workspace <path>` flag override only the MCP-discovery root or the entire workspace concept (where the agent edits files)? The CLI help says "Workspace directory to use (defaults to current working directory)". We assume the second meaning (it sets cwd-equivalent for the agent). The integration test will verify by writing a sentinel file and asserting the agent edits it. If the flag turns out to override only MCP discovery, we drop it and rely solely on the `cwd:` plumbing from Decision 3.

- **OQ-3:** Does setting `cwd` for `claude` affect any existing assumption (e.g. `claude` reads project-rooted `.claude/` config)? The prior change's e2e test uses a fake CLI fixture, not the real `claude` binary, so the answer is "no test today either way". We assume `cwd:` is a no-op for `claude` semantics; the maintainer's local probe (running against the real `claude` binary) will confirm.
