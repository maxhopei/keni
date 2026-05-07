# runtime-workspace Specification

## Purpose

`@keni/runtime-workspace` owns the role-agnostic workspace-provisioner contract — the `WorkspaceProvisioner` interface, the `GitWorkspaceProvisioner` production default, and the typed `WorkspaceProvisioningError` shape. Any agent role that needs a per-agent sparse-checkout (engineer today; QA, PO, writer if/when they grow workspaces) plugs into this package by passing its own sparse pattern through `ensureProvisioned`. The package contains zero engineer-specific knowledge — sparse patterns and any role-specific provisioning steps live in the role packages and flow in as parameters.

Created by archiving change `split-role-runtimes-package`. The workspace-shaped requirements split out of the previous `engineer-runtime` capability; behaviour is preserved verbatim with the documented introduction of `sparseCheckoutPattern` as a per-call argument and the `sparse_pattern_invalid` error code.

## Requirements

### Requirement: `@keni/runtime-workspace` is a workspace package that owns the role-agnostic workspace-provisioner interface and the `GitWorkspaceProvisioner` default implementation

The workspace `deno.json` SHALL list `./packages/runtime-workspace` as a workspace member. The package's `deno.json` SHALL declare `"name": "@keni/runtime-workspace"`, `"version": "0.0.0"`, and `"exports": { ".": "./src/main.ts", "./test-fakes": "./tests/fakes/mod.ts" }`. The package's `src/main.ts` SHALL re-export:

- `WorkspaceProvisioner` (interface)
- `WorkspaceProvisioningError` (typed error class)
- `WorkspaceProvisioningErrorCode` (closed string-literal union)
- `WorkspaceProvisioningErrorDetails` (typed details bag)
- `GitWorkspaceProvisioner` (production default class)
- `GitWorkspaceProvisionerOpts` (constructor options)

The package SHALL NOT export any engineer-specific symbol (no `ENGINEER_SPARSE_CHECKOUT_PATTERN` constant, no engineer-only error code, no engineer-only ensure-step). The engineer-specific sparse pattern lives in `@keni/runtime-engineer` and is passed through the interface as a parameter.

#### Scenario: Public surface is reachable through the package's main barrel

- **WHEN** a downstream module writes `import { WorkspaceProvisioner, GitWorkspaceProvisioner, WorkspaceProvisioningError } from "@keni/runtime-workspace"`
- **THEN** every import resolves without error

#### Scenario: The package contains no engineer-specific exports

- **WHEN** the source of `packages/runtime-workspace/src/main.ts` is scanned for the symbol `ENGINEER_SPARSE_CHECKOUT_PATTERN`, `engineerSparseCheckoutPattern`, or any string literal beginning with `engineer`
- **THEN** none appear

### Requirement: `WorkspaceProvisioner` accepts the sparse-checkout pattern as a per-call argument so any role's wire can invoke it with a role-specific pattern

The `WorkspaceProvisioner` interface SHALL expose the methods:

- `workspacePathFor(projectId: string, agentId: string): string` — pure path computation (`<homeDir>/.keni/workspaces/<projectId>/<agentId>`).
- `ensureProvisioned(opts: { projectId: string; agentId: string; projectRepoPath: string; sparseCheckoutPattern: readonly string[] }): Promise<string>` — sparse-clone the project repo into the workspace, configure the sparse pattern from the supplied argument, set per-workspace git identity. Idempotent. Returns the workspace path.
- `pullMain(projectId: string, agentId: string): Promise<void>` — `git pull --ff-only origin main` against the workspace.
- `discardProvisioned(projectId: string, agentId: string): Promise<void>` — recursively remove the workspace directory; no-op when absent.

The interface SHALL NOT hard-code any sparse pattern. `GitWorkspaceProvisioner` SHALL apply the supplied `sparseCheckoutPattern` exactly (one line per array element, no implicit augmentation, no implicit `/*` prefix). The legacy zero-argument `ensureProvisioned(projectId, agentId, projectRepoPath)` signature is removed.

