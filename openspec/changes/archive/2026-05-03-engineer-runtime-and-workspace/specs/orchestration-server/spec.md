## ADDED Requirements

### Requirement: `runServer` wires up the built-in engineer role runner at bootstrap

`runServer` SHALL, after constructing the scheduler but before `Deno.serve` accepts connections, instantiate a single shared `GitWorkspaceProvisioner` (from `@keni/role-runtimes`), filter the project's `agents` roster to entries whose `role` is `"engineer"`, and for each such entry: (1) call `await provisioner.ensureProvisioned(projectId, agentId, projectRepoPath)` where `projectRepoPath` is the resolved `--project` argument's absolute path; (2) construct an engineer runner via `createEngineerRunner(deps, opts)`; (3) call `scheduler.registerRunner(runner)`. `runServer` SHALL emit one info-level log line per engineer naming the agent id, the workspace path, and the elapsed provisioning time. `runServer` SHALL call `scheduler.start()` exactly once after every engineer is wired and only then SHALL `Deno.serve` accept connections. When the project's roster contains zero engineers (a future PO-only project), `runServer` SHALL skip the engineer-wiring loop entirely; this is not a failure. When `provisioner.ensureProvisioned` rejects for any single engineer, `runServer` SHALL exit with code 1 and a stderr message naming the failed agent and the underlying error code, *not* swallow the failure or skip that agent's registration.

