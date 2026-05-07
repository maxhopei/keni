# runtime-engineer Specification

## Purpose

`@keni/runtime-engineer` owns every engineer-specific symbol that builds an `AgentRunner` for the scheduler: the bundled engineer prompt (eight-section TS string constant), the `createEngineerRunner` factory, the four-step engineer precheck (pull main → in-flight query → pickup query → skip), the `buildEngineerMcpServerConfig` helper, the engineer's documented sparse-checkout pattern (`["/*", "!.keni/"]`), and the `wire(input)` plug-in function the CLI registers under the `"engineer"` role. Workspace primitives are imported (not re-exported) from `@keni/runtime-workspace`; cycle types and the `AgentRunner` shape come from `@keni/runtime-common`. The orchestration server depends on neither this package nor any other role package — the polymorphic `roleWires` registry is the only seam.

Created by archiving change `split-role-runtimes-package`. Behavioural guarantees previously captured in the `engineer-runtime` capability are preserved verbatim (runner factory, prompt body, precheck, MCP config builder, merge-PR surface); workspace-shaped requirements moved to `runtime-workspace`; the runner factory now returns `AgentRunner` from `@keni/runtime-common` directly (the legacy `EngineerAgentRunner` interface is gone).

## Requirements

### Requirement: `@keni/runtime-engineer` is a workspace package that owns every engineer-specific symbol — prompt, runner factory, MCP config builder, and the engineer `wire(input)` export

The workspace `deno.json` SHALL list `./packages/runtime-engineer` as a workspace member. The package's `deno.json` SHALL declare `"name": "@keni/runtime-engineer"`, `"version": "0.0.0"`, and `"exports": { ".": "./src/main.ts" }`. The package's `src/main.ts` SHALL re-export:

- `ENGINEER_PROMPT_NAME`, `ENGINEER_PROMPT_BODY` (TS string constants from `packages/runtime-engineer/src/prompts/engineer.ts`).
- `createEngineerRunner` (the runner factory; returns `AgentRunner` directly).
- `EngineerRunnerDeps`, `EngineerRunnerOpts` (the factory's parameter shapes).
- `buildEngineerMcpServerConfig`, `BuildEngineerMcpServerConfigOpts` (the MCP-config builder).
- `orderEngineerTickets` (the precheck's ordering helper, exposed for unit-test pinning).
- `ENGINEER_SPARSE_CHECKOUT_PATTERN` (the array passed to `WorkspaceProvisioner.ensureProvisioned`; today: `["/*", "!.keni/"]`).
- `wire` — the `WireFn` the CLI registers under `Role: "engineer"`.

The package SHALL NOT export `WorkspaceProvisioner`, `GitWorkspaceProvisioner`, or any other workspace-shaped symbol — those live in `@keni/runtime-workspace` and are imported, not re-exported.

#### Scenario: Public surface is reachable through the package's main barrel

- **WHEN** a downstream module writes `import { wire, createEngineerRunner, ENGINEER_PROMPT_BODY, ENGINEER_PROMPT_NAME } from "@keni/runtime-engineer"`
- **THEN** every import resolves without error

#### Scenario: The package does not re-export workspace primitives

- **WHEN** the source of `packages/runtime-engineer/src/main.ts` is scanned for the symbols `WorkspaceProvisioner`, `GitWorkspaceProvisioner`, `WorkspaceProvisioningError`
- **THEN** none appear in any `export` statement
- **AND** every consumer reaches them via `@keni/runtime-workspace` directly

### Requirement: `createEngineerRunner` returns `AgentRunner` directly; the legacy `EngineerAgentRunner` interface is gone

The `@keni/runtime-engineer` package's `createEngineerRunner(deps, opts): AgentRunner` factory SHALL return the `AgentRunner` value bag imported from `@keni/runtime-common`. No package SHALL declare a separate `EngineerAgentRunner` interface; structural duplication of the runner shape is forbidden.

The runner's behaviour SHALL be unchanged from the archived `engineer-runtime` capability: `role: "engineer"`, the four-step precheck (pull main → in-flight query → pickup query → skip), the bundled engineer prompt via `promptResolver`, the MCP config from `buildEngineerMcpServerConfig`, the per-agent workspace path threaded into `RoleCycleParams.workspacePath`. The factory SHALL be pure (no I/O at construction); every effectful primitive flows through `deps`.

#### Scenario: Factory return type is `AgentRunner`

- **WHEN** a consumer writes `const runner: AgentRunner = createEngineerRunner(deps, opts)`
- **THEN** `deno task check` passes
- **AND** no widening or narrowing is required at the assignment site

#### Scenario: `EngineerAgentRunner` is gone from the workspace

- **WHEN** the workspace is searched for `EngineerAgentRunner`
- **THEN** zero occurrences are found in any production source file or test file

### Requirement: The engineer `wire(input: WireInput) => Promise<AgentRunner | null>` function lives in `@keni/runtime-engineer` and replaces the CLI's `buildProductionEngineerRunnerFactory`

The package SHALL export, from `packages/runtime-engineer/src/wire.ts` (re-exported through the main barrel), a `wire` function whose signature matches `WireFn` from `@keni/runtime-common`. The function's body SHALL implement the production wiring previously living in `packages/cli/src/start/engineerRunner.ts`'s `buildProductionEngineerRunnerFactory`:

1. Resolve the agent's CLI name (per-agent `cli` → global `coding_agent_cli` → `null`).
2. When the resolved CLI is `null`, log `engineer.runner_skipped` (`reason: "no_cli_configured"`) via the input's logger and return `null`.
3. Look up the entry in `input.codingAgentCliRegistry`. When absent, log `engineer.runner_skipped` (`reason: "unknown_cli"`) and return `null`.
4. Construct a `CodingAgentInvoker` via `createSubprocessCodingAgentInvoker(...)`.
5. Compute `workspacePath` via `input.workspaceProvisioner.workspacePathFor(...)` and call `input.workspaceProvisioner.ensureProvisioned({ ..., sparseCheckoutPattern: ENGINEER_SPARSE_CHECKOUT_PATTERN })` to provision the workspace.
6. Build `mcpServerConfig` via `buildEngineerMcpServerConfig(...)`.
7. Construct an `ActivityHttpClient` via `input.makeActivityHttpClient(input.serverUrl, input.agentConfig.id)`.
8. Return `createEngineerRunner(...)` (which returns `AgentRunner`).

The function SHALL be stateless across invocations (wiring two engineers produces two independent runners). It SHALL NOT throw under nominal operation; missing CLI / unknown CLI is reported via the `null` return, identical to today's behaviour.

#### Scenario: Engineer wire returns a runner for a fully-configured engineer agent

- **WHEN** `wire(input)` is invoked with a `WireInput` whose `agentConfig.role === "engineer"`, `resolvedConfig.coding_agent_cli === "claude"`, and the registry includes the `claude` entry
- **THEN** the function resolves with a non-null `AgentRunner` whose `role === "engineer"`
- **AND** the input's `workspaceProvisioner.ensureProvisioned` was called exactly once with `sparseCheckoutPattern: ENGINEER_SPARSE_CHECKOUT_PATTERN`

#### Scenario: Engineer wire returns `null` when no CLI is configured

- **WHEN** `wire(input)` is invoked with a `WireInput` whose `agentConfig.cli` is undefined and `resolvedConfig.coding_agent_cli` is undefined
- **THEN** the function resolves with `null`
- **AND** the input's logger received exactly one `engineer.runner_skipped` line with `reason: "no_cli_configured"`

#### Scenario: Engineer wire returns `null` when the configured CLI is unknown

- **WHEN** `wire(input)` is invoked with `agentConfig.cli: "made-up"` and the registry does not contain that key
- **THEN** the function resolves with `null`
- **AND** the input's logger received exactly one `engineer.runner_skipped` line with `reason: "unknown_cli"` and `configured_cli: "made-up"`

### Requirement: Engineer-runtime behaviours previously captured in the `engineer-runtime` capability apply unchanged for the runner factory, prompt, and MCP config builder

Every behavioural guarantee captured in the archived `engineer-runtime` capability spec for the runner factory, the engineer prompt (eight sections, length window, fixture pin), the precheck (pull-main → in-flight → pickup → skip), the MCP config builder (`deno run -A` against the MCP entry path with `--agent`, `--server-url`, `--workspace`), and the merge-PR / `merge_pr` MCP-tool surface SHALL hold verbatim for `@keni/runtime-engineer`. The capability is renamed from `engineer-runtime` to `runtime-engineer`; the workspace-shaped requirements move to `runtime-workspace`; the requirement text and scenarios for the runner / prompt / MCP-config bits are preserved with the package name and source paths updated to `@keni/runtime-engineer` and `packages/runtime-engineer/src/...` respectively.

#### Scenario: Engineer prompt's eight-section structure is preserved

- **WHEN** the bundled engineer prompt body in `@keni/runtime-engineer` is parsed for the eight section headings (Identity, Workspace, MCP tools, The loop, Self-review, Integration tests, Summary line, Refusals)
- **THEN** all eight headings appear in the documented order
- **AND** the body length is within the documented `[500, 8192]` character window

### Requirement: `@keni/runtime-engineer`'s production source depends on `@keni/runtime-common`, `@keni/runtime-workspace`, and `@keni/shared` only

The package SHALL NOT import from `@keni/server`, `@keni/cli`, or `@keni/runtime-po`. Its `@keni/*` dependency edges SHALL be exactly:

- `@keni/runtime-common` — for `AgentRunner`, `WireFn`, `WireInput`, cycle types, `ActivityHttpClient`.
- `@keni/runtime-workspace` — for `WorkspaceProvisioner`, `WorkspaceProvisioningError`.
- `@keni/shared` — for `Role`, `AgentId`, `AgentConfig`, `ResolvedConfig`, `TicketSummary`, `TicketFilter`.

#### Scenario: Source contains no `@keni/server` or `@keni/cli` imports

- **WHEN** the production source files under `packages/runtime-engineer/src/` are scanned for `from "@keni/server"` or `from "@keni/cli"`
- **THEN** zero occurrences are found
