## 1. Scaffolding the four new packages

- [x] 1.1 Add `./packages/runtime-common`, `./packages/runtime-workspace`, `./packages/runtime-engineer`, `./packages/runtime-po` to the root `deno.json`'s `workspace` array. Keep `./packages/role-runtimes` in the array for now (atomic flip happens in §9). Run `deno install` to refresh `deno.lock`.
- [x] 1.2 Create `packages/runtime-common/{deno.json,src/main.ts,README.md,tests/{unit,integration,fakes}/.keep}`. `deno.json` declares `"name": "@keni/runtime-common"`, `"version": "0.0.0"`, `"exports": { ".": "./src/main.ts", "./test-fakes": "./tests/fakes/mod.ts" }`, `"tasks": { "build": "echo noop" }`. `src/main.ts` starts as `export const packageName = "@keni/runtime-common";` (filled in §3).
- [x] 1.3 Create `packages/runtime-workspace/{deno.json,src/main.ts,README.md,tests/{unit,integration,fakes}/.keep}` with the same shape (`"name": "@keni/runtime-workspace"`, secondary `./test-fakes` entry).
- [x] 1.4 Create `packages/runtime-engineer/{deno.json,src/main.ts,README.md,tests/{unit,integration,e2e}/.keep}` with `"name": "@keni/runtime-engineer"`, single `"."` entry (no test-fakes secondary by default — added in §6 only if cross-package consumers materialise).
- [x] 1.5 Create `packages/runtime-po/{deno.json,src/main.ts,README.md,tests/{unit,integration}/.keep}` with `"name": "@keni/runtime-po"`, single `"."` entry.
- [x] 1.6 Run `deno task fmt && deno task lint && deno task check && deno task test` from repo root. Confirm all four scaffold packages are picked up by `deno task test` (they have at least placeholder `*_test.ts` files — add a minimal `Deno.test("packageName", () => assertEquals(packageName, "@keni/runtime-<x>"))` per package). Fix any drift before moving on.

## 2. Hoisting `AgentRunner` into `@keni/runtime-common`

- [x] 2.1 Create `packages/runtime-common/src/runner.ts` with the `AgentRunner` interface verbatim from `packages/server/src/scheduler/registry.ts` (every field, every JSDoc preserved). Re-export through `packages/runtime-common/src/main.ts`.
- [x] 2.2 Update `packages/server/src/scheduler/registry.ts` to `import type { AgentRunner } from "@keni/runtime-common"`; delete the local `interface AgentRunner` block. Confirm `AgentRunnerRegistry` still type-checks.
- [x] 2.3 Run `deno task check` to confirm no other production file in `@keni/server` redeclares `AgentRunner`. Update any places that internally re-export the interface to source it from `@keni/runtime-common`.
- [x] 2.4 Run `deno task test` to confirm the scheduler unit and integration tests still pass with the hoisted interface.

## 3. Moving the cycle, types, CLI registry, and prompt resolver into `@keni/runtime-common`

- [x] 3.1 Move `packages/role-runtimes/src/common/types.ts` to `packages/runtime-common/src/types.ts`. Update import paths inside the file (none today reach outside the package; confirm).
- [x] 3.2 Move `packages/role-runtimes/src/common/startCycle.ts` to `packages/runtime-common/src/startCycle.ts`. Update local imports (`./types.ts`, `./activityClient.ts`, `./summaryLine.ts`, etc.) to the new flat layout.
- [x] 3.3 Move `packages/role-runtimes/src/common/activityClient.ts` to `packages/runtime-common/src/activityClient.ts`. Apply the same import-path updates.
- [x] 3.4 Move `packages/role-runtimes/src/common/codingAgentInvoker.ts`, `subprocess.ts`, `summaryLine.ts`, `promptResolver.ts` to `packages/runtime-common/src/<name>.ts`.
- [x] 3.5 Move `packages/role-runtimes/src/common/codingAgentCliRegistry.ts` and the `codingAgentClis/` directory (`claude.ts`, `cursorAgent.ts`, `codex.ts`) to `packages/runtime-common/src/<...>`.
- [x] 3.6 Update `packages/runtime-common/src/main.ts` to re-export every symbol per the `runtime-common` capability spec's enumeration: `startCycle`, `RoleCycleParams`, `RoleCycleResult`, `CodingAgentInvocation`, `CodingAgentLifecycle`, `CodingAgentOutcome`, `CodingAgentInvoker`, `CyclePrepCtx`, `PrecheckResult`, `BundledPrompt`, `McpServerConfig`, `createSubprocessCodingAgentInvoker`, `SubprocessCodingAgentInvokerOpts`, `codingAgentCliRegistry`, `isKnownCli`, `CodingAgentCliEntry`, `KnownCli`, `McpConfigStrategy`, `resolveBundledPrompt`, `RoleRuntimeError`, `RoleRuntimeHttpError`, `WorkspaceLogger`, `WorkspaceLogLevel`. Plus `AgentRunner` (from §2).
- [x] 3.7 Move every `tests/unit/common/*.ts` test file from `packages/role-runtimes/tests/unit/common/` to `packages/runtime-common/tests/unit/`. Update import specifiers from `@keni/role-runtimes` to `@keni/runtime-common`.
- [x] 3.8 Move the cross-package fakes barrel: `packages/role-runtimes/tests/fakes/common/fakeCodingAgentInvoker.ts` and `placeholderPrompt.ts` move to `packages/runtime-common/tests/fakes/<name>.ts`. Re-export them from `packages/runtime-common/tests/fakes/mod.ts`.
- [x] 3.9 Move the integration test `packages/role-runtimes/tests/integration/common/integration_test.ts` to `packages/runtime-common/tests/integration/integration_test.ts`. Update specifiers and the fixture path (`packages/role-runtimes/tests/fixtures/fake-coding-agent.ts` → `packages/runtime-common/tests/fixtures/fake-coding-agent.ts`).
- [x] 3.10 Run `deno task fmt && deno task lint && deno task check && deno task test`. Fix any test-import drift.

