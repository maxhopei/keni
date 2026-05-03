## Context

After steps 07 and 08, Keni has a deterministic role-runtime cycle (`startCycle`) and a tick scheduler that fans out cycles to a registered runner per role. Neither yet knows what an engineer is. The orchestration server, the storage layer, and the MCP surface are all in place; what is missing is the **engineer specialisation** — a runner that tells the cycle which prompt to inject, which precheck to run, and where on disk the engineer's code lives.

Five constraints from `spec.md` shape every decision below:

1. **§5.3 — `.keni/` write boundary.** Engineers never see, read, or write any file under `.keni/`. The workspace must be a sparse clone whose checkout pattern *excludes* `.keni/`.
2. **§5.2 — workspace location.** Engineer workspaces live at `~/.keni/workspaces/<project-id>/<agent-id>/`, *outside* the project tree, so nested-git awkwardness is avoided. `<project-id>` is the stable UUIDv4 from `.keni/project.yaml`; `<agent-id>` comes from the `agents` roster in `project.yaml` (default `alice` per the project-layout spec).
3. **§11#3 — prompts as code.** The engineer prompt is a TS string constant compiled into the binary, never loaded from a user-editable file. The role-runtime spec already enforces this for *any* role's prompt; this change adds a concrete `engineer.ts` constant that satisfies the rule.
4. **§5.5 — git is the merge surface.** "Merges land back in the project repo's `main`; the exact mechanism is an architecture concern." Local-only operation in the prototype means we own the mechanism — and "two engineers may race on merge" (§12) becomes the failure mode we have to be deliberate about, even though step 09 ships single-engineer.
5. **§6.3 — single-line summary contract.** The engineer's prompt must teach the agent to emit one final stdout line as the cycle's summary. The role-runtime cycle captures that line verbatim into `session_end.summary` and into the activity log.

The change also has to *fit* the seams the previous steps designed:

- The scheduler from step 08 expects a registered `AgentRunner` whose shape is `{ role, precheck, promptResolver, expectedPromptName, codingAgentInvoker, envAllowlist?, mcpServerConfig?, idleThresholdMs?, terminationGraceMs? }`. The engineer specialisation is one such runner.
- The role-runtime cycle threads `params.workspacePath` into the subprocess via the env var `KENI_MCP_WORKSPACE` (per step 07's allowlist contract) and into the MCP `get_workspace_path` tool (per step 06's mcp-engineer-surface spec). Workspace resolution is the engineer runner's responsibility before each `startCycle` call.
- The orchestration server already exposes `/tickets`, `/prs`, `/activity`, `/agents`, and the `/events` WebSocket. Adding a `POST /prs/:id/merge` endpoint is an extension of the existing PR routes, not a new subsystem.

## Goals / Non-Goals

**Goals:**

- Ship a single-engineer-end-to-end prototype loop where `keni init` + `keni start` produces a server with `alice` registered, a workspace at `~/.keni/workspaces/<project-id>/alice/`, and a cycle that — given an `open` ticket on the board — picks it up, runs the bundled engineer prompt under the configured coding-agent CLI, pushes branch `ticket-NNNN`, calls `POST /prs/:id/merge`, and transitions the ticket to `ready_for_test`.
- Pin every workspace-shaped detail (clone strategy, sparse pattern, branch name, per-workspace git identity, pull-main rule, removal-on-roster-change rule) so step 09 itself is deterministic and steps 25 / 26 (manual override / multi-engineer) have something concrete to extend.
- Define the merge-to-`main` mechanism *as an HTTP endpoint*, not as a git command the engineer runs against the project repo on disk. The engineer never touches the project repo directly; every legitimate write is API-mediated.
- Bundle the engineer prompt v1 with structure and a stable `name: "engineer"` so the role-runtime cycle's `expectedPromptName` guard catches accidental wiring mistakes at boot.
- Provide a `/opsx:verify`-able **engineer-prompt** capability spec — a separate spec file that pins the prompt's expected behaviour (sections, summary-line contract, refuses-to-touch-`.keni/` clause, etc.) so future prompt iterations land as deltas without breaking downstream tests.

