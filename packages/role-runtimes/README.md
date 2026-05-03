# `@keni/role-runtimes`

Per-role specialisations of Keni's deterministic seven-step cycle. The package's two
responsibilities are:

1. Export the **role-agnostic** cycle wrapper (`startCycle(params)`) the scheduler invokes once per
   tick — see [`src/common/`](./src/common/) and the [`spec.md` §6.2](../../spec.md) cycle
   definition.
2. Export the **role-specific** runner factories (engineer today; QA, PO, writer to follow) that
   plug a precheck, a bundled prompt, an MCP-server config, and a `CodingAgentInvoker` into the
   common cycle.

## Layout

```
packages/role-runtimes/src/
├── common/                       # role-agnostic seven-step cycle + types
│   ├── startCycle.ts             # the cycle wrapper (single invocation, stateless)
│   ├── activityClient.ts         # typed POST /activity adapter (X-Keni-{Role,Agent} stamped)
│   ├── types.ts                  # AgentRunner, BundledPrompt, McpServerConfig, RoleCycleResult, …
│   └── integration_test.ts       # end-to-end fake-coding-agent driving startCycle
├── engineer/                     # engineer specialisation
│   ├── runner.ts                 # createEngineerRunner factory
│   ├── prompts/
│   │   └── engineer.ts           # ENGINEER_PROMPT_NAME + ENGINEER_PROMPT_BODY (eight sections)
│   ├── workspace/
│   │   ├── interface.ts          # WorkspaceProvisioner + WorkspaceProvisioningError
│   │   ├── git.ts                # GitWorkspaceProvisioner (production default)
│   │   └── fakes/
│   │       └── fakeWorkspaceProvisioner.ts   # test double, records calls, no FS touch
│   └── integration_test.ts       # in-process runServer + workspace shape + POST /prs/:id/merge
└── main.ts                       # barrel re-exports
```

## The engineer subdirectory

The engineer specialisation has three load-bearing pieces:

### `WorkspaceProvisioner` interface

The seam between the cycle and the per-agent on-disk workspace clone. Exactly four methods:

- `workspacePathFor(projectId, agentId)` — pure path computation
  (`<homeDir>/.keni/workspaces/<projectId>/<agentId>`).
- `ensureProvisioned(projectId, agentId, projectRepoPath)` — sparse-clone the project repo into the
  workspace directory, set per-workspace identity, verify `.keni/` is sparse-excluded. Idempotent.
- `pullMain(projectId, agentId)` — `git pull --ff-only origin main`. Surfaces non-fast-forward as
  `WorkspaceProvisioningError("pull_main_failed", …)`.
- `discardProvisioned(projectId, agentId)` — recursively remove the workspace directory; no-op when
  the path does not exist.

Failures are reported via `WorkspaceProvisioningError` with a closed `code` discriminator
(`home_dir_unset`, `git_clone_failed`, `sparse_init_failed`, `sparse_reapply_failed`,
`checkout_failed`, `git_config_failed`, `sparse_pattern_failed`, `pull_main_failed`,
`workspace_missing`).

### `GitWorkspaceProvisioner` (default implementation)

Backs the interface with real `git` subprocesses (via `Deno.Command`). Workspace shape produced by
`ensureProvisioned`:

- `<homeDir>/.keni/workspaces/<projectId>/<agentId>/.git/` — present.
- `<homeDir>/.keni/workspaces/<projectId>/<agentId>/.keni/` — **absent** (sparse-checkout
  exclusion); a post-checkout `Deno.lstat` proves this and surfaces `sparse_pattern_failed` if the
  exclusion silently broke.
- `<homeDir>/.keni/workspaces/<projectId>/<agentId>/.git/info/sparse-checkout` — exactly two lines
  (`/*` and `!.keni/`).
- Per-workspace `git config --local user.name <agentId>` / `user.email <agentId>@keni.invalid` — the
  host's `~/.gitconfig` is never read or written.

### `createEngineerRunner` factory

Returns the `AgentRunner` value bag the scheduler hands to `startCycle` on every tick. Composition:

- **`role`** — fixed to `"engineer"`.
- **`precheck`** — `pullMain` first; then queries the orchestration server for an in-flight ticket
  assigned to this agent; if none, picks an unassigned `open` ticket. Returns `"skip"` on
  fast-forward refusal, missing workspace, or no eligible ticket.
- **`promptResolver`** — returns `{ name: ENGINEER_PROMPT_NAME, body: ENGINEER_PROMPT_BODY }` — the
  bundled engineer prompt as a TypeScript string constant (no filesystem read).
- **`codingAgentInvoker`** — the dependency-injected invoker (production: a subprocess invoker
  spawning `claude-code` / similar against the engineer's workspace).
- **`mcpServerConfig`** — built once at runner creation: `command: "deno"`, args pointing at
  `packages/server/src/mcp/main.ts` with `--agent`, `--server-url`, and `--workspace` flags.

### Engineer prompt (`prompts/engineer.ts`)

The bundled engineer system prompt. Code, not a file: imported as a `const` like any other module
(see the repo-root README's "Prompts are code, not files" convention). Eight sections in fixed
order: Identity, Workspace, MCP tools, The loop, Self-review, Integration tests, Summary line,
Refusals. Length is constrained to `[500, 8192]` characters and pinned by structural tests in
`engineer_test.ts`.

## See also

- [`spec.md` §6.2](../../spec.md) — the seven-step cycle definition.
- The
  [`engineer-runtime` capability spec](../../openspec/changes/engineer-runtime-and-workspace/specs/engineer-runtime/spec.md)
  (active until archived) — the formal contract for the engineer specialisation.
- The repo-root README's "Engineer runtime" section — operator-facing summary of the six engineer
  invariants.
