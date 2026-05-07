# Tasks — relocate-unit-tests-to-tests-folder

## 1. Establish the cross-package fakes seam (no test moves yet)

- [x] 1.1 Create the directory `packages/role-runtimes/tests/fakes/` and an empty barrel `packages/role-runtimes/tests/fakes/mod.ts` (placeholder; content added in 2.x).
- [x] 1.2 Update `packages/role-runtimes/deno.json` to convert `"exports": "./src/main.ts"` into the object form `{ ".": "./src/main.ts", "./test-fakes": "./tests/fakes/mod.ts" }`.
- [x] 1.3 Run `deno install` from the repo root; confirm `deno.lock` is regenerated cleanly (no resolution errors, no spurious diff outside the new entry).
- [x] 1.4 Run `deno task check` from the repo root; confirm it is green before proceeding (catches any stray `deno.json` syntax issue early).

## 2. Move shared fakes to `packages/role-runtimes/tests/fakes/` and rewire the barrel

- [x] 2.1 Move `packages/role-runtimes/src/common/fakes/fakeCodingAgentInvoker.ts` → `packages/role-runtimes/tests/fakes/common/fakeCodingAgentInvoker.ts`. Update the file's relative imports to point at the package's `src/` (`../../src/common/...`).
- [x] 2.2 Move `packages/role-runtimes/src/engineer/workspace/fakes/fakeWorkspaceProvisioner.ts` → `packages/role-runtimes/tests/fakes/engineer/workspace/fakeWorkspaceProvisioner.ts`. Update its relative imports of `WorkspaceProvisioner` and friends to `../../../src/engineer/workspace/interface.ts`.
- [x] 2.3 Populate `packages/role-runtimes/tests/fakes/mod.ts` to re-export the public symbols of both fakes (`FakeWorkspaceProvisioner`, `FakeWorkspaceProvisionerCall`, `FakeWorkspaceProvisionerOpts`, `createFakeCodingAgentInvoker`, `FakeCodingAgentInvokerHandle`, `FakeCodingAgentInvokerOpts`).
- [x] 2.4 Drop the corresponding `export { ... }` and `export type { ... }` blocks from `packages/role-runtimes/src/main.ts` so the production barrel no longer leaks the fakes. Update the surrounding JSDoc to point readers at `@keni/role-runtimes/test-fakes`.
- [x] 2.5 Update the JSDoc reference in `packages/role-runtimes/src/engineer/workspace/interface.ts` (mention of `FakeWorkspaceProvisioner`) to name the new location (`@keni/role-runtimes/test-fakes`); no `import` change required.
- [x] 2.6 Update the JSDoc in `packages/server/src/runServer.ts`, `packages/server/src/scheduler/registry.ts`, and `packages/cli/src/start/mod.ts` to mention the new import specifier (`@keni/role-runtimes/test-fakes`); no `import` change required.
- [x] 2.7 Move the fakes' own unit tests:
  - [x] 2.7.1 `packages/role-runtimes/src/common/fakes/fakeCodingAgentInvoker_test.ts` → `packages/role-runtimes/tests/unit/common/fakes/fakeCodingAgentInvoker_test.ts`. Rewrite its import to `../../../fakes/common/fakeCodingAgentInvoker.ts`.
  - [x] 2.7.2 `packages/role-runtimes/src/engineer/workspace/fakes/fakeWorkspaceProvisioner_test.ts` → `packages/role-runtimes/tests/unit/engineer/workspace/fakes/fakeWorkspaceProvisioner_test.ts`. Rewrite its import to `../../../../fakes/engineer/workspace/fakeWorkspaceProvisioner.ts`.

## 3. Rewire cross-package fake imports to `@keni/role-runtimes/test-fakes`