**Non-Goals:**

- **Multi-engineer parallelism.** Step 26 introduces parallel engineers and per-agent schedules. This change ships single-engineer; the merge endpoint emits a `409 merge_conflict` on a non-fast-forward, which is the correct shape for multi-engineer to inherit, but the integration test is single-engineer.
- **Self-review automation.** The engineer prompt teaches the loop "submit PR → next cycle, in a fresh session, self-review the PR → comment or approve." But the prototype runs single-engineer with one cycle per tick; the same engineer's *next* tick performs the review. This is consistent with §11#4 ("self-review in a new session") and is not a new orchestration primitive.
- **Manual override flow.** Step 25 wires the user-role override that lets a human flip a ticket through any status. This change does not add manual-override surfaces.
- **PR-record write tools on MCP.** Per the mcp-engineer-surface spec ("PR-record write tools — engineers create PRs through the role runtime's git/PR handling in step 09"), this change creates and updates PR records via the existing REST `POST /prs` and `PATCH /prs/:id` endpoints, *not* via new MCP tools. The engineer's bundled prompt names `POST /prs` directly; the MCP layer serves the read paths and the new `POST /prs/:id/merge` endpoint via a new MCP tool (see Decision 6 below).
- **PO, QA, Writer roles.** Out of scope per the prototype slice.
- **Brownfield project import** (an existing repo at the project root with pre-existing `main` history that the engineer should respect). The engineer-runtime change assumes a *fresh* `keni init`-produced project root whose `main` is at the initial commit. Brownfield handling is post-MVP per `spec.md` §10.

## Decisions

### Decision 1 — Workspace location and naming are deterministic from `(project_id, agent_id)`

`WorkspaceProvisioner.workspacePathFor(projectId, agentId)` SHALL return `<homeDir>/.keni/workspaces/<projectId>/<agentId>/` with no further parameterisation. `<homeDir>` resolves via the same helper the rest of the codebase uses (`Deno.env.get("HOME")` with a documented fallback to `Deno.env.get("USERPROFILE")` on Windows). The `agent-id` segment is whatever the `agents` roster in `project.yaml` declares (default `alice`).

**Rationale.** Determinism makes the path knowable from configuration alone — the role runtime can compute the path before `startCycle`, the MCP server's `get_workspace_path` tool can return it, and the SPA can display it without a separate "where is alice's workspace?" query. The `<project-id>` segment isolates workspaces across projects on the same host (a user with two Keni projects has two distinct workspace trees per agent).

**Alternatives considered.**

- **Per-cycle ephemeral workspaces** (`mktemp`-style, discarded after each cycle). Rejected: contradicts §5.2 ("created when the engineer is added … discarded if the engineer is removed") and would force a fresh clone every minute, burning bandwidth and cache.
- **Workspaces inside the project tree** (`<project>/.keni/workspaces/`). Rejected: nested-git is awkward (two `.git/` directories at different roots), and the workspace would need to ignore itself in the project's `.gitignore`. `spec.md` §5 is explicit that workspaces live outside.
- **Workspace-id as a hash of `(projectId, agentId)`**. Rejected: the path is human-debuggable; a hash is opaque.

### Decision 2 — Sparse checkout uses `git sparse-checkout` in **no-cone** mode with a pattern set that excludes `.keni/`

The provisioner SHALL initialise sparse-checkout via `git sparse-checkout init --no-cone`, then write the pattern file (`.git/info/sparse-checkout`) with exactly two lines:

```
/*
!.keni/
```

The first pattern selects every top-level path; the negation excludes `.keni/`. The provisioner SHALL run `git sparse-checkout reapply` after writing the pattern (or after `git pull`) so the working tree reflects the rule. The provisioner SHALL verify post-checkout that no path under `<workspace>/.keni/` exists, and SHALL throw `WorkspaceProvisioningError("sparse_pattern_failed", ...)` if any does.

**Rationale.** No-cone mode lets us express the precise pattern "everything *except* `.keni/`", which cone mode cannot (cone mode requires positive directory selectors only). The pattern is small, auditable, and its violation is a single `Deno.lstat` check away from the verification.

