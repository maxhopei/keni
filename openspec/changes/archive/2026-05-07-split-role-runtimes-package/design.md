## Context

Today's `@keni/role-runtimes` package collapses three concerns into one:

1. The role-agnostic seven-step cycle (`startCycle.ts`, `types.ts`, `activityClient.ts`,
 `codingAgentInvoker.ts`, `codingAgentCliRegistry.ts`, `promptResolver.ts`).
2. The engineer-specific specialisation (`engineer/runner.ts`, `engineer/prompts/engineer.ts`,
 `engineer/workspace/git.ts`, `engineer/workspace/interface.ts`).
3. The cross-package test fakes (`tests/fakes/common/fakeCodingAgentInvoker.ts`,
 `tests/fakes/engineer/workspace/fakeWorkspaceProvisioner.ts`,
 `tests/fakes/common/placeholderPrompt.ts`).

The orchestration server collapses two concerns into one:

1. Scheduler-shaped registry (`AgentRunner`, `AgentRunnerRegistry`, scheduler ticking).
2. Engineer-specific boot wiring (`runServer.ts`'s `wireEngineers` loop, `routes/prs.ts`'s direct
 `WorkspaceProvisioner` import, the `MakeEngineerRunnerInput` factory protocol).

The collapse forces structural duplication (`EngineerAgentRunner` redeclares `AgentRunner` because
`@keni/role-runtimes` cannot import from `@keni/server`) and bakes the literal string `"engineer"`
into `runServer`'s spec. The plug-in promise in `spec.md` §1–§3 ("Keni simulates an Agile product
team — PO, Engineers, QA, Writer") is undermined by every new role requiring server edits.

Constraints inherited from `AGENTS.md` and the existing capability specs:

- No new third-party dependencies. Every primitive is already in `deno.json` or in `@keni/shared`.
- `deno.json` is the single source of workspace membership; the lockfile is regenerated once.
- Prompts stay code (TypeScript `export const`), never files.
- Tests live under `packages/<pkg>/tests/`; cross-package fakes use `./test-fakes` secondary
 entries.
- `127.0.0.1`-only HTTP, `X-Keni-{Role,Agent}` headers, same-origin `/api/*` mirror — unchanged.

## Goals / Non-Goals

**Goals:**

- `@keni/server` compiles with zero imports referencing `engineer`, `WorkspaceProvisioner`,
 `createEngineerRunner`, `GitWorkspaceProvisioner`, or any other role-specific symbol. The server
 spec language stops mentioning the literal `"engineer"` outside the agent-roster wire schema.
- `AgentRunner` lives in exactly one place — `@keni/runtime-common` — and every role package and
 the scheduler import the same type. `EngineerAgentRunner` is deleted.
- Adding a new role is mechanically: (1) create a `packages/runtime-<role>/` package, (2) export
 a `wire(input)` function from its barrel, (3) add a row in the CLI's `roleWires` map. No other
 file in the repo changes (modulo capability-spec additions for the new role).
- Workspace provisioning is decoupled from the engineer role. The PR-merge route in
 `@keni/server` depends on `@keni/runtime-workspace`'s interface, not on engineer code.
- The PO stub package proves the polymorphic plug-in model end-to-end: two roles register, both
 tick on the scheduler, the PO runner always `precheck_skipped`s, the engineer runner behaves as
 today.

**Non-Goals:**

- Implementing the real PO role (chat mode, ticket-triage prompt, etc.). The stub returns
 `precheck_skipped` always; that's enough to pin the wiring.
- Implementing QA or Writer role packages. The model supports them; the proof point is two roles,
 not four.
- Changing the seven-step cycle's behaviour or the scheduler's tick semantics. Both move type
 imports; neither changes runtime contracts.
- Renaming `Role`, `AgentId`, `TicketStatus`, or any wire-shape type in `@keni/shared`.
- Replacing the closed `KnownCli` registry with an open one. The closed registry stays in
 `runtime-common` unchanged.
- Splitting `@keni/runtime-common` further (e.g., separating cycle from CLI registry). The cycle,
 the CLI registry, and the prompt resolver all share the same dependency footprint and are
 imported together.
- Versioning packages independently. Every new package keeps `version: "0.0.0"` like the existing
 four; the workspace ships atomically.
- Touching the SPA. `@keni/spa` does not import from role-runtimes today and remains untouched.

## Decisions

### Decision 1: Four packages, not three