- [x] 3.1 Update `packages/server/src/runServer_test.ts` → import `FakeWorkspaceProvisioner, WorkspaceProvisioningError` from `@keni/role-runtimes/test-fakes` (the latter stays in the prod barrel — verify only the fake name is moved, the error type stays on the default export).
- [x] 3.2 Update `packages/server/src/createServer_test.ts` to import `FakeWorkspaceProvisioner` from `@keni/role-runtimes/test-fakes`.
- [x] 3.3 Update `packages/server/src/mcp/integration_test.ts` to import `FakeWorkspaceProvisioner` from `@keni/role-runtimes/test-fakes`.
- [x] 3.4 Update `packages/server/src/scheduler/integration_test.ts` to import `FakeWorkspaceProvisioner` from `@keni/role-runtimes/test-fakes`.
- [x] 3.5 Update `packages/cli/src/start/start_e2e_test.ts` to import `FakeWorkspaceProvisioner` from `@keni/role-runtimes/test-fakes`.
- [x] 3.6 Update `packages/cli/src/start/engineerRunner_e2e_test.ts` to import `FakeWorkspaceProvisioner` from `@keni/role-runtimes/test-fakes`.
- [x] 3.7 Update `packages/cli/src/start/engineerRunner_test.ts` to import `FakeWorkspaceProvisioner` from `@keni/role-runtimes/test-fakes`.
- [x] 3.8 Run `deno task check` from the repo root; confirm zero unresolved-symbol errors.
- [x] 3.9 Run `deno task test --filter=role-runtimes` (or equivalent) and confirm the role-runtimes package's tests still pass with the new fake locations and import paths. The cross-package test moves come in the next sections; the role-runtimes-internal moves complete here.

## 4. Move `@keni/server` tests to `packages/server/tests/`

- [x] 4.1 Move every `*_test.ts` under `packages/server/src/` into the matching path under `packages/server/tests/<bucket>/`, where the bucket is selected by suffix (`integration_test.ts` → `integration/`, otherwise `unit/`):
  - [x] 4.1.1 `src/middleware/{errorBoundary,requestLog,roleIdentity,requestId}_test.ts` → `tests/unit/middleware/<same>_test.ts`.
  - [x] 4.1.2 `src/{runServer,statusGraph,main,startServer,restPrefixes,mcpEntryPath,eventBus,agentState,errors,createServer}_test.ts` → `tests/unit/<same>_test.ts`.
  - [x] 4.1.3 `src/wire/{health,tickets,prs,activity,agents,errors,events}_test.ts` → `tests/unit/wire/<same>_test.ts`.
  - [x] 4.1.4 `src/scheduler/{registry,activityClient,runnerSourceScan,schedule,scheduler}_test.ts` → `tests/unit/scheduler/<same>_test.ts`.
  - [x] 4.1.5 `src/scheduler/integration_test.ts` → `tests/integration/scheduler/integration_test.ts`.
  - [x] 4.1.6 `src/mcp/{tools/{tickets,workspace,activity},wire/{tickets,workspace,activity},main,merge_pr,runMcpServer,errors,createMcpServer,httpClient}_test.ts` → `tests/unit/mcp/<same>_test.ts`.
  - [x] 4.1.7 `src/mcp/integration_test.ts` → `tests/integration/mcp/integration_test.ts`.
  - [x] 4.1.8 `src/concurrency/mutex_test.ts` → `tests/unit/concurrency/mutex_test.ts`.
  - [x] 4.1.9 `src/routes/{prsMerge,health,tickets,prs,activity,agents,static,events}_test.ts` → `tests/unit/routes/<same>_test.ts`.
- [x] 4.2 Move `packages/server/src/scheduler/fakes/fakeClock.ts` → `packages/server/tests/fakes/scheduler/fakeClock.ts`. Update the consumer (`tests/unit/scheduler/scheduler_test.ts`) to import from `../../fakes/scheduler/fakeClock.ts`.
- [x] 4.3 For each moved test file, rewrite its relative imports of the unit under test from `./<sibling>.ts` to `../<.. as needed>/src/<original path>/<sibling>.ts`. Also rewrite cross-test imports (e.g. helper modules under `tests/`) using the new layout.
- [x] 4.4 Run `deno task check` and `deno task test --filter=@keni/server` from the repo root and confirm both are green before moving on.

## 5. Move `@keni/cli` tests to `packages/cli/tests/`

- [x] 5.1 Move `src/init/{execute,state,plan,git,gitignore,errors,messages}_test.ts` → `tests/unit/init/<same>_test.ts`.
- [x] 5.2 Move `src/init/init_integration_test.ts` → `tests/integration/init/init_integration_test.ts`.
- [x] 5.3 Move `src/main_test.ts` → `tests/unit/main_test.ts`.
- [x] 5.4 Move `src/start/{pausedAgents,args,engineerRunner,port,shutdown,loadEnv,loadConfig,spaBundle}_test.ts` → `tests/unit/start/<same>_test.ts`.
- [x] 5.5 Move `src/start/engineerRunner_e2e_test.ts` → `tests/e2e/start/engineerRunner_e2e_test.ts`.
- [x] 5.6 Move `src/start/start_e2e_test.ts` → `tests/e2e/start/start_e2e_test.ts`.
- [x] 5.7 Rewrite each moved file's relative imports to point at `../<...>/src/...` for the unit under test, and at the new `@keni/role-runtimes/test-fakes` for the fakes.
- [x] 5.8 Run `deno task check` and `deno task test --filter=@keni/cli` from the repo root and confirm both are green.

