## MODIFIED Requirements

### Requirement: `@keni/server` exposes a `Scheduler` whose `start()` / `stop()` are owned by `runServer`

The `@keni/server` package SHALL export a `createScheduler(deps, opts)` factory whose return value (the `Scheduler` handle) carries exactly four methods: `start(): void`, `stop(): Promise<void>`, `interrupt(agentId: string): { interrupted: true; sessionId: string } | { interrupted: false; reason: "no_active_cycle" | "unknown_agent" }`, and `registerRunner(runner: AgentRunner): void`. The `AgentRunner` type SHALL be imported from `@keni/runtime-common` (the single source of truth for the role-agnostic plug-in shape); no copy of the interface SHALL exist inside `@keni/server`. `start()` SHALL be idempotent for the no-runners case (calling it twice is allowed; the second call is a no-op with a warn-level "scheduler already started" log line). `stop()` SHALL be idempotent unconditionally; subsequent calls SHALL resolve immediately with no further side effects. `runServer` SHALL instantiate the scheduler exactly once after constructing the bus and the runtime-state store, SHALL pass the project config's `agents` and `schedules` (and optional `timeouts`) into the factory, SHALL call `start()` exactly once before `Deno.serve` accepts connections, and SHALL call `stop()` from the abort handler before resolving the server's exit code. The `Scheduler` SHALL NOT be re-creatable after `stop()` — the contract is single-use per server lifecycle.

#### Scenario: `runServer` instantiates and starts the scheduler exactly once at bootstrap

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a `keni init`-produced temp dir whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]`
- **AND** an instrumented `createScheduler` records each call
- **THEN** `createScheduler` is called exactly once during bootstrap
- **AND** the returned scheduler's `start()` method is called exactly once before the server begins accepting connections

#### Scenario: `runServer`'s abort handler calls `scheduler.stop()` before resolving

- **WHEN** the test fires the server's abort signal during a normal shutdown
- **THEN** `scheduler.stop()` is invoked exactly once
- **AND** the function returns 0 only after `stop()` has resolved
- **AND** the server's resolved promise's resolution does not race ahead of `stop()`

#### Scenario: `start()` is idempotent

- **WHEN** `scheduler.start()` is called twice in succession
- **THEN** both calls return without throwing
- **AND** the captured log shows exactly one warn-level line naming "scheduler already started"
- **AND** at most one per-agent timer is armed for each agent

#### Scenario: `stop()` is idempotent and resolves immediately on the second call

- **WHEN** `scheduler.stop()` is called twice
- **THEN** the first call resolves after every per-agent timer is cleared and every active cycle's abort signal has fired
- **AND** the second call resolves on the next microtask without further side effects

#### Scenario: `AgentRunner` is imported from `@keni/runtime-common`, not redeclared in `@keni/server`

- **WHEN** the workspace is searched for `interface AgentRunner` and `type AgentRunner`
- **THEN** exactly one declaration is found, in `packages/runtime-common/src/`
- **AND** `packages/server/src/scheduler/registry.ts` imports the interface via `import type { AgentRunner } from "@keni/runtime-common"`

### Requirement: `AgentRunnerRegistry` is the role plug-in surface; the scheduler imports zero role-specific code

The scheduler SHALL accept and own an `AgentRunnerRegistry`. The registry SHALL expose `register(runner: AgentRunner): void` (idempotent for the same `runner.role`; a second `register` for the same role replaces the first and emits an info-level "runner.replaced" log line), `get(role: string): AgentRunner | null`, and `roles(): readonly Role[]`. Both `AgentRunner` and `Role` SHALL be imported types: `AgentRunner` from `@keni/runtime-common` and `Role` from `@keni/shared`. The scheduler's source files under `packages/server/src/scheduler/` SHALL contain zero `=== "engineer"`, `=== "qa"`, `=== "po"`, or `=== "writer"` literal comparisons. The scheduler's source files SHALL NOT import from any `@keni/runtime-engineer`, `@keni/runtime-po`, or other role-specific package; the only `@keni/runtime-*` import allowed is `@keni/runtime-common`. Every role-shaped concern (precheck content, prompt resolution, invoker selection, allowlist, MCP config) is supplied by the registered runner. The polymorphic role-wire model (an `@keni/runtime-engineer` wire, an `@keni/runtime-po` wire, future role wires) lands their specifics by `register(...)`-ing a runner; the scheduler's tests use a `fakeAgentRunner` factory that wraps the `createFakeCodingAgentInvoker` exposed via `@keni/runtime-common/test-fakes`.

#### Scenario: Registry replaces a previously-registered runner for the same role

- **WHEN** `register({ role: "engineer", … })` is called twice with different runner instances
- **AND** afterwards `registry.get("engineer")` is called
- **THEN** the second runner is returned
- **AND** the captured log contains exactly one info-level "runner.replaced" line naming `"engineer"`

#### Scenario: Source code under `packages/server/src/scheduler/` contains no role-keyed conditional logic and no role-specific imports

- **WHEN** the production source files under `packages/server/src/scheduler/` (excluding `*_test.ts`) are scanned for `=== "engineer"`, `=== "qa"`, `=== "po"`, `=== "writer"`, `=== "user"`
- **THEN** no occurrence is found
- **AND** scanning the same files for `from "@keni/runtime-engineer"`, `from "@keni/runtime-po"`, or `from "@keni/runtime-workspace"` finds zero occurrences
- **AND** the only `@keni/runtime-*` import-specifier prefix found is `@keni/runtime-common`

#### Scenario: A test wires a fake runner without modifying scheduler source

- **WHEN** an integration test constructs a `fakeAgentRunner({ role: "engineer", precheck, codingAgentInvoker })` and calls `scheduler.registerRunner(runner)`
- **AND** the scheduler is started
- **AND** the fake clock fires a tick
- **THEN** the registered runner's precheck and invoker are called as documented
- **AND** the scheduler source contains no special-case for the test fixture