**Choice:** `@keni/runtime-common`, `@keni/runtime-workspace`, `@keni/runtime-engineer`,
`@keni/runtime-po` — four new packages.

**Alternatives considered:**

- **Three packages** (common + engineer + po; workspace stays inside engineer). Rejected because
 `routes/prs.ts` would have to import from `@keni/runtime-engineer`, which keeps a thin engineer
 dependency on the server. Workspace as its own package severs that.
- **Two packages** (common + engineer; po inside engineer until needed). Rejected because the PO
 stub is the regression guard for the polymorphic model; bundling it inside engineer hides the
 plug-in seam from `deno check`.
- **One package** with strict subdirectory boundaries enforced by lint. Rejected — TypeScript /
 Deno workspace lints cannot prevent a future contributor from adding `import "../engineer/…"`
 inside `common/`. Package boundaries make the constraint compile-time.

**Rationale:** Four packages map 1:1 to four capability specs and make the dependency graph a DAG
that `deno check` enforces. Each package has a single responsibility; `routes/prs.ts` depending on
`@keni/runtime-workspace` is the load-bearing decoupling.

### Decision 2: `AgentRunner` lives in `@keni/runtime-common`

**Choice:** Move the `AgentRunner` interface from `packages/server/src/scheduler/registry.ts` into
`packages/runtime-common/src/runner.ts` (or `types.ts`). The scheduler's registry imports it from
`@keni/runtime-common` and otherwise stays identical. `EngineerAgentRunner` in
`packages/role-runtimes/src/engineer/runner.ts` is deleted; `createEngineerRunner` returns
`AgentRunner` directly.

**Alternatives considered:**

- **Keep `AgentRunner` in server, redeclare in each role package.** Rejected — perpetuates the
 duplication and contradicts the "polymorphic, generic" framing.
- **Define `AgentRunner` in `@keni/shared`.** Rejected — `@keni/shared` is wire-types and storage
 interfaces, deliberately scoped to shapes the server, role runtimes, and SPA all need. The
 cycle types (`CyclePrepCtx`, `BundledPrompt`, `CodingAgentInvoker`, `McpServerConfig`) belong to
 `runtime-common` only; shared has no business knowing about them. Putting `AgentRunner` in
 shared splits its dependency footprint across two packages awkwardly.

**Rationale:** `AgentRunner` is the polymorphic plug-in shape every role implements and the server
consumes. Its dependency footprint is the cycle-types module, which is `runtime-common`'s home.
Placing it there makes both directions natural (`server → runtime-common`,
`runtime-engineer → runtime-common`) without cycles.

### Decision 3: The polymorphic wire shape is `(input: WireInput) => Promise<AgentRunner | null>`

**Choice:** Each role package exports `wire(input)` whose input bag carries the per-agent context
the runner needs to be constructed:

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
  readonly makeActivityHttpClient: (serverUrl: string, agentId: string) => ActivityHttpClient;
  readonly codingAgentCliRegistry: Readonly<Record<string, CodingAgentCliEntry>>;
  readonly workspaceProvisioner: WorkspaceProvisioner;
}

