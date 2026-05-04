# engineer-runtime Specification

## Purpose
TBD - created by archiving change engineer-runtime-and-workspace. Update Purpose after archive.
## Requirements
### Requirement: `@keni/role-runtimes` exposes a `createEngineerRunner(deps, opts)` factory that returns an `AgentRunner` for the scheduler

The `@keni/role-runtimes` package SHALL export, from `packages/role-runtimes/src/engineer/runner.ts` (re-exported through `packages/role-runtimes/src/main.ts`), a factory `createEngineerRunner(deps: EngineerRunnerDeps, opts: EngineerRunnerOpts): AgentRunner` whose return value satisfies the scheduler's `AgentRunner` interface from the `scheduler` capability (the bag of `{ role, precheck, promptResolver, expectedPromptName, codingAgentInvoker, envAllowlist?, mcpServerConfig?, idleThresholdMs?, terminationGraceMs? }` the scheduler hands to `startCycle` per tick). The returned runner's `role` field SHALL be the literal `"engineer"`. The returned runner's `expectedPromptName` SHALL be the literal `"engineer"` so the role-runtime cycle's prompt-name guard catches accidental wiring of a non-engineer prompt. The returned runner SHALL be safe to register on a single scheduler instance via `scheduler.registerRunner(runner)` exactly once; the runner SHALL NOT hold scheduler-specific state (the runner is a value bag, not a stateful object). The factory SHALL be pure: it SHALL NOT spawn subprocesses, SHALL NOT call `git`, SHALL NOT call `fetch`, and SHALL NOT touch the filesystem; every effectful primitive (the workspace provisioner, the coding-agent invoker, the activity client used by the precheck) flows in through `deps`. `EngineerRunnerDeps` SHALL be `{ provisioner: WorkspaceProvisioner, codingAgentInvoker: CodingAgentInvoker, activityHttpClient: { listTickets(filter): Promise<TicketSummary[]> }, logger: Logger }`. `EngineerRunnerOpts` SHALL be `{ projectId: string, projectName: string, agentId: string, projectRepoPath: string, serverUrl: string, mcpServerConfig: McpServerConfig, envAllowlist?: readonly string[], idleThresholdMs?: number, terminationGraceMs?: number }`.

#### Scenario: `createEngineerRunner` returns an `AgentRunner` whose `role` is `"engineer"` and `expectedPromptName` is `"engineer"`

- **WHEN** a caller invokes `createEngineerRunner({ provisioner: fakeProvisioner, codingAgentInvoker: fakeInvoker, activityHttpClient: fakeClient, logger: fakeLogger }, { projectId: "p1", projectName: "demo", agentId: "alice", projectRepoPath: "/tmp/demo", serverUrl: "http://127.0.0.1:5174", mcpServerConfig: { … } })`
- **THEN** the returned value has `role === "engineer"`
- **AND** the returned value has `expectedPromptName === "engineer"`
- **AND** the returned value has a `precheck` that is a function
- **AND** the returned value has a `promptResolver` that is a function
- **AND** the returned value has a `codingAgentInvoker` referentially equal to the `deps.codingAgentInvoker` value passed in

#### Scenario: `createEngineerRunner` is pure — no I/O at construction

- **WHEN** the factory is invoked with `deps` whose every member records its calls
- **THEN** the factory returns synchronously without invoking any `deps` member
- **AND** no `git` subprocess is spawned during the factory call
- **AND** no `fetch` is issued during the factory call
- **AND** no path under `~/.keni/workspaces/` is created during the factory call

#### Scenario: A returned runner is safe to register on the scheduler

- **WHEN** the returned runner is passed to `scheduler.registerRunner(runner)`
- **THEN** the registration succeeds
- **AND** a subsequent `registry.get("engineer")` returns the same runner reference

### Requirement: The engineer precheck pulls `main`, queries the orchestration server, and returns the top-of-queue ticket or skips

The runner's `precheck(prepCtx)` SHALL execute these steps in this order, and SHALL NOT execute any later step when an earlier step short-circuits:

1. **Pull main.** Call `deps.provisioner.pullMain(opts.projectId, opts.agentId)`. On rejection, log a warn-level "engineer.pull_main_failed" line naming the agent and the error, and return `{ kind: "skip", reason: "pull_main_failed" }`. The cycle SHALL NOT proceed; the role-runtime cycle's "no `POST /activity` on the skip path" rule then guarantees the activity log is silent for this tick.
2. **In-flight query.** Call `deps.activityHttpClient.listTickets({ status: ["in_progress", "ready_for_review", "in_review", "has_comments", "approved", "merged"], assignee: opts.agentId })`. If the result is non-empty, return `{ kind: "proceed", roleContext: { summary: "ticket-NNNN (in-flight)", ticketId: <top result's id> } }` for the highest-priority ticket (`priority` descending, ties broken by id ascending — the deterministic order documented in the orchestration-server `list` contract). Step 4 (pickup) SHALL be skipped.
3. **Pickup query.** Call `deps.activityHttpClient.listTickets({ status: ["open", "test_failed", "has_comments"], assignee: null })`. The `assignee: null` filter selects tickets that no engineer currently owns. If the result is non-empty, return `{ kind: "proceed", roleContext: { summary: "ticket-NNNN (picking up)", ticketId: <top result's id> } }` for the top result by the same priority order.
4. **Skip.** Return `{ kind: "skip", reason: "no_ticket_to_pick_up" }`.

The precheck SHALL NOT mutate any ticket's `assignee` or `status` field; the engineer's bundled prompt teaches the agent to do that on its first MCP call. The precheck SHALL NOT depend on `prepCtx.workspacePath` (the workspace path is already known to the precheck via `opts.agentId` + `deps.provisioner.workspacePathFor(...)`); the runtime hands `workspacePath` to `prepCtx` for documentation and downstream use.

#### Scenario: `precheck` calls `pullMain` first, before any HTTP query

- **WHEN** the precheck is invoked
- **AND** `deps.provisioner` and `deps.activityHttpClient` both record their calls in arrival order
- **THEN** the first recorded call is `provisioner.pullMain("p1", "alice", …)`
- **AND** at most one `activityHttpClient.listTickets` call has been made by the time the precheck resolves (or none if step 2 short-circuits)

#### Scenario: `pullMain` failure short-circuits to `skip` with no HTTP traffic

- **WHEN** `deps.provisioner.pullMain` rejects with `Error("non-fast-forward")`
- **AND** the precheck is invoked
- **THEN** the precheck resolves with `{ kind: "skip", reason: "pull_main_failed" }`
- **AND** no `activityHttpClient.listTickets` call was made
- **AND** the captured logger gained one warn-level line whose `code` is `"engineer.pull_main_failed"` and whose payload names `"alice"` and the error message

