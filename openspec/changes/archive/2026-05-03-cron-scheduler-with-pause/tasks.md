## 1. Type surface and config plumbing

- [x] 1.1 Add an optional `timeouts?: Readonly<Record<string, string | number>>` field to `ProjectConfig` in `packages/shared/src/storage/config/interface.ts` with a doc comment naming "scheduler reads this; key is agent id or role; value is duration shorthand or ms integer". Update `packages/shared/src/storage/config/file_test.ts` and `contract_test.ts` to round-trip the field through YAML.

- [x] 1.2 Add `Role` re-export from `@keni/shared` if not already present (the scheduler uses it).
- [x] 1.3 Define `AgentRunner` and `AgentRunnerRegistry` interfaces in `packages/server/src/scheduler/registry.ts`. Reference `CyclePrepCtx`, `PrecheckResult`, `BundledPrompt`, `CodingAgentInvoker`, `McpServerConfig` from `@keni/role-runtimes`. Write `registry_test.ts` covering: dedup-by-role, replace-emits-info-log, `roles()` returns registered roles in insertion order, `get(unknown)` returns `null`.

## 2. Schedule and timeout parsing

- [x] 2.1 Implement `parseDurationShorthand(value: string | number): number | null` in `packages/server/src/scheduler/schedule.ts`. Accept `/^(\d+)(ms|s|m|h)$/`, bare positive integers, and `"*/N * * * *"` cron-style. Return `null` on unparseable input.
- [x] 2.2 Implement `resolveCadenceMs({ agentId, role, schedules })` returning the resolved cadence with the documented fallback chain (`schedules[agentId] ?? schedules[role] ?? defaults[role] ?? 60_000`). Emits a one-line warning via the injected `LogSink` for unparseable values.
- [x] 2.3 Implement `resolveTimeoutMs({ agentId, role, timeouts })` mirroring the cadence resolution; defaults: `engineer = 30 * 60 * 1_000`, `qa = 30 * 60 * 1_000`, `po = 5 * 60 * 1_000`.
- [x] 2.4 Write `schedule_test.ts` covering every shorthand, the cron pattern, the bare-int path, the unparseable fallback (with captured warning), the per-agent-wins-over-per-role precedence, and the role-default fallback.

## 3. Activity-log adapter for scheduler-owned events

- [x] 3.1 Implement `appendSessionInterrupted({ sessionId, agentId, role, serverUrl })` and `appendSessionTimeout({ sessionId, agentId, role, serverUrl })` helpers in `packages/server/src/scheduler/activityClient.ts`. Both `POST /activity` with the documented headers (`X-Keni-Role`, `X-Keni-Agent`, `Content-Type`) and the documented body shape; both swallow non-2xx and network failures with a warn-level log line and a `{ posted: false, status }` return value.
- [x] 3.2 Write `activityClient_test.ts` covering: success path stamps headers correctly; 5xx response logs warn and returns `posted: false`; network failure logs warn and returns `posted: false`.

## 4. Clock injection and core tick loop

- [x] 4.1 Define `SchedulerClock = { setTimeout, clearTimeout, now }` in `packages/server/src/scheduler/clock.ts` with a `defaultClock()` factory that binds to globals and a `wrapClock(opts)` helper used by tests.
- [x] 4.2 Implement the `Scheduler` core in `packages/server/src/scheduler/scheduler.ts` with: per-agent `AgentState` (`agentId`, `role`, `cadenceMs`, `timeoutMs`, `tickHandle`, `active`), the work-fn that consults `paused`, calls precheck, invokes `startCycle`, and re-arms `setTimeout` after the cycle resolves (or skip-fast).
- [x] 4.3 Implement `start()` which iterates the agents, resolves cadence + timeout, registers warnings for unknown roles, and arms the first per-agent `setTimeout`. Implement `stop()` per Decision 9 (set `stopped`, clear all timers, abort active cycles, `await Promise.allSettled` with a 30 s hard timeout).
- [x] 4.4 Implement `interrupt(agentId)` per the spec's three return shapes; the implementation calls `abortController.abort("interrupt")` synchronously, then awaits the activity-log adapter, then returns.
- [x] 4.5 Wire the per-cycle timeout: at cycle start, `clock.setTimeout(() => { abort(); appendSessionTimeout(...) }, timeoutMs)`; at cycle resolve (success or failure), `clock.clearTimeout(handle)`.

## 5. Scheduler unit tests with FakeTime

