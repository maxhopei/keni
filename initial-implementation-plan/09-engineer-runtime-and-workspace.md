# Step 09 — engineer-runtime-and-workspace

**Phase:** Prototype
**Suggested change name:** `engineer-runtime-and-workspace`
**Depends on:** 07, 08

## Goal

Realise the Engineer role end-to-end. Workspace provisioning, the bundled TS/Deno/React system prompt, branch conventions, and an integration-test runner driven by docker-compose. After this step, the prototype loop **user → ticket → engineer → PR → merge → ready_for_test** has all engineer-side machinery in place.

## Scope

- Engineer specialisation built on top of the role runtime (step 07):
  - Precheck for the engineer: "is there an unblocked ticket I can pick up (open or test_failed) given my in-flight tickets?" Returns yes/no without spawning if no work.
  - Workspace path resolution (per-agent) supplied to the subprocess via env and via MCP `get_workspace_path`.
- Workspace provisioning:
  - Sparse clone of the project repo into `~/.keni/workspaces/<project-id>/<agent-id>/`. Sparse pattern excludes `.keni/` so engineers cannot see metadata.
  - Origin remote points at the project folder on disk; pulls bring `main` up to date at the start of each cycle.
  - Lifecycle: created when the engineer is added (default: `alice`, from `project.yaml`); discarded if the engineer is removed.
  - Branch convention: `ticket-{id}` (configurable, but default per §5.2).
- Bundled engineer system prompt (TS/Deno/React-opinionated):
  - Compiled into the binary per step 07's prompt-resolution decision.
  - Teaches the engineer the loop: pick top-of-queue ticket, plan, code in workspace, run integration tests via docker-compose, push and submit PR (record via REST/MCP), self-review in a fresh session (a separate cycle), fix comments, merge, move ticket to `ready_for_test`.
  - Specifies the one-line summary contract from §6.3.
- docker-compose integration-test hook:
  - The engineer can invoke `docker-compose -f <project>/docker-compose.yml ...` from inside its workspace.
  - Output streams to the activity log via the role runtime.
- Default agent: `alice`, configured in `project.yaml`. The engineer's own identity and workspace path are deterministic given `project_id` and `agent_id`.

## Out of scope

- PO and QA — out of scope for the prototype entirely (§8).
- Multi-engineer parallelism — step 26 (MVP).
- Self-review automation — the engineer prompt covers it conceptually but the prototype runs single-engineer; reviewing its own PR happens inside the same engineer's next cycle.
- Manual override flow — step 25 (MVP).

## Spec references

- §3 (Engineer) — Responsibilities, including self-review in a separate fresh session and the loop "in_progress → ready_for_review → in_review → has_comments|approved → merged → ready_for_test."
- §4.1 — Ticket lifecycle the engineer drives.
- §5.2 — Workspace location and naming convention; `<project-id>/<agent-id>/` rationale.
- §5.3 — Sparse clone excludes `.keni/`. Engineer never sees project metadata.
- §8 — Prototype includes "git workspace provisioning … into `~/.keni/workspaces/<project-id>/alice/`" and "docker-compose used by each workspace for integration-test runs."
- §11#4 — Engineer self-review in a new session.
- §11#10 — Code-only workspaces; metadata is API-managed.

## Open decisions for the proposer

- **Sparse-checkout mechanism.** `git sparse-checkout` cone or no-cone, `.git/info/sparse-checkout` patterns, etc. Pick one and confirm `.keni/` is excluded.
- **Merge strategy onto `main`.** The spec calls "the exact mechanism is an architecture concern" (§5.5). Local-only operation in prototype suggests a local merge; document whether it's `git merge --ff-only`, fast-forward branches, or a server-side merge endpoint.
- **Engineer prompt content.** Iterate. Capture v1 in this step; future tightening is expected (per §10 prompt customisation note).

## Notes for /opsx:propose

- `proposal.md` should frame this as the moment the prototype becomes capable of building software.
- `design.md` should: pin the workspace lifecycle, sparse-checkout rules, branch naming, the engineer prompt structure (sections, summary-line spec), the merge mechanism, and the docker-compose interface.
- `tasks.md` should cover: workspace provisioner, engineer precheck, engineer runtime, bundled prompt v1, docker-compose hook, integration test that drives a no-op-but-realistic engineer cycle end-to-end against a seeded project.
- Capability spec for `engineer-runtime` covers the contract; a separate capability spec for `engineer-prompt` documents the prompt's expected behaviour for `/opsx:verify`.
