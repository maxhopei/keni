## MODIFIED Requirements

### Requirement: `runStart` assembles the polymorphic `roleWires` registry from role packages and passes it to `runServer`

When the caller of `runStart` does not supply `RunStartDeps.roleWires`, `runStart` SHALL construct a default `roleWires: Readonly<Record<string, WireFn>>` registry by importing each role package's exported `wire` function and binding it under the role's string key. At minimum, the default registry SHALL bind:

- `"engineer"` → `wire` from `@keni/runtime-engineer`.
- `"po"` → `wire` from `@keni/runtime-po`.

The default registry SHALL be constructed once per `runStart` invocation. `runStart` SHALL pass the registry verbatim through `RunServerDeps.roleWires` to `runServer`. The legacy `RunStartDeps.makeEngineerRunner` and `MakeEngineerRunnerInput` types are removed; their function is subsumed by the role-package-exported `wire` functions and the polymorphic `WireInput` shape from `@keni/runtime-common`.

When the caller of `runStart` supplies `RunStartDeps.roleWires`, the supplied registry SHALL win over the production default — `runStart` SHALL forward the caller's value verbatim to `runServer` and SHALL NOT import any role package's `wire` symbol on that path. This is the test seam the e2e tests rely on (a fake engineer wire, a fake PO wire, a custom registry merging fixtures with production wires) and replaces the previous `makeEngineerRunner` seam.

#### Scenario: Default `roleWires` registers engineer and PO wires

- **WHEN** `runStart` is invoked without supplying `RunStartDeps.roleWires`
- **THEN** the value passed through to `runServer` as `RunServerDeps.roleWires` is a `Record<string, WireFn>` whose keys are exactly `["engineer", "po"]`
- **AND** `roleWires.engineer` is the `wire` symbol exported from `@keni/runtime-engineer`
- **AND** `roleWires.po` is the `wire` symbol exported from `@keni/runtime-po`

#### Scenario: Production engineer wire resolves a configured CLI and registers a runner

- **WHEN** `runStart` is invoked against a project whose effective config (project shallow-merged over global) carries `coding_agent_cli: "claude"` and the agent has no per-agent `cli` override
- **AND** the caller does not supply `RunStartDeps.roleWires`
- **THEN** the engineer wire's invocation SHALL look up the entry for `"claude"` in `codingAgentCliRegistry` (passed via `WireInput.codingAgentCliRegistry`)
- **AND** SHALL construct a `CodingAgentInvoker` via `createSubprocessCodingAgentInvoker(opts)` with the entry's `cliBinary`, `buildArgs`, `promptInjection`, `resumeFlag`, and `envAllowlist`
- **AND** SHALL build the engineer's `mcpServerConfig` via `buildEngineerMcpServerConfig({ agentId, serverUrl, workspacePath, mcpEntryPath: WireInput.mcpEntryPath })`
- **AND** SHALL build an `ActivityHttpClient` via `WireInput.makeActivityHttpClient(serverUrl, agentId)`
- **AND** SHALL pass all of the above to `createEngineerRunner(...)` and return the resulting `AgentRunner`
- **AND** the scheduler SHALL register the returned runner so the next engineer tick proceeds through the runner's precheck instead of logging `runner.missing`

#### Scenario: Per-agent `cli` overrides the global `coding_agent_cli`

- **WHEN** the global config sets `coding_agent_cli: "claude"`
- **AND** the project config's `agents[0].cli` is `"cursor-agent"`
- **THEN** the engineer wire SHALL resolve the agent's CLI to `"cursor-agent"` and look up that entry in `codingAgentCliRegistry`
- **AND** the resulting `CodingAgentInvoker` SHALL be constructed from the `"cursor-agent"` registry entry, not the `"claude"` one

#### Scenario: A test-supplied `roleWires` wins over the production default

- **WHEN** a caller invokes `runStart` with `deps.roleWires = { engineer: <fakeEngineerWire>, po: <fakePoWire> }`
- **THEN** `runStart` SHALL forward the caller's registry verbatim to `runServer`
- **AND** SHALL NOT import `wire` from `@keni/runtime-engineer` or `@keni/runtime-po`
- **AND** the smoke test that injects fake wires SHALL continue to pass without modification (modulo the `makeEngineerRunner → roleWires` field rename)

### Requirement: The engineer wire logs `engineer.runner_skipped` and returns `null` when the CLI is missing or unknown

