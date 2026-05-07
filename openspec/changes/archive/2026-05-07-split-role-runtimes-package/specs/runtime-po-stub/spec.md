## ADDED Requirements

### Requirement: `@keni/runtime-po` is a workspace stub package that proves the polymorphic role plug-in model registers and ticks a second role end-to-end

The workspace `deno.json` SHALL list `./packages/runtime-po` as a workspace member. The package's `deno.json` SHALL declare `"name": "@keni/runtime-po"`, `"version": "0.0.0"`, and `"exports": { ".": "./src/main.ts" }`. The package's `src/main.ts` SHALL re-export:

- `PO_PROMPT_NAME = "po"` and `PO_PROMPT_BODY` (a TS string constant whose body length is at least 500 characters; the body's first non-empty line SHALL contain the literal substring `STUB IMPLEMENTATION` so an operator reading the prompt understands the role is a placeholder).
- `wire` — a `WireFn` (signature from `@keni/runtime-common`) that the CLI registers under `Role: "po"`.

The package SHALL NOT register an MCP tool, SHALL NOT touch any workspace, and SHALL NOT implement a real precheck. Its purpose is structural: prove the polymorphic dispatch works for two roles.

#### Scenario: Public surface is reachable through the package's main barrel

- **WHEN** a downstream module writes `import { wire, PO_PROMPT_NAME, PO_PROMPT_BODY } from "@keni/runtime-po"`
- **THEN** every import resolves without error
- **AND** `PO_PROMPT_NAME === "po"`
- **AND** `PO_PROMPT_BODY.length >= 500`
- **AND** `PO_PROMPT_BODY` contains the substring `"STUB IMPLEMENTATION"`

### Requirement: The PO `wire(input)` returns an `AgentRunner` whose `precheck` always resolves `{ kind: "skip", reason: "po_not_implemented" }`

The PO `wire(input: WireInput) => Promise<AgentRunner | null>` function SHALL build an `AgentRunner` whose:

- `role === "po"`.
- `precheck(ctx)` resolves synchronously with `{ kind: "skip", reason: "po_not_implemented" }` regardless of `ctx`.
- `promptResolver(ctx)` returns `{ name: PO_PROMPT_NAME, body: PO_PROMPT_BODY }`.
- `expectedPromptName === "po"`.
- `codingAgentInvoker` is the standard `createSubprocessCodingAgentInvoker` (built from any registry entry compatible with the agent's `coding_agent_cli`, defaulting to a no-op invoker bound to `/usr/bin/true`-equivalent if no CLI is resolvable). The invoker is never invoked because the precheck always skips.
- `mcpServerConfig` is a placeholder `{ command: "deno", args: ["run", "-A", input.mcpEntryPath, "--agent", input.agentConfig.id, "--server-url", input.serverUrl, "--workspace", "/dev/null"] }`. The field exists only because `AgentRunner.mcpServerConfig` is non-optional; the MCP server is never spawned.
- `workspacePath` is undefined (the PO does not have a workspace).

The wire SHALL return `null` only when `input.agentConfig.role !== "po"` (a defensive check; the orchestration server's dispatch is keyed on role and would not call this wire for a non-PO agent, but the guard is documented).

#### Scenario: PO runner's precheck always skips

- **WHEN** the scheduler ticks the PO runner once
- **THEN** the runner's `precheck` resolves with `{ kind: "skip", reason: "po_not_implemented" }`
- **AND** the cycle returns `{ outcome: "precheck_skipped", reason: "po_not_implemented" }`
- **AND** no `POST /activity` request is issued for this tick (the precheck-skip short-circuit applies)
- **AND** no MCP server process is spawned

### Requirement: An end-to-end integration test boots `runServer` against a fixture project with one engineer and one PO agent and asserts both runners register and tick

`packages/runtime-po/tests/integration/po-stub_test.ts` SHALL:

- Provision a temp `~/.keni`-rooted project via the `keni init` helper. The project's `agents` SHALL be exactly two: `{ id: "alice", role: "engineer", cli: "claude" }` and `{ id: "petra", role: "po" }`. The project's `schedules` SHALL be `{ engineer: "100ms", po: "100ms" }`.
- Construct `runServer` with `roleWires: { engineer: <fakeEngineerWire that returns a no-op runner>, po: poWire }` (the real engineer wire is replaced with a fake to avoid a CLI binary dependency in this test).
- Boot the server (`startServer({ port: 0 })`); advance `FakeTime` by 100 ms to fire one tick per agent.
- Assert: (a) the scheduler's `roles()` returned `["engineer", "po"]` (in insertion order); (b) the engineer agent's tick spawned the fake invoker (recorded a single call); (c) the PO agent's tick recorded a `precheck_skipped` outcome with `reason: "po_not_implemented"`; (d) the activity log on disk gained zero PO-side entries (precheck-skip short-circuit emits nothing); (e) the engineer agent's runtime state observed `idle` after its tick.
- Tear down deterministically: server `abort()`, temp dir removal.

#### Scenario: Both engineer and PO runners register and tick

- **WHEN** the integration test fires one tick per agent
- **THEN** the engineer runner's precheck is called exactly once and the PO runner's precheck is called exactly once
- **AND** the PO runner's precheck resolves with `{ kind: "skip", reason: "po_not_implemented" }`
- **AND** the activity log contains zero entries for `agent: "petra"` after the tick

#### Scenario: The orchestration server never imports the PO package

- **WHEN** the source files under `packages/server/src/` are scanned for `from "@keni/runtime-po"`
- **THEN** zero occurrences are found
- **AND** the polymorphic dispatch (`runServer`'s `roleWires` invocation) is the only seam through which the PO runner reaches the scheduler

### Requirement: `@keni/runtime-po`'s production source depends on `@keni/runtime-common` and `@keni/shared` only

The package SHALL NOT import from `@keni/server`, `@keni/cli`, `@keni/runtime-engineer`, or `@keni/runtime-workspace`. Its `@keni/*` dependency edges SHALL be exactly `@keni/runtime-common` and `@keni/shared`.

#### Scenario: Source dependency edges are the documented two

- **WHEN** the production source files under `packages/runtime-po/src/` are scanned for `from "@keni/`
- **THEN** the only matched specifier prefixes are `@keni/runtime-common` and `@keni/shared`
