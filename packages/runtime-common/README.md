# `@keni/runtime-common`

Role-agnostic primitives for Keni's seven-step role-runtime cycle: types, the cycle wrapper, the
coding-agent CLI registry, the prompt resolver, the activity-log adapter, and the polymorphic
plug-in contracts (`AgentRunner`, `WireFn`, `WireInput`) consumed by `@keni/server` and every
`@keni/runtime-*` role package.

The package is engineer/QA/PO/Writer-agnostic — every role-shaped concern (precheck, prompt,
invoker, env allowlist, MCP-server config, workspace path) is a parameter on the cycle. Each role's
specifics live in the matching `@keni/runtime-<role>` package; the CLI assembles a
`Record<Role, WireFn>` registry and hands it to `runServer`.

## Public surface

Re-exported from `src/main.ts`:

- **Cycle wrapper.** `startCycle(params: RoleCycleParams): Promise<RoleCycleResult>` — the
  deterministic seven-step cycle (`spec.md` §6.2). Pure with respect to its inputs; never reads
  `.keni/` or `Deno.env`; never loops. The scheduler owns retry policy.
- **Types.** `RoleCycleParams`, `RoleCycleResult`, `CodingAgentInvocation`, `CodingAgentInvoker`,
  `CodingAgentLifecycle`, `CodingAgentOutcome`, `CyclePrepCtx`, `PrecheckResult`, `BundledPrompt`,
  `McpServerConfig`, `RoleRuntimeError`, `RoleRuntimeHttpError`.
- **Coding-agent invoker.** `createSubprocessCodingAgentInvoker(opts)` — the production invoker that
  spawns a child process via `Deno.Command`, streams stdout/stderr per line, and applies the
  caller's `mcpConfigStrategy` (tempfile JSON, workspace JSON merge, workspace TOML merge).
- **CLI registry.** `codingAgentCliRegistry`, `isKnownCli(name)`, plus the `CodingAgentCliEntry`,
  `KnownCli`, and `McpConfigStrategy` types. The closed list of supported coding-agent CLIs.
- **Prompt resolver.** `resolveBundledPrompt(prompt, expected)` — defensive cross-check that the
  resolved prompt name matches the runner's `expectedPromptName`.
- **Plug-in protocol.** `AgentRunner`, `WireFn`, `WireInput`, `RoleWires` — the polymorphic role
  plug-in contracts the CLI hands to `runServer.roleWires` and the orchestration server dispatches
  per agent. `ActivityHttpClient` is the role-agnostic HTTP client interface each `wire` builds via
  `WireInput.makeActivityHttpClient`.

## Test fakes (`./test-fakes` entry)

Cross-package consumers import test doubles from `@keni/runtime-common/test-fakes`:

- `createFakeCodingAgentInvoker()` — promise-deferred fake invoker used by the cycle's unit and
  integration tests, and by the scheduler's integration tests.
- `PLACEHOLDER_PROMPT_NAME` / `PLACEHOLDER_PROMPT_BODY` — neutral bundled-prompt constants used to
  drive `startCycle` / a fake `AgentRunner` without depending on a specific role's prompt.

The production barrel (`@keni/runtime-common`) deliberately does NOT re-export anything from
`tests/fakes/` — fakes are test-only seams.

## Package-boundary invariants

These are pinned by structural tests in `@keni/shared`'s `tests/unit/repoLayout_test.ts`:

- **`@keni/runtime-common` does not import from `@keni/server` or any `@keni/runtime-<role>`
  sibling.** The dependency graph is unidirectional: roles depend on common, common depends on
  `@keni/shared` (and `@keni/runtime-workspace`'s logger / provisioner types via `WireInput`).
- **No `role === "engineer"` (or any other role) branches.** Every role-shaped concern is a
  parameter; the dispatch happens in `runServer` via `roleWires[agent.role]`.
- **No `.keni/` reads or writes.** The cycle stamps activity entries via `POST /activity` only,
  through the server's typed adapter. Storage interfaces live in `@keni/shared`.

## Authoritative spec

The detailed contract lives in `openspec/specs/runtime-common/spec.md`.
