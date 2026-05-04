## 1. Add the coding-agent CLI registry to `@keni/role-runtimes`

- [x] 1.1 Create `packages/role-runtimes/src/common/codingAgentCliRegistry.ts` exporting the `KnownCli` literal union, the `CodingAgentCliEntry` interface, the `codingAgentCliRegistry` constant, and the `isKnownCli` type guard. Cover entries for `"claude"`, `"cursor-agent"`, and `"codex"` per the `engineer-runtime` spec delta. JSDoc each entry with the documentation source the `buildArgs` was modelled against and a `coverage: "tested" | "best-effort"` tag.
- [x] 1.2 Re-export `codingAgentCliRegistry`, `KnownCli`, `CodingAgentCliEntry`, and `isKnownCli` from `packages/role-runtimes/src/main.ts`.
- [x] 1.3 Create `packages/role-runtimes/src/common/codingAgentCliRegistry_test.ts` covering: (a) `Object.keys` matches the closed set; (b) every entry has the documented shape; (c) every entry's `envAllowlist` includes `HOME` and `PATH` and excludes the `KENI_MCP_*` mandates; (d) the `claude` entry's `buildArgs` produces an argv that includes the `mcpConfigPath` substring exactly once and a non-interactive flag; (e) `isKnownCli` returns the right answer for all three known names plus a typo and the empty string; (f) spreading an entry into `createSubprocessCodingAgentInvoker(...)` type-checks against the existing `SubprocessCodingAgentInvokerOpts`.

## 2. Export `MCP_ENTRY_PATH` from `@keni/server`

- [x] 2.1 Create `packages/server/src/mcpEntryPath.ts` exporting `MCP_ENTRY_PATH = new URL("./mcp/main.ts", import.meta.url).pathname`. JSDoc that the constant resolves at runtime against `import.meta.url` and is dev-mode-only (a future binary-packaging change replaces it with an embedded-asset extractor).
- [x] 2.2 Re-export `MCP_ENTRY_PATH` from `packages/server/src/main.ts`.
- [x] 2.3 Add a tiny test `packages/server/src/mcpEntryPath_test.ts` that asserts the resolved path ends with `/mcp/main.ts` and that the file exists on disk via `Deno.statSync`.

## 3. Build the production engineer-runner factory in `@keni/cli`

