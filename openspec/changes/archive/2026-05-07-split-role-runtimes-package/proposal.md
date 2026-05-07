## Why

The single `@keni/role-runtimes` package today bundles role-agnostic cycle infrastructure (the
seven-step cycle, the coding-agent CLI registry, the activity-log adapter) with engineer-specific
code (the engineer prompt, the workspace provisioner, `createEngineerRunner`). Two design smells
follow:

1. **Server-side role coupling.** `@keni/server`'s `runServer.ts` filters the agent roster on
   `role === "engineer"` and calls `createEngineerRunner(...)` directly; `routes/prs.ts` imports
   `WorkspaceProvisioner` from `@keni/role-runtimes`. Adding QA, PO, or Writer therefore requires
   editing the orchestration server and its capability spec — the opposite of the plug-in model
   `spec.md` §1–§3 promises.
2. **Structural duplication of `AgentRunner`.** The scheduler's `AgentRunner` interface lives in
   `@keni/server`. The engineer side cannot import it (would form a `server → role-runtimes →
   server` cycle), so it redeclares the identical shape as `EngineerAgentRunner`. The duplication
   is a symptom: `AgentRunner` is a role-runtime concept that lives in the wrong package.

This change makes the orchestration server **role-agnostic**: it gains zero compile-time knowledge
of any specific role, accepts a `Record<Role, WireFn>` at construction, and dispatches per-agent
wiring polymorphically. Adding a new role becomes "add a new `@keni/runtime-<role>` package and
register its `wire` function in the CLI" — no edits to the server, no edits to the orchestration-
server spec.

## What Changes

- **NEW** `@keni/runtime-common` package — the role-agnostic seven-step cycle, cycle types
 (`RoleCycleParams`, `BundledPrompt`, `CyclePrepCtx`, `PrecheckResult`, `McpServerConfig`,
 `CodingAgentInvoker` and friends), the coding-agent CLI registry, the activity-log adapter, the
 prompt resolver, and the hoisted **`AgentRunner` interface** (moved from `@keni/server`).
- **NEW** `@keni/runtime-workspace` package — the workspace abstraction lifted out of engineer
 specifics: `WorkspaceProvisioner` interface, `WorkspaceProvisioningError`,
 `GitWorkspaceProvisioner` default implementation, and the `WorkspaceLogger` shape. The interface
 stays generic (the sparse-checkout pattern is now a per-call argument, not hard-coded to
 `!.keni/`); each role chooses its own pattern.
- **NEW** `@keni/runtime-engineer` package — the engineer prompt constants, `EngineerActivityHttpClient`,
 `createEngineerRunner`, `buildEngineerMcpServerConfig`, and the engineer's `wire(input)` function
 the CLI hands to the server. Returns `AgentRunner` directly; `EngineerAgentRunner` is deleted.
- **NEW** `@keni/runtime-po` package (stub) — proves the polymorphic plug-in model end-to-end.
 Exports a PO prompt placeholder constant (small string, marked as stub) and a `wire(input)`
 function that returns an `AgentRunner` whose `precheck` always resolves
 `{ kind: "skip", reason: "po_not_implemented" }`. No MCP server, no workspace, no coding-agent
 invocation — but the runner registers, the scheduler ticks it, and the activity log shows
 `precheck_skipped` per tick. This is the regression-prevention net for the polymorphic model.
- **BREAKING** `@keni/server` becomes role-agnostic. `runServer` no longer imports
 `createEngineerRunner`, `GitWorkspaceProvisioner`, or any engineer-specific symbol; it accepts a
 new `roleWires: Record<Role, WireFn>` dependency, iterates the project roster, and dispatches
 `roleWires[agent.role]?.(wireInput)` per agent. The "filter on `role === 'engineer'`" loop is
 removed. `MakeEngineerRunnerInput` is renamed to a generic `WireInput` and moved to
 `@keni/runtime-common`. `routes/prs.ts` imports `WorkspaceProvisioner` from
 `@keni/runtime-workspace`.
- **BREAKING** `@keni/cli` becomes the role registration root. `runStart` assembles
 `roleWires = { engineer: engineerWire, po: poWire }` from the role packages and hands it to
 `runServer`. The existing `buildProductionEngineerRunnerFactory` is moved into
 `@keni/runtime-engineer` as that package's `wire` export (the CLI no longer owns engineer-shaped
 wiring code).
- **BREAKING** `@keni/role-runtimes` is removed. Its `src/main.ts` re-exports are split across the
 four new packages; downstream import specifiers change accordingly. The
 `@keni/role-runtimes/test-fakes` secondary entry point splits into per-package `test-fakes` exports
 (`@keni/runtime-common/test-fakes` for `FakeCodingAgentInvoker` + placeholder prompt;
 `@keni/runtime-workspace/test-fakes` for `FakeWorkspaceProvisioner`).
- The structural-layout test in `@keni/shared` (`tests/unit/repoLayout_test.ts`) is updated to pin
 the new four-package layout.

