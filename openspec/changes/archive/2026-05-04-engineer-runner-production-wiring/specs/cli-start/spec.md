## ADDED Requirements

### Requirement: `runStart` defaults `RunStartDeps.makeEngineerRunner` to a production helper that resolves the configured coding-agent CLI

When the caller of `runStart` does not supply `RunStartDeps.makeEngineerRunner`, `runStart` SHALL construct a default factory by calling `buildProductionEngineerRunnerFactory(...)` exported from `packages/cli/src/start/engineerRunner.ts` and pass that factory verbatim through `RunServerDeps.makeEngineerRunner` to `runServer`. The helper SHALL receive: the loaded `ResolvedConfig` (so it can read `coding_agent_cli`); the `codingAgentCliRegistry` from `@keni/role-runtimes`; the `MCP_ENTRY_PATH` constant from `@keni/server`; a function returning a fresh `EngineerActivityHttpClient` for a given `(serverUrl, agentId)` (the production wiring uses `createMcpHttpClient`); and the `WorkspaceLogger` adapter built around the scheduler logger that `runServer` already constructs. The helper's returned closure SHALL be stateless across invocations (registering one engineer's runner SHALL NOT mutate any state observable to a sibling engineer's call). The closure SHALL NOT throw on construction or on resolution; the only success outcomes are "return a registered `AgentRunner`" or "return `null` (skip)".

The seam supplied by tests (a `RunStartDeps.makeEngineerRunner` injected by `start_e2e_test.ts` or any caller) SHALL continue to win over the production default — `runStart` SHALL only consult the production helper when the field is `undefined` on the supplied `RunStartDeps`.

#### Scenario: Production wiring resolves a configured CLI and registers a runner

- **WHEN** `runStart` is invoked against a project whose effective config (project shallow-merged over global) carries `coding_agent_cli: "claude"` and the agent has no per-agent `cli` override
- **AND** the caller does not supply `RunStartDeps.makeEngineerRunner`
- **THEN** the production helper SHALL look up the entry for `"claude"` in `codingAgentCliRegistry`
- **AND** SHALL construct a `CodingAgentInvoker` via `createSubprocessCodingAgentInvoker(opts)` with the entry's `cliBinary`, `buildArgs`, `promptInjection`, `resumeFlag`, and `envAllowlist`
- **AND** SHALL build the engineer's `mcpServerConfig` via `buildEngineerMcpServerConfig({ agentId, serverUrl, workspacePath, mcpEntryPath: MCP_ENTRY_PATH })`
- **AND** SHALL build the engineer's `EngineerActivityHttpClient` over `createMcpHttpClient({ serverUrl, agentId })`
- **AND** SHALL pass all of the above to `createEngineerRunner(...)` and return the resulting `AgentRunner` from the closure
- **AND** the scheduler SHALL register the returned runner so the next engineer tick proceeds through the runner's precheck instead of logging `runner.missing`

#### Scenario: Per-agent `cli` overrides the global `coding_agent_cli`

- **WHEN** the global config sets `coding_agent_cli: "claude"`
- **AND** the project config's `agents[0].cli` is `"cursor-agent"`
- **THEN** the production helper SHALL resolve the agent's CLI to `"cursor-agent"` and look up that entry in `codingAgentCliRegistry`
- **AND** the resulting `CodingAgentInvoker` SHALL be constructed from the `"cursor-agent"` registry entry, not the `"claude"` one

#### Scenario: A test-supplied `makeEngineerRunner` wins over the production default

- **WHEN** a caller invokes `runStart` with `deps.makeEngineerRunner` set (the existing test seam)
- **THEN** `runStart` SHALL forward the caller's factory verbatim to `runServer`
- **AND** SHALL NOT call `buildProductionEngineerRunnerFactory(...)`
- **AND** the smoke test that injects a precheck-skip stub SHALL continue to pass without modification

### Requirement: The production engineer-runner helper logs `engineer.runner_skipped` and skips registration when the CLI is missing or unknown

