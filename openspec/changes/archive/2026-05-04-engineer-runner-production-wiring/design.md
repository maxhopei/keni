## Context

The orchestration server, scheduler, role-runtime cycle, engineer runner, subprocess invoker, workspace provisioner, MCP server, and typed HTTP client all exist and have passing test coverage. They were intentionally landed without a production composition root for the engineer runner — the `cli-start-and-end-to-end-wiring` change explicitly punted this in its design doc and `runServer.ts` carries the comment "the scheduler simply logs `runner.missing` on engineer ticks until a follow-up change wires the production coding-agent invoker."

The user-visible consequence today is straightforward: a project initialised via `keni init` and started via `keni start` provisions the engineer's workspace, ticks the cron schedule, but never picks up tickets. The dashboard reports the agent as idle; the activity log is silent.

The pieces this change has to compose:

- **Config layer.** `~/.keni/config.yaml` already accepts `coding_agent_cli: <name>` (`GlobalConfig.coding_agent_cli`). `<project>/.keni/project.yaml` already accepts a per-agent `cli: <name>` override (`AgentConfig.cli`). Neither value is read by anything at runtime today.
- **Invoker.** `createSubprocessCodingAgentInvoker(opts)` (`@keni/role-runtimes`) accepts `{ cliBinary, buildArgs, promptInjection, resumeFlag, envAllowlist }` and returns a `CodingAgentInvoker`.
- **Engineer runner.** `createEngineerRunner({ provisioner, codingAgentInvoker, activityHttpClient, logger }, { projectId, projectName, agentId, projectRepoPath, serverUrl, mcpServerConfig })` returns the `AgentRunner` value bag the scheduler hands to `startCycle`.
- **MCP server config.** `buildEngineerMcpServerConfig({ agentId, serverUrl, workspacePath, mcpEntryPath })` produces the `mcpServerConfig` the engineer subprocess hands its CLI.
- **HTTP client.** `createMcpHttpClient({ serverUrl, agentId })` from `@keni/server` already implements `listTickets(filter)` with the right envelope handling and identity headers; its surface is a superset of `EngineerActivityHttpClient`.
- **Composition root.** `runStart` (`packages/cli/src/start/mod.ts`) is the only place that sees both the loaded config and the `RunStartDeps` bag where `makeEngineerRunner` plugs in.

The constraint is to add the smallest possible amount of new code at the composition root, keep the boundaries clean (`@keni/role-runtimes` does not depend on `@keni/server`), and preserve the current "skip on missing config" behaviour with a clearer log message.

## Goals / Non-Goals

**Goals:**

- A `keni start` against a project whose effective config has `coding_agent_cli` set to a known CLI name registers an engineer runner per engineer agent and picks up tickets on the next scheduler tick.
- The CLI registry (`codingAgentCliRegistry`) is a closed table that ships with at least three known entries (`"claude"`, `"cursor-agent"`, `"codex"`); each entry documents its CLI binary name, `buildArgs`, `promptInjection`, `resumeFlag`, and `envAllowlist`.
- A missing or unknown CLI name produces a single `warn`-level `engineer.runner_skipped` log line per agent at boot, naming the agent id, the resolved CLI value (or `null`), and the documented set of supported names. Boot continues normally.
- The smoke test seam (`RunStartDeps.makeEngineerRunner`) is preserved verbatim; the test path that already injects a precheck-skip stub continues to work.
- No SPA / REST / WS surface change. No new third-party dependency. No filesystem-layout change.

**Non-Goals:**

- A SPA UI for editing `~/.keni/config.yaml` or `<project>/.keni/project.yaml`.
- Hot-reload of the CLI registration when config files change after `keni start`.
- Running multiple coding-agent CLIs per engineer agent (each agent maps to exactly one CLI).
- Auto-detecting the CLI from `$PATH` when neither config key is set (out of scope; an explicit config opt-in is the contract).
- Per-CLI authentication (each supported CLI handles its own auth via env vars; the env allowlist is the only seam).
- Adding new roles (this change is engineer-only — PO/QA wiring is a separate, later change).

## Decisions

### Decision 1: The CLI registry is a closed table in `@keni/role-runtimes`