## 6. Move `@keni/role-runtimes` tests to `packages/role-runtimes/tests/`

- [x] 6.1 Move `src/main_test.ts` → `tests/unit/main_test.ts`.
- [x] 6.2 Move `src/common/{summaryLine,codingAgentCliRegistry,types,activityClient,subprocess,startCycle,promptResolver,codingAgentInvoker}_test.ts` → `tests/unit/common/<same>_test.ts`.
- [x] 6.3 Move `src/common/integration_test.ts` → `tests/integration/common/integration_test.ts`.
- [x] 6.4 Move `src/engineer/{runner,workspace/git,prompts/engineer}_test.ts` → `tests/unit/engineer/<same>_test.ts`.
- [x] 6.5 Move `src/engineer/integration_test.ts` → `tests/integration/engineer/integration_test.ts`.
- [x] 6.6 The existing `tests/integration/cursorAgent_test.ts` and `tests/fixtures/fake-coding-agent.ts` stay in place; update `tests/integration/cursorAgent_test.ts`'s relative import from `../../src/main.ts` if any directory level shifted (verify no change is needed).
- [x] 6.7 Update each moved file's relative imports to point at `../<...>/src/...` and at `../../fakes/common/fakeCodingAgentInvoker.ts` / `../../fakes/engineer/workspace/fakeWorkspaceProvisioner.ts` as needed.
- [x] 6.8 Run `deno task check` and `deno task test --filter=@keni/role-runtimes` from the repo root and confirm both are green.

## 7. Move `@keni/shared` tests to `packages/shared/tests/`, including the contracts split

- [x] 7.1 Move `src/main_test.ts` → `tests/unit/main_test.ts`.
- [x] 7.2 Move `src/storage/{paths,atomic,ids,errors}_test.ts` → `tests/unit/storage/<same>_test.ts`.
- [x] 7.3 Move `src/storage/tickets/{memory,file}_test.ts` → `tests/unit/storage/tickets/<same>_test.ts`.
- [x] 7.4 Move `src/storage/prs/{memory,file}_test.ts` → `tests/unit/storage/prs/<same>_test.ts`.
- [x] 7.5 Move `src/storage/config/{memory,file}_test.ts` → `tests/unit/storage/config/<same>_test.ts`.
- [x] 7.6 Move `src/storage/activity/{memory,file}_test.ts` → `tests/unit/storage/activity/<same>_test.ts`.
- [x] 7.7 Move and rename the four contract helpers:
  - [x] 7.7.1 `src/storage/tickets/contract_test.ts` → `tests/contracts/storage/tickets/ticketStoreContract.ts` (drop `_test.ts` suffix; rename file to `<artifact>StoreContract.ts`).
  - [x] 7.7.2 `src/storage/prs/contract_test.ts` → `tests/contracts/storage/prs/prStoreContract.ts`.
  - [x] 7.7.3 `src/storage/config/contract_test.ts` → `tests/contracts/storage/config/configStoreContract.ts`.
  - [x] 7.7.4 `src/storage/activity/contract_test.ts` → `tests/contracts/storage/activity/activityLogStoreContract.ts` (matches the existing `runActivityLogStoreContract` symbol).
- [x] 7.8 Update each pair of `memory_test.ts` / `file_test.ts` (now under `tests/unit/storage/<artifact>/`) to import the contract helper from `../../../contracts/storage/<artifact>/<artifact>StoreContract.ts`.
- [x] 7.9 Update `packages/shared/src/storage/README.md` to reference the new locations of the contract helpers (no longer named `contract_test.ts`).
- [x] 7.10 Run `deno task check` and `deno task test --filter=@keni/shared` from the repo root and confirm both are green.

## 8. Move `@keni/spa` tests to `packages/spa/tests/`