#### Scenario: Engineer wiring runs before `Deno.serve` accepts

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a project whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]`
- **AND** an instrumented `provisioner.ensureProvisioned` and an instrumented `Deno.serve` both record their call times
- **THEN** `provisioner.ensureProvisioned("<projectId>", "alice", "<tempDir>")` was called exactly once
- **AND** the call resolved before `Deno.serve` began accepting connections

#### Scenario: Engineer runner is registered on the scheduler before start

- **WHEN** the same bootstrap completes
- **AND** an instrumented `scheduler.registerRunner` and `scheduler.start` both record their calls in arrival order
- **THEN** the captured array shows `registerRunner({ role: "engineer", expectedPromptName: "engineer", … })` was called exactly once
- **AND** `scheduler.start()` was called exactly once after `registerRunner`

#### Scenario: Engineer wiring is skipped when the roster has no engineers

- **WHEN** `runServer` is invoked against a project whose `agents` roster contains exactly `[{ id: "po", role: "po" }]`
- **THEN** `provisioner.ensureProvisioned` is called zero times
- **AND** `scheduler.registerRunner` is called zero times for the `engineer` role
- **AND** `runServer` returns exit code 0 on a normal shutdown

#### Scenario: Provisioning failure exits the server with code 1

- **WHEN** `provisioner.ensureProvisioned` rejects with `WorkspaceProvisioningError("git_clone_failed", …)` for the `alice` engineer
- **AND** `runServer` is invoked
- **THEN** the function returns exit code 1
- **AND** stderr names `"alice"` and the error code `"git_clone_failed"`
- **AND** `scheduler.start()` is not invoked
- **AND** `Deno.serve` is not invoked

### Requirement: `POST /prs/:id/merge` performs a fast-forward merge of the PR's branch onto `main` and returns the merge commit SHA

The orchestration server SHALL expose a new endpoint `POST /prs/:id/merge`. The endpoint SHALL: (1) require `X-Keni-Role: engineer` (rejecting any other role with `403 role_not_owner`, including `qa`, `po`, and `writer`; the `user` role override path is allowed per the existing `USER_OVERRIDE_ALLOWED` constant); (2) require an `X-Keni-Agent` header (rejecting absence with `400 missing_role` consistent with the existing role-identity middleware); (3) reject a non-empty request body with `400 validation_failed` (the PR record names the source branch — the request is identifier-only); (4) read the PR record via `PRStore.read(id)`, mapping `StoreNotFoundError` to `404 store_not_found`; (5) extract the source branch and the workspace path from the PR record (the workspace path is computed via the in-process `WorkspaceProvisioner.workspacePathFor(projectId, prRecord.author)`, where `prRecord.author` is the engineer who created the PR); (6) execute, in the project repo working directory `runServer.projectRepoPath`, the sequence `git fetch <workspacePath> <branch>:<branch>` followed by `git merge --ff-only <branch>` against `main`; (7) on `git merge --ff-only` exit code 0, read the merge commit SHA via `git rev-parse HEAD`, call `PRStore.updateStatus(id, prRecord.status, "merged")` (mapping `StaleStateError` to `409 stale_state`), call `ActivityLogStore.append(...)` with `event: "pr_merged"`, `agent: <calling agent id>`, `role: "engineer"`, `summary: "Merged PR <id> as <sha>"`, `refs: { pr_id: id, branch, merge_commit_sha: <sha> }`, and respond `200 { data: { merge_commit_sha: string }, project_id }`; (8) on `git merge --ff-only` exit code 1 (the workspace's branch tip is not a descendant of `main`'s tip), respond `409 { error: { code: "merge_conflict", message: "Branch is not a fast-forward of main", details: { branch, base: "main", git_stderr } }, project_id }` and SHALL NOT update the PR's status; (9) on any other git failure (missing branch, missing workspace, git binary unavailable), respond `400 { error: { code: "validation_failed", message: <message naming the failure mode>, details: { ... } }, project_id }`. The endpoint SHALL serialise concurrent merge attempts via a per-server in-process `Mutex` (single-writer on the project repo); concurrent requests SHALL queue and execute in arrival order with no observable interleaving.

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

### Requirement: The `ErrorCode` enum gains `merge_conflict` and the `EventName` union gains `pr_merged`

The `ErrorCode` enum exported from `@keni/shared/wire/errors.ts` SHALL be extended additively to include the new code `merge_conflict`. The `EventName` union exported from `@keni/shared/wire/activity.ts` SHALL be extended additively to include the new event `pr_merged`. Both additions SHALL be backward-compatible (existing consumers that pattern-match on the enum/union SHALL continue to compile; consumers that exhaustively switch over either union SHALL gain a new case to handle, and TypeScript SHALL flag missing branches at `deno task check` time). No existing code SHALL be removed or renamed.

#### Scenario: `ErrorCode` enum includes `merge_conflict`

- **WHEN** the `ErrorCode` type or constant exported from `@keni/shared` is inspected
- **THEN** the value `"merge_conflict"` is a member
- **AND** all previously-documented values (`store_not_found`, `stale_state`, `duplicate_id`, `invalid_artifact`, `status_in_patch`, `status_graph_violation`, `role_not_owner`, `missing_role`, `validation_failed`, `internal_error`) are still members

#### Scenario: `EventName` union includes `pr_merged`

- **WHEN** the `EventName` type or constant exported from `@keni/shared` is inspected
- **THEN** the value `"pr_merged"` is a member
- **AND** all previously-documented event names (including `session_start`, `session_end`, `subprocess_stdout`, `subprocess_stderr`, `idle`, `subprocess_output_truncated`, `session_interrupted`, `session_timeout`) are still members

#### Scenario: Exhaustive switches over `ErrorCode` flag a missing `merge_conflict` branch

- **WHEN** a consumer writes a `switch (code)` that omits the `"merge_conflict"` case
- **THEN** `deno task check` fails with a TypeScript error naming the missing case

### Requirement: `runServer` constructs the workspace provisioner once per server lifecycle and shares it across handlers that need workspace paths

`runServer` SHALL instantiate exactly one `GitWorkspaceProvisioner` per server invocation, *before* the engineer-wiring loop. The same instance SHALL be passed to every `createEngineerRunner` call (so all engineers share the provisioner) and SHALL be made available to the `POST /prs/:id/merge` handler via the existing `createServer(deps, opts)` deps bag (a new `workspaceProvisioner: WorkspaceProvisioner` field is added to `ServerDeps`). The provisioner SHALL NOT be reconstructed on hot-reload, request boundary, or any in-process boundary other than `runServer` exit. On `runServer` shutdown, the provisioner SHALL NOT be discarded — workspaces persist across server restarts per the engineer-runtime capability's documented lifecycle.

#### Scenario: Exactly one provisioner is constructed per `runServer` lifecycle

- **WHEN** an instrumented `GitWorkspaceProvisioner` constructor records its calls
- **AND** `runServer(["--project=<tempDir>", "--port=0"])` is invoked, runs through bootstrap, accepts one merge request, and shuts down cleanly
- **THEN** the constructor was called exactly once during that lifecycle

#### Scenario: The merge handler reads `workspaceProvisioner` from `ServerDeps`

- **WHEN** `createServer({ ticketStore, prStore, activityLogStore, configStore, logSink, workspaceProvisioner }, opts)` is constructed
- **AND** the merge handler is invoked for a PR whose `author` is `"alice"`
- **THEN** the handler calls `workspaceProvisioner.workspacePathFor(opts.projectId, "alice")` to obtain the source-branch's workspace path
- **AND** the resolved path is the absolute path the engineer's pushed branch lives in

## MODIFIED Requirements

### Requirement: A status-graph constant encodes the §4.1 ticket lifecycle and the §4.2 owning-role rule

The server SHALL export a frozen constant `TICKET_STATUS_TRANSITIONS` whose shape is `Readonly<Record<TicketStatus, readonly TicketStatus[]>>` and whose entries SHALL match the diagram in `spec.md` §4.1 edge-for-edge: `open → [in_progress]`; `in_progress → [ready_for_review]`; `ready_for_review → [in_review]`; `in_review → [has_comments, approved]`; `has_comments → [in_progress]`; `approved → [merged]`; `merged → [ready_for_test]`; `ready_for_test → [in_testing]`; `in_testing → [tested, test_failed]`; `tested → [done]`; `test_failed → [in_progress]`; `done → []`. The server SHALL export a frozen constant `TICKET_STATUS_OWNING_ROLES` whose entries map each status to the role(s) authorised to transition into it: `engineer` for `in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, `ready_for_test`; `qa` for `in_testing`, `tested`, `test_failed`; `po` for `done`; `[]` (no role) for `open`. The server SHALL also export `USER_OVERRIDE_ALLOWED = ["user"]`: the `user` role SHALL be authorised to transition into any status (the override path), although the prototype SHALL NOT yet emit a corresponding `manual_override` activity-log entry (see the deferred-override requirement below). PRs SHALL have an analogous pair of constants (`PR_STATUS_TRANSITIONS`, `PR_STATUS_OWNING_ROLES`) covering the engineer-only PR lifecycle, **including a documented edge `approved → merged` that the new `POST /prs/:id/merge` endpoint owns** (the endpoint calls `PRStore.updateStatus(id, prRecord.status, "merged")` after the fast-forward succeeds; the engineer also has the option to drive this transition via the existing `POST /prs/:id/transition` endpoint, but production code SHALL prefer the merge endpoint because the merge endpoint is the only path that performs the actual git fast-forward).