**Alternatives considered.**

- **Cone mode with an explicit per-directory selector.** Rejected: requires us to know every top-level path the project contains and re-run init when the project gains a top-level dir. Brittle.
- **Full clone + post-clone delete of `.keni/`.** Rejected: the next `git pull` would re-fetch `.keni/`. Sparse checkout is the only mechanism that genuinely keeps `.keni/` out of the working tree across pulls.
- **`git filter-repo` to strip `.keni/` from the workspace's history.** Rejected: rewrites history (the workspace's `main` would no longer share commits with the project's `main`), making merge-back impossible.

### Decision 3 — Per-workspace git identity, set with `git config --local`

The provisioner SHALL set per-workspace git identity via `git config --local user.name "<agent-id>"` and `git config --local user.email "<agent-id>@keni.invalid"` on first provisioning. This is *per-workspace* (writes to `<workspace>/.git/config`), never *global* (no writes to `~/.gitconfig`). On idempotent re-provisioning of an existing workspace the provisioner SHALL NOT touch the identity if the existing values match (writes are gated by a read-then-compare).

**Rationale.** The engineer's commits need a deterministic author (otherwise `git log` shows the host user as the author of every engineer commit, leaking their identity). Per-workspace identity keeps the host's `~/.gitconfig` untouched (consistent with the `init-default-git-identity` change's no-`.git/config`-writes invariant for `keni init`). The `@keni.invalid` TLD is a documented placeholder per RFC 6761 — it's deliberately unroutable so no real email gets misdirected.

**Alternatives considered.**

- **Reuse the host's git identity** (the same one `keni init` would use). Rejected: the user's commits and `alice`'s commits would be indistinguishable in `git log`, defeating one of the few audit signals the prototype has.
- **Per-cycle env-var override** (`GIT_AUTHOR_NAME=alice` on every git invocation). Rejected: the engineer subprocess runs `git` itself; env-var overrides would have to flow through the role-runtime's env allowlist on every call. Per-workspace `.git/config` is set once and persists.

### Decision 4 — Branch naming is `ticket-{id}` with the id segment matching `/^[0-9]{4,}$/`

The engineer prompt SHALL teach `git checkout -b ticket-NNNN` where `NNNN` is the zero-padded numeric portion of the ticket id (e.g., `ticket-0001`). The MCP `transition_ticket_status` tool SHALL NOT validate branch names (the engineer's compliance is enforced by the prompt and verified by the integration test). The merge endpoint (Decision 5) SHALL accept any branch name the engineer pushes — branch-naming is a convention, not a server-enforced invariant.

**Rationale.** `spec.md` §5.2 calls out the convention but explicitly notes "configurable, but default per §5.2." Hard-coding it server-side would lock out the post-MVP per-project override; making it a prompt-level convention keeps the door open and matches the prototype's "thin wrapper, agentic decisions" principle (§2#4).

**Alternatives considered.**

- **Server-enforced branch names**, with the merge endpoint rejecting non-conforming names. Rejected: the merge endpoint already needs a PR id, which links to the ticket; the branch name is decorative.

### Decision 5 — Merge-to-`main` is a server-side `POST /prs/:id/merge` endpoint with `--ff-only` semantics and a `409 merge_conflict` on failure

The orchestration server SHALL expose `POST /prs/:id/merge` with the following contract:

- **Auth.** `X-Keni-Role: engineer` (any user-role override path is out of scope per §10's manual-override deferral).
- **Request body.** Empty (the PR record already names the source branch).
- **Server behaviour.** Read the PR record; identify the source branch; in the project repo on disk (a fixed working directory the server holds at boot), run `git fetch <workspace-path> <branch>:<branch>` then `git merge --ff-only <branch>` against `main`. On success, update the PR's status to `merged` and return `200 { data: { merge_commit_sha: <sha> }, project_id }`. On a non-fast-forward (the workspace's branch tip is not a descendant of `main`'s tip), `git merge --ff-only` fails with exit code 1; the server SHALL respond `409 { error: { code: "merge_conflict", message, details: { branch, base: "main" } } }`. On a missing branch or any other git failure, respond `400 { error: { code: "validation_failed", ... } }`.
- **Activity log.** On success, the server SHALL `POST /activity` (internally) with `event: "pr_merged"`, `agent: <calling agent id>`, `role: "engineer"`, `summary: "Merged PR <id> as <sha>"`, `refs: { pr_id, branch, merge_commit_sha }`.
- **Concurrency.** The endpoint SHALL serialise concurrent merge attempts with a per-server `Mutex` (single in-process lock — the project repo is single-writer in the prototype). Step 26 (multi-engineer) inherits this mutex unchanged.

**Rationale.** A server-side endpoint preserves the §5.3 invariant that the project's `.keni/`-bearing repo is API-managed; if the engineer ran `git merge` directly in the project tree, they would also see `.keni/` (which they must not). Fast-forward-only is the cleanest semantics for prototype: it forces the engineer to rebase before merge if `main` advanced, which keeps the on-disk history linear and avoids merge commits cluttering the audit log. The `409 merge_conflict` shape matches the documented `ErrorCode` enum's pattern for state-conflict errors.

**Alternatives considered.**

- **Engineer runs `git push origin main` from inside its workspace.** Rejected: the workspace has no remote besides the project folder, and a `push` into the project folder bypasses `.keni/` boundary (the engineer's process would have access to write `.keni/`-adjacent files via git hooks). The HTTP endpoint is the only way to keep the engineer process inside its sparse-checked-out sandbox.
- **Three-way merge (`git merge`, no `--ff-only`).** Rejected: produces a merge commit per cycle, complicating the audit log. Single-engineer prototype never needs it; multi-engineer (step 26) revisits the choice if rebases prove painful.
- **Squash-merge.** Rejected: loses the engineer's commit history per ticket. The audit value of per-commit messages (which the prompt teaches the engineer to write meaningfully) outweighs the linear-graph benefit.

### Decision 6 — `merge_pr` MCP tool wraps the `POST /prs/:id/merge` endpoint

The mcp-engineer-surface spec already enumerates seven tools and is closed to additions only via a delta. This change SHALL NOT add an eighth. Instead, the engineer's bundled prompt SHALL teach the engineer to call the new endpoint *directly* via `fetch` from inside the subprocess. The `KENI_MCP_SERVER_URL` env var (already in the role-runtime allowlist per step 07) supplies the URL; the engineer's identity headers (`X-Keni-Role: engineer`, `X-Keni-Agent: <agent-id>`) are documented in the prompt.

Wait — that's fragile. Reconsidered: the prompt MUST stay focused on the loop, not on HTTP plumbing. Deferred to a follow-up: this change SHALL ship the endpoint *and* extend the mcp-engineer-surface spec with a delta adding an eighth tool `merge_pr`. The delta is minor (one tool, one zod schema, one HTTP delegate) and keeps the engineer's prompt clean.

**Final shape.** This change adds `merge_pr` to the engineer's MCP surface as a delta against `mcp-engineer-surface`:

| Tool name  | Description                                                                                                       | Input schema      | HTTP delegate            |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------ |
| `merge_pr` | Fast-forward merges the PR's source branch onto `main`. Returns the merge commit SHA. Engineers only.             | `{ pr_id: string }` | `POST /prs/:id/merge`    |

**Rationale.** The prompt is shorter and more reliable when every external action is a single MCP tool call. HTTP-from-prompt has a track record of agents inventing wrong URLs.

### Decision 7 — Workspace lifecycle: `ensure → pull-main → run` per cycle; remove on roster removal

`runServer` SHALL invoke `provisioner.ensureProvisioned(projectId, agentId, projectRepoPath)` for every engineer in the roster at boot, *before* `Deno.serve` accepts connections. The engineer runner's precheck SHALL invoke `provisioner.pullMain(projectId, agentId)` as its **first step**, before any HTTP call to the orchestration server. A `pull --ff-only` failure SHALL surface as `{ kind: "skip", reason: "pull_main_failed", details: <git stderr> }` (the cycle is skipped, the activity log gains no entry, and the failure is logged at warn level by the precheck — the next tick will retry).

Workspace removal SHALL happen only when `agents` in `project.yaml` no longer contains the `agent-id`. This is detected at `runServer` boot by diffing the prior state (cached in memory; the server holds no persistent provisioner state) against the current roster. **Within a single server lifecycle**, the roster does not mutate (no API exists yet to add/remove agents at runtime), so removal is effectively a "next-restart" operation — consistent with the orchestration-server invariant that runtime state resets on restart.

**Rationale.** Pull-at-cycle-start guarantees the engineer always works against an up-to-date `main`. Pre-existing-workspace re-use avoids the "fresh clone every minute" cost. Removal on roster change satisfies §5.2 ("discarded if the engineer is removed") without forcing live roster-edit machinery into this change.

**Alternatives considered.**

- **Pull-main inside the cycle (after `session_start`).** Rejected: a pull failure mid-cycle would emit `session_start` but no `session_end`-with-summary, polluting the activity log. The precheck is the right place because precheck failures are silent (per the role-runtime spec's "no `POST /activity` on the skip path" rule).
- **Periodic pull-main on a separate timer.** Rejected: extra moving parts, no clear win over per-cycle pull (cycles are minute-scale; a separate timer would also be minute-scale).

### Decision 8 — Engineer precheck: query `/tickets?status=open,test_failed,has_comments`, apply in-flight guard, return top-of-queue

The precheck SHALL:

1. Pull `main` (Decision 7).
2. Issue `GET /tickets?status=open,test_failed,has_comments&assignee=<agent-id>` to find tickets *already assigned* to this engineer in those active-states. If any are returned, return `{ kind: "proceed", roleContext: { summary: "ticket-NNNN (in-flight)", ticketId } }` for the **highest-priority** in-flight ticket (priority field on the ticket, descending, ties broken by id ascending — the deterministic order spec'd in step 04).
3. Otherwise, issue `GET /tickets?status=open&assignee=` (unassigned `open` tickets) ordered by priority desc / id asc; if any are returned, return `{ kind: "proceed", roleContext: { summary: "ticket-NNNN (picking up)", ticketId } }` for the top one.
4. Otherwise, return `{ kind: "skip", reason: "no_ticket_to_pick_up" }`.

The precheck does **not** transition the ticket's status; the engineer prompt does that on the agent's first MCP call (`transition_ticket_status open → in_progress`). The precheck's `roleContext.ticketId` is documented as advisory — the agent reads from MCP; the precheck just decides whether to spend tokens.

**Rationale.** Prevents two bad outcomes: (a) running cycles when nothing is actionable (token waste), and (b) the engineer abandoning an in-flight ticket to pick up a fresh one (status would never advance). The "in-flight first" rule is borrowed straight from the engineer responsibilities in §3 (Engineer).

**Alternatives considered.**

- **Server-side "next ticket for me" endpoint.** Rejected: would couple the orchestration server to per-role assignment policy; the precheck is the right place for that policy.
- **Random-pick from the queue** (simulating a real-world "team picks tickets in standup"). Rejected: not deterministic, and the prototype's value is in being predictable.

### Decision 9 — Bundled engineer prompt structure (v1)

The prompt is a TS string constant exported from `packages/role-runtimes/src/engineer/prompts/engineer.ts` as `export const ENGINEER_PROMPT_BODY: string` and `export const ENGINEER_PROMPT_NAME = "engineer" as const`. Its body has **eight numbered sections**:

1. **Identity.** "You are an Engineer agent on a Keni team. Your role is `engineer`; your agent id is supplied in the env var `KENI_MCP_AGENT`."
2. **Workspace.** Explains `KENI_MCP_WORKSPACE` env var; refuses to operate outside it; documents `.keni/` is *not* visible (because the workspace is sparse-checked).
3. **MCP tools inventory.** Names the eight engineer tools (the seven from `mcp-engineer-surface` plus `merge_pr` from Decision 6) with one-line descriptions. The *full* descriptions live in the MCP tool descriptors; the prompt names them so the agent knows what to ask for.
4. **The loop.** A numbered playbook: (a) `list_tickets` and pick the top-of-queue, (b) `transition_ticket_status open → in_progress` (or `test_failed → in_progress`), (c) plan + code in the workspace, (d) run integration tests via `docker-compose -f $(git rev-parse --show-toplevel)/docker-compose.yml run --rm tests` (Decision 10), (e) push branch `ticket-NNNN`, (f) `POST /prs` (via stdlib `fetch`, since PR creation is REST not MCP) — actually no, the prompt teaches `merge_pr` tool but PR creation is awkward; reconsidered: the prompt teaches the agent to call `merge_pr` only after the PR record exists, and PR creation goes via an existing `create_pr` MCP tool — wait, that tool doesn't exist either. **Open question OQ-1 below.**
5. **Self-review.** "After your PR is submitted, your *next* cycle (a fresh subprocess) will pick the same ticket up in `ready_for_review` and review it. In that role you read the PR diff, run tests, and either approve (transition `in_review → approved` then `merge_pr` then `transition merged → ready_for_test`) or comment (transition `in_review → has_comments` and write a short critique into the ticket body via `update_ticket_body`)."
6. **Integration tests.** Documents the `docker-compose` contract from Decision 10.
7. **Summary line.** "Your final stdout line is captured verbatim as the cycle's summary. Make it a single line under 200 chars naming the ticket and what you did (`ticket-0001 in_progress: implemented X` or `ticket-0001 ready_for_test: merged PR-3`)."
8. **Refusals.** "Never write to `.keni/` (you cannot see it). Never run `git push origin main` directly (use `merge_pr`). Never call `transition_ticket_status` for a status outside the engineer's owning roles (`in_progress`, `ready_for_review`, `in_review`, `has_comments`, `approved`, `merged`, `ready_for_test`)."

The prompt SHALL NOT prescribe a coding style, framework version, or test naming convention beyond TS/Deno/React preferences; per `spec.md` §10's prompt-customisation note, the prompt is expected to evolve.

**Rationale.** Eight short sections is small enough to fit comfortably under 4 KB (well within typical coding-agent context budgets) and structured enough that the engineer-prompt capability spec can pin each section's existence without locking in word-for-word phrasing. Future iterations land as content tweaks behind the same section structure.

**Alternatives considered.**

- **One monolithic paragraph.** Rejected: agents reason better against numbered playbooks; reviewability suffers.
- **Per-step micro-prompts** (one prompt for "pick a ticket", one for "submit PR", etc.). Rejected: contradicts the role-runtime cycle's single-prompt-per-cycle contract; would require multi-cycle orchestration the prototype isn't ready for.

### Decision 10 — Docker-compose integration-test contract

The bundled engineer prompt SHALL document the convention that `<project>/docker-compose.yml` exists and exposes a `tests` service whose `command` runs the project's integration suite. The engineer invokes:

```
docker-compose -f $(git rev-parse --show-toplevel)/docker-compose.yml run --rm tests
```

— from inside its workspace. Stdout / stderr stream to the role-runtime cycle's per-line activity-log emission as `subprocess_stdout` / `subprocess_stderr` entries (already specified in the role-runtime capability). The role runtime does **not** wrap docker-compose itself; the engineer's subprocess invokes it directly via `Deno.Command` (or its equivalent in the coding-agent CLI's tool surface).

The change SHALL NOT add a code-side helper for docker-compose invocation — the convention lives in the prompt and the contract lives in the engineer-prompt capability spec. A `keni init`-produced project does **not** include a `docker-compose.yml`; the engineer prompt teaches the agent to write one as part of the first ticket that needs integration tests.

**Rationale.** A code-side wrapper would mean the runtime owns the test-orchestration concern, which contradicts §2#4 ("agentic decisions"). The convention-in-prompt approach lets each project's `docker-compose.yml` evolve without runtime changes.

**Alternatives considered.**

- **A `run_integration_tests` MCP tool** that wraps the docker-compose invocation. Rejected: same reason as the runtime wrapper — it makes the runtime opinionated about test orchestration.
- **No docker-compose convention at all** (let each ticket discover its own test command). Rejected: contradicts the step file's explicit "docker-compose integration-test hook" scope.

### Decision 11 — `runServer` boot-time wiring sequence

The orchestration-server delta SHALL extend `runServer` such that, after the scheduler is constructed but before `Deno.serve` accepts connections:

```
1. Read project.yaml (already done for project_id stamping).
2. Filter agents to those whose role is "engineer".
3. For each engineer:
   a. Compute workspacePath = provisioner.workspacePathFor(projectId, agentId).
   b. Call provisioner.ensureProvisioned(projectId, agentId, projectRepoPath).
   c. Construct runner = createEngineerRunner({
        agentId, projectId, projectName, serverUrl, workspacePath, provisioner,
        codingAgentInvoker: createSubprocessCodingAgentInvoker(...),
        promptResolver: () => ({ name: "engineer", body: ENGINEER_PROMPT_BODY }),
        expectedPromptName: "engineer",
        envAllowlist: ["PATH", "HOME", "SHELL", "TZ", "LANG", "LC_ALL", ...vendor-specific keys],
        mcpServerConfig: { ... }, // built from step 06's config + this engineer's identity
      }).
   d. scheduler.registerRunner(runner).
4. scheduler.start().
5. Deno.serve(...).
```

`runServer` SHALL NOT skip step 2 if the project has no engineer (a future PO-only project is valid; the prototype always has at least `alice`, but the sequence is no-op-safe). The `projectRepoPath` is the resolved `--project` argument's absolute path.

**Rationale.** Provisioning before `Deno.serve` accepts connections guarantees that the moment a user opens the SPA and sees `alice` registered, alice's workspace is already on disk and ready to clone — no race window where a tick fires before provisioning completes.

**Alternatives considered.**

- **Lazy provisioning on first cycle.** Rejected: a slow first cycle (clone takes seconds) would look like the engineer is unresponsive; the boot-time clone keeps the cycle deterministic.
- **Provisioning in a background `Promise.allSettled` while `Deno.serve` is already accepting.** Rejected: the SPA could observe an engineer with no workspace, breaking SPA invariants for `get_workspace_path`.

### Decision 12 — `WorkspaceProvisioner` is an interface; `GitWorkspaceProvisioner` is the default; tests use `FakeWorkspaceProvisioner`

```ts
interface WorkspaceProvisioner {
  workspacePathFor(projectId: string, agentId: string): string;
  ensureProvisioned(projectId: string, agentId: string, projectRepoPath: string): Promise<void>;
  pullMain(projectId: string, agentId: string): Promise<void>;
  discardProvisioned(projectId: string, agentId: string): Promise<void>;
}
```

`GitWorkspaceProvisioner` is the only production implementation in this change. `FakeWorkspaceProvisioner` (used by the engineer-runner unit tests) records calls in memory and never touches the filesystem. The integration test (the only test that exercises `GitWorkspaceProvisioner`) uses a real temp dir as `projectRepoPath` and asserts on the on-disk shape of the resulting workspace.

**Rationale.** The interface seam keeps the engineer runner unit-testable without a real git binary. The fake also allows step 26 (multi-engineer) to write parallelism tests against multiple fake provisioners without cross-test interference.

## Risks / Trade-offs

- **[Risk] `git sparse-checkout`'s no-cone mode is documented as a deprecated path on some git versions.** → **Mitigation.** The docs warn but the feature is still supported; we pin a `git --version >= 2.30` check in `ensureProvisioned` and document the floor in the developer-setup spec (a cross-link, not a delta). If git removes no-cone mode in a future major, we revisit Decision 2 — the alternative (cone-mode with explicit positive selectors) requires re-running init when the project's top-level structure changes, which we accept as a worse-but-workable fallback.
- **[Risk] Per-workspace git identity (`alice@keni.invalid`) leaks into the project's commit log on merge.** → **Mitigation.** `--ff-only` merges preserve the author identity verbatim; the audit value (knowing `alice` made the change) outweighs the cosmetic concern. Step 25 (manual override) introduces a "user-attributed override commit" path for cases where the user wants their own identity on the commit.
- **[Risk] `git fetch <local-path> <branch>` from the project repo to itself can fail on some git versions when the workspace is on a different filesystem (e.g., `~/` on a tmpfs).** → **Mitigation.** The integration test exercises this on the host's real filesystem; if a user's home dir is on a network mount, the failure surfaces clearly via `409 merge_conflict` with a `details` field that names the underlying git stderr.
- **[Risk] The `merge_pr` MCP tool delegates to a server endpoint that holds a per-server mutex; multi-engineer (step 26) could see merge latency if engineers all finish at the same minute boundary.** → **Mitigation.** The mutex is intentional — single-writer on the project repo is the correct invariant. Step 26 measures the real distribution of merge attempts and decides whether to add per-merge concurrency (likely not needed at MVP scale).
- **[Risk] The bundled engineer prompt is opinionated for TS/Deno/React.** → **Mitigation.** The prompt names the stack but doesn't gate behaviour on it (no "if this isn't a Deno project, refuse"). For non-TS projects the prompt is suboptimal; per `spec.md` §10's prompt-customisation note, this is expected and explicitly deferred.
- **[Risk] First-time provisioning of a large project repo could take tens of seconds, blocking `Deno.serve`.** → **Mitigation.** Sparse checkout downloads the full pack but checks out only the sparse pattern; on prototype-scale projects this is sub-second. If a real project is large enough to matter, we revisit Decision 11's "block on provisioning" choice — currently the user-visible cost is one slow `keni start` first-run, which is acceptable.
- **[Trade-off] Server-side merge endpoint vs engineer-runs-merge.** The endpoint preserves the `.keni/` boundary at the cost of one extra HTTP round-trip per merge. This is the right call for the prototype's invariants; multi-engineer scaling (step 26) is the place to measure whether the round-trip becomes a bottleneck.
- **[Trade-off] `ENGINEER_PROMPT_BODY` is a single TS constant rather than composed from sub-prompts.** Single constant is simpler to test and version; composability lands as a refactor when (and if) the PO prompts (step 18) suggest a shared sub-prompt vocabulary.

## Migration Plan

This is a greenfield change — there is no prior engineer runtime to migrate from. Deployment is `git pull && deno task check && deno task test`. Rollback is `git revert <commit>` (no on-disk migrations to undo); a stale `~/.keni/workspaces/<project-id>/<agent-id>/` remains harmless on disk after rollback (a future `keni init`-style command may add a `keni doctor --clean-workspaces` flag to remove orphans, but that's out of scope here).

## Open Questions

- **OQ-1: PR creation surface.** This change adds `merge_pr` as the eighth engineer MCP tool but does not add a `create_pr` or `update_pr_status` tool. The engineer creates PRs via REST (`POST /prs`) using `fetch` from inside the subprocess, with the `KENI_MCP_SERVER_URL` and `KENI_MCP_AGENT` env vars supplying the URL and identity headers. **Decision needed during apply:** is fetch-from-prompt acceptable, or do we widen this change to add `create_pr` (and probably `update_pr_status`) to the MCP surface? Recommendation: ship `merge_pr` only in this change; defer `create_pr` to a follow-up if the prompt's HTTP plumbing proves brittle in the integration test. The integration test is the forcing function.
- **OQ-2: Workspace removal at runtime.** The prototype detects roster changes only at `runServer` boot. Should an engineer removed mid-run see their workspace removed immediately? Recommendation: defer to step 26 / the agents-API write surface (which doesn't yet exist); this change documents the limitation.
- **OQ-3: Default coding-agent CLI.** The role-runtime cycle parameterises `cliBinary`. This change needs to wire a *concrete* CLI for the prototype's `keni start` smoke test. Candidates: `claude`, `cursor-agent`, `opencode`. Recommendation: read the project config's `agent_cli` field (which `keni init` SHALL be extended to write — see the orchestration-server delta) with a sane fallback documented in the README. The integration test uses the existing fake-coding-agent fixture from step 07, not a real CLI, so this decision doesn't gate test pass.
