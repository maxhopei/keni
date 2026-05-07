## MODIFIED Requirements

### Requirement: Every tool delegates to an existing orchestration-server REST endpoint via a typed HTTP client; no tool reads or writes `.keni/` directly

Every engineer MCP tool SHALL delegate to an existing orchestration-server REST endpoint via a typed HTTP client (`createMcpHttpClient` from `@keni/server`). The HTTP client's role and agent identity SHALL be stamped on every outbound request via the documented `X-Keni-Role` and `X-Keni-Agent` headers (the values are validated at MCP-server startup from the `--agent` and `--server-url` flags and are immutable for the life of the MCP-server process). No engineer MCP tool SHALL read or write any path under `.keni/` or `~/.keni/` directly; the orchestration server is the only authority for persisted artifacts. The engineer's workspace path (used by tools that need to know where the engineer's clone lives, e.g., for context to the LLM) SHALL be resolved via the `WorkspaceProvisioner` interface imported from `@keni/runtime-workspace` (not from `@keni/role-runtimes` or `@keni/runtime-engineer`).

#### Scenario: Every tool's call path issues HTTP, never `.keni/` reads/writes

- **WHEN** any engineer MCP tool's handler runs
- **AND** an instrumented HTTP client and an instrumented filesystem layer record their calls
- **THEN** at least one captured HTTP request fires per tool invocation
- **AND** zero `Deno.readTextFile`, `Deno.writeTextFile`, `Deno.readFile`, or `Deno.writeFile` calls target paths under `.keni/` or `~/.keni/` for any tool's handler

#### Scenario: `WorkspaceProvisioner` is imported from `@keni/runtime-workspace`

- **WHEN** the production source files of `@keni/server`'s MCP-tool handlers are scanned for `WorkspaceProvisioner` imports
- **THEN** every matched import statement uses the specifier `@keni/runtime-workspace`
- **AND** zero matches use the legacy `@keni/role-runtimes` specifier
- **AND** zero matches use `@keni/runtime-engineer`
