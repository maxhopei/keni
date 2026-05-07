## REMOVED Requirements

### Requirement: `@keni/role-runtimes` exposes a `createEngineerRunner(deps, opts)` factory that returns an `AgentRunner` for the scheduler

**Reason**: The `engineer-runtime` capability is split into `runtime-engineer` (the runner factory, prompt wiring, MCP config builder, engineer wire export) and `runtime-workspace` (the provisioner interface and the git default). The runner factory now returns the polymorphic `AgentRunner` from `@keni/runtime-common` directly; the legacy `EngineerAgentRunner` shape is deleted.
**Migration**: See the new `runtime-engineer` capability spec. Replace every `import { createEngineerRunner } from "@keni/role-runtimes"` with `from "@keni/runtime-engineer"`. The factory's return type changes from `EngineerAgentRunner` to `AgentRunner` (the latter imported from `@keni/runtime-common`); structurally compatible.

### Requirement: The engineer precheck pulls `main`, queries the orchestration server, and returns the top-of-queue ticket or skips

**Reason**: Folded into the `runtime-engineer` capability. The `WorkspaceProvisioner` reference now resolves through `@keni/runtime-workspace`.
**Migration**: No behavioural change; update the import specifier for `WorkspaceProvisioner` in the engineer's wire / runner code to `@keni/runtime-workspace`.

### Requirement: `WorkspaceProvisioner` interface and `GitWorkspaceProvisioner` default exist with the documented method surface

**Reason**: Moved to the new `runtime-workspace` capability and decoupled from the engineer role. The `ensureProvisioned` method's signature gains a `sparseCheckoutPattern: readonly string[]` argument so any role's wire can supply its own pattern; engineer passes `["/*", "!.keni/"]` (now `ENGINEER_SPARSE_CHECKOUT_PATTERN` in `@keni/runtime-engineer`).
**Migration**: Replace `import { WorkspaceProvisioner, GitWorkspaceProvisioner } from "@keni/role-runtimes"` with `from "@keni/runtime-workspace"`. Update `ensureProvisioned` call sites to pass the sparse pattern explicitly.

### Requirement: `workspacePathFor(projectId, agentId)` returns `<homeDir>/.keni/workspaces/<projectId>/<agentId>` deterministically

**Reason**: Moved to `runtime-workspace`. The path computation rule is preserved verbatim.
**Migration**: Import update only.

### Requirement: `ensureProvisioned` performs a sparse clone whose checkout pattern excludes `.keni/`

**Reason**: Moved to `runtime-workspace` with the sparse pattern parameterised. The engineer's pattern (`["/*", "!.keni/"]`) is now `ENGINEER_SPARSE_CHECKOUT_PATTERN` in `@keni/runtime-engineer` and is passed through `ensureProvisioned`'s new argument.
**Migration**: Update call sites to pass the sparse pattern; for the engineer, pass `ENGINEER_SPARSE_CHECKOUT_PATTERN`.

### Requirement: `pullMain` runs `git pull --ff-only origin main` and surfaces failures as a typed error

**Reason**: Moved to `runtime-workspace`.
**Migration**: Import update only.

### Requirement: `discardProvisioned` removes the workspace tree recursively, no-op when the path does not exist

**Reason**: Moved to `runtime-workspace`.
**Migration**: Import update only.

### Requirement: The runner's `promptResolver` returns the bundled engineer prompt as a TS string constant

**Reason**: Folded into `runtime-engineer`. The prompt constants move from `packages/role-runtimes/src/engineer/prompts/engineer.ts` to `packages/runtime-engineer/src/prompts/engineer.ts`.
**Migration**: Import specifier flips to `@keni/runtime-engineer`.

### Requirement: The runner's `mcpServerConfig` includes the engineer's `agentId`, `serverUrl`, and `workspacePath`, and the `merge_pr` MCP tool is available to the subprocess

**Reason**: Folded into `runtime-engineer`. The `buildEngineerMcpServerConfig` helper moves to `@keni/runtime-engineer`. The `merge_pr` MCP tool's availability remains an `mcp-engineer-surface` requirement (unchanged).
**Migration**: Import specifier flips to `@keni/runtime-engineer`.

### Requirement: `runServer` wires up the engineer runner at bootstrap before `Deno.serve` accepts connections

**Reason**: Replaced by the polymorphic role-wiring loop in the modified `orchestration-server` capability. `runServer` no longer knows about the literal role `"engineer"`; it dispatches via `roleWires[agent.role]`.
**Migration**: See the modified `orchestration-server` capability's "polymorphic role wires" requirement. The CLI assembles `roleWires` from `@keni/runtime-engineer` and `@keni/runtime-po` and hands it through `RunServerDeps`.

### Requirement: An end-to-end integration test exercises the engineer runner against a real orchestration server, real workspace provisioning, and a fixture coding agent

**Reason**: Folded into `runtime-engineer`. The integration test moves from `packages/role-runtimes/tests/integration/engineer/` to `packages/runtime-engineer/tests/integration/`.
**Migration**: Move the test file; update import specifiers; the assertions are preserved.

### Requirement: The engineer runtime introduces no new runtime dependencies beyond Deno built-ins and `@std/*` modules already in `deno.json`

**Reason**: Folded into `runtime-engineer` (and applied across all four new packages).
**Migration**: The change SHALL NOT add any third-party dependency.

### Requirement: Capability documentation names the workspace lifecycle and `.keni/`-boundary invariants

**Reason**: The workspace-lifecycle invariants move to the `runtime-workspace` capability; the engineer-specific narrative (sparse pattern, per-workspace identity rule for engineers) stays in `runtime-engineer`.
**Migration**: Update the repo-root README and per-package READMEs to reflect the new package boundaries.

### Requirement: `@keni/role-runtimes` exposes a `codingAgentCliRegistry` mapping known CLI names to their subprocess spawn shapes

**Reason**: Folded into `runtime-common`. The CLI registry is role-agnostic and lives in the common package.
**Migration**: Replace `import { codingAgentCliRegistry } from "@keni/role-runtimes"` with `from "@keni/runtime-common"`. The `KnownCli` union, `CodingAgentCliEntry` interface, `McpConfigStrategy` discriminated union, and `isKnownCli` guard are unchanged.

### Requirement: Each registry entry's `buildArgs` produces a CLI-correct argv that consumes the engineer's prompt and connects the MCP server

**Reason**: Folded into `runtime-common`.
**Migration**: Import update only.

### Requirement: The CLI registry's per-CLI entries live in single-file modules under `codingAgentClis/`; the registry assembly lives in `codingAgentCliRegistry.ts`

**Reason**: Folded into `runtime-common`. The path becomes `packages/runtime-common/src/codingAgentClis/<cli>.ts` and `packages/runtime-common/src/codingAgentCliRegistry.ts`.
**Migration**: File moves and import-specifier flip.

### Requirement: Each `CodingAgentCliEntry` carries an `mcpConfigStrategy` field that names the per-CLI MCP-config materialisation contract

**Reason**: Folded into `runtime-common`.
**Migration**: Import update only.