## 4. Generalising `WorkspaceProvisioner` into `@keni/runtime-workspace`

- [x] 4.1 Move `packages/role-runtimes/src/engineer/workspace/interface.ts` to `packages/runtime-workspace/src/interface.ts`. Modify the `WorkspaceProvisioner` interface: change `ensureProvisioned(projectId, agentId, projectRepoPath): Promise<string>` to `ensureProvisioned(opts: { projectId: string; agentId: string; projectRepoPath: string; sparseCheckoutPattern: readonly string[] }): Promise<string>`. Add `sparse_pattern_invalid` to the `WorkspaceProvisioningErrorCode` union.
- [x] 4.2 Move `packages/role-runtimes/src/engineer/workspace/git.ts` to `packages/runtime-workspace/src/git.ts`. Update `GitWorkspaceProvisioner.ensureProvisioned(...)` to consume the new `opts` argument and apply the supplied sparse pattern verbatim. Reject empty pattern with `WorkspaceProvisioningError("sparse_pattern_invalid", { reason: "empty_pattern" })`.
- [x] 4.3 Update `packages/runtime-workspace/src/main.ts` to re-export `WorkspaceProvisioner`, `WorkspaceProvisioningError`, `WorkspaceProvisioningErrorCode`, `WorkspaceProvisioningErrorDetails`, `GitWorkspaceProvisioner`, `GitWorkspaceProvisionerOpts`. Do NOT re-export any engineer-specific symbol.
- [x] 4.4 Move `packages/role-runtimes/tests/fakes/engineer/workspace/fakeWorkspaceProvisioner.ts` to `packages/runtime-workspace/tests/fakes/fakeWorkspaceProvisioner.ts`. Update its `ensureProvisioned` signature to match the new `opts` argument; record the supplied `sparseCheckoutPattern` for assertion.
- [x] 4.5 Re-export from `packages/runtime-workspace/tests/fakes/mod.ts`. Confirm `@keni/runtime-workspace/test-fakes` resolves the fake.
- [x] 4.6 Move `packages/role-runtimes/tests/unit/engineer/workspace/git_test.ts` and `interface_test.ts` to `packages/runtime-workspace/tests/unit/git_test.ts` / `interface_test.ts`. Update tests to pass the sparse pattern explicitly (`["/*", "!.keni/"]` for engineer-style tests).
- [x] 4.7 Run `deno task check && deno task test`. Confirm `@keni/runtime-workspace`'s tests pass standalone.

## 5. Building `@keni/runtime-engineer`: prompt, runner factory, MCP config builder, wire export