When the resolved CLI for an engineer agent is `null` (neither the project's per-agent `cli` nor the global `coding_agent_cli` is set), or non-null but absent from `codingAgentCliRegistry`, the engineer `wire(input)` function from `@keni/runtime-engineer` SHALL: (1) call `input.logger.log("warn", "engineer.runner_skipped", { agent, reason, configured_cli, supported })` exactly once for that agent, where `reason` is `"no_cli_configured"` for the null case and `"unknown_cli"` for the unknown-name case, `configured_cli` is the resolved name (or `null`), and `supported` is the closed list of names from `input.codingAgentCliRegistry`; (2) return `null` from the wire so no runner is registered; (3) NOT throw, NOT mutate any global state, and NOT prevent the boot from completing.

The orchestration server's per-agent `runner.skipped` log line SHALL fire once for the affected agent at boot when the wire returns `null`. The scheduler's existing per-tick `runner.missing` log line SHALL continue to fire for the affected agent on every tick, unchanged. The three log keys are intentionally distinct: `engineer.runner_skipped` is a single boot-time line per agent that names the config gap; `runner.skipped` is a single boot-time line per agent at the runServer layer; `runner.missing` is a per-tick line that names the consequence.

#### Scenario: No CLI configured anywhere logs `engineer.runner_skipped` once at boot

- **WHEN** `runStart` is invoked against a project whose `~/.keni/config.yaml` and `<project>/.keni/project.yaml` both omit `coding_agent_cli` / per-agent `cli`
- **AND** the project's roster has one engineer agent `alice`
- **THEN** the engineer wire's invocation logs exactly one `warn`-level line with event `engineer.runner_skipped`, fields `{ agent: "alice", reason: "no_cli_configured", configured_cli: null, supported: ["claude", "cursor-agent", "codex"] }`
- **AND** returns `null` so no runner is registered
- **AND** the runServer-layer logger gains exactly one info-level `runner.skipped` line for `alice`
- **AND** `runStart` boot completes successfully (exit code path unaffected)
- **AND** the scheduler's subsequent `runner.missing` log lines fire once per tick, unchanged

#### Scenario: An unknown CLI name logs `engineer.runner_skipped` with `unknown_cli`

- **WHEN** `~/.keni/config.yaml` sets `coding_agent_cli: "claud"` (typo)
- **THEN** the engineer wire logs exactly one `warn`-level line with event `engineer.runner_skipped`, fields `{ agent: "alice", reason: "unknown_cli", configured_cli: "claud", supported: ["claude", "cursor-agent", "codex"] }`
- **AND** returns `null` so no runner is registered
- **AND** the supported-name list in the log payload helps the user spot the typo

#### Scenario: A configured but unsupported CLI per agent skips that agent only

- **WHEN** the project roster has two engineers, `alice` (per-agent `cli: "claude"`) and `bob` (per-agent `cli: "homebrew-toy"` not in the registry)
- **THEN** the engineer wire registers a runner for `alice` (using the `"claude"` registry entry)
- **AND** logs `engineer.runner_skipped` with `agent: "bob", reason: "unknown_cli"` and returns `null` for `bob`
- **AND** the boot continues; `alice` picks up tickets, `bob` does not

### Requirement: An end-to-end test exercises the production wiring against a fake CLI fixture and a registered PO stub

The repository SHALL contain a Deno test under `packages/cli/tests/e2e/start/` (`engineerRunner_e2e_test.ts` or equivalent) that boots `runStart` against a temp-dir fixture pre-populated by `runInit`, with: (1) a `~/.keni/config.yaml` that names a CLI registered via a test-only override on `RunStartDeps` (the production `KnownCli` union remains closed); (2) a `FakeWorkspaceProvisioner` so no real git is touched (imported from `@keni/runtime-workspace/test-fakes`); (3) a project roster containing one engineer `alice` (with the test CLI configured) and one PO `petra`; (4) a `roleWires` test seam that wraps the production `wire` from `@keni/runtime-engineer` to spawn the existing fake-coding-agent fixture, and registers the production `wire` from `@keni/runtime-po` verbatim. The test SHALL assert that:

- The first engineer tick produces an `engineer.session_start` event frame on the captured event bus.
- The first PO tick produces no `session_*` event frames (precheck-skip short-circuit).
- The captured scheduler logger received zero `runner.missing` lines for either agent (both runners registered successfully).
- The test-injected `AbortSignal` cleanly terminates the in-flight engineer cycle.
- `runStart` resolves to exit code 0.

A second Deno test SHALL boot `runStart` against a project whose effective config does NOT set `coding_agent_cli` and SHALL assert that the captured scheduler logger received exactly one `engineer.runner_skipped` warn entry for `alice`, that no `CodingAgentInvoker` was constructed (no `Deno.Command` was spawned), and that `runStart` resolves to exit code 0.

#### Scenario: Configured CLI registers a runner and PO registers alongside

- **WHEN** the e2e test boots `runStart` with `coding_agent_cli` pointing at a test-only registry entry whose `cliBinary` is the fake-coding-agent script
- **AND** an `open` ticket is `POST`-ed to `/tickets` before the first tick
- **THEN** the captured event bus observes an `engineer.session_start` frame with `agent: "alice"` and the new ticket's id in `payload.ticket_id`
- **AND** the captured scheduler `roles()` returns `["engineer", "po"]` (insertion order)
- **AND** the activity log captures the fake CLI's stdout/stderr lines via the role-runtime cycle's existing per-line forwarding
- **AND** the test-injected shutdown signal cleanly terminates the cycle within `terminationGraceMs`
- **AND** `runStart` resolves to exit code 0

#### Scenario: No CLI configured produces the documented warn line and skips registration

- **WHEN** the e2e test boots `runStart` against a project whose effective config does NOT set `coding_agent_cli` and whose engineer agent has no per-agent `cli` override
- **THEN** the captured scheduler logger contains exactly one `warn`-level entry with event `engineer.runner_skipped` and `agent: "alice"`
- **AND** no `Deno.Command` is constructed (no subprocess is spawned)
- **AND** `runStart` resolves to exit code 0