When the resolved CLI for an engineer agent is `null` (neither the project's per-agent `cli` nor the global `coding_agent_cli` is set), or non-null but absent from `codingAgentCliRegistry`, the helper's closure SHALL: (1) call `logger.log("warn", "engineer.runner_skipped", { agent, reason, configured_cli, supported })` exactly once for that agent, where `reason` is `"no_cli_configured"` for the null case and `"unknown_cli"` for the unknown-name case, `configured_cli` is the resolved name (or `null`), and `supported` is the closed list of names from `codingAgentCliRegistry`; (2) return `null` from the closure so no runner is registered; (3) NOT throw, NOT mutate any global state, and NOT prevent the boot from completing.

The scheduler's existing per-tick `runner.missing` log line SHALL continue to fire for the affected agent on every tick, unchanged. The two log keys are intentionally distinct: `engineer.runner_skipped` is a single boot-time line per agent that names the config gap; `runner.missing` is a per-tick line that names the consequence.

#### Scenario: No CLI configured anywhere logs `engineer.runner_skipped` once at boot

- **WHEN** `runStart` is invoked against a project whose `~/.keni/config.yaml` and `<project>/.keni/project.yaml` both omit `coding_agent_cli` / per-agent `cli`
- **AND** the project's roster has one engineer agent `alice`
- **THEN** the helper's closure logs exactly one `warn`-level line with event `engineer.runner_skipped`, fields `{ agent: "alice", reason: "no_cli_configured", configured_cli: null, supported: ["claude", "cursor-agent", "codex"] }`
- **AND** returns `null` so no runner is registered
- **AND** `runStart` boot completes successfully (exit code path unaffected)
- **AND** the scheduler's subsequent `runner.missing` log lines fire once per tick, unchanged

#### Scenario: An unknown CLI name logs `engineer.runner_skipped` with `unknown_cli`

- **WHEN** `~/.keni/config.yaml` sets `coding_agent_cli: "claud"` (typo)
- **THEN** the helper's closure logs exactly one `warn`-level line with event `engineer.runner_skipped`, fields `{ agent: "alice", reason: "unknown_cli", configured_cli: "claud", supported: ["claude", "cursor-agent", "codex"] }`
- **AND** returns `null` so no runner is registered
- **AND** the supported-name list in the log payload helps the user spot the typo

#### Scenario: A configured but unsupported CLI per agent skips that agent only

- **WHEN** the project roster has two engineers, `alice` (per-agent `cli: "claude"`) and `bob` (per-agent `cli: "homebrew-toy"` not in the registry)
- **THEN** the helper registers a runner for `alice` (using the `"claude"` registry entry)
- **AND** logs `engineer.runner_skipped` with `agent: "bob", reason: "unknown_cli"` and skips registration for `bob`
- **AND** the boot continues; `alice` picks up tickets, `bob` does not

### Requirement: An end-to-end test exercises the production wiring against a fake CLI fixture

The repository SHALL contain a Deno test under `packages/cli/src/start/` (extending `start_e2e_test.ts` or in a sibling file `engineerRunner_e2e_test.ts`) that boots `runStart` against a temp-dir fixture pre-populated by `runInit`, with: (1) a `~/.keni/config.yaml` that names a CLI registered via a test-only override on `RunStartDeps` (the production `KnownCli` union remains closed); (2) a `FakeWorkspaceProvisioner` so no real git is touched; (3) a `MakeEngineerRunnerInput` whose returned runner spawns the existing fixture script `packages/role-runtimes/tests/fixtures/fake-coding-agent.ts` (or an equivalent fake) under `Deno.Command`. The test SHALL assert that the first engineer tick produces an `engineer.session_start` event frame on the captured event bus, that the test-injected `AbortSignal` cleanly terminates the in-flight cycle, and that `runStart` resolves to exit code 0.

A second Deno test SHALL boot `runStart` against a project whose effective config does NOT set `coding_agent_cli` and SHALL assert that the captured scheduler logger received exactly one `engineer.runner_skipped` warn entry for the configured engineer agent, that no `CodingAgentInvoker` was constructed (no `Deno.Command` was spawned), and that `runStart` resolves to exit code 0.

#### Scenario: Configured CLI registers a runner that picks up a ticket on the first tick

- **WHEN** the e2e test boots `runStart` with `coding_agent_cli` pointing at a test-only registry entry whose `cliBinary` is the fake-coding-agent script
- **AND** an `open` ticket is `POST`-ed to `/tickets` before the first tick
- **THEN** the captured event bus observes an `engineer.session_start` frame with `agent: "alice"` and the new ticket's id in `payload.ticket_id`
- **AND** the activity log captures the fake CLI's stdout/stderr lines via the role-runtime cycle's existing per-line forwarding
- **AND** the test-injected shutdown signal cleanly terminates the cycle within `terminationGraceMs`
- **AND** `runStart` resolves to exit code 0

#### Scenario: No CLI configured produces the documented warn line and skips registration

- **WHEN** the e2e test boots `runStart` against a project whose effective config does NOT set `coding_agent_cli` and whose engineer agent has no per-agent `cli` override
- **THEN** the captured scheduler logger contains exactly one `warn`-level entry with event `engineer.runner_skipped` and `agent: "alice"`
- **AND** no `Deno.Command` is constructed (no subprocess is spawned)
- **AND** `runStart` resolves to exit code 0