export type WireFn = (input: WireInput) => Promise<AgentRunner | null>;
```

The server iterates the project's roster; for each agent it dispatches
`await roleWires[agent.role]?.(input)`. A `null` return means "skip this agent" (identical to
today's "no CLI configured" path); a missing `roleWires[role]` entry logs `runner.skipped` and
moves on.

**Alternatives considered:**

- **Per-agent wire functions (one wire per `AgentConfig`).** Rejected — the CLI doesn't have
 agent-specific knowledge that role-specific knowledge can't supply. Per-role keeps the registry
 small (4 entries max for engineer/QA/PO/Writer) and centralises role logic.
- **Server discovers wires via the filesystem (auto-loading).** Rejected — `AGENTS.md` requires
 prompts-as-code and storage-as-interface; auto-loading wires off disk would smuggle a fifth
 dynamic-loading mechanism into the system without the same compile-time guarantees.
- **A class hierarchy (`abstract class Role`, subclasses per role).** Rejected — the cycle code
 is FP-shaped (factories returning value bags); a class hierarchy doesn't fit and would break
 the existing test seams.
- **Pass `roleWires` through `runServer` opts as a `Map<Role, WireFn>` instead of
 `Record<Role, WireFn>`.** Rejected — `Record` matches the existing `RunServerDeps` style and is
 trivially serialisable for tests; `Map` adds nothing for a 4-entry table.

**Rationale:** A function value keyed by `Role` is the smallest possible plug-in surface. The
server holds zero role-specific code; the CLI holds the role-package imports; each role package
holds its own wiring logic. The shape mirrors the existing
`buildProductionEngineerRunnerFactory(...)` closure, so the migration is mechanical: extract the
function from CLI, move it to `@keni/runtime-engineer/src/wire.ts`, accept a generic `WireInput`
instead of a engineer-shaped `MakeEngineerRunnerInput`.

### Decision 4: `WorkspaceProvisioner` becomes role-agnostic by parameterising the sparse pattern

**Choice:** The `WorkspaceProvisioner` interface stays near-identical, but `ensureProvisioned` and
the helpers accept the sparse-pattern as an argument rather than hard-coding `["/*", "!.keni/"]`.
`@keni/runtime-engineer` passes the engineer's pattern; future roles pass theirs. The constant
`SPARSE_CHECKOUT_PATTERN` is renamed `ENGINEER_SPARSE_CHECKOUT_PATTERN` and moved to
`@keni/runtime-engineer`.

**Alternatives considered:**

- **Keep `WorkspaceProvisioner` engineer-specific.** Rejected — the user asked for workspace to
 be a separate concern explicitly so QA / Writer / PO can re-use it.
- **Generalise to `Workspace` with arbitrary clone strategies (full clone, shallow, sparse
 etc.).** Rejected as scope creep. Sparse-checkout is good enough for every role we've spec'd;
 broadening the interface today is YAGNI.
- **Move `GitWorkspaceProvisioner` to `runtime-engineer` instead.** Rejected — engineer is one of
 N roles; the `git` adapter is general-purpose.

**Rationale:** The minimum change that decouples workspace from engineer. The interface gains a
single argument; the spec is mostly preserved.

### Decision 5: `routes/prs.ts` keeps `WorkspaceProvisioner` as its merge dependency, sourced from `runtime-workspace`

**Choice:** `packages/server/src/routes/prs.ts` continues to receive a `WorkspaceProvisioner`
instance for `--ff-only` merge into `main`, but imports the type from `@keni/runtime-workspace`,
not from `@keni/role-runtimes`. The provisioner instance is constructed by the CLI and threaded
through `RunServerDeps`. The server gains zero engineer-specific knowledge.

**Alternatives considered:**

- **Inversion to a `mergePr(prId)` callback.** Rejected for now — the merge logic in `prs.ts`
 (sparse pattern, `git fetch`, `git merge --ff-only`, `git push`) is non-trivial and the
 callback abstraction would re-shape the merge contract for unclear gain. The interface
 dependency is surgical: a typed import, no implementation pull-in.
- **Move `prs.ts` merge logic out of `@keni/server` entirely.** Rejected as scope creep; a
 future change can do that if `@keni/runtime-engineer` ends up wanting to own merge.

**Rationale:** The cleanest minimum cut. The server depends only on the *interface* package
(`runtime-workspace`), never on a role-specific package.

### Decision 6: Naming — `@keni/runtime-*`, not `@keni/role-runtime-*`

**Choice:** `@keni/runtime-common`, `@keni/runtime-workspace`, `@keni/runtime-engineer`,
`@keni/runtime-po`. The "role-" prefix is dropped (per the user's chat answer). The old
`@keni/role-runtimes` plural form is retired.

**Rationale:** Shorter import specifiers, consistent with the user's vocabulary. The "role" word
is implicit: every package in the `runtime-*` family is a role-runtime concept.

### Decision 7: Single atomic migration, no transitional dual-package phase

**Choice:** The change ships in one PR. Every `import { … } from "@keni/role-runtimes"` flips to
the new specifier in the same commit. The workspace `deno.json` drops `packages/role-runtimes` and
adds the four `packages/runtime-*` members in the same edit. The lockfile is regenerated once
after the package list changes.

**Alternatives considered:**

- **Phase-1 add new packages, phase-2 redirect imports, phase-3 delete old.** Rejected — there is
 no production-deploy gate (Keni runs locally), so the "no breakage between phases" benefit is
 zero. The atomic flip keeps `deno check` honest at every commit.
- **Keep `@keni/role-runtimes` as a re-export shim for one release.** Rejected — Keni has no
 external consumers; the shim has no audience.

**Rationale:** Atomic flips trade git-history complexity for compile-time safety; with no external
consumers to support, atomic wins.

### Decision 8: PO stub shape

**Choice:** `@keni/runtime-po` exports:

- `PO_PROMPT_NAME = "po"` and `PO_PROMPT_BODY` — the latter a placeholder string at least 500
 characters long, marked `STUB IMPLEMENTATION` in its first line, satisfying the same length
 constraint the engineer prompt is held to so future tightening of the prompt-resolver guard
 does not need a special case.
- `wire(input)` — returns an `AgentRunner` whose `precheck` always resolves
 `{ kind: "skip", reason: "po_not_implemented" }` and whose `codingAgentInvoker` is the standard
 subprocess invoker (never invoked because the precheck always skips). The `mcpServerConfig`
 reuses the engineer's MCP config builder — the PO role hits no MCP tool because it never
 spawns; the field exists only because `AgentRunner.mcpServerConfig` is non-optional.
- `tests/integration/po-stub_test.ts` — boots `runServer` against a fixture `~/.keni` with one
 engineer and one PO agent; advances `FakeTime`; asserts both runners register, both tick, the PO
 runner emits `precheck_skipped` per tick.

**Alternatives considered:**

- **Empty package with no `wire` export, registered as `null` in the CLI.** Rejected — fails to
 prove the dispatch path actually invokes the PO wire. Need a runner that returns from `wire(...)`,
 even if the precheck is a permanent skip.
- **A "real" minimal PO role that picks up tickets and emits chat lines.** Rejected as scope
 creep; the user asked for a stub.

**Rationale:** The stub is large enough to exercise every seam the polymorphic model touches
(wire registration, runner registration, scheduler tick, precheck dispatch, activity log) and
small enough to not commit Keni to a half-baked PO role.

### Decision 9: Test-fakes split per package

**Choice:** Each new package exposes a `./test-fakes` secondary entry point:

- `@keni/runtime-common/test-fakes` — `FakeCodingAgentInvoker`, `placeholderPrompt`
 (the "neutral" prompt the scheduler integration test uses).
- `@keni/runtime-workspace/test-fakes` — `FakeWorkspaceProvisioner`.
- `@keni/runtime-engineer/test-fakes` — engineer-specific fakes if any (today: none — all engineer
 tests reach for the workspace and common fakes via their secondary entries).
- `@keni/runtime-po/test-fakes` — none planned; the integration test is sufficient.

**Rationale:** Mirrors the existing `@keni/role-runtimes/test-fakes` discipline. Cross-package
test code stays in `tests/fakes/`, never in `src/`.

### Decision 10: Spec deltas — ADD four, MODIFY four, REMOVE two

The change rewrites the specs as follows:

- **NEW** `runtime-common/spec.md` — captures the cycle, types, CLI registry, prompt resolver,
 `AgentRunner`, `WireFn`, `WireInput`. Replaces the bulk of legacy `role-runtime/spec.md`.
- **NEW** `runtime-workspace/spec.md` — captures the `WorkspaceProvisioner` interface,
 `WorkspaceProvisioningError`, `GitWorkspaceProvisioner`, the parameterised sparse pattern.
- **NEW** `runtime-engineer/spec.md` — captures `createEngineerRunner`,
 `buildEngineerMcpServerConfig`, `EngineerActivityHttpClient`, the engineer prompt's package
 home, the engineer wire export.
- **NEW** `runtime-po-stub/spec.md` — captures the stub shape and the polymorphic-registration
 integration scenario.
- **MODIFIED** `orchestration-server/spec.md` — the `wireEngineers` paragraph becomes the
 polymorphic-dispatch paragraph; `routes/prs.ts` depends on `runtime-workspace`.
- **MODIFIED** `cli-start/spec.md` — `runStart` assembles `roleWires` from
 `@keni/runtime-engineer` and `@keni/runtime-po`, hands it to `runServer`.
- **MODIFIED** `scheduler/spec.md` — `AgentRunner` source-of-truth is `@keni/runtime-common`.
- **MODIFIED** `developer-setup/spec.md` — the structural-layout test pins the new packages.
- **REMOVED** `role-runtime/spec.md` — folded into `runtime-common`.
- **REMOVED** `engineer-runtime/spec.md` — split between `runtime-engineer` and
 `runtime-workspace`.

The `engineer-prompt` and `mcp-engineer-surface` specs are also touched — the package-name
references update — but their requirements stay intact and are recorded as MODIFIED with full
text per the openspec convention.

## Risks / Trade-offs

- **Risk: blast-radius mistakes.** ~30+ import statements across the workspace flip in one
 commit. → **Mitigation:** the migration runs `deno task check && deno task test` after every
 sub-step in `tasks.md`. Any miss surfaces immediately. The atomic flip is a deliberate trade-off
 for compile-time honesty.
- **Risk: `WorkspaceProvisioner` interface drift between roles.** Today the engineer's pattern
 (`!.keni/`) is hard-coded. Generalising to "pattern as parameter" risks roles drifting toward
 incompatible patterns. → **Mitigation:** the interface enforces "exactly the patterns supplied
 — no implicit augmentation"; a structural test in `runtime-workspace` pins this. Future role
 packages document their pattern in their own spec.
- **Risk: PO stub goes stale.** A long-lived stub may drift from the real polymorphic contract
 if `WireFn` evolves. → **Mitigation:** the integration test covers both engineer and PO end-to-
 end; any `WireFn` change that breaks PO trips CI immediately.
- **Risk: capability-spec churn confuses readers.** Eight specs change in one delta. →
 **Mitigation:** `proposal.md` flags the scope explicitly; `tasks.md` lists each spec edit as a
 separate ticked task; the archive step folds the deltas into `openspec/specs/` cleanly per the
 standard workflow.
- **Trade-off: server still depends on `runtime-workspace`.** A purist version would invert
 `routes/prs.ts` to a callback and remove the dependency entirely. We accept the interface-only
 dependency to keep the change focused. A follow-up change can do the inversion if PR-merge ever
 wants to live in `@keni/runtime-engineer`.
- **Trade-off: four packages multiply boilerplate.** Each new package adds a `deno.json`, a
 `README.md`, a `tests/{unit,integration}/` tree, and a row in the workspace `deno.json`. The
 plug-in benefit pays for the boilerplate; subdirectory boundaries within a single package would
 not.
- **Trade-off: no transitional shim.** Users with their own forks who imported from
 `@keni/role-runtimes` will see a breaking import-specifier change. Acceptable: Keni runs locally,
 has no published consumers.

## Migration Plan

The change applies in a single sequence of commits per `tasks.md`:

1. Scaffold the four new packages (empty `deno.json` + `src/main.ts` + `README.md` + `tests/`
 trees). Update workspace `deno.json` to add the four members but keep the old
 `packages/role-runtimes` member so `deno check` still passes mid-migration.
2. Move source files into the new packages, leaving `re-export shim` files behind in
 `packages/role-runtimes/src/main.ts` so existing imports continue to resolve.
3. Move `AgentRunner` from `@keni/server` into `@keni/runtime-common`; update server's scheduler
 registry imports.
4. Generalise `WorkspaceProvisioner` (sparse pattern as parameter); update engineer call site;
 update `routes/prs.ts` to import from `@keni/runtime-workspace`.
5. Move the engineer's wire function from `packages/cli/src/start/engineerRunner.ts` into
 `packages/runtime-engineer/src/wire.ts`. Convert `MakeEngineerRunnerInput` to the generic
 `WireInput` in `runtime-common`.
6. Add the PO stub package — prompt constants, wire function, integration test.
7. Replace `runServer`'s `wireEngineers` loop with the polymorphic dispatch loop; thread
 `roleWires` through `RunServerDeps`. Update CLI to assemble `roleWires` from the role packages.
8. Flip every `from "@keni/role-runtimes"` specifier in production and test code to its new
 home. Delete the shim files and the `packages/role-runtimes/` directory.
9. Update the structural-layout test in `@keni/shared` to pin the new four-package layout.
10. Run `deno install` (regenerate the lockfile), `deno task fmt`, `lint`, `check`, `test`.

Rollback: revert the merge commit. The change touches no on-disk state, no migrations, no
external services.

## Open Questions

- **Does the engineer's `wire(input)` need access to the resolved CLI registry, or should each
 role package import `codingAgentCliRegistry` directly from `@keni/runtime-common`?** Default
 plan: pass it through `WireInput` so the e2e test seam (extended registry with a fixture entry)
 keeps working. Confirmable post-implementation if cleaner.
- **Should the PO stub's `precheck` reason be `po_not_implemented` or a more neutral
 `stub_runner`?** Default: `po_not_implemented` so an operator reading the activity log
 immediately understands the role is a stub.
- **Does `@keni/runtime-workspace` need its own `Logger` interface, or should it accept the
 `WorkspaceLogger` defined in `runtime-common`?** Default: `runtime-common` owns `WorkspaceLogger`
 (it's a generic logger shape used by every role); `runtime-workspace` imports it. Re-evaluate if
 the dependency edge feels backwards during implementation.