## Capabilities

### New Capabilities

- `runtime-common`: The role-agnostic cycle wrapper, types, CLI registry, prompt resolver,
 activity-log adapter, and the hoisted `AgentRunner` / `WireFn` / `WireInput` contracts every role
 package and the orchestration server depends on. Replaces the cycle-shaped half of the archived
 `role-runtime` capability.
- `runtime-workspace`: The role-agnostic workspace-provisioner interface and the
 `GitWorkspaceProvisioner` default implementation. Replaces the workspace half of the archived
 `engineer-runtime` capability.
- `runtime-engineer`: The engineer specialisation — prompt, `EngineerActivityHttpClient`,
 `createEngineerRunner`, `buildEngineerMcpServerConfig`, and the engineer `wire(input)` export
 consumed by the CLI. Replaces the engineer-specialisation half of the archived `engineer-runtime`
 capability.
- `runtime-po-stub`: The PO placeholder package. Pins that the polymorphic plug-in model registers
 a second role end-to-end; no behavioural promises beyond "registers, ticks, always skips".

### Modified Capabilities

- `role-runtime`: Renamed in spirit to `runtime-common`; the existing requirements move to the
 new spec, the legacy `@keni/role-runtimes` package name is replaced with `@keni/runtime-common`,
 and the `AgentRunner` interface is added (hoisted from `scheduler`). The legacy spec is removed
 (delta records the removal).
- `engineer-runtime`: Split between `runtime-engineer` (the runner factory, prompt wiring, MCP
 config builder) and `runtime-workspace` (the provisioner interface, the git default). The legacy
 spec is removed (delta records the split).
- `engineer-prompt`: Re-anchored to `@keni/runtime-engineer` (the prompt constants move
 packages); requirement text updated, scenarios re-pinned.
- `mcp-engineer-surface`: Re-anchored — the MCP server config builder moves to
 `@keni/runtime-engineer`; the `WorkspaceProvisioner` import in `routes/prs.ts` resolves through
 `@keni/runtime-workspace`.
- `orchestration-server`: The "filter engineers, instantiate `GitWorkspaceProvisioner`, call
 `createEngineerRunner`, registerRunner" paragraph is replaced with a polymorphic dispatch
 paragraph: `runServer` accepts `roleWires: Record<Role, WireFn>`, iterates the roster, calls
 `roleWires[agent.role]?.(input)`, and registers the returned `AgentRunner` (or logs
 `runner.skipped` when the wire returns `null` or no wire exists for the role). `routes/prs.ts`
 depends on `@keni/runtime-workspace`, not on engineer code.
- `cli-start`: `runStart` becomes the role-registration root: it imports `wire` from
 `@keni/runtime-engineer` and `@keni/runtime-po`, assembles `roleWires`, and passes it through
 `RunServerDeps`. The current `buildProductionEngineerRunnerFactory` requirement is replaced with
 a "the CLI assembles `roleWires` from the role packages" requirement.
- `scheduler`: The `AgentRunner` interface moves out of `@keni/server` into `@keni/runtime-common`;
 the scheduler's registry imports the type from there. Behaviour unchanged.
- `developer-setup`: The structural layout test pins four new packages
 (`runtime-common`, `runtime-workspace`, `runtime-engineer`, `runtime-po`) and the absence of the
 old `role-runtimes` directory.

## Impact

- **Workspace `deno.json`** gains four `packages/runtime-*` members and drops `packages/role-runtimes`.
- **Public package surface** — every `import { … } from "@keni/role-runtimes"` is rewritten to
 import from one of the four new packages. The blast radius is concentrated in `@keni/server`,
 `@keni/cli`, and the test files cited in the proposal's investigation. No SPA code is affected
 (`@keni/spa` does not import from role-runtimes).
- **`@keni/server` becomes smaller.** The `AgentRunner` interface, the `MakeEngineerRunnerInput`
 type, and the `wireEngineers` loop in `runServer.ts` all leave the package. The scheduler keeps
 its registry; only the type imports change.
- **No new third-party dependencies.** Every primitive used by the new packages is already in
 `deno.json` (`@std/path`, `@std/fs`, `Deno.Command`, etc.). `@keni/shared` and
 `@modelcontextprotocol/sdk` usage is unchanged.
- **Capability-spec churn** is the largest single cost: eight specs are touched (four new, four
 modified). The structural-layout test in `@keni/shared` is updated in the same change to keep
 `deno task test` green.
- **CI implications.** `deno task fmt`, `lint`, `check`, and `test` must all stay green per
 `AGENTS.md`. The frozen lockfile is regenerated once after the workspace `deno.json` is amended.
- **Migration.** Single change, applied atomically — no transitional dual-package phase. Every
 import specifier across the workspace flips in one commit so `deno check` never sees a
 half-migrated tree.
- **PO stub deliberately ships in the same change.** Without it, the polymorphic model is
 unverified at runtime; the structural test alone cannot prove "two roles register and tick".
