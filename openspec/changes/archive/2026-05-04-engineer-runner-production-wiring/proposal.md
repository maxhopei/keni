## Why

`keni start` boots the orchestration server, provisions per-agent workspaces, and starts the cron scheduler — but on every engineer tick the scheduler logs `runner.missing` and does nothing, because no `AgentRunner` is registered for engineer agents in production. The composition root (`packages/cli/src/start/mod.ts`) leaves `RunStartDeps.makeEngineerRunner` undefined, and `runServer.ts` documents this explicitly: "the scheduler simply logs `runner.missing` on engineer ticks until a follow-up change wires the production coding-agent invoker." This is that follow-up. Every primitive needed (the workspace provisioner, the engineer runner factory, the subprocess invoker, the engineer prompt, the MCP server config builder, the typed HTTP client) already exists and ships with passing tests; only the composition wire is missing. The user-visible symptom today is "I created a ticket but nothing happens" — the dashboard shows the ticket open, the agent idle, and the ticket never transitions.

## What Changes

- Add a `codingAgentCliRegistry` in `@keni/role-runtimes` — a closed table mapping a known coding-agent CLI name (e.g. `"claude"`, `"cursor-agent"`, `"codex"`) to the `SubprocessCodingAgentInvokerOpts` shape (binary, `buildArgs`, `promptInjection`, `resumeFlag`, `envAllowlist`).
- Add a new helper `packages/cli/src/start/engineerRunner.ts` — a pure factory `buildProductionEngineerRunnerFactory(deps)` that returns a `MakeEngineerRunner` closure. The closure: (1) resolves the agent's CLI from per-agent `cli` (project) → `coding_agent_cli` (global), (2) looks the name up in `codingAgentCliRegistry`, (3) constructs `createSubprocessCodingAgentInvoker(...)`, (4) builds an `EngineerActivityHttpClient` adapter over `createMcpHttpClient(...)` from `@keni/server`, (5) builds the `mcpServerConfig` via `buildEngineerMcpServerConfig(...)` against the resolved MCP entry path, and (6) hands all of the above to `createEngineerRunner(...)`.
- Wire `runStart` to default `RunStartDeps.makeEngineerRunner` to the new helper when the caller did not supply one (smoke test still wins). The wiring is opt-out: when no CLI is configured for an agent, the helper returns `null` (skip registration) and emits a `warn`-level `engineer.runner_skipped` line that names the agent and the missing config keys, replacing today's silent `runner.missing` with a clear, actionable message.
- Export an `MCP_ENTRY_PATH` constant from `@keni/server` (resolved against the package root via `import.meta.resolve`) so the helper does not hard-code the path. Tests inject an override.
- Add an end-to-end test under `packages/cli/src/start/` that exercises the new wiring against a fake CLI binary fixture (a small Deno script under `packages/cli/tests/fixtures/`) so the test suite asserts: (a) a configured `coding_agent_cli` causes the runner to be registered, (b) the scheduler invokes the precheck on a tick, (c) a missing CLI emits the documented `engineer.runner_skipped` warn line and does NOT register a runner.
- Update `README.md` to document the `coding_agent_cli` config key, the supported CLI registry entries, the per-agent `cli` override, and the resolution order.

This change is **non-breaking**: existing `keni start` invocations against projects whose `~/.keni/config.yaml` does not set `coding_agent_cli` continue to log a warn line and skip engineer runner registration — exactly today's behaviour with a clearer log key.

## Capabilities

### New Capabilities

(none — the new code lives entirely inside the existing `cli-start`, `engineer-runtime`, and `role-runtime-common` capabilities)

### Modified Capabilities

- `cli-start`: add a requirement that `runStart` constructs a production `makeEngineerRunner` from the resolved `coding_agent_cli` / per-agent `cli` config when no override is injected, and a requirement that the helper logs `engineer.runner_skipped` (warn) when the resolved CLI is missing or unknown.
- `engineer-runtime`: add a requirement that `@keni/role-runtimes` exposes the `codingAgentCliRegistry` value (a closed table covering at least `"claude"`, `"cursor-agent"`, `"codex"`), with documented per-CLI `buildArgs`, `promptInjection`, `resumeFlag`, and `envAllowlist`.

## Impact

- `packages/role-runtimes/src/common/codingAgentCliRegistry.ts` — new module + tests.
- `packages/role-runtimes/src/main.ts` — re-export the registry.
- `packages/server/src/main.ts` (or a new `mcpEntryPath.ts`) — export `MCP_ENTRY_PATH`.
- `packages/cli/src/start/engineerRunner.ts` — new helper + tests.
- `packages/cli/src/start/mod.ts` — default `RunStartDeps.makeEngineerRunner` to the new helper.
- `packages/cli/src/start/start_e2e_test.ts` (or a sibling test) — new end-to-end coverage.
- `README.md` — config docs.
- No changes to the SPA, the orchestration-server REST/WS surface, the MCP server, the workspace provisioner, the scheduler, or the role-runtime cycle.
- No new third-party deps.
- No filesystem-layout changes (`coding_agent_cli` already lives in `~/.keni/config.yaml` per the existing `GlobalConfig` schema).
