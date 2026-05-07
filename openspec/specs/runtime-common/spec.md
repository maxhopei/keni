# runtime-common Specification

## Purpose

`@keni/runtime-common` is the role-agnostic core of the Keni role-runtime stack: it owns the seven-step `startCycle` algorithm, the wire shapes the scheduler consumes (`AgentRunner`, `RoleCycleParams`, `RoleCycleResult`, `CodingAgentInvoker`, …), the `codingAgentCliRegistry` for known CLIs, the `resolveBundledPrompt` helper, the polymorphic plug-in protocol (`WireFn`, `WireInput`, `RoleWires`, `ActivityHttpClient`), and the cross-package test fakes that role packages and the orchestration server rely on. Every role package (`@keni/runtime-engineer`, `@keni/runtime-po`, future QA / writer / …) sits on top of this package; the orchestration server consumes only this package's wire shapes — never role-specific symbols.

Created by archiving change `split-role-runtimes-package`. The capability replaces the previous `role-runtime` capability one-for-one; behavioural guarantees are preserved verbatim with package paths updated to `@keni/runtime-common` and `packages/runtime-common/src/...`.

## Requirements

### Requirement: `@keni/runtime-common` is a workspace package whose `src/main.ts` re-exports the role-agnostic cycle, types, CLI registry, and the polymorphic plug-in contracts

The workspace `deno.json` SHALL list `./packages/runtime-common` as a workspace member. The package's `deno.json` SHALL declare `"name": "@keni/runtime-common"`, `"version": "0.0.0"`, and `"exports": { ".": "./src/main.ts", "./test-fakes": "./tests/fakes/mod.ts" }`. The package's `src/main.ts` SHALL re-export every public symbol previously exported from `@keni/role-runtimes`'s `src/main.ts` that is *not* engineer- or workspace-specific:

- `startCycle`
- `RoleCycleParams`, `RoleCycleResult`, `CodingAgentInvocation`, `CodingAgentLifecycle`, `CodingAgentOutcome`, `CodingAgentInvoker`, `CyclePrepCtx`, `PrecheckResult`, `BundledPrompt`, `McpServerConfig`
- `createSubprocessCodingAgentInvoker`, `SubprocessCodingAgentInvokerOpts`
- `codingAgentCliRegistry`, `isKnownCli`, `CodingAgentCliEntry`, `KnownCli`, `McpConfigStrategy`
- `resolveBundledPrompt`
- `RoleRuntimeError`, `RoleRuntimeHttpError`
- `WorkspaceLogger`, `WorkspaceLogLevel` (the generic logger shape used by every role)

#### Scenario: Public surface is reachable through the package's main barrel

- **WHEN** a downstream module writes `import { startCycle, AgentRunner, codingAgentCliRegistry } from "@keni/runtime-common"`
- **THEN** every import resolves without error
- **AND** no internal path (`@keni/runtime-common/src/...`) needs to be referenced

#### Scenario: The package's main barrel does not re-export engineer- or workspace-specific symbols

- **WHEN** the source of `packages/runtime-common/src/main.ts` is scanned for the symbol names `createEngineerRunner`, `WorkspaceProvisioner`, `GitWorkspaceProvisioner`, `WorkspaceProvisioningError`, `ENGINEER_PROMPT_BODY`, `ENGINEER_PROMPT_NAME`, `EngineerActivityHttpClient`, `buildEngineerMcpServerConfig`
- **THEN** none appear in any export statement
- **AND** the workspace `deno check` succeeds with the engineer/workspace symbols sourced exclusively from `@keni/runtime-engineer` and `@keni/runtime-workspace`

### Requirement: `AgentRunner` is the polymorphic plug-in shape, defined in `@keni/runtime-common`, and consumed by both the scheduler and every role package

The `@keni/runtime-common` package SHALL export, from `packages/runtime-common/src/runner.ts` (re-exported through the main barrel), a TypeScript interface `AgentRunner` whose field set is exactly:

- `readonly role: Role` — the role string from `@keni/shared`.
- `readonly precheck: (ctx: CyclePrepCtx) => Promise<PrecheckResult> | PrecheckResult`.
- `readonly promptResolver: (ctx: CyclePrepCtx) => BundledPrompt`.
- `readonly expectedPromptName?: string`.
- `readonly codingAgentInvoker: CodingAgentInvoker`.
- `readonly envAllowlist?: readonly string[]`.
- `readonly mcpServerConfig: McpServerConfig`.
- `readonly workspacePath?: string` — per-agent workspace cwd; the scheduler forwards this as `RoleCycleParams.workspacePath`.
- `readonly idleThresholdMs?: number`, `readonly terminationGraceMs?: number` — optional overrides of the cycle defaults.

The interface SHALL NOT carry any role-specific field (no `provisioner`, no `activityHttpClient`, no engineer-only or PO-only branches). The `@keni/server` package's scheduler registry SHALL import `AgentRunner` from `@keni/runtime-common`; no copy or structural duplicate of the interface SHALL exist anywhere in the workspace. The legacy `EngineerAgentRunner` interface SHALL be removed and SHALL NOT reappear in any package.

#### Scenario: `AgentRunner` source-of-truth is `@keni/runtime-common`

- **WHEN** the workspace is searched for `interface AgentRunner` and `type AgentRunner =`
- **THEN** exactly one occurrence is found, in `packages/runtime-common/src/runner.ts`
- **AND** every other reference in the codebase is an import from `@keni/runtime-common`

#### Scenario: `EngineerAgentRunner` is gone

- **WHEN** the workspace is searched for the symbol name `EngineerAgentRunner`
- **THEN** zero occurrences are found in any production source file or test file

### Requirement: `WireFn` and `WireInput` are the per-role plug-in protocol every role package implements; the orchestration server's `runServer` accepts a `Record<Role, WireFn>` and dispatches polymorphically

The `@keni/runtime-common` package SHALL export, from `packages/runtime-common/src/wire.ts` (re-exported through the main barrel), the following types:

```ts
export interface WireInput {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRepoPath: string;
  readonly serverUrl: string;
  readonly agentConfig: AgentConfig;
  readonly resolvedConfig: ResolvedConfig;
  readonly mcpEntryPath: string;
  readonly logger: WorkspaceLogger;
  readonly makeActivityHttpClient: (
    serverUrl: string,
    agentId: string,
  ) => ActivityHttpClient;
  readonly codingAgentCliRegistry: Readonly<Record<string, CodingAgentCliEntry>>;
  readonly workspaceProvisioner: WorkspaceProvisioner;
}

export type WireFn = (input: WireInput) => Promise<AgentRunner | null>;
export type RoleWires = Readonly<Record<string, WireFn>>;
```