- [x] 8.1 Move `src/transport/{apiClient,eventsClient}_test.ts` → `tests/unit/transport/<same>_test.ts`.
- [x] 8.2 Move `src/shell/AppShell_test.tsx` → `tests/unit/shell/AppShell_test.tsx`.
- [x] 8.3 Move `src/features/board/{dragHelpers_test.ts,BoardView_test.tsx}` → `tests/unit/features/board/<same>`.
- [x] 8.4 Move `src/features/agentRoster/{AgentRosterCard_test.tsx,formatRelativeTime_test.ts,TerminalEventBadge_test.tsx,ConfirmInterruptDialog_test.tsx,AgentRosterPanel_test.tsx}` → `tests/unit/features/agentRoster/<same>`.
- [x] 8.5 Move `src/features/ticketDetail/TicketDetailView_test.tsx` → `tests/unit/features/ticketDetail/TicketDetailView_test.tsx`.
- [x] 8.6 Move `src/features/shared/statusGraph_test.ts` → `tests/unit/features/shared/statusGraph_test.ts`.
- [x] 8.7 Move `src/features/activityLog/{ActivityLogView_test.tsx,formatActivityRefs_test.tsx}` → `tests/unit/features/activityLog/<same>`.
- [x] 8.8 Move `src/features/prDetail/PRDetailView_test.tsx` → `tests/unit/features/prDetail/PRDetailView_test.tsx`.
- [x] 8.9 Update each moved file's relative imports to point at the corresponding unit under `../<...>/src/...`.
- [x] 8.10 Run `deno task check` and `deno task test --filter=@keni/spa` from the repo root and confirm both are green.

## 9. Add the structural enforcement test

- [x] 9.1 Create `packages/shared/tests/unit/repoLayout_test.ts`. The test SHALL walk `packages/*/src/**` (resolved relative to the repo root via `import.meta.url`) and assert: (a) no file matches `*_test.ts` or `*_test.tsx`; (b) no directory is named `fakes/`, `fixtures/`, `__fixtures__/`, `__tests__/`, or `tests/`; (c) no file is named `contract_test.ts`. The test MUST use `@std/fs.walk` (already in the workspace import map) and SHOULD report each violation with its absolute path so failures are easy to grep.
- [x] 9.2 The same test SHALL assert that for every package in the workspace, a `packages/<pkg>/tests/` directory exists (since every package today contributes at least one test).
- [x] 9.3 Manually confirm the structural test fires on a deliberate violation: temporarily place a stub `packages/shared/src/_layout_smoke_test.ts`, run `deno task test`, observe the failure, then remove the stub. (Document the smoke check happened in the apply-phase log; do not commit the stub.)
- [x] 9.4 Run `deno task test` from the repo root and confirm the new structural test passes against the fully-moved tree.

## 10. Documentation, formatting, and final green-build pass

- [x] 10.1 Update `packages/role-runtimes/README.md`'s "Layout" section: the file-tree no longer shows `src/.../fakes/`; instead it shows `tests/fakes/...`. Reflect the `./test-fakes` secondary export in a sentence beneath the tree.
- [x] 10.2 Update `AGENTS.md` if its "load-bearing conventions" section needs a one-liner pointing at the new tests-location convention (the canonical reference is the updated `developer-setup` capability spec; `AGENTS.md` should cross-link, not duplicate).
- [x] 10.3 Run `deno task fmt` from the repo root; commit any whitespace fix-ups produced by the move.
- [x] 10.4 Run `deno task fmt:check` from the repo root; confirm exit code 0.
- [x] 10.5 Run `deno task lint` from the repo root; confirm zero diagnostics.
- [x] 10.6 Run `deno task check` from the repo root; confirm zero diagnostics.
- [x] 10.7 Run `deno task test` from the repo root; confirm every package contributes tests (≥ 1 from each of `cli`, `server`, `spa`, `role-runtimes`, `shared`) and the aggregate exit code is 0.
- [x] 10.8 Run `deno task build` from the repo root; confirm the SPA's `vite build` still produces `packages/spa/dist/index.html`.

## 11. Archive prep (post-merge)

- [x] 11.1 After CI is green, run the `openspec-archive-change` skill to fold the spec deltas into `openspec/specs/developer-setup/spec.md` and move the change folder under `openspec/changes/archive/<YYYY-MM-DD-relocate-unit-tests-to-tests-folder>/`.
- [x] 11.2 Confirm `openspec list` shows no active change for `relocate-unit-tests-to-tests-folder` after archiving.
