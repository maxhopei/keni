## MODIFIED Requirements

### Requirement: `runServer` instantiates the bus and the agent runtime-state store at bootstrap

`runServer` SHALL call `createInMemoryEventBus()` once after parsing argv and before constructing the server. It SHALL read `projectConfig.agents` (treating an absent field as `[]`) and pass that list to `createInMemoryAgentRuntimeStateStore(roster)`, where each entry is seeded with `paused: false`, `status: "idle"`, `last_activity: null`, `last_active_at: null` and the role read from the project-config row. `runServer` SHALL also call `createScheduler(deps, opts)` exactly once after the bus and runtime-state store exist, passing `projectConfig.agents`, `projectConfig.schedules`, and `projectConfig.timeouts` (each defaulted to its empty value when absent), and the bound server URL (resolved via the `startServer` return value) for the scheduler's activity-log adapter. `runServer` SHALL call `scheduler.start()` exactly once after the HTTP server is bound and accepting connections, and SHALL call `scheduler.stop()` from the abort handler before resolving the server's exit code (so an in-flight cycle's `AbortSignal` fires before the HTTP server's draining `Deno.serve` shuts down). The bus, runtime-state store, and scheduler SHALL all be passed to `createServer` via the extended `ServerDeps`. Direct `deno run -A packages/server/src/main.ts --project=<path>` invocations SHALL produce a working `/agents` endpoint and `/events` upgrade *and* a running scheduler without any additional flags. When `projectConfig.agents` is empty, the scheduler SHALL still be started (a no-op tick loop), so adding the first agent later is purely additive.

#### Scenario: Boot against a project with a roster

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a project whose `project.yaml` declares `agents: [{ id: "alice", role: "engineer" }]`
- **THEN** the bound server's `GET /agents` returns the seeded `alice` row
- **AND** the bound server's `/events` accepts a WS upgrade
- **AND** the scheduler has been started exactly once with alice in its agent list

#### Scenario: Boot against a project with no roster

- **WHEN** `runServer(["--project=<tempDir>", "--port=0"])` is invoked against a project whose `project.yaml` has no `agents` field
- **THEN** the bound server's `GET /agents` returns `{ data: [], project_id: <uuid> }`
- **AND** the scheduler has been started with an empty agent list (no per-agent timers armed)

#### Scenario: Shutdown calls `scheduler.stop()` before resolving

- **WHEN** the test fires the server's abort signal during a normal shutdown
- **THEN** `scheduler.stop()` is invoked exactly once
- **AND** the function returns 0 only after `scheduler.stop()` has resolved
- **AND** the HTTP server's draining `Deno.serve` does not begin its drain until `scheduler.stop()` has resolved (ensuring in-flight cycles' final `POST /activity` calls reach a still-running server)