`@keni/runtime-engineer` SHALL pass `["/*", "!.keni/"]` (the engineer's documented pattern). Future role packages MAY pass other patterns documented in their own capability specs.

#### Scenario: `ensureProvisioned` rejects an empty pattern

- **WHEN** `provisioner.ensureProvisioned({ ..., sparseCheckoutPattern: [] })` is invoked
- **THEN** the call rejects with `WorkspaceProvisioningError("sparse_pattern_invalid", { reason: "empty_pattern" })`
- **AND** no `git` subprocess is spawned

#### Scenario: Engineer's pattern produces the engineer's expected on-disk shape

- **WHEN** the engineer's wire calls `ensureProvisioned({ ..., sparseCheckoutPattern: ["/*", "!.keni/"] })`
- **THEN** the workspace directory contains every project file
- **AND** `<workspace>/.keni/` is absent (sparse-excluded)
- **AND** `<workspace>/.git/info/sparse-checkout` contains exactly two lines: `/*` and `!.keni/` in that order

### Requirement: Workspace lifecycle and error semantics previously captured in the `engineer-runtime` capability apply unchanged

Every `WorkspaceProvisioner`-shaped behaviour previously captured in `engineer-runtime` — the workspace path computation rule (`<homeDir>/.keni/workspaces/<projectId>/<agentId>`), the per-workspace local git identity (`<agentId> <<agentId>@keni.invalid>`), the host-`~/.gitconfig`-untouched invariant, the `pullMain` `--ff-only` semantics with `pull_main_failed` error code, the `discardProvisioned` no-op-on-missing semantics, and the `WorkspaceProvisioningError` closed `code` discriminator — SHALL hold verbatim for `@keni/runtime-workspace`. The capability is split out of `engineer-runtime`; the requirement text and scenarios are preserved with package paths updated to `@keni/runtime-workspace` and `packages/runtime-workspace/src/...` respectively. The `code` union SHALL gain `sparse_pattern_invalid` for the empty-or-malformed-pattern guard introduced by this change; every other code value (`home_dir_unset`, `git_clone_failed`, `sparse_init_failed`, `sparse_reapply_failed`, `checkout_failed`, `git_config_failed`, `sparse_pattern_failed`, `pull_main_failed`, `workspace_missing`) is preserved.

#### Scenario: Per-workspace git identity is set on `ensureProvisioned`

- **WHEN** `ensureProvisioned` runs successfully for `(projectId: "p1", agentId: "alice", sparseCheckoutPattern: [...])`
- **THEN** the workspace directory's `git config --local user.name` is `"alice"`
- **AND** the workspace's `git config --local user.email` is `"alice@keni.invalid"`
- **AND** the host's `~/.gitconfig` is unchanged

#### Scenario: `pullMain` non-fast-forward surfaces as a typed error

- **WHEN** the workspace's `main` has diverged from origin and `pullMain` is invoked
- **THEN** the call rejects with `WorkspaceProvisioningError("pull_main_failed", { agentId, projectId })`

### Requirement: `@keni/runtime-workspace/test-fakes` exposes `FakeWorkspaceProvisioner`

The package's `./test-fakes` secondary entry SHALL re-export `FakeWorkspaceProvisioner` (the in-memory stub used by cross-package tests). The fake SHALL record every call in arrival order, SHALL never touch the filesystem, and SHALL accept the new `sparseCheckoutPattern` argument on `ensureProvisioned` (recording the value verbatim for assertion).

#### Scenario: Cross-package consumers import the fake from the secondary entry

- **WHEN** a test file in `packages/server/tests/` writes `import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace/test-fakes"`
- **THEN** the import resolves and the class is constructable
- **AND** `import { FakeWorkspaceProvisioner } from "@keni/runtime-workspace"` (the production specifier) fails to resolve the symbol

### Requirement: `@keni/runtime-workspace` depends only on `@keni/shared`, Deno built-ins, and `@std/*` modules

The package SHALL NOT import from `@keni/server`, `@keni/cli`, `@keni/runtime-common`, `@keni/runtime-engineer`, or `@keni/runtime-po`. Its only `@keni/*` dependency edge is `@keni/shared` (for `Role`, `AgentId`, `Logger` types). The workspace `WorkspaceLogger` shape is imported from `@keni/runtime-common`'s re-exported logger types if a logger argument is needed; alternatively, `@keni/runtime-workspace` MAY define a minimal `Logger` shape locally to keep the dependency edge to `@keni/shared` only.

#### Scenario: Package's source contains no `@keni/server`, `@keni/cli`, or sibling-runtime imports

- **WHEN** the production source files under `packages/runtime-workspace/src/` are scanned for `from "@keni/`
- **THEN** the only matched specifier prefixes are `@keni/shared` and (optionally) `@keni/runtime-common`
- **AND** no source file imports from `@keni/server`, `@keni/cli`, `@keni/runtime-engineer`, or `@keni/runtime-po`