- [x] 5.1 Write `scheduler_test.ts` with `FakeTime` covering: (a) default cadence per role; (b) per-agent override beats per-role override; (c) unparseable fallback warns and uses default; (d) paused agent ticks silently; (e) pause flip during in-flight cycle does not abort; (f) `precheck=skip` short-circuits with no activity entries; (g) `precheck=proceed` invokes `startCycle` with the registered runner's params verbatim; (h) coalesce on second tick when `active !== null`; (i) cross-agent parallelism (alice mid-cycle does not block bob); (j) timeout fires `abort()` and appends `session_timeout` with the cycle's `session_id`; (k) timeout cleared on early resolution; (l) interrupt aborts and appends `session_interrupted` with the cycle's `session_id`; (m) interrupt on idle returns `no_active_cycle`; (n) interrupt on unknown agent returns `unknown_agent`; (o) interrupt does not auto-revert ticket status (no `TicketStore` writes).
- [x] 5.2 Write `runnerSourceScan_test.ts` asserting that `packages/server/src/scheduler/*.ts` (excluding `*_test.ts`) contains zero `=== "engineer"`, `=== "qa"`, `=== "po"`, `=== "writer"`, `=== "user"`; zero `Deno.readTextFile` / `Deno.readFile` / `Deno.writeTextFile` / `Deno.writeFile`; zero path literals starting with `.keni/` or `~/.keni/`; and zero direct `setTimeout(` / `clearTimeout(` / `Date.now(` outside `clock.ts`.

## 6. `runServer` integration

- [x] 6.1 Extend `ServerDeps` in `packages/server/src/createServer.ts` with `scheduler?: Scheduler` so future route handlers (step 12's interrupt endpoint) can read it.
- [x] 6.2 Modify `packages/server/src/runServer.ts` to: (a) read `projectConfig.timeouts` (treating absent as `{}`), (b) call `createScheduler({ runtimeStore, logSink, configStore, clock: defaultClock() }, { agents, schedules, timeouts, serverUrl })` after `startServer` returns the bound URL, (c) call `scheduler.start()`, (d) register `await scheduler.stop()` in the abort handler before `Deno.serve`'s drain.
- [x] 6.3 Update `packages/server/src/runServer_test.ts` to assert: (a) `createScheduler` is called exactly once; (b) `scheduler.start()` is called exactly once; (c) on abort, `scheduler.stop()` is invoked before the function resolves.

## 7. End-to-end integration test

- [x] 7.1 Write `packages/server/src/scheduler/integration_test.ts` that: (a) provisions a temp dir via the existing `keni init` helper with one engineer agent (`alice`) and `schedules: { engineer: "100ms" }`; (b) starts `runServer({ port: 0 })`; (c) registers a fake `AgentRunner` whose `precheck` returns `{ kind: "proceed", roleContext: { summary: "ticket-0001" } }`, whose `promptResolver` returns the placeholder prompt (`@keni/role-runtimes/common/prompts/placeholder.ts`), and whose `codingAgentInvoker` is a `fakeCodingAgentInvoker` emitting three stdout lines; (d) advances `FakeTime` 100 ms to fire one tick and asserts on the on-disk activity-log file.
- [x] 7.2 Add scenarios in the same file: pause-then-resume cycle, interrupt-mid-cycle, timeout-mid-cycle. Each asserts on activity-log entries (`session_start`, `session_end` or `session_interrupted` / `session_timeout`) and on the runtime-state store's `last_activity` and `status` fields.
- [x] 7.3 Cleanup test: any single failed step still calls `scheduler.stop()` and `server.abort()` and removes the temp dir.

## 8. Documentation

- [x] 8.1 Add a "Scheduler" subsection to the root `README.md` covering: in-process / single-server / no-replay invariants; the pause vs. interrupt distinction; the role-default cadence and timeout values; the `schedules` and `timeouts` config keys with examples; the `AgentRunnerRegistry` plug-in surface (one-paragraph pointer for steps 09 and 17).
- [x] 8.2 Add a top-of-file module doc to `packages/server/src/scheduler/scheduler.ts` covering the core invariants and naming the spec file.
- [x] 8.3 Add a one-line entry to `packages/server/README.md` (if it exists) or to the root README's package map listing the scheduler subdirectory.

## 9. Validation pass

- [x] 9.1 Run `deno task lint` and `deno task fmt:check` and fix any violations.
- [x] 9.2 Run `deno task check` and fix any TypeScript errors (especially the `AgentRunner` ↔ `RoleCycleParams` mapping, since both share types from `@keni/role-runtimes`).
- [x] 9.3 Run `deno task test` for the entire workspace and confirm all new tests pass and no existing test regressed.
- [x] 9.4 Verify the spec scenarios listed in `specs/scheduler/spec.md` and `specs/orchestration-server/spec.md` are each backed by at least one test (cross-walk by scenario name as a comment in the test file).
- [x] 9.5 Run `openspec validate cron-scheduler-with-pause --strict` and resolve any warnings.
