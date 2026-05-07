# `@keni/runtime-po`

Stub PO role implementation. The package exists to prove the polymorphic role plug-in model
registers and ticks a second role end-to-end — i.e. that `@keni/server`'s `runServer` holds zero
role-specific compile-time knowledge and that adding a new role is "add a new package and a `wire`
export".

## Stub status

The bundled `wire(input)` returns an `AgentRunner` whose `precheck` always resolves
`{ kind: "skip", reason: "po_not_implemented" }`. No MCP server is spawned, no workspace is
provisioned, no coding-agent CLI runs. The runner registers, the scheduler ticks it, and the
activity log shows nothing for the PO agent (the precheck-skip short-circuit precedes
`appendSessionStart`).

A real PO implementation lands in a follow-up change.

## Public surface

Re-exported from `src/main.ts`:

- `PO_PROMPT_NAME = "po"` and `PO_PROMPT_BODY` (a placeholder string ≥500 characters whose first
  non-empty line contains the literal substring `STUB IMPLEMENTATION` so an operator reading the
  prompt understands the role is a placeholder).
- `wire: WireFn` — registers the stub runner under `Role: "po"`.

## Dependency edges

`@keni/runtime-po` imports from exactly two `@keni/*` packages: `@keni/runtime-common` (for
`AgentRunner`, `WireFn`, `BundledPrompt`, `CyclePrepCtx`, `createSubprocessCodingAgentInvoker`) and
`@keni/shared` (transitively, via the runtime-common type aliases). It does NOT import from
`@keni/server`, `@keni/cli`, `@keni/runtime-engineer`, or `@keni/runtime-workspace`. The polymorphic
dispatch in `runServer` is the only seam through which the PO runner reaches the scheduler.

## Integration coverage

`tests/integration/po-stub_test.ts` boots `runServer` against a fixture project with one engineer
(covered by an inline fake wire) and one PO (covered by the real `wire` export). The test asserts:

- the registry's `roles()` snapshots `["engineer", "po"]` in roster declaration order;
- the engineer's fake invoker is called at least once;
- the PO's `tick.precheck_skipped` log line carries `reason: "po_not_implemented"`;
- zero activity-log entries land for the PO agent.

## Authoritative spec

The detailed contract lives in `openspec/specs/runtime-po-stub/spec.md`.