#### Scenario: `TICKET_STATUS_TRANSITIONS` matches `spec.md` §4.1 line-for-line

- **WHEN** the value of `TICKET_STATUS_TRANSITIONS` is read
- **THEN** every key listed in `spec.md` §4.1 is present
- **AND** every outgoing edge listed in `spec.md` §4.1 is in the corresponding array
- **AND** no extra edges are present

#### Scenario: `done` is a terminal state in the graph

- **WHEN** the value of `TICKET_STATUS_TRANSITIONS.done` is read
- **THEN** the array is empty
- **AND** any transition request whose `to` field is `done` is allowed only from `tested` (per the graph)

#### Scenario: `TICKET_STATUS_OWNING_ROLES` enforces the §4.2 ownership table

- **WHEN** the value of `TICKET_STATUS_OWNING_ROLES` is read
- **THEN** `in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, and `ready_for_test` map to `["engineer"]`
- **AND** `in_testing`, `tested`, `test_failed` map to `["qa"]`
- **AND** `done` maps to `["po"]`
- **AND** `open` maps to `[]`

#### Scenario: `user` is allowed for every transition target

- **WHEN** any ticket-transition request is made with `X-Keni-Role: user`
- **AND** the `from`/`to` pair is in `TICKET_STATUS_TRANSITIONS`
- **THEN** the role guard SHALL NOT reject the request
- **AND** the transition SHALL be applied

#### Scenario: `PR_STATUS_TRANSITIONS` includes the `approved → merged` edge owned by the merge endpoint

- **WHEN** the value of `PR_STATUS_TRANSITIONS.approved` is read
- **THEN** the array contains `"merged"`
- **AND** the merge endpoint's post-success `PRStore.updateStatus(id, "approved", "merged")` call passes the `from`/`to` graph check