#### Scenario: An in-flight ticket is preferred over an unassigned `open` ticket

- **WHEN** `activityHttpClient.listTickets({ status: ["in_progress", …], assignee: "alice" })` resolves to `[{ id: "ticket-0007", priority: 50 }]`
- **AND** an `open` unassigned ticket also exists with priority 100
- **THEN** the precheck resolves with `{ kind: "proceed", roleContext: { summary: "ticket-0007 (in-flight)", ticketId: "ticket-0007" } }`
- **AND** the second `listTickets` call (for unassigned `open` tickets) was not issued

#### Scenario: Top-of-queue order is `priority` descending, id ascending

- **WHEN** the unassigned-open query resolves to `[{ id: "ticket-0003", priority: 50 }, { id: "ticket-0001", priority: 100 }, { id: "ticket-0002", priority: 100 }]`
- **AND** no in-flight tickets exist
- **THEN** the precheck resolves with `{ kind: "proceed", roleContext: { summary: "ticket-0001 (picking up)", ticketId: "ticket-0001" } }` (priority 100 wins, ties broken by lowest id)

#### Scenario: Empty board returns `skip` with `no_ticket_to_pick_up`

- **WHEN** both `listTickets` queries resolve to `[]`
- **THEN** the precheck resolves with `{ kind: "skip", reason: "no_ticket_to_pick_up" }`
- **AND** no further calls are made (the cycle does not generate a `session_id`, per the role-runtime cycle's precheck contract)

### Requirement: `WorkspaceProvisioner` interface and `GitWorkspaceProvisioner` default exist with the documented method surface

The `@keni/role-runtimes` package SHALL export, from `packages/role-runtimes/src/engineer/workspace/interface.ts`, a TypeScript interface `WorkspaceProvisioner` whose method surface is exactly:

```ts
interface WorkspaceProvisioner {
  workspacePathFor(projectId: string, agentId: string): string;
  ensureProvisioned(projectId: string, agentId: string, projectRepoPath: string): Promise<void>;
  pullMain(projectId: string, agentId: string): Promise<void>;
  discardProvisioned(projectId: string, agentId: string): Promise<void>;
}
```

The package SHALL also export `class GitWorkspaceProvisioner implements WorkspaceProvisioner` from `packages/role-runtimes/src/engineer/workspace/git.ts` as the default implementation. `GitWorkspaceProvisioner`'s constructor SHALL accept `{ homeDir: string, gitBinary?: string, logger: Logger, clock?: Clock }` (defaults: `gitBinary = "git"`, `clock = realClock`). The package SHALL also export `class FakeWorkspaceProvisioner implements WorkspaceProvisioner` from `packages/role-runtimes/src/engineer/workspace/fakes/fakeWorkspaceProvisioner.ts` for test use; the fake SHALL record every call in arrival order and SHALL never touch the filesystem. The package's main barrel (`packages/role-runtimes/src/main.ts`) SHALL re-export `WorkspaceProvisioner` and `GitWorkspaceProvisioner` so downstream consumers (steps 13, 25, 26) can import them directly from `@keni/role-runtimes`.

#### Scenario: `WorkspaceProvisioner` interface is importable from `@keni/role-runtimes`

- **WHEN** a downstream module writes `import { WorkspaceProvisioner, GitWorkspaceProvisioner } from "@keni/role-runtimes"`
- **THEN** both names resolve without error
- **AND** `WorkspaceProvisioner` is a type and `GitWorkspaceProvisioner` is a class

#### Scenario: The interface's method surface is exactly four methods

- **WHEN** the source file under `packages/role-runtimes/src/engineer/workspace/interface.ts` is inspected
- **THEN** the `WorkspaceProvisioner` interface declares exactly the four methods `workspacePathFor`, `ensureProvisioned`, `pullMain`, and `discardProvisioned`
- **AND** no other methods are declared

#### Scenario: `GitWorkspaceProvisioner` accepts the documented constructor options

- **WHEN** `new GitWorkspaceProvisioner({ homeDir: "/tmp/home", logger: fakeLogger })` is invoked
- **THEN** the construction succeeds
- **AND** `provisioner.workspacePathFor("p1", "alice")` returns `"/tmp/home/.keni/workspaces/p1/alice"`

#### Scenario: `FakeWorkspaceProvisioner` records calls without touching the filesystem

- **WHEN** `await fakeProvisioner.ensureProvisioned("p1", "alice", "/tmp/repo")` is invoked
- **AND** the test inspects `fakeProvisioner.calls`
- **THEN** the array contains one entry of shape `{ method: "ensureProvisioned", args: ["p1", "alice", "/tmp/repo"] }`
- **AND** no path under `/tmp/home/.keni/` was created

### Requirement: `workspacePathFor(projectId, agentId)` returns `<homeDir>/.keni/workspaces/<projectId>/<agentId>` deterministically

`GitWorkspaceProvisioner.workspacePathFor(projectId, agentId)` SHALL return `joinPath(homeDir, ".keni", "workspaces", projectId, agentId)` using the platform-appropriate path separator (forward slash on POSIX; the existing `@std/path` `join` is the implementation primitive). The method SHALL NOT consult the filesystem. The method SHALL NOT validate `projectId` or `agentId` shape (the caller's `EngineerRunnerOpts.projectId` is the project's UUIDv4 from `project.yaml`, validated upstream by `keni init`; the caller's `agentId` is enforced by the orchestration server's role-identity middleware via `/^[a-z0-9_-]+$/`). On Windows, `homeDir` SHALL be sourced from `Deno.env.get("USERPROFILE")` with a fallback to `Deno.env.get("HOME")`; the constructor SHALL throw `WorkspaceProvisioningError("home_dir_unset", ...)` at construction if both are absent.

#### Scenario: Path is deterministic for the same `(projectId, agentId)` pair

- **WHEN** `provisioner.workspacePathFor("p1", "alice")` is called twice
- **THEN** both calls return the identical string

#### Scenario: Different `agentId` values produce sibling paths

- **WHEN** `provisioner.workspacePathFor("p1", "alice")` returns `<homeDir>/.keni/workspaces/p1/alice`
- **AND** `provisioner.workspacePathFor("p1", "bob")` is called
- **THEN** the returned path is `<homeDir>/.keni/workspaces/p1/bob` (sibling under the same project subtree)

#### Scenario: `workspacePathFor` does not consult the filesystem

- **WHEN** `provisioner.workspacePathFor(...)` is called
- **THEN** no `Deno.stat`, `Deno.readDir`, or other filesystem syscall has been made by the time the method returns

### Requirement: `ensureProvisioned` performs a sparse clone whose checkout pattern excludes `.keni/`

`GitWorkspaceProvisioner.ensureProvisioned(projectId, agentId, projectRepoPath)` SHALL ensure the workspace directory `workspacePathFor(projectId, agentId)` exists and contains a sparse-checkout git clone of `projectRepoPath`. The method SHALL be idempotent: a second call with identical arguments after a successful first call SHALL be a near-no-op (it SHALL verify the workspace's invariants — `.git/` exists, sparse-checkout is configured, the pattern excludes `.keni/`, the per-workspace identity is set — and SHALL NOT re-clone). The method SHALL execute these steps when the workspace does not already exist:

1. Recursively create the parent directory `<homeDir>/.keni/workspaces/<projectId>/`.
2. `git clone --no-checkout --origin origin <projectRepoPath> <workspacePath>` (clone without checking out any files; the sparse pattern is set before checkout).
3. `git -C <workspacePath> sparse-checkout init --no-cone`.
4. Write `<workspacePath>/.git/info/sparse-checkout` with exactly two lines: `/*` followed by `!.keni/` (each line terminated with `\n`; no trailing blank line).
5. `git -C <workspacePath> sparse-checkout reapply`.
6. `git -C <workspacePath> checkout main` (creates the working tree according to the sparse pattern).
7. `git -C <workspacePath> config --local user.name "<agentId>"`.
8. `git -C <workspacePath> config --local user.email "<agentId>@keni.invalid"`.
9. **Verify.** Assert `<workspacePath>/.keni/` does not exist (via `Deno.lstat` rejecting with `NotFound`); throw `WorkspaceProvisioningError("sparse_pattern_failed", ...)` otherwise.

When the workspace already exists, the method SHALL: (a) verify `.git/` exists; (b) verify the sparse-checkout pattern file equals the documented two lines (re-write if drift is detected, then re-apply); (c) verify per-workspace identity matches `<agentId>` / `<agentId>@keni.invalid` (re-write if drift is detected); (d) verify `<workspacePath>/.keni/` is absent. The method SHALL NOT modify the host's `~/.gitconfig`, SHALL NOT modify any system-level git config, and SHALL NOT modify the project repo at `projectRepoPath`. On any git subprocess failure, the method SHALL throw `WorkspaceProvisioningError(<code>, <message>, { stderr, stdout, exitCode })` where `<code>` is one of `git_clone_failed`, `sparse_init_failed`, `sparse_reapply_failed`, `checkout_failed`, `git_config_failed`, `home_dir_unset`, or `sparse_pattern_failed`.

#### Scenario: First-time provisioning produces a sparse-checkout clone with `.keni/` absent

- **WHEN** `await provisioner.ensureProvisioned("p1", "alice", "/tmp/demo-repo")` is invoked against a real git project repo containing `src/main.ts` and `.keni/project.yaml`
- **AND** the workspace path `<homeDir>/.keni/workspaces/p1/alice/` does not yet exist on disk
- **THEN** the method resolves successfully
- **AND** `<workspacePath>/.git/` exists as a directory
- **AND** `<workspacePath>/src/main.ts` exists as a regular file (the project's source file is checked out)
- **AND** `<workspacePath>/.keni/` does not exist (the sparse pattern excluded it)
- **AND** `<workspacePath>/.git/info/sparse-checkout` contains exactly the two lines `/*` and `!.keni/`

#### Scenario: Per-workspace git identity is set, host `~/.gitconfig` untouched

- **WHEN** `await provisioner.ensureProvisioned("p1", "alice", "/tmp/demo-repo")` succeeds
- **AND** `git -C <workspacePath> config --get user.name` is read
- **THEN** the value is `"alice"`
- **AND** `git -C <workspacePath> config --get user.email` returns `"alice@keni.invalid"`
- **AND** the host's `~/.gitconfig` (or equivalent global config) is unchanged from before the call (byte-for-byte identical SHA)

#### Scenario: Idempotent re-provisioning is a near-no-op

- **WHEN** `ensureProvisioned("p1", "alice", "/tmp/demo-repo")` succeeds once
- **AND** the same call is invoked a second time with no intervening changes
- **THEN** the second call resolves successfully
- **AND** the workspace tree's mtime is unchanged (no fresh clone occurred)
- **AND** the per-workspace `.git/config` `[user]` section is unchanged

#### Scenario: Idempotent re-provisioning repairs a drifted sparse-checkout pattern

- **WHEN** `ensureProvisioned` previously succeeded and produced the documented sparse-checkout pattern
- **AND** an external process overwrites `<workspacePath>/.git/info/sparse-checkout` with the single line `/*` (no `.keni/` exclusion)
- **AND** `ensureProvisioned("p1", "alice", "/tmp/demo-repo")` is invoked again
- **THEN** the method re-writes the pattern file with the documented two lines
- **AND** runs `git sparse-checkout reapply`
- **AND** the post-call assertion that `<workspacePath>/.keni/` does not exist passes

#### Scenario: Verification failure throws `WorkspaceProvisioningError("sparse_pattern_failed")`

- **WHEN** `ensureProvisioned` runs and the post-checkout assertion finds `<workspacePath>/.keni/` exists (e.g., a sparse-checkout-incapable git binary silently ignored the pattern)
- **THEN** the method rejects with `WorkspaceProvisioningError`
- **AND** the error's `code` is `"sparse_pattern_failed"`
- **AND** the workspace tree is *not* removed by the rejection (debugging is left to the operator)

#### Scenario: Missing git binary throws `WorkspaceProvisioningError("git_clone_failed")`

- **WHEN** `new GitWorkspaceProvisioner({ homeDir, gitBinary: "/no/such/git", logger })` is constructed
- **AND** `await provisioner.ensureProvisioned("p1", "alice", "/tmp/repo")` is invoked
- **THEN** the method rejects with `WorkspaceProvisioningError`
- **AND** the error's `code` is `"git_clone_failed"`
- **AND** the error's `details.stderr` names the missing binary

### Requirement: `pullMain` runs `git pull --ff-only origin main` and surfaces failures as a typed error

`GitWorkspaceProvisioner.pullMain(projectId, agentId)` SHALL run `git -C <workspacePath> pull --ff-only origin main`. On exit code 0 the method SHALL resolve. On any non-zero exit, the method SHALL reject with `WorkspaceProvisioningError("pull_main_failed", <git stderr>, { exitCode, stderr, stdout })`. The method SHALL NOT attempt a non-fast-forward merge, SHALL NOT auto-rebase, and SHALL NOT auto-stash uncommitted changes (the engineer prompt teaches the agent to commit work-in-progress on its `ticket-NNNN` branch before yielding). On a missing workspace (the directory does not exist), the method SHALL reject with `WorkspaceProvisioningError("workspace_missing", ...)`; the engineer runner's precheck handles this rejection by mapping to `{ kind: "skip", reason: "pull_main_failed" }`.

#### Scenario: Successful fast-forward pull resolves silently

- **WHEN** the project repo's `main` advances by one commit
- **AND** `await provisioner.pullMain("p1", "alice")` is invoked
- **THEN** the method resolves
- **AND** `<workspacePath>/main`'s git log includes the new commit (`git -C <workspacePath> log -1 --format=%H` matches the project repo's tip)

#### Scenario: Non-fast-forward pull rejects with `pull_main_failed`

- **WHEN** the workspace's `main` and the project repo's `main` have diverged (rare in single-engineer prototype, common to test)
- **AND** `await provisioner.pullMain("p1", "alice")` is invoked
- **THEN** the method rejects with `WorkspaceProvisioningError`
- **AND** the error's `code` is `"pull_main_failed"`
- **AND** the workspace's tree is unchanged (`--ff-only` aborts cleanly on a non-fast-forward)

#### Scenario: Missing workspace rejects with `workspace_missing`

- **WHEN** `pullMain("p1", "ghost")` is invoked and `<homeDir>/.keni/workspaces/p1/ghost/` does not exist
- **THEN** the method rejects with `WorkspaceProvisioningError`
- **AND** the error's `code` is `"workspace_missing"`

### Requirement: `discardProvisioned` removes the workspace tree recursively, no-op when the path does not exist

`GitWorkspaceProvisioner.discardProvisioned(projectId, agentId)` SHALL recursively remove the directory `workspacePathFor(projectId, agentId)` via `Deno.remove(path, { recursive: true })`. When the path does not exist, the method SHALL resolve without error (no-op). The method SHALL NOT remove the parent `<homeDir>/.keni/workspaces/<projectId>/` directory even when the removed workspace was the last child (other engineers' workspaces may co-exist; cleanup of the parent is left to a future `keni doctor` flow). The method SHALL NOT touch the project repo at `projectRepoPath`. The method SHALL NOT emit any activity-log entry; workspace lifecycle is below the activity-log abstraction.

#### Scenario: Removing an existing workspace clears its tree

- **WHEN** `<workspacePath>` exists with a populated git tree
- **AND** `await provisioner.discardProvisioned("p1", "alice")` is invoked
- **THEN** the method resolves
- **AND** `<workspacePath>` no longer exists (`Deno.lstat` rejects with `NotFound`)
- **AND** `<homeDir>/.keni/workspaces/p1/` still exists as a (possibly empty) directory

#### Scenario: Removing a missing workspace is a no-op

- **WHEN** `<homeDir>/.keni/workspaces/p1/ghost/` does not exist
- **AND** `await provisioner.discardProvisioned("p1", "ghost")` is invoked
- **THEN** the method resolves
- **AND** no error is thrown

#### Scenario: Sibling workspaces are unaffected

- **WHEN** `<workspacePath_alice>` and `<workspacePath_bob>` both exist under the same project
- **AND** `discardProvisioned("p1", "alice")` is invoked
- **THEN** `<workspacePath_alice>` is removed
- **AND** `<workspacePath_bob>` is unchanged (its tree's mtime equals the pre-call value)

### Requirement: The runner's `promptResolver` returns the bundled engineer prompt as a TS string constant

The runner's `promptResolver` SHALL return `{ name: ENGINEER_PROMPT_NAME, body: ENGINEER_PROMPT_BODY }` where both constants are imported from `packages/role-runtimes/src/engineer/prompts/engineer.ts`. `ENGINEER_PROMPT_NAME` SHALL be the string literal `"engineer"`. `ENGINEER_PROMPT_BODY` SHALL be a non-empty TypeScript string constant exported from the prompt module — it SHALL NOT be loaded from a file at runtime, SHALL NOT be assembled from `Deno.readTextFile` calls, and SHALL NOT be templated against any environment variable. The role-runtime cycle's `expectedPromptName` guard SHALL receive `"engineer"` so a future accidental swap of the prompt body for a different role's prompt fails at boot, not at runtime.

#### Scenario: `promptResolver` returns the bundled name and body

- **WHEN** the runner's `promptResolver(prepCtx)` is invoked
- **THEN** the returned value is `{ name: "engineer", body: <ENGINEER_PROMPT_BODY> }`
- **AND** the body is a non-empty string

#### Scenario: The prompt body is a TS string constant, not a file read

- **WHEN** the source file `packages/role-runtimes/src/engineer/prompts/engineer.ts` is inspected
- **THEN** `ENGINEER_PROMPT_BODY` is declared as `export const ENGINEER_PROMPT_BODY = "..."` (a string-literal constant)
- **AND** no `Deno.readTextFile`, `Deno.readFile`, or `import.meta.resolve` call appears in the file
- **AND** the constant's `.length` is greater than zero at module-load time

#### Scenario: The cycle's prompt-name guard rejects a body whose name doesn't equal `"engineer"`

- **WHEN** the runner is wired into the role-runtime cycle and the cycle is invoked
- **AND** an instrumented `resolveBundledPrompt` records the `(prompt, expectedName)` it receives
- **THEN** the captured `expectedName` is `"engineer"`
- **AND** a contrived `promptResolver` returning `{ name: "po-chat", body: "..." }` causes `resolveBundledPrompt` to throw `RoleRuntimeError("prompt_name_mismatch", …)` and the cycle to short-circuit with `outcome: "spawn_failed"`

### Requirement: The runner's `mcpServerConfig` includes the engineer's `agentId`, `serverUrl`, and `workspacePath`, and the `merge_pr` MCP tool is available to the subprocess

The runner SHALL pass `mcpServerConfig` through `RoleCycleParams` to the role-runtime cycle, which writes it to a temp `mcpServers` JSON file and hands the path to the coding-agent CLI (per the role-runtime spec's invoker contract). The `mcpServerConfig` SHALL be constructed at runner-creation time from `opts.serverUrl`, `opts.agentId`, and `provisioner.workspacePathFor(opts.projectId, opts.agentId)`, and SHALL invoke the existing `runMcpServer` binary (per the mcp-engineer-surface spec) with `--agent <agentId> --server-url <serverUrl> --workspace <workspacePath>`. The MCP server's tool surface SHALL include the new `merge_pr` tool (defined in the mcp-engineer-surface delta within this same change), so the engineer's bundled prompt can call it without further wiring.

#### Scenario: `mcpServerConfig` carries the engineer's identity into the subprocess

- **WHEN** the runner is invoked through the role-runtime cycle
- **AND** the cycle's invoker captures the args passed to the MCP-server subprocess
- **THEN** the captured args include `--agent alice`, `--server-url http://127.0.0.1:<port>`, and `--workspace <homeDir>/.keni/workspaces/p1/alice` in the documented `--key=value` or `--key value` form

#### Scenario: `merge_pr` is registered on the MCP server the engineer subprocess sees

- **WHEN** the engineer's MCP-server subprocess is started via the runner
- **AND** the subprocess's tool list is queried over the stdio transport
- **THEN** the returned names include `merge_pr`

### Requirement: `runServer` wires up the engineer runner at bootstrap before `Deno.serve` accepts connections

The orchestration-server `runServer` SHALL, after constructing the scheduler but before `Deno.serve` accepts connections: (1) read the project config and filter the `agents` roster to entries whose `role` is `"engineer"`; (2) for each engineer entry, instantiate a single shared `GitWorkspaceProvisioner` (the same instance is reused across engineers); (3) call `await provisioner.ensureProvisioned(projectId, agentId, projectRepoPath)` for each engineer (if any single call rejects, `runServer` SHALL exit with code 1 and a stderr message naming the failed agent and the underlying error code, *not* swallow the failure); (4) construct the engineer runner via `createEngineerRunner({ provisioner, codingAgentInvoker, activityHttpClient, logger }, { projectId, projectName, agentId, projectRepoPath, serverUrl, mcpServerConfig, envAllowlist, idleThresholdMs, terminationGraceMs })` for each engineer; (5) call `scheduler.registerRunner(runner)` for each. Steps (3) through (5) SHALL run in the roster's declared order. `runServer` SHALL emit one info-level log line per engineer naming the agent, the workspace path, and the elapsed provisioning time. After all engineers are wired, `runServer` SHALL call `scheduler.start()` exactly once and only then SHALL `Deno.serve` accept connections.

When the project's roster contains zero engineers (a future PO-only project), `runServer` SHALL skip the engineer-wiring loop entirely; this is not a failure. The provisioner SHALL be instantiated on every `runServer` invocation; the prototype does not persist provisioner state across server restarts.

#### Scenario: `runServer` provisions the engineer's workspace before `Deno.serve` accepts

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a project whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]`
- **AND** an instrumented provisioner records its `ensureProvisioned` calls in arrival order
- **AND** an instrumented `Deno.serve` records the time at which it begins accepting connections
- **THEN** `provisioner.ensureProvisioned("<projectId>", "alice", "<tempDir>")` was called exactly once
- **AND** the provisioning call resolved before `Deno.serve` began accepting

#### Scenario: `runServer` registers the engineer runner on the scheduler

- **WHEN** the same `runServer` invocation completes its bootstrap
- **AND** an instrumented `scheduler.registerRunner` records its calls
- **THEN** the captured array contains exactly one runner whose `role === "engineer"` and `expectedPromptName === "engineer"`

#### Scenario: `runServer` exits 1 when provisioning fails

- **WHEN** the configured `projectRepoPath` is unreadable (e.g., `/dev/null/repo`) so `ensureProvisioned` rejects
- **AND** `runServer(["--project=<tempDir>"])` is invoked
- **THEN** the function returns exit code 1
- **AND** stderr names the agent `"alice"` and the error code (`git_clone_failed`)
- **AND** the scheduler is not started (no per-agent timer is armed)
- **AND** `Deno.serve` is not invoked

#### Scenario: `runServer` skips engineer wiring when the roster has no engineers

- **WHEN** `runServer` is invoked against a project whose `agents` roster contains exactly `[{ id: "po", role: "po" }]`
- **THEN** `provisioner.ensureProvisioned` is called zero times
- **AND** `scheduler.registerRunner` is called zero times for the `engineer` role
- **AND** the server starts cleanly (no "missing engineer" warning is emitted)

### Requirement: An end-to-end integration test exercises the engineer runner against a real orchestration server, real workspace provisioning, and a fixture coding agent

`packages/role-runtimes/src/engineer/integration_test.ts` SHALL: (a) provision a temp directory via `Deno.makeTempDir()` and run the existing `keni init` helper to produce a `.keni/`-bearing project root with one engineer (`alice`); (b) seed one `open` ticket via `POST /tickets`; (c) start the orchestration server via `startServer({ port: 0 })`; (d) instantiate `GitWorkspaceProvisioner({ homeDir: <tempHome>, logger: testLogger })` against a separate temp `<tempHome>` so the host's real `~/.keni/` is untouched; (e) construct an `EngineerRunner` whose `codingAgentInvoker` is a fixture (the same fake-coding-agent fixture used by the role-runtime integration test) parameterised by env vars to emit a deterministic plan + summary; (f) drive *one* cycle by invoking `startCycle(runner-derived params)` directly (the test does not exercise the scheduler — that's covered separately) and assert on the returned `RoleCycleResult` and on the on-disk activity log; (g) cover four scenarios: (i) precheck picks the open ticket; (ii) workspace is provisioned with `.keni/` excluded and per-workspace identity set; (iii) the cycle's `session_end.summary` matches the fixture's last stdout line; (iv) `pullMain` is called as the precheck's first step. Teardown SHALL stop the orchestration server (`abort()`) and remove both temp dirs (`<tempProject>` and `<tempHome>`) in every code path, including failures.

#### Scenario: Precheck picks the seeded open ticket

- **WHEN** the seeded project has exactly one ticket `ticket-0001` in status `open` with `assignee: null`
- **AND** the runner's precheck is invoked
- **THEN** the precheck resolves with `{ kind: "proceed", roleContext: { summary: "ticket-0001 (picking up)", ticketId: "ticket-0001" } }`

#### Scenario: Workspace is provisioned with `.keni/` excluded

- **WHEN** the integration test's bootstrap completes
- **THEN** `<tempHome>/.keni/workspaces/<projectId>/alice/.git/` exists
- **AND** `<tempHome>/.keni/workspaces/<projectId>/alice/.keni/` does not exist
- **AND** `<tempHome>/.keni/workspaces/<projectId>/alice/.git/info/sparse-checkout` contains exactly the two lines `/*` and `!.keni/`

#### Scenario: Cycle's `session_end.summary` is the fixture's final stdout line

- **WHEN** the fixture coding agent emits stdout lines `["plan", "code", "ticket-0001 in_progress: implemented login form"]` and exits 0
- **AND** the cycle resolves
- **THEN** the returned `RoleCycleResult` is `{ outcome: "completed", sessionId, exitCode: 0, summary: "ticket-0001 in_progress: implemented login form" }`
- **AND** the on-disk `.keni/activity/<UTC date>.jsonl` file's `session_end` line for this `session_id` carries `summary: "ticket-0001 in_progress: implemented login form"`

#### Scenario: `pullMain` is called as the precheck's first step

- **WHEN** the runner's precheck is invoked
- **AND** an instrumented provisioner records the order of its calls
- **THEN** `pullMain("<projectId>", "alice")` was the first recorded call
- **AND** the in-flight `listTickets` HTTP query was issued only after `pullMain` resolved

#### Scenario: Test teardown removes both temp dirs

- **WHEN** any single integration test path reaches its `finally` block
- **THEN** `<tempProject>` no longer exists on disk
- **AND** `<tempHome>` no longer exists on disk
- **AND** the host's real `~/.keni/` is unchanged from before the test

### Requirement: The engineer runtime introduces no new runtime dependencies beyond Deno built-ins and `@std/*` modules already in `deno.json`

The `engineer-runtime-and-workspace` change SHALL NOT add any entry to the workspace `deno.json` `imports` map. Every primitive used by the engineer-runtime code SHALL be either: (a) a Deno built-in (`Deno.Command` for `git`, `Deno.makeTempDir`, `Deno.lstat`, `Deno.remove`, `crypto.randomUUID`); (b) an existing `@std/*` module already in `deno.json` (`@std/path` for path joining, `@std/fs` for tree operations); (c) an existing `@keni/*` workspace package (`@keni/role-runtimes` for the cycle types, `@keni/server` for `runMcpServer`, `@keni/shared` for wire types). The change SHALL NOT add a git-library dependency (e.g., `isomorphic-git`); every git operation flows through the host's `git` binary via `Deno.Command`.

#### Scenario: `deno.json` is unchanged by this change

- **WHEN** the diff of the workspace `deno.json` against the post-step-08 baseline is inspected
- **THEN** the `imports` map is unchanged
- **AND** `deno.lock` is unchanged (modulo any transitive lock churn from `@std/*` versions already present)

#### Scenario: No git library is imported

- **WHEN** the source files under `packages/role-runtimes/src/engineer/` are scanned for `isomorphic-git`, `nodegit`, or any other git library import
- **THEN** no occurrence is found in any production file or test file
- **AND** every git operation in `git.ts` flows through `new Deno.Command("git", ...)`

### Requirement: Capability documentation names the workspace lifecycle and `.keni/`-boundary invariants

This capability SHALL document, in this spec file and in the `@keni/role-runtimes` package's README (forwarded from the root README), that: (a) every engineer workspace lives at `<homeDir>/.keni/workspaces/<projectId>/<agentId>/`, deterministic from configuration alone; (b) every engineer workspace is a sparse-checkout clone whose pattern excludes `.keni/`, so the engineer never sees project metadata; (c) the per-workspace git identity is `<agentId> <<agentId>@keni.invalid>`, set via `git config --local`, with no writes to the host's `~/.gitconfig`; (d) `pullMain` runs as the precheck's first step, so cycles always work against an up-to-date `main`; (e) workspace removal happens on `runServer` boot when the agent is no longer in the roster, not at runtime; (f) merge-to-`main` flows through the orchestration-server `POST /prs/:id/merge` endpoint with `--ff-only` semantics, never through engineer-side `git push`. Any change that adds a workspace lifecycle phase, alters the sparse pattern, introduces a new identity policy, changes the merge mechanism, or adds an engineer-facing `.keni/` write path lands as a delta spec against this capability.

#### Scenario: Documentation names the six invariants

- **WHEN** the root `README.md`'s engineer-runtime subsection is read
- **THEN** the documentation explicitly names invariants (a) through (f) above

#### Scenario: A grep for forbidden engineer-side `.keni/` writes finds none

- **WHEN** the source files under `packages/role-runtimes/src/engineer/` (excluding `*_test.ts`) are scanned for `Deno.writeTextFile`, `Deno.writeFile`, or any path literal beginning with `.keni/` outside the workspace-scoped subdirectory `.keni/workspaces/`
- **THEN** no occurrence is found
- **AND** the only filesystem-write primitive used in production is `Deno.writeTextFile` against the sparse-checkout pattern file `<workspacePath>/.git/info/sparse-checkout` (which is *inside* the workspace's `.git/`, not inside any project's `.keni/`)


### Requirement: `@keni/role-runtimes` exposes a `codingAgentCliRegistry` mapping known CLI names to their subprocess spawn shapes

The `@keni/role-runtimes` package SHALL export, from `packages/role-runtimes/src/common/codingAgentCliRegistry.ts` (re-exported through `packages/role-runtimes/src/main.ts`), a constant `codingAgentCliRegistry` of type `Readonly<Record<KnownCli, CodingAgentCliEntry>>` where `KnownCli` is the closed string-literal union `"claude" | "cursor-agent" | "codex"`. The package SHALL also export the `KnownCli` type alias, the `isKnownCli(value: string): value is KnownCli` type guard, the `CodingAgentCliEntry` interface, and the `McpConfigStrategy` discriminated union.

Each `CodingAgentCliEntry` SHALL have shape `{ cliBinary: string; buildArgs: (invocation: CodingAgentInvocation, mcpConfigPath: string) => readonly string[]; promptInjection: "stdin" | "arg"; resumeFlag: string; envAllowlist: readonly string[]; mcpConfigStrategy: McpConfigStrategy }`. The shape SHALL be a strict subset of the new `SubprocessCodingAgentInvokerOpts` (per the `role-runtime` capability) so a caller can spread an entry into `createSubprocessCodingAgentInvoker(opts)` directly. The `envAllowlist` SHALL be the per-CLI minimum set of host env variables the CLI needs to authenticate and run (e.g. `HOME`, `PATH`, `ANTHROPIC_API_KEY` for `"claude"`); the role-runtime cycle's existing `KENI_MCP_*` mandates SHALL be added on top by `buildChildEnv` and SHALL NOT be duplicated in the per-CLI allowlist.

The registry SHALL be a constant value — it SHALL NOT be a function or a class instance, and adding a new entry SHALL require a code change with tests (no plugin loader, no path-resolved import). The registry SHALL be referentially stable across imports (importers SHALL be able to use entries by reference and rely on identity for caching).

#### Scenario: The registry exposes the documented entries with the documented shape

- **WHEN** a caller imports `codingAgentCliRegistry` from `@keni/role-runtimes`
- **THEN** `Object.keys(codingAgentCliRegistry)` is the closed set `["claude", "cursor-agent", "codex"]` (order is irrelevant)
- **AND** every entry has the keys `cliBinary`, `buildArgs`, `promptInjection`, `resumeFlag`, `envAllowlist`, `mcpConfigStrategy`
- **AND** `cliBinary` is a non-empty string
- **AND** `buildArgs` is a function with arity 2
- **AND** `promptInjection` is one of `"stdin"` or `"arg"`
- **AND** `resumeFlag` is a non-empty string starting with `--`
- **AND** `envAllowlist` is a `readonly string[]` containing at least `"HOME"` and `"PATH"`
- **AND** `mcpConfigStrategy.kind` is one of `"tempfile-json"`, `"workspace-json"`, or `"workspace-toml"`

#### Scenario: An entry can be spread into `createSubprocessCodingAgentInvoker` directly

- **WHEN** a caller writes `createSubprocessCodingAgentInvoker(codingAgentCliRegistry["claude"])`
- **THEN** the call type-checks
- **AND** the resulting `CodingAgentInvoker` is structurally indistinguishable from one constructed by spelling out the entry's fields manually

#### Scenario: `isKnownCli` narrows a string at the boundary

- **WHEN** a caller invokes `isKnownCli(name)` with `name: string`
- **THEN** the return type is the type predicate `name is KnownCli`
- **AND** `isKnownCli("claude")`, `isKnownCli("cursor-agent")`, and `isKnownCli("codex")` each return `true`
- **AND** `isKnownCli("claud")` and `isKnownCli("")` each return `false`

#### Scenario: The registry is a constant value, not a function

- **WHEN** a static analyser inspects `codingAgentCliRegistry`'s declaration
- **THEN** the binding is a `const` assignment to an object literal
- **AND** the type signature is exactly `Readonly<Record<KnownCli, CodingAgentCliEntry>>`
- **AND** there is no exported "register a CLI" function in the same module

### Requirement: Each registry entry's `buildArgs` produces a CLI-correct argv that consumes the engineer's prompt and connects the MCP server

For each `KnownCli`, the registry entry's `buildArgs(invocation, mcpConfigPath)` SHALL return an argv array such that, when spawned with `cliBinary`, the engineer's prompt body fed via the entry's `promptInjection` channel, and the MCP-config materialised per the entry's `mcpConfigStrategy`, the CLI: (1) accepts the engineer's prompt as input; (2) loads the keni MCP server (whether via the `mcpConfigPath` argv slot or via on-disk discovery is a per-CLI implementation detail captured by the strategy); (3) runs in a non-interactive mode appropriate for headless invocation; (4) honours `invocation.resumeSessionId` via the entry's `resumeFlag` when the role-runtime cycle prepends it (see the `role-runtime` spec).

For the `"claude"` entry, `cliBinary` SHALL be `"claude"`, `promptInjection` SHALL be `"stdin"`, `resumeFlag` SHALL be `"--resume"`, `mcpConfigStrategy.kind` SHALL be `"tempfile-json"`, and `buildArgs` SHALL produce an argv that includes `["--mcp-config", mcpConfigPath]` and the documented non-interactive flag `"--print"`. The argv SHALL NOT contain `--interactive` or any flag that would block on a TTY. Coverage SHALL be `"tested"` (verified against the documented `claude --help` and the unit test in `codingAgentCliRegistry_test.ts`).

For the `"cursor-agent"` entry, `cliBinary` SHALL be `"cursor-agent"`, `promptInjection` SHALL be `"stdin"`, `resumeFlag` SHALL be `"--resume"`, `mcpConfigStrategy` SHALL be `{ kind: "workspace-json", relativePath: ".cursor/mcp.json", mergeKey: "mcpServers", entryName: "keni" }`, and `buildArgs` SHALL produce an argv that includes `["--print", "--approve-mcps"]` and `["--workspace", invocation.workspacePath]` when `invocation.workspacePath !== null`. The argv SHALL NOT include `--mcp-config` (the CLI does not accept it, per [Cursor CLI MCP docs](https://cursor.com/docs/cli/mcp) and the installed `cursor-agent v2026.04.15-dccdccd`). Coverage SHALL be `"tested"` (the registry entry's argv flags are pinned against the installed binary's `--help` output by the integration sanity test in `packages/role-runtimes/tests/integration/cursorAgent_test.ts`, gated on the binary being on `PATH`).

For the `"codex"` entry, `cliBinary` SHALL be `"codex"`, `promptInjection` SHALL be `"stdin"`, `resumeFlag` SHALL be `"--resume"`, `mcpConfigStrategy` SHALL be `{ kind: "workspace-toml", relativePath: ".codex/config.toml", tableHeader: "mcp_servers", entryName: "keni" }`, and `buildArgs` SHALL produce an argv whose first element is `"exec"` (the documented non-interactive subcommand) and whose remaining elements set the appropriate non-interactive switches per the [OpenAI Codex CLI MCP docs](https://developers.openai.com/codex/mcp). The argv SHALL NOT include `--mcp-config` (the CLI does not accept it; see [openai/codex#9550](https://github.com/openai/codex/issues/9550)). Coverage SHALL remain `"best-effort"` (no integration test in this change; the follow-up `engineer-runner-production-wiring/tasks.md#6.2` tracks the gap).

#### Scenario: The `claude` entry's `buildArgs` uses `--mcp-config` and `--print`, and its strategy is tempfile-json

- **WHEN** `codingAgentCliRegistry["claude"].buildArgs(fakeInvocation, "/tmp/mcp-1234.json")` is called
- **THEN** the resulting argv includes the substring `"/tmp/mcp-1234.json"` exactly once (as the value of `--mcp-config`)
- **AND** the argv contains `"--print"`
- **AND** the argv does NOT contain `--interactive` or `--mcp-debug` or any flag that would block on a TTY
- **AND** `codingAgentCliRegistry["claude"].mcpConfigStrategy.kind === "tempfile-json"`

#### Scenario: The `cursor-agent` entry's `buildArgs` uses `--print --approve-mcps --workspace`, and its strategy is workspace-json under `.cursor/mcp.json`

- **WHEN** `codingAgentCliRegistry["cursor-agent"].buildArgs(invocation, "<ignored>")` is called with `invocation.workspacePath === "/tmp/ws"`
- **THEN** the resulting argv contains `"--print"`, `"--approve-mcps"`, and the consecutive pair `["--workspace", "/tmp/ws"]`
- **AND** the argv does NOT contain `"--mcp-config"`
- **AND** `codingAgentCliRegistry["cursor-agent"].mcpConfigStrategy.kind === "workspace-json"`
- **AND** `codingAgentCliRegistry["cursor-agent"].mcpConfigStrategy.relativePath === ".cursor/mcp.json"`
- **AND** `codingAgentCliRegistry["cursor-agent"].mcpConfigStrategy.mergeKey === "mcpServers"`
- **AND** `codingAgentCliRegistry["cursor-agent"].mcpConfigStrategy.entryName === "keni"`

#### Scenario: The `codex` entry's `buildArgs` uses `exec` (no `--mcp-config`), and its strategy is workspace-toml under `.codex/config.toml`

- **WHEN** `codingAgentCliRegistry["codex"].buildArgs(invocation, "<ignored>")` is called
- **THEN** the resulting argv's first element is `"exec"`
- **AND** the argv does NOT contain `"--mcp-config"`
- **AND** `codingAgentCliRegistry["codex"].mcpConfigStrategy.kind === "workspace-toml"`
- **AND** `codingAgentCliRegistry["codex"].mcpConfigStrategy.relativePath === ".codex/config.toml"`
- **AND** `codingAgentCliRegistry["codex"].mcpConfigStrategy.tableHeader === "mcp_servers"`
- **AND** `codingAgentCliRegistry["codex"].mcpConfigStrategy.entryName === "keni"`

#### Scenario: Each entry's `envAllowlist` includes the host basics

- **WHEN** any registry entry is inspected
- **THEN** its `envAllowlist` includes both `"HOME"` and `"PATH"`
- **AND** does NOT include the runtime-mandated `KENI_MCP_AGENT`, `KENI_MCP_SERVER_URL`, or `KENI_MCP_WORKSPACE` (those are added on top by `buildChildEnv` per the `role-runtime` spec)

### Requirement: The CLI registry's per-CLI entries live in single-file modules under `codingAgentClis/`; the registry assembly lives in `codingAgentCliRegistry.ts`

The `@keni/role-runtimes` package SHALL physically split the CLI registry: each `KnownCli` entry SHALL be the default export of a single-purpose module under `packages/role-runtimes/src/common/codingAgentClis/`, and the registry constant SHALL be assembled in `packages/role-runtimes/src/common/codingAgentCliRegistry.ts` by importing each per-CLI module and binding it to its `KnownCli` key.

The per-CLI modules SHALL be:

- `codingAgentClis/claude.ts` — exports `claudeEntry: CodingAgentCliEntry`
- `codingAgentClis/cursorAgent.ts` — exports `cursorAgentEntry: CodingAgentCliEntry`
- `codingAgentClis/codex.ts` — exports `codexEntry: CodingAgentCliEntry`

The per-CLI modules SHALL NOT import each other. They MAY import `CodingAgentCliEntry`, `McpConfigStrategy`, and `CodingAgentInvocation` from `codingAgentCliRegistry.ts` (or the shared `types.ts`), and MAY import `@std/path` for path joining at construction time. The per-CLI module SHALL JSDoc the entry with: (a) the CLI binary name and a documentation-source link (URL or version string the entry was modelled against); (b) a `coverage: "tested" | "best-effort"` tag matching the existing convention; (c) a one-line summary of the MCP-config strategy in human language (e.g. `"Reads <workspace>/.cursor/mcp.json; merge our entry under mcpServers.keni"`).

`codingAgentCliRegistry.ts` SHALL keep: the `McpConfigStrategy` discriminated union, the `CodingAgentCliEntry` interface, the `KnownCli` literal union, the `isKnownCli` type guard, and the `codingAgentCliRegistry` constant (now assembled from imports). It SHALL NOT contain any per-CLI literal data (no `cliBinary` strings, no argv shapes, no env-allowlist values for specific CLIs).

#### Scenario: The registry is assembled from per-CLI modules

- **WHEN** a static analyser inspects `packages/role-runtimes/src/common/codingAgentCliRegistry.ts`
- **THEN** the file imports `claudeEntry` from `./codingAgentClis/claude.ts`, `cursorAgentEntry` from `./codingAgentClis/cursorAgent.ts`, and `codexEntry` from `./codingAgentClis/codex.ts`
- **AND** the `codingAgentCliRegistry` constant binds each import to its `KnownCli` key (e.g. `{ "claude": claudeEntry, "cursor-agent": cursorAgentEntry, "codex": codexEntry }`)
- **AND** the file does NOT contain any `cliBinary: "claude" | "cursor-agent" | "codex"` literal (no inline entry construction)

#### Scenario: Per-CLI modules don't import each other

- **WHEN** the imports of any file under `packages/role-runtimes/src/common/codingAgentClis/` (excluding `*_test.ts`) are inspected
- **THEN** no file imports from another sibling file in the same directory
- **AND** every file's exports include exactly one constant assignable to `CodingAgentCliEntry`

### Requirement: Each `CodingAgentCliEntry` carries an `mcpConfigStrategy` field that names the per-CLI MCP-config materialisation contract

The `CodingAgentCliEntry` interface SHALL include a non-optional field `mcpConfigStrategy: McpConfigStrategy` where `McpConfigStrategy` is a closed discriminated union:

```ts
type McpConfigStrategy =
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
```

The strategy is a value type — every field is a string literal or a discriminator. The strategy SHALL NOT carry function-typed fields (no closures inside the entry); the runtime executor in `codingAgentInvoker.ts` interprets the `kind` and the strategy-specific fields. Adding a fourth strategy is a deliberate type-level change and SHALL require updating the union, the executor, and at least one structural test scenario.

The `entryName` field across `workspace-json` and `workspace-toml` SHALL be the merge key under which the keni MCP server config is written (e.g. `"keni"`); the executor SHALL use this verbatim — neither uppercasing it, prefixing it, nor namespacing it.

#### Scenario: `McpConfigStrategy` is a closed discriminated union

- **WHEN** a TypeScript exhaustiveness check (`switch (strategy.kind) { case "tempfile-json": ... case "workspace-json": ... case "workspace-toml": ... default: const _: never = strategy.kind; }`) is compiled
- **THEN** the `default` arm's `_: never` assignment type-checks
- **AND** removing any of the three `case` arms produces a compile error

#### Scenario: Every registry entry has a strategy field with a documented `kind`

- **WHEN** any entry of `codingAgentCliRegistry` is inspected
- **THEN** `entry.mcpConfigStrategy` is defined
- **AND** `entry.mcpConfigStrategy.kind` is one of `"tempfile-json"`, `"workspace-json"`, or `"workspace-toml"`
- **AND** when `kind === "workspace-json"`, the entry has `relativePath: string`, `mergeKey: string`, `entryName: string`
- **AND** when `kind === "workspace-toml"`, the entry has `relativePath: string`, `tableHeader: string`, `entryName: string`
