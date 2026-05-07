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
packages/role-runtimes/
├── src/                                      # production code only
│   ├── common/                               # role-agnostic seven-step cycle + types
│   │   ├── startCycle.ts                     # the cycle wrapper (single invocation, stateless)
│   │   ├── activityClient.ts                 # typed POST /activity adapter (X-Keni-{Role,Agent} stamped)
│   │   ├── codingAgentCliRegistry.ts         # closed registry: KnownCli, CodingAgentCliEntry, McpConfigStrategy
│   │   ├── codingAgentClis/                  # one file per CLI; each exports a single CodingAgentCliEntry
│   │   │   ├── claude.ts                     # claudeEntry (tempfile-json strategy)
│   │   │   ├── cursorAgent.ts                # cursorAgentEntry (workspace-json under .cursor/mcp.json)
│   │   │   └── codex.ts                      # codexEntry (workspace-toml under .codex/config.toml)
│   │   ├── codingAgentInvoker.ts             # createSubprocessCodingAgentInvoker + strategy executor
│   │   └── types.ts                          # AgentRunner, BundledPrompt, McpServerConfig, RoleCycleResult, …
│   ├── engineer/                             # engineer specialisation
│   │   ├── runner.ts                         # createEngineerRunner factory
│   │   ├── prompts/engineer.ts               # ENGINEER_PROMPT_NAME + ENGINEER_PROMPT_BODY (eight sections)
│   │   └── workspace/
│   │       ├── interface.ts                  # WorkspaceProvisioner + WorkspaceProvisioningError
│   │       └── git.ts                        # GitWorkspaceProvisioner (production default)
│   └── main.ts                               # production barrel (no fakes)
└── tests/                                    # all tests + test-only support code
    ├── unit/                                 # mirrors src/ tree; one *_test.ts per module
    ├── integration/                          # in-process runServer + cursorAgent argv shape
    │   ├── common/integration_test.ts        # end-to-end fake-coding-agent driving startCycle
    │   ├── engineer/integration_test.ts      # in-process runServer + workspace shape + POST /prs/:id/merge
    │   └── cursorAgent_test.ts               # cursor-agent registry-entry argv sanity check
    ├── fakes/                                # test doubles (re-exported via ./test-fakes)
    │   ├── common/fakeCodingAgentInvoker.ts  # fake CodingAgentInvoker, records lifecycle calls
    │   ├── engineer/workspace/fakeWorkspaceProvisioner.ts  # records calls, no FS touch
    │   └── mod.ts                            # barrel for `@keni/role-runtimes/test-fakes`
    └── fixtures/
        └── fake-coding-agent.ts              # standalone script run as a child process by tests
```

The package's `deno.json` declares two `exports` entries:

- `"."` → `./src/main.ts` — the production barrel. Production code in other packages
  (`@keni/server`, `@keni/cli`) imports from `@keni/role-runtimes`.
- `"./test-fakes"` → `./tests/fakes/mod.ts` — the test-only barrel. Cross-package test code
  (`packages/server/tests/**`, `packages/cli/tests/**`) imports `FakeWorkspaceProvisioner` and
  `createFakeCodingAgentInvoker` from `@keni/role-runtimes/test-fakes`. The production barrel
  deliberately does NOT re-export anything from `tests/fakes/`.

### Adding a new coding-agent CLI to the registry

1. Add `packages/role-runtimes/src/common/codingAgentClis/<newCli>.ts` exporting the
   `CodingAgentCliEntry` constant. The entry's `mcpConfigStrategy` field is the seam that decides
   where the keni MCP-server config is materialised:
   - `{ kind: "tempfile-json" }` for CLIs that accept a `--mcp-config <path>` argv flag.
   - `{ kind: "workspace-json", relativePath, mergeKey, entryName }` for CLIs that discover MCP
     servers from a workspace-scoped JSON file (e.g. `.cursor/mcp.json`).
   - `{ kind: "workspace-toml", relativePath, tableHeader, entryName }` for CLIs that consume a TOML
     config file (e.g. `.codex/config.toml`).
2. Bind the entry under its `KnownCli` key in `codingAgentCliRegistry.ts` and extend the `KnownCli`
   literal union and `isKnownCli` guard.
3. Add a registry-shape scenario in `tests/unit/common/codingAgentCliRegistry_test.ts` pinning the
   new entry's argv invariants and strategy fields.
4. (Optional) Add an integration test against the real binary under
   `packages/role-runtimes/tests/integration/<newCli>_test.ts`, gated on the binary being on `PATH`.

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