The mapping from a CLI name (`"claude"`) to the spawn shape (`SubprocessCodingAgentInvokerOpts` minus `cliBinary` substituted with the CLI's executable name) lives in a new module `packages/role-runtimes/src/common/codingAgentCliRegistry.ts`. The exported value is a `Readonly<Record<KnownCli, CodingAgentCliEntry>>` where `KnownCli = "claude" | "cursor-agent" | "codex"`. The entry shape:

```ts
interface CodingAgentCliEntry {
  readonly cliBinary: string;                   // e.g. "claude"
  readonly buildArgs: (invocation, mcpConfigPath) => readonly string[];
  readonly promptInjection: "stdin" | "arg";
  readonly resumeFlag: string;
  readonly envAllowlist: readonly string[];
}
```

**Rationale.** A closed table — not a plugin loader, not a function pulled from config — keeps the supported set auditable, the typings tight, and the security surface small. New CLI support is an explicit code change with tests, not a filesystem fact. The `KnownCli` literal union also lets the `cli-start` validator reject an unknown name at boot with a precise message.

**Alternatives considered.**

- *Open string field with the CLI name.* Rejected: any typo in `~/.keni/config.yaml` (`claud`, `cursor_agent`) would silently fail with a generic "spawn_failed" much later. The closed union catches this at boot.
- *Plugin path / dynamic import.* Rejected: out of scope for the prototype; introduces a security surface and a debug surface (path resolution failures) we do not want yet.
- *Encoding the spawn shape in `~/.keni/config.yaml` itself (`{ cli: { binary, args, ... } }`).* Rejected: pushes implementation detail into user-edited YAML, makes it impossible to ship a CLI upgrade as a code-only change, and forces the user to know the MCP-config tempfile placeholder used by `buildArgs`.

### Decision 2: The composition helper lives in `@keni/cli`, not `@keni/role-runtimes`

A new file `packages/cli/src/start/engineerRunner.ts` exports `buildProductionEngineerRunnerFactory(deps)` which returns a `(input: MakeEngineerRunnerInput) => AgentRunner | null` closure. The closure: (1) reads the agent's `cli` from `agentConfig.cli`, falling back to the resolved global `coding_agent_cli`; (2) on `null` or unknown name, logs `engineer.runner_skipped` and returns `null`; (3) otherwise looks up the registry entry, calls `createSubprocessCodingAgentInvoker(...)`, builds an `EngineerActivityHttpClient` adapter wrapping `createMcpHttpClient(...)`, builds the `mcpServerConfig` via `buildEngineerMcpServerConfig(...)`, and calls `createEngineerRunner(...)`.

**Rationale.** `createMcpHttpClient` lives in `@keni/server`. Putting the helper in `@keni/role-runtimes` would force a new `@keni/role-runtimes → @keni/server` dependency edge, which the package boundary deliberately avoids (role-runtimes is engineer/PO/QA-agnostic and stays HTTP-shape-agnostic via `EngineerActivityHttpClient`). The helper is composition root code; it belongs in the CLI package alongside the other start-time wiring (`spaBundle.ts`, `loadConfig.ts`, `loadEnv.ts`).

**Alternatives considered.**

- *Put the helper in `@keni/server`.* Rejected: `@keni/server` does not depend on `@keni/cli` today, and reaching into `runStart` from the server's package would invert the dependency direction. The CLI is the only consumer; there is no second one.
- *Put the helper in a new shared `@keni/wiring` package.* Rejected: speculative generality. One consumer, one implementation, no need.

### Decision 3: `MCP_ENTRY_PATH` is exported as a `URL` constant from `@keni/server`

A new file `packages/server/src/mcpEntryPath.ts` exports

```ts
export const MCP_ENTRY_PATH = new URL("./mcp/main.ts", import.meta.url).pathname;
```

re-exported from the package's main entry. The CLI helper passes this verbatim to `buildEngineerMcpServerConfig`. Tests inject an override.

**Rationale.** Two reasons. First, the path needs to resolve at runtime no matter where the user invokes `keni start` from (cwd-independent). `import.meta.url` in the package guarantees that. Second, hard-coding `"packages/server/src/mcp/main.ts"` in the CLI helper would only work when the cwd is the monorepo root — which is the dev path but not the future packaged path. Centralising the constant in `@keni/server` makes a future binary-packaged distribution a one-line change.

**Alternatives considered.**

- *Resolve via `import.meta.resolve` from inside the CLI helper.* Rejected: requires the helper to know the package layout of `@keni/server`, which is exactly what the constant abstracts.
- *Pass the path as a config value.* Rejected: the path is not a user-tunable thing — it is an implementation detail of the orchestration server's distribution.

### Decision 4: Resolution order is per-agent → global → null (skip)

For each engineer agent, the helper resolves `cli` as:

1. `agentConfig.cli` (string from `<project>/.keni/project.yaml`).
2. Else `globalConfig.coding_agent_cli` (string from `~/.keni/config.yaml`).
3. Else `null` → log `engineer.runner_skipped` and return `null` (do not register).

When the resolved name is non-null but not in `codingAgentCliRegistry`, the helper logs the same `engineer.runner_skipped` line with `reason: "unknown_cli"` and the documented set of supported names, and returns `null`. The scheduler then continues to log `runner.missing` for that agent (one tick = one warn), unchanged.

**Rationale.** Mirrors the existing per-agent-overrides-global pattern documented in `AgentConfig.cli`'s JSDoc (`"Optional override for the global coding_agent_cli."`). The skip path preserves today's "boot succeeds even when no CLI is configured" UX so users with multiple projects on different agents don't see a mass failure on upgrade.

**Alternatives considered.**

- *Fail boot with exit 1 on missing CLI.* Rejected: too strict. A user starting `keni start` against a fresh project legitimately wants to inspect the dashboard, hand-create tickets, and configure the CLI later; they should not be blocked by exit-1.
- *Default to `"claude"` when no CLI is configured.* Rejected: silently picks one for the user. A future choice between Claude / Cursor / Codex should be deliberate; the warn line is the prompt.

### Decision 5: The scheduler-side log key changes from `runner.missing` to `engineer.runner_skipped` at boot

The scheduler keeps emitting `runner.missing` per tick (no change there). The new line is `engineer.runner_skipped` emitted **once per agent at boot**, with structured fields `{ agent: <id>, reason: "no_cli_configured" | "unknown_cli", configured_cli: <string | null>, supported: ["claude", "cursor-agent", "codex"] }`. The two log keys distinguish "I never registered a runner because of config" (boot, once) from "the registry has no runner" (every tick).

**Rationale.** The current single `runner.missing` line per tick is correct from the scheduler's perspective but unhelpful to the user — it doesn't say *why*. Adding the boot-time line gives the user a copy-pasteable hint exactly once, while preserving the per-tick observability the scheduler test suite already covers.

### Decision 6: The end-to-end test exercises a Deno-script "fake CLI" fixture

`packages/cli/tests/fixtures/fake-coding-agent.ts` already exists and is used by the role-runtime integration test. The new e2e test under `packages/cli/src/start/` extends `start_e2e_test.ts` (or a sibling file) to:

1. Bootstrap a temp project via `runInit`.
2. Write a `~/.keni/config.yaml` whose `coding_agent_cli` points to a *new* fixture-derived registry entry — added in the test only via a `RunStartDeps.codingAgentCliRegistryOverride` seam — so the production registry stays a closed `KnownCli` union but the test exercises the resolution + spawn path with a deterministic Deno script.
3. Drive `runStart` with a `FakeWorkspaceProvisioner`, the temp project, and a stubbed `EventBus` capturing `engineer.session_start` / `engineer.session_end` frames.
4. Assert: (a) on the first scheduler tick, `engineer.session_start` was emitted; (b) the fake CLI's stdout/stderr lines were forwarded to the activity log; (c) the test-injected shutdown signal terminates the cycle within `terminationGraceMs`; (d) `runStart` resolves to exit 0.

A separate test asserts the `engineer.runner_skipped` log line for an unconfigured agent, with no fixture spawned.

**Rationale.** Round-trips the entire wire from YAML → registry → invoker → child process → activity log against deterministic fixtures, so a regression anywhere in the wire breaks the test. Reuses the existing fake-CLI script to keep the new test surface small.

**Alternatives considered.**

- *Mock the invoker at the helper boundary.* Rejected: would only test the helper's resolution logic, not the actual end-to-end spawn. The whole point of this change is the spawn working.
- *Spin up the real `claude` / `cursor-agent` binary.* Rejected: makes the test environment-dependent and slow.

## Risks / Trade-offs

- **Risk:** A user sets `coding_agent_cli: claude` but the binary is not on `PATH`. → **Mitigation:** the subprocess invoker's existing `spawn_failed` path surfaces this as a `roleRuntime.spawn_failed` activity entry per cycle (already covered by `engineer-runtime` spec); the new boot path does not paper over it.
- **Risk:** A registry entry's `buildArgs` mis-encodes the MCP config flag for a CLI we don't have an integration test for, and the user discovers it at first run. → **Mitigation:** ship with `claude` only as the well-tested entry; mark `cursor-agent` and `codex` entries with a `coverage: "best-effort"` flag in their JSDoc and a follow-up task to add per-CLI integration tests (deferred, but tracked in `tasks.md` 6.1–6.2).
- **Risk:** The new `MCP_ENTRY_PATH` constant breaks when `@keni/server` is bundled into a single binary (the `import.meta.url` resolves into the binary, not a real file). → **Mitigation:** out-of-scope for this change (no binary distribution exists today); document in JSDoc that the constant is dev-mode-only, and a future binary-packaging change is responsible for replacing it with an embedded-asset extractor.
- **Trade-off:** Closed `KnownCli` union vs. open string. The closed union forces a code change to add a CLI; the win is type-checked configuration and a precise boot-time error message. The team can revisit if the CLI surface grows beyond a handful.

## Migration Plan

No data migration. No file-format change. Users on the prototype today are running `keni start` with no `coding_agent_cli` set in their global config — they will see the new `engineer.runner_skipped` warn line at boot and otherwise observe identical behaviour. Users who *do* set `coding_agent_cli: claude` (or one of the other supported names) will see their engineer agents start picking up tickets on the next tick after upgrade.

Rollback: revert the `runStart` line that defaults `makeEngineerRunner`. The new helper, registry, and tests can stay in the codebase without effect.

## Open Questions

- Should the warn line also fire when `agents` is empty (i.e. no engineers configured at all)? → Probably not; that is a "no engineers in the roster" case the scheduler already handles silently. Defer.
- Do we want a `keni doctor` subcommand that validates the resolved CLI is on `PATH` before `start`? → Out of scope; track as a follow-up if the support load justifies it.