- [x] 5.1 Move `packages/role-runtimes/src/engineer/prompts/engineer.ts` to `packages/runtime-engineer/src/prompts/engineer.ts`. The constants (`ENGINEER_PROMPT_NAME`, `ENGINEER_PROMPT_BODY`) are unchanged.
- [x] 5.2 Move `packages/role-runtimes/src/engineer/runner.ts` to `packages/runtime-engineer/src/runner.ts`. Modify: drop the `EngineerAgentRunner` interface entirely; `createEngineerRunner(deps, opts)` returns `AgentRunner` (imported from `@keni/runtime-common`). Update `EngineerActivityHttpClient` to be type-aliased to a narrowing of `ActivityHttpClient` from `@keni/runtime-common` (or remove the type entirely if the narrowing is identical).
- [x] 5.3 In `packages/runtime-engineer/src/runner.ts`, keep `buildEngineerMcpServerConfig`, `BuildEngineerMcpServerConfigOpts`, and `orderEngineerTickets` as named exports. Move them into `packages/runtime-engineer/src/mcp.ts` and `packages/runtime-engineer/src/precheck.ts` if the file grows past ~200 lines (optional split for readability; not required for spec compliance).
- [x] 5.4 Add `packages/runtime-engineer/src/sparseCheckout.ts` exporting `export const ENGINEER_SPARSE_CHECKOUT_PATTERN: readonly string[] = ["/*", "!.keni/"];`.
- [x] 5.5 Add `packages/runtime-engineer/src/wire.ts` exporting `wire(input: WireInput): Promise<AgentRunner | null>`. Body: lift the production wiring from `packages/cli/src/start/engineerRunner.ts`'s `buildProductionEngineerRunnerFactory`; replace `MakeEngineerRunnerInput` references with destructuring of `WireInput` (the new generic shape from `@keni/runtime-common`); call `input.workspaceProvisioner.ensureProvisioned({ ..., sparseCheckoutPattern: ENGINEER_SPARSE_CHECKOUT_PATTERN })` before returning the runner.
- [x] 5.6 Update `packages/runtime-engineer/src/main.ts` to re-export per the `runtime-engineer` capability spec: `ENGINEER_PROMPT_NAME`, `ENGINEER_PROMPT_BODY`, `createEngineerRunner`, `EngineerRunnerDeps`, `EngineerRunnerOpts`, `buildEngineerMcpServerConfig`, `BuildEngineerMcpServerConfigOpts`, `orderEngineerTickets`, `ENGINEER_SPARSE_CHECKOUT_PATTERN`, `wire`.
- [x] 5.7 Move every `tests/unit/engineer/*.ts` test file (excluding workspace tests already moved in §4) to `packages/runtime-engineer/tests/unit/`. Update import specifiers.
- [x] 5.8 Move the engineer integration test `packages/role-runtimes/tests/integration/engineer/integration_test.ts` to `packages/runtime-engineer/tests/integration/integration_test.ts`. Update specifiers and adjust to import the workspace fake from `@keni/runtime-workspace/test-fakes`.
- [x] 5.9 Run `deno task check && deno task test`. Fix any drift.

## 6. Defining `WireInput`/`WireFn`/`ActivityHttpClient` in `@keni/runtime-common`

- [x] 6.1 Create `packages/runtime-common/src/activityHttpClient.ts` defining `interface ActivityHttpClient { listTickets(filter: TicketFilter): Promise<readonly TicketSummary[]>; }` (extensible — additional methods MAY be added by future changes). Re-export from `main.ts`.
- [x] 6.2 Create `packages/runtime-common/src/wire.ts` defining `interface WireInput { ... }` and `type WireFn = (input: WireInput) => Promise<AgentRunner | null>` and `type RoleWires = Readonly<Record<string, WireFn>>` per the `runtime-common` capability spec. Re-export from `main.ts`.
- [x] 6.3 Update `@keni/runtime-engineer`'s `wire.ts` and `runner.ts` to import `WireInput`, `WireFn`, `AgentRunner`, and `ActivityHttpClient` from `@keni/runtime-common`. Replace any internal `EngineerActivityHttpClient` re-declaration with `ActivityHttpClient`.
- [x] 6.4 Run `deno task check && deno task test`.

## 7. Building `@keni/runtime-po`: stub package

- [x] 7.1 Create `packages/runtime-po/src/prompts/po.ts` exporting `PO_PROMPT_NAME = "po"` and `PO_PROMPT_BODY` (a placeholder string ≥500 characters whose first non-empty line contains `"STUB IMPLEMENTATION"`).
- [x] 7.2 Create `packages/runtime-po/src/wire.ts` exporting `wire(input: WireInput): Promise<AgentRunner | null>`. Body: build an `AgentRunner` with `role: "po"`, a `precheck` that resolves `{ kind: "skip", reason: "po_not_implemented" }`, a `promptResolver` returning `{ name: PO_PROMPT_NAME, body: PO_PROMPT_BODY }`, `expectedPromptName: "po"`, the standard `createSubprocessCodingAgentInvoker` (with a no-op `cliBinary` like `/usr/bin/true` if no resolvable CLI), a placeholder `mcpServerConfig` (deno-run shape with `--workspace /dev/null`), and `workspacePath: undefined`.
- [x] 7.3 Update `packages/runtime-po/src/main.ts` to re-export `PO_PROMPT_NAME`, `PO_PROMPT_BODY`, `wire`.
- [x] 7.4 Add `packages/runtime-po/tests/unit/prompts/po_test.ts` asserting the prompt's length and `STUB IMPLEMENTATION` substring. Add `packages/runtime-po/tests/unit/wire_test.ts` asserting `wire(<input>)` returns a runner whose precheck always skips with `po_not_implemented`.
- [x] 7.5 Run `deno task check && deno task test`.

