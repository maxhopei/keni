## MODIFIED Requirements

### Requirement: `runServer` wires up role runners polymorphically via the `roleWires` registry; the server holds zero role-specific knowledge

`runServer` SHALL accept, on its `RunServerDeps` value bag, a `roleWires: Readonly<Record<string, WireFn>>` field where `WireFn` is the type imported from `@keni/runtime-common`. After constructing the scheduler but before `Deno.serve` accepts connections, `runServer` SHALL: (1) instantiate a single shared `WorkspaceProvisioner` (concretely, `GitWorkspaceProvisioner` from `@keni/runtime-workspace`) and pass it through to every wire's `WireInput`; (2) iterate the project's `agents` roster in declaration order; (3) for each agent, look up `wireFn = roleWires[agent.role]`; (4) when `wireFn` is undefined, log one info-level `engineer.runner_skipped` (or, generically, `runner.skipped`) line naming the agent and the missing role and proceed; (5) when `wireFn` is defined, call `await wireFn(input)` with a `WireInput` carrying `projectId`, `projectName`, `projectRepoPath`, `serverUrl`, `agentConfig`, `resolvedConfig`, `mcpEntryPath`, `logger`, `makeActivityHttpClient`, `codingAgentCliRegistry`, and the shared `workspaceProvisioner`; (6) when the wire returns a non-`null` `AgentRunner`, call `scheduler.registerRunner(runner)`; when the wire returns `null`, log one info-level `runner.skipped` line naming the agent (the wire itself has already logged the reason) and proceed; (7) when the wire throws, exit `runServer` with code 1 and a stderr message naming the failed agent and the underlying error message — wire failures are boot failures.

`runServer` SHALL NOT import `createEngineerRunner`, `createPoRunner`, or any role-specific factory. `runServer`'s source under `packages/server/src/` SHALL contain zero `=== "engineer"`, `=== "qa"`, `=== "po"`, or `=== "writer"` literal comparisons in its boot path. `runServer` SHALL emit one info-level log line per registered runner naming the agent id, the role, the workspace path (when applicable), and the elapsed wiring time.

`runServer` SHALL call `scheduler.start()` exactly once after every roster entry has been processed, and only then SHALL `Deno.serve` accept connections. When `roleWires` is empty (no roles registered) or when every roster entry's wire returns `null`, `runServer` SHALL still complete bootstrap successfully — the scheduler runs with zero registered runners, every per-tick invocation logs `runner.missing` per the `scheduler` capability.

#### Scenario: `runServer` polymorphically dispatches per-agent wiring

- **WHEN** `runServer(deps, opts)` is invoked with `deps.roleWires = { engineer: <fakeEngineerWire>, po: <fakePoWire> }` against a project whose roster is `[{ id: "alice", role: "engineer" }, { id: "petra", role: "po" }]`
- **AND** instrumented wires record their calls
- **THEN** `<fakeEngineerWire>` is called exactly once with `WireInput.agentConfig.id === "alice"`
- **AND** `<fakePoWire>` is called exactly once with `WireInput.agentConfig.id === "petra"`
- **AND** `scheduler.registerRunner` is called exactly twice (once per non-null wire return), with the engineer runner registered before the PO runner (roster order)
- **AND** `scheduler.start()` is called exactly once after both `registerRunner` calls
- **AND** every captured registration call resolves before `Deno.serve` begins accepting connections

#### Scenario: Missing role wire logs `runner.skipped` and continues

- **WHEN** `runServer` is invoked with `deps.roleWires = { engineer: <wire> }` against a project whose roster is `[{ id: "petra", role: "po" }]` (no PO wire registered)
- **THEN** the captured logger received exactly one info-level `runner.skipped` line naming `agent: "petra"` and `role: "po"`
- **AND** `scheduler.registerRunner` is called zero times
- **AND** `scheduler.start()` is called exactly once
- **AND** `runServer` completes bootstrap successfully (no exit code 1)

#### Scenario: Wire `null` return logs `runner.skipped` and continues

- **WHEN** the engineer wire returns `null` for `alice` (e.g., no CLI configured)
- **THEN** the captured logger received the wire's own role-specific skip log (e.g., `engineer.runner_skipped` with `reason: "no_cli_configured"`) plus exactly one `runner.skipped` line at the runServer layer
- **AND** `scheduler.registerRunner` is not called for `alice`
- **AND** `runServer` completes bootstrap successfully

#### Scenario: Wire throw exits `runServer` with code 1

- **WHEN** the engineer wire throws `new Error("workspace clone failed")` for `alice`
- **THEN** `runServer` returns exit code 1
- **AND** stderr names `"alice"` and the error message
- **AND** `scheduler.start()` is not invoked
- **AND** `Deno.serve` is not invoked