- [x] 3.1 Create `packages/cli/src/start/engineerRunner.ts` exporting `buildProductionEngineerRunnerFactory(deps): MakeEngineerRunner` per `design.md` Decision 2. The dependency bag SHALL accept: `resolvedConfig: ResolvedConfig`, `registry: typeof codingAgentCliRegistry` (parameterised so a test seam can pass an extended registry — see Decision 6), `mcpEntryPath: string`, `makeActivityHttpClient: (serverUrl, agentId) => EngineerActivityHttpClient`, and `logger: WorkspaceLogger`. The closure SHALL implement the resolution order from the `cli-start` spec delta (`agentConfig.cli` → `coding_agent_cli` → null) and emit `engineer.runner_skipped` for `null` / unknown names.
- [x] 3.2 Wire the helper into `packages/cli/src/start/mod.ts`'s `runStart`: when `deps.makeEngineerRunner === undefined`, default it to `buildProductionEngineerRunnerFactory({ resolvedConfig, registry: codingAgentCliRegistry, mcpEntryPath: MCP_ENTRY_PATH, makeActivityHttpClient: createMcpHttpClient, logger: workspaceLoggerOf(schedulerLogger) })`. Preserve the existing test seam: when `deps.makeEngineerRunner !== undefined`, pass it through verbatim.
- [x] 3.3 Resolve the `ResolvedConfig` once in `runStart` (it is already loaded by `loadKeniConfig` for the project YAML; thread the global YAML through alongside so the helper sees both layers) and pass it into the helper. Adjust `loadConfig.ts` if the helper needs the global YAML directly (it does — `coding_agent_cli` lives only at the global layer today; the project YAML's `agents[i].cli` is already on `ProjectConfig.agents`).
- [x] 3.4 Create `packages/cli/src/start/engineerRunner_test.ts` covering the helper in isolation: (a) configured global CLI registers a runner; (b) per-agent override wins over global; (c) `null` resolution emits `engineer.runner_skipped` with `reason: "no_cli_configured"` and returns `null`; (d) unknown name emits `reason: "unknown_cli"` with `configured_cli` and `supported` populated; (e) one engineer registers, a second engineer with an unknown name skips — both outcomes happen in the same boot; (f) the helper does not throw on any input shape exercised in (a)–(e).

## 4. End-to-end test against a fake CLI fixture

- [x] 4.1 Add a test-only registry-extension seam to `RunStartDeps` (e.g. `RunStartDeps.codingAgentCliRegistryOverride?: Record<string, CodingAgentCliEntry>`) so the e2e test can register a fixture entry without changing the closed `KnownCli` production union. `runStart` SHALL pass the override (when set) into `buildProductionEngineerRunnerFactory` as the merged registry; the production path leaves it `undefined` and the helper uses the production constant.
- [x] 4.2 Either extend `packages/cli/src/start/start_e2e_test.ts` or create a sibling `engineerRunner_e2e_test.ts` that boots `runStart` against a temp project (built by the existing `runInit` helper), with: a `~/.keni/config.yaml` setting `coding_agent_cli: "fake-coding-agent"` and a registry override pointing that name at `packages/role-runtimes/tests/fixtures/fake-coding-agent.ts` invoked under `Deno.Command`. Assert: (a) one ticket POST'd before the first tick; (b) an `engineer.session_start` event frame with the new ticket id arrives on the captured event bus; (c) the fake CLI's stdout/stderr lines surface in the activity log; (d) the test-injected `AbortSignal` cleanly terminates the cycle within `terminationGraceMs`; (e) `runStart` resolves to exit 0.
- [x] 4.3 Add a sibling test asserting the "no CLI configured" path: a fresh temp project with no `coding_agent_cli`, captured logger asserts exactly one `engineer.runner_skipped` warn line with `agent: "alice"` and `reason: "no_cli_configured"`, no `Deno.Command` is constructed (the test inspects this via a `commandSpy` that wraps `Deno.Command` for the duration of the test), and `runStart` resolves to exit 0.

## 5. Documentation

- [x] 5.1 Update `README.md` to add a "Configure the coding-agent CLI" section under "Run the orchestration server", covering: (a) the `coding_agent_cli` global config key and where the file lives; (b) the per-agent `cli` override and its precedence; (c) the closed list of supported names; (d) what happens when the value is missing or unknown (the documented `engineer.runner_skipped` warn line and a copy-pasteable YAML snippet that gets the user to a working state).
- [x] 5.2 Add a JSDoc cross-reference at the top of `packages/cli/src/start/engineerRunner.ts` linking to the `cli-start` and `engineer-runtime` capability specs and the README section.
- [x] 5.3 Update the comment block on `RunServerDeps.makeEngineerRunner` in `packages/server/src/runServer.ts` to remove the "until a follow-up change wires the production coding-agent invoker" sentence (the follow-up is this change). Replace it with a reference to `buildProductionEngineerRunnerFactory` in `@keni/cli` so future readers know where the production wiring lives.

## 6. Best-effort follow-ups (NOT blocking this change)

- [-] 6.1 Track an integration test for the `cursor-agent` registry entry that spawns the real binary against the fake-coding-agent fixture's MCP server output. (Out of scope here; documented in `design.md` Risks. The closed `KnownCli` union and the `coverage: "best-effort"` JSDoc tag on the `cursor-agent` entry are the surface-area documentation; a follow-up change should write the integration test against the real binary.)
- [-] 6.2 Track an integration test for the `codex` registry entry under the same shape. (Out of scope here. Same posture as 6.1.)

## 7. End-to-end verification

- [x] 7.1 `deno task fmt:check` is clean.
- [x] 7.2 `deno task lint` is clean.
- [x] 7.3 `deno task check` is clean.
- [x] 7.4 `deno task test` is green (every test added in tasks 1–4, plus the existing suite).
- [x] 7.5 `deno task --filter=@keni/spa build` succeeds (no SPA changes, smoke check).
- [-] 7.6 Manual probe: (a) write `coding_agent_cli: claude` to `~/.keni/config.yaml`; (b) start `keni start` against an initialised project; (c) `POST /tickets` an open ticket; (d) verify within one cron interval the activity log shows `engineer.session_start` and the ticket transitions out of `open`. Repeat without `coding_agent_cli` set and verify the documented `engineer.runner_skipped` warn line appears at boot. (Deferred to the user: requires a real `claude` binary on the dev machine. The `engineerRunner_e2e_test.ts` covers both the configured-CLI happy path and the no-CLI warn line via the fake fixture; the only thing the manual probe additionally verifies is that the `claude` registry entry's argv shape works against the real binary.)

## 8. Archive

- [x] 8.1 After all tasks above are complete and the test suite is green, run `/opsx-archive` to move the change to `openspec/changes/archive/<date>-engineer-runner-production-wiring/` and roll the spec deltas into `openspec/specs/cli-start/spec.md` and `openspec/specs/engineer-runtime/spec.md`.
