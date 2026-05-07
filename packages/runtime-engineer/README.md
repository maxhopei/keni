# `@keni/runtime-engineer`

Engineer specialisation of Keni's role-runtime cycle: the bundled engineer prompt, the runner
factory, the engineer MCP-config builder, the engineer sparse-checkout pattern, and the polymorphic
`wire` plug-in entry point the CLI hands to `runServer` under the `engineer` role key.

## Public surface

Re-exported from `src/main.ts`:

- **Bundled prompt.** `ENGINEER_PROMPT_NAME = "engineer"` and `ENGINEER_PROMPT_BODY` (a TS string
  constant — prompts are code, not files; per `spec.md` §11#3).
- **Runner factory.** `createEngineerRunner(deps, opts): AgentRunner` with `EngineerRunnerDeps` and
  `EngineerRunnerOpts` types. The factory is pure (no I/O at construction); the precheck pulls
  `main` first, then queries the orchestration server for in-flight tickets and unassigned pickups;
  the prompt resolver returns the bundled engineer prompt; `mcpServerConfig` is built once from
  `serverUrl`, `agentId`, and `provisioner.workspacePathFor(...)`.
- **MCP-config builder.** `buildEngineerMcpServerConfig(opts)` and
  `BuildEngineerMcpServerConfigOpts` — the
  `deno run -A <mcpEntryPath> --agent <id> --server-url <url> --workspace <ws>` shape the engineer
  subprocess inherits.
- **Precheck helpers.** `orderEngineerTickets(tickets, agentId)` — the documented in-flight / pickup
  ordering used by the precheck.
- **Sparse pattern.** `ENGINEER_SPARSE_CHECKOUT_PATTERN = ["/*", "!.keni/"]` — the engineer
  workspace's sparse-checkout file contents. Passed verbatim to
  `WorkspaceProvisioner.ensureProvisioned({ ..., sparseCheckoutPattern })` by the wire below.
- **Wire export.** `wire: WireFn` — the polymorphic plug-in entry point. The CLI builds
  `{ engineer: wire, … }` and hands it to `runServer.roleWires`. The wire defensively returns `null`
  for non-engineer agents and for engineer agents whose CLI is missing or unsupported (the scheduler
  then logs `runner.skipped` for that agent and the rest of the roster boots normally). When the
  agent is fully resolvable, the wire calls `provisioner.ensureProvisioned(...)` with the engineer
  pattern, then returns the `AgentRunner` from `createEngineerRunner`.

## Dependency edges

`@keni/runtime-engineer` imports from exactly three `@keni/*` packages:

- `@keni/runtime-common` — cycle types, CLI registry, `WireInput`, `AgentRunner`,
  `ActivityHttpClient`.
- `@keni/runtime-workspace` — `WorkspaceProvisioner` interface (the wire calls `ensureProvisioned`).
- `@keni/shared` — `AgentConfig`, `AgentId`, `ResolvedConfig`, `Role`, `TicketFilter`,
  `TicketSummary`.

It does NOT import from `@keni/server` or `@keni/cli`. The orchestration server reaches the engineer
runner exclusively through the `wire` export above.

## Authoritative spec

The detailed contract lives in `openspec/specs/runtime-engineer/spec.md`.