#### Scenario: `runServer`'s source is role-agnostic

- **WHEN** the production source files under `packages/server/src/` (excluding `*_test.ts`) are scanned for `createEngineerRunner`, `createPoRunner`, or any other role-specific factory name
- **THEN** zero occurrences are found
- **AND** scanning the same files for `=== "engineer"`, `=== "qa"`, `=== "po"`, `=== "writer"` finds zero occurrences in the boot path

### Requirement: `runServer` constructs the workspace provisioner once per server lifecycle and shares it across handlers and role wires

`runServer` SHALL instantiate exactly one `GitWorkspaceProvisioner` per server invocation, *before* the polymorphic role-wiring loop. The `GitWorkspaceProvisioner` class and the `WorkspaceProvisioner` interface SHALL be imported from `@keni/runtime-workspace`. The same instance SHALL be passed into every `WireFn` invocation via `WireInput.workspaceProvisioner` (so any role's wire can call `ensureProvisioned(...)` with its own sparse pattern) and SHALL be made available to the `POST /prs/:id/merge` handler via the existing `createServer(deps, opts)` deps bag (a `workspaceProvisioner: WorkspaceProvisioner` field on `ServerDeps`). The provisioner SHALL NOT be reconstructed on hot-reload, request boundary, or any in-process boundary other than `runServer` exit. On `runServer` shutdown, the provisioner SHALL NOT be discarded — workspaces persist across server restarts per the `runtime-workspace` capability's documented lifecycle.

#### Scenario: Exactly one provisioner is constructed per `runServer` lifecycle

- **WHEN** an instrumented `GitWorkspaceProvisioner` constructor records its calls
- **AND** `runServer(["--project=<tempDir>", "--port=0"])` is invoked, runs through bootstrap, accepts one merge request, and shuts down cleanly
- **THEN** the constructor was called exactly once during that lifecycle

#### Scenario: The provisioner is sourced from `@keni/runtime-workspace`

- **WHEN** the production source of `packages/server/src/runServer.ts` is inspected for the import of `GitWorkspaceProvisioner`
- **THEN** the import specifier is `@keni/runtime-workspace`
- **AND** no `@keni/role-runtimes` or `@keni/runtime-engineer` import provides this symbol

#### Scenario: The merge handler reads `workspaceProvisioner` from `ServerDeps`

- **WHEN** `createServer({ ticketStore, prStore, activityLogStore, configStore, logSink, workspaceProvisioner }, opts)` is constructed
- **AND** the merge handler is invoked for a PR whose `author` is `"alice"`
- **THEN** the handler calls `workspaceProvisioner.workspacePathFor(opts.projectId, "alice")` to obtain the source-branch's workspace path
- **AND** the resolved path is the absolute path the engineer's pushed branch lives in

### Requirement: `POST /prs/:id/merge` performs a fast-forward merge of the PR's branch onto `main` and returns the merge commit SHA

The orchestration server SHALL expose a new endpoint `POST /prs/:id/merge`. The endpoint SHALL: (1) require `X-Keni-Role: engineer` (rejecting any other role with `403 role_not_owner`, including `qa`, `po`, and `writer`; the `user` role override path is allowed per the existing `USER_OVERRIDE_ALLOWED` constant); (2) require an `X-Keni-Agent` header (rejecting absence with `400 missing_role` consistent with the existing role-identity middleware); (3) reject a non-empty request body with `400 validation_failed` (the PR record names the source branch — the request is identifier-only); (4) read the PR record via `PRStore.read(id)`, mapping `StoreNotFoundError` to `404 store_not_found`; (5) extract the source branch and the workspace path from the PR record (the workspace path is computed via the in-process `WorkspaceProvisioner.workspacePathFor(projectId, prRecord.author)`, where `prRecord.author` is the engineer who created the PR; the `WorkspaceProvisioner` interface is imported from `@keni/runtime-workspace`, not from any role-specific package); (6) execute, in the project repo working directory `runServer.projectRepoPath`, the sequence `git fetch <workspacePath> <branch>:<branch>` followed by `git merge --ff-only <branch>` against `main`; (7) on `git merge --ff-only` exit code 0, read the merge commit SHA via `git rev-parse HEAD`, call `PRStore.updateStatus(id, prRecord.status, "merged")` (mapping `StaleStateError` to `409 stale_state`), call `ActivityLogStore.append(...)` with `event: "pr_merged"`, `agent: <calling agent id>`, `role: "engineer"`, `summary: "Merged PR <id> as <sha>"`, `refs: { pr_id: id, branch, merge_commit_sha: <sha> }`, and respond `200 { data: { merge_commit_sha: string }, project_id }`; (8) on `git merge --ff-only` exit code 1 (the workspace's branch tip is not a descendant of `main`'s tip), respond `409 { error: { code: "merge_conflict", message: "Branch is not a fast-forward of main", details: { branch, base: "main", git_stderr } }, project_id }` and SHALL NOT update the PR's status; (9) on any other git failure (missing branch, missing workspace, git binary unavailable), respond `400 { error: { code: "validation_failed", message: <message naming the failure mode>, details: { ... } }, project_id }`. The endpoint SHALL serialise concurrent merge attempts via a per-server in-process `Mutex` (single-writer on the project repo); concurrent requests SHALL queue and execute in arrival order with no observable interleaving.

`packages/server/src/routes/prs.ts` SHALL import `WorkspaceProvisioner` from `@keni/runtime-workspace` and SHALL NOT import from `@keni/runtime-engineer` or any other role-specific package.

#### Scenario: Engineer fast-forward merges a clean branch

- **WHEN** an engineer's pushed branch `ticket-0001` is one commit ahead of `main`
- **AND** `POST /prs/pr-0001/merge` is called with `X-Keni-Role: engineer` and `X-Keni-Agent: alice`
- **THEN** the response is 200
- **AND** the response body is `{ data: { merge_commit_sha: <40-char SHA> }, project_id: <uuid> }`
- **AND** the project repo's `main` HEAD now equals the engineer's `ticket-0001` tip
- **AND** the PR's status on disk is `merged`
- **AND** the activity log gained one entry with `event: "pr_merged"` whose `refs.merge_commit_sha` equals the response's value

#### Scenario: Non-fast-forward returns 409 `merge_conflict`

- **WHEN** the engineer's pushed branch and `main` have diverged (a different commit landed on `main` after the engineer branched)
- **AND** `POST /prs/pr-0001/merge` is called with `X-Keni-Role: engineer` and `X-Keni-Agent: alice`
- **THEN** the response is 409
- **AND** `error.code === "merge_conflict"`
- **AND** `error.details.branch === "ticket-0001"` and `error.details.base === "main"`
- **AND** `main`'s HEAD is unchanged (the failed `git merge --ff-only` aborted cleanly)
- **AND** the PR's status on disk is unchanged (still whatever it was before the call)
- **AND** the activity log gained zero `pr_merged` entries for this PR

#### Scenario: Non-engineer role rejected with 403 `role_not_owner`

- **WHEN** `POST /prs/pr-0001/merge` is called with `X-Keni-Role: qa` and `X-Keni-Agent: bob`
- **THEN** the response is 403
- **AND** `error.code === "role_not_owner"`
- **AND** `main`'s HEAD is unchanged
- **AND** the PR's status on disk is unchanged

#### Scenario: User override role is allowed

- **WHEN** `POST /prs/pr-0001/merge` is called with `X-Keni-Role: user`
- **AND** the branch is a fast-forward of `main`
- **THEN** the response is 200
- **AND** the activity-log `pr_merged` entry's `role` field is `"user"` (the calling role is recorded verbatim) and `agent` field is whatever the request's `X-Keni-Agent` value was, or absent if no `X-Keni-Agent` was sent

#### Scenario: Non-empty request body rejected with 400 `validation_failed`

- **WHEN** `POST /prs/pr-0001/merge` is called with a non-empty JSON body (e.g., `{ branch: "ticket-0001" }`)
- **AND** `X-Keni-Role: engineer`
- **THEN** the response is 400
- **AND** `error.code === "validation_failed"`
- **AND** `main`'s HEAD is unchanged

#### Scenario: Missing PR returns 404 `store_not_found`

- **WHEN** `POST /prs/pr-9999/merge` is called and no such PR exists
- **AND** `X-Keni-Role: engineer`
- **THEN** the response is 404
- **AND** `error.code === "store_not_found"`

#### Scenario: Concurrent merge attempts queue and execute serially

- **WHEN** two `POST /prs/:id/merge` requests for two different PRs (`pr-0001` and `pr-0002`, both fast-forward of `main` at request time) are issued concurrently
- **THEN** both responses are 200
- **AND** the second response's `merge_commit_sha` is a descendant of the first response's `merge_commit_sha` in the project repo's `main` history
- **AND** the activity log shows two `pr_merged` entries whose timestamps are non-overlapping (the second entry's `timestamp` is greater than or equal to the first entry's)

#### Scenario: `routes/prs.ts` does not import role-specific code

- **WHEN** the source of `packages/server/src/routes/prs.ts` is scanned for `from "@keni/runtime-engineer"`, `from "@keni/runtime-po"`, or `from "@keni/role-runtimes"`
- **THEN** zero occurrences are found
- **AND** the only `@keni/runtime-*` import is from `@keni/runtime-workspace`