## 8. Polymorphic dispatch in `@keni/server`'s `runServer`

- [x] 8.1 Add a `roleWires: Readonly<Record<string, WireFn>>` field to `RunServerDeps` in `packages/server/src/runServer.ts` (or wherever the deps shape is declared). Import `WireFn` from `@keni/runtime-common`.
- [x] 8.2 Replace the existing `wireEngineers` block in `runServer.ts` with the polymorphic dispatch loop per the modified `orchestration-server` capability spec: instantiate the shared `GitWorkspaceProvisioner` (from `@keni/runtime-workspace`); iterate the project's `agents` roster in declaration order; look up `wireFn = roleWires[agent.role]`; on undefined wire log `runner.skipped` and continue; on defined wire `await wireFn(input)` and either `scheduler.registerRunner(runner)` (non-null return) or log `runner.skipped` (null return); on throw, exit code 1 with stderr message.
- [x] 8.3 Remove the `MakeEngineerRunnerInput` type and the legacy `makeEngineerRunner` field on `RunServerDeps`. Update every internal call site in `@keni/server`.
- [x] 8.4 Update `packages/server/src/routes/prs.ts`'s `WorkspaceProvisioner` import from `@keni/role-runtimes` to `@keni/runtime-workspace`. Confirm `routes/prs.ts` no longer imports from `@keni/runtime-engineer` or any role-specific package.
- [x] 8.5 Run a `rg` sweep over `packages/server/src/**` for `=== "engineer"`, `=== "po"`, `=== "qa"`, `=== "writer"`, `createEngineerRunner`, `MakeEngineerRunnerInput`, `from "@keni/runtime-engineer"`, `from "@keni/runtime-po"`. Confirm zero matches in production source (matches in test files are allowed for fixture setup).
- [x] 8.6 Update `packages/server/tests/unit/scheduler/*.ts` and `packages/server/tests/integration/scheduler/*.ts` to import `AgentRunner`, `placeholderPrompt`, etc. from `@keni/runtime-common` / `@keni/runtime-common/test-fakes`. Update any test that constructed a `wireEngineers`-shaped fixture to instead supply a `roleWires` map.
- [x] 8.7 Run `deno task check && deno task test`.

## 9. CLI: assemble `roleWires` from role packages

- [x] 9.1 In `packages/cli/src/start/mod.ts` (or the equivalent entry), import `wire as engineerWire` from `@keni/runtime-engineer` and `wire as poWire` from `@keni/runtime-po`. When `RunStartDeps.roleWires` is undefined, default it to `{ engineer: engineerWire, po: poWire }`.
- [x] 9.2 Delete `packages/cli/src/start/engineerRunner.ts` (its body was moved to `packages/runtime-engineer/src/wire.ts` in §5). Update any importers.
- [x] 9.3 Update `packages/cli/tests/unit/start/engineerRunner_test.ts` to import the engineer wire from `@keni/runtime-engineer` and run the same scenarios against the wire export. Move the file to `packages/cli/tests/unit/start/roleWires_test.ts` if it grows to cover both engineer and PO wires.
- [x] 9.4 Update `packages/cli/tests/e2e/start/engineerRunner_e2e_test.ts` to use the new `RunStartDeps.roleWires` seam (replace `deps.makeEngineerRunner = …` with `deps.roleWires = { engineer: <fakeWire>, po: poWire }`). Add an assertion that `scheduler.roles()` includes `"po"` post-boot.
- [x] 9.5 Update `packages/cli/tests/e2e/start/start_e2e_test.ts` (the smoke test) similarly: replace the legacy seam with `roleWires`.
- [x] 9.6 Run `deno task check && deno task test`.

## 10. PO end-to-end integration test