`AgentConfig` and `ResolvedConfig` are imported from `@keni/shared`; `WorkspaceProvisioner` is imported from `@keni/runtime-workspace`; `ActivityHttpClient` is the role-agnostic activity-HTTP-client interface (a generalised form of today's engineer-only `EngineerActivityHttpClient`).

A `null` return from a wire SHALL be honoured by the server as "skip this agent — no runner registered". A throw from a wire SHALL surface as a `runServer` boot failure (the scheduler does not start; the process exits non-zero).

#### Scenario: `WireFn` is the canonical per-role plug-in shape

- **WHEN** a downstream consumer imports `WireFn` and `WireInput` from `@keni/runtime-common`
- **THEN** every role package's `wire(input)` export's signature is structurally compatible with `WireFn`
- **AND** the orchestration server's `runServer(deps, opts)` accepts a `roleWires: RoleWires` field on `RunServerDeps`

### Requirement: `ActivityHttpClient` is the role-agnostic activity-HTTP-client interface every role's wire receives via `WireInput`

The `@keni/runtime-common` package SHALL export, from `packages/runtime-common/src/activityHttpClient.ts` (re-exported through the main barrel), an interface `ActivityHttpClient` whose method surface is exactly the union of every role's HTTP needs at precheck time. For the engineer, today's surface is `listTickets(filter): Promise<readonly TicketSummary[]>`. The interface SHALL be open for extension (additional methods MAY be added by future roles) but SHALL NOT carry any role-specific field name.

`@keni/runtime-engineer` SHALL re-use `ActivityHttpClient` directly via type-narrowing where its precheck only needs a subset of the methods. The legacy `EngineerActivityHttpClient` interface SHALL be removed.

#### Scenario: `ActivityHttpClient` is reachable from every role package

- **WHEN** the source files of `packages/runtime-engineer/` and `packages/runtime-po/` are scanned for type imports
- **THEN** the `ActivityHttpClient` type is imported from `@keni/runtime-common` (not from a role-specific module)
- **AND** the legacy `EngineerActivityHttpClient` type is gone

### Requirement: Cycle behaviour and CLI-registry behaviour previously captured in the `role-runtime` capability apply unchanged when the relevant exports come from `@keni/runtime-common`

Every behavioural guarantee captured in the archived `role-runtime` capability spec — the seven-step cycle, the activity-log adapter's `POST /activity` semantics, the precheck-skip short-circuit, the idle-threshold rule, the SIGTERM/SIGKILL graceful-termination utility, the env-allowlist enforcement, the `CodingAgentInvoker` factory's `mcpConfigStrategy` materialisation, the `RoleCycleResult` discriminated union, and the package's no-`.keni/`-direct-write invariant — SHALL hold verbatim for `@keni/runtime-common`. The capability is renamed from `role-runtime` to `runtime-common`; the requirement text and scenarios are preserved with the package name and source paths updated to `@keni/runtime-common` and `packages/runtime-common/src/...` respectively.

The package's source SHALL contain zero conditional logic keyed on a literal role string (no `=== "engineer"`, `=== "qa"`, `=== "po"`, `=== "writer"` comparisons). The package SHALL NOT import from `@keni/server`, `@keni/cli`, `@keni/runtime-workspace`, `@keni/runtime-engineer`, or `@keni/runtime-po`.

#### Scenario: Cycle source contains no role-keyed conditional logic

- **WHEN** the production source files under `packages/runtime-common/src/` are scanned for `=== "engineer"`, `=== "qa"`, `=== "po"`, `=== "writer"`, `=== "user"`
- **THEN** zero occurrences are found

#### Scenario: Package depends only on `@keni/shared` plus Deno built-ins and `@std/*`

- **WHEN** the production source files under `packages/runtime-common/src/` are scanned for `from "@keni/`
- **THEN** the only `@keni/*` import-specifier prefix is `@keni/shared`
- **AND** no source file imports from `@keni/server`, `@keni/cli`, `@keni/runtime-workspace`, `@keni/runtime-engineer`, or `@keni/runtime-po`

### Requirement: `@keni/runtime-common` introduces no new entries to the workspace `deno.json` `imports` map

The change SHALL NOT add any third-party dependency to the workspace `deno.json`'s `imports` map. Every primitive used by `@keni/runtime-common` SHALL be either: (a) a Deno built-in (`Deno.Command`, `fetch`, `crypto.randomUUID`, `TextDecoderStream`); (b) an existing `@std/*` module already present (`@std/uuid`, `@std/path`, `@std/toml`, `@std/fs`); or (c) `@keni/shared` wire types.

#### Scenario: `deno.json` `imports` is unchanged by the introduction of `@keni/runtime-common`

- **WHEN** the diff of the workspace `deno.json` between pre- and post-change states is inspected for the `imports` field
- **THEN** the `imports` map's entries are identical (only the `workspace` array gained the new package members)

### Requirement: `@keni/runtime-common/test-fakes` exposes the cycle-shaped fakes other packages depend on

The package SHALL declare `"./test-fakes": "./tests/fakes/mod.ts"` in its `deno.json` `exports`. The fakes barrel SHALL re-export at minimum:

- `createFakeCodingAgentInvoker` and the supporting fixtures.
- `placeholderPrompt` (the neutral prompt used by the scheduler integration test in `@keni/server`).

`@keni/runtime-common`'s production barrel (`./src/main.ts`) SHALL NOT re-export anything from `tests/fakes/`.

#### Scenario: Cross-package consumers reach test fakes through the secondary entry

- **WHEN** a test file in another workspace package writes `import { createFakeCodingAgentInvoker, placeholderPrompt } from "@keni/runtime-common/test-fakes"`
- **THEN** the imports resolve and the symbols are callable / usable verbatim
- **AND** `import { createFakeCodingAgentInvoker } from "@keni/runtime-common"` (the production specifier) fails to resolve the symbol