- [x] 10.1 Write `packages/runtime-po/tests/integration/po-stub_test.ts` per the `runtime-po-stub` capability spec: provision a temp `~/.keni`, project roster `[{ id: "alice", role: "engineer", cli: "claude" }, { id: "petra", role: "po" }]`, schedules `{ engineer: "100ms", po: "100ms" }`. Boot `runServer` with `roleWires: { engineer: <fakeEngineerWire returning a no-op runner>, po: poWire }`. Advance `FakeTime` by 100 ms. Assert: `scheduler.roles() === ["engineer", "po"]`; engineer's fake invoker called once; PO's tick produced no activity-log entries; PO precheck-skip reason is `po_not_implemented`. Tear down (server `abort()`, temp dir removal).
- [x] 10.2 Run the test in isolation: `deno test -A packages/runtime-po/tests/integration/po-stub_test.ts`. Confirm green.
- [x] 10.3 Run the full workspace test suite: `deno task test`. Confirm green.

## 11. Atomic flip: delete `packages/role-runtimes/`, update workspace `deno.json`, repo-wide import sweep

- [x] 11.1 Run a workspace-wide `rg` sweep for `from "@keni/role-runtimes"` and `from "@keni/role-runtimes/test-fakes"`. Update every match: cycle types/CLI registry/`AgentRunner`/`startCycle` → `@keni/runtime-common`; `WorkspaceProvisioner`/`GitWorkspaceProvisioner` → `@keni/runtime-workspace`; engineer prompt/runner/MCP-config builder → `@keni/runtime-engineer`; fakes → `@keni/<pkg>/test-fakes` per package.
- [x] 11.2 Delete `packages/role-runtimes/` entirely (`rm -rf packages/role-runtimes/`).
- [x] 11.3 Remove `./packages/role-runtimes` from the workspace `deno.json`'s `workspace` array. Run `deno install` to refresh the lockfile.
- [x] 11.4 Update `AGENTS.md`'s "Workspace layout" table: replace the `@keni/role-runtimes` row with four rows for `runtime-common`, `runtime-workspace`, `runtime-engineer`, `runtime-po`. Update the "Adding a new coding-agent CLI to the registry" subsection's path references.
- [x] 11.5 Update the repo-root `README.md`'s "Repository layout" subsection (and any `keni init` Quickstart references) to enumerate the eight packages.
- [x] 11.6 Update the structural-layout test in `@keni/shared`'s `tests/unit/repoLayout_test.ts` to assert: (a) workspace array has exactly the eight documented members; (b) `packages/role-runtimes/` does not exist; (c) every package's `name` matches its directory.
- [x] 11.7 Run `deno task fmt && deno task lint && deno task check && deno task test`. Fix every drift. The structural test from 11.6 SHALL pass.

## 12. Documentation pass

- [x] 12.1 Add `packages/runtime-common/README.md` describing the cycle, types, CLI registry, `AgentRunner`, `WireFn`/`WireInput`, the `./test-fakes` secondary entry, and the package-boundary invariants (no imports from sibling runtime packages or `@keni/server`).
- [x] 12.2 Add `packages/runtime-workspace/README.md` describing the `WorkspaceProvisioner` interface, the parameterised sparse pattern, the engineer-pattern example, the typed-error semantics, and the `./test-fakes` entry.
- [x] 12.3 Add `packages/runtime-engineer/README.md` describing the prompt, the runner factory, the MCP-config builder, the precheck playbook, the `wire` export, and the dependency edges (`@keni/runtime-common` + `@keni/runtime-workspace` + `@keni/shared` only).
- [x] 12.4 Add `packages/runtime-po/README.md` documenting the stub status, the `precheck_skipped` permanent return, and the integration test that proves the polymorphic model.
- [x] 12.5 Update `AGENTS.md`'s "Load-bearing conventions" if any of the conventions reference `@keni/role-runtimes` by name. Specifically: convention #2 ("Storage is interface-bound") is unaffected; convention #6 ("Engineer workspaces …") may want an update to mention `@keni/runtime-workspace` as the home of the provisioner.

## 13. CI green-light and final validation

- [x] 13.1 Run `deno task fmt:check && deno task lint && deno task check && deno task test` from the repo root. Confirm every task exits 0.
- [x] 13.2 Run `openspec validate split-role-runtimes-package`. Confirm the change is valid.
- [x] 13.3 Run a final `rg` sweep: zero `@keni/role-runtimes` references anywhere in `packages/**` or `openspec/specs/**` (the change's own delta files SHALL still mention the legacy specifier in REMOVED-Migration text — that's expected). Note: `openspec/specs/**` references will clear when the change is archived; `packages/**` is clean.
- [x] 13.4 Optional sanity: `deno task build` if the SPA bundle changed (it should not; this change does not touch SPA). Skipped — change does not touch SPA, so the bundle is unaffected.
