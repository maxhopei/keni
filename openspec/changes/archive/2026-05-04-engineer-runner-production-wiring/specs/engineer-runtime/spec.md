## ADDED Requirements

### Requirement: `@keni/role-runtimes` exposes a `codingAgentCliRegistry` mapping known CLI names to their subprocess spawn shapes

The `@keni/role-runtimes` package SHALL export, from `packages/role-runtimes/src/common/codingAgentCliRegistry.ts` (re-exported through `packages/role-runtimes/src/main.ts`), a constant `codingAgentCliRegistry` of type `Readonly<Record<KnownCli, CodingAgentCliEntry>>` where `KnownCli` is the closed string-literal union `"claude" | "cursor-agent" | "codex"`. The package SHALL also export the `KnownCli` type alias and a type guard `isKnownCli(value: string): value is KnownCli` so the CLI's resolution code can narrow at the boundary without duplicating the union.

Each `CodingAgentCliEntry` SHALL have shape `{ cliBinary: string; buildArgs: (invocation: CodingAgentInvocation, mcpConfigPath: string) => readonly string[]; promptInjection: "stdin" | "arg"; resumeFlag: string; envAllowlist: readonly string[] }`. The shape SHALL be a strict subset of `SubprocessCodingAgentInvokerOpts` (per the `role-runtime-common` capability) so a caller can spread an entry into `createSubprocessCodingAgentInvoker(opts)` directly. The `envAllowlist` SHALL be the per-CLI minimum set of host env variables the CLI needs to authenticate and run (e.g. `HOME`, `PATH`, `ANTHROPIC_API_KEY` for `"claude"`); the role-runtime cycle's existing `KENI_MCP_*` mandates SHALL be added on top by `buildChildEnv` and SHALL NOT be duplicated in the per-CLI allowlist.

The registry SHALL be a constant value — it SHALL NOT be a function or a class instance, and adding a new entry SHALL require a code change with tests (no plugin loader, no path-resolved import). The registry SHALL be referentially stable across imports (importers SHALL be able to use entries by reference and rely on identity for caching).

#### Scenario: The registry exposes the documented entries with the documented shape

- **WHEN** a caller imports `codingAgentCliRegistry` from `@keni/role-runtimes`
- **THEN** `Object.keys(codingAgentCliRegistry)` is the closed set `["claude", "cursor-agent", "codex"]` (order is irrelevant)
- **AND** every entry has the keys `cliBinary`, `buildArgs`, `promptInjection`, `resumeFlag`, `envAllowlist`
- **AND** `cliBinary` is a non-empty string
- **AND** `buildArgs` is a function with arity 2
- **AND** `promptInjection` is one of `"stdin"` or `"arg"`
- **AND** `resumeFlag` is a non-empty string starting with `--`
- **AND** `envAllowlist` is a `readonly string[]` containing at least `"HOME"` and `"PATH"`

#### Scenario: An entry can be spread into `createSubprocessCodingAgentInvoker` directly

- **WHEN** a caller writes `createSubprocessCodingAgentInvoker(codingAgentCliRegistry["claude"])`
- **THEN** the call type-checks
- **AND** the resulting `CodingAgentInvoker` is structurally indistinguishable from one constructed by spelling out the entry's fields manually

#### Scenario: `isKnownCli` narrows a string at the boundary

- **WHEN** a caller invokes `isKnownCli(name)` with `name: string`
- **THEN** the return type is the type predicate `name is KnownCli`
- **AND** `isKnownCli("claude")`, `isKnownCli("cursor-agent")`, and `isKnownCli("codex")` each return `true`
- **AND** `isKnownCli("claud")` and `isKnownCli("")` each return `false`

#### Scenario: The registry is a constant value, not a function

- **WHEN** a static analyser inspects `codingAgentCliRegistry`'s declaration
- **THEN** the binding is a `const` assignment to an object literal
- **AND** the type signature is exactly `Readonly<Record<KnownCli, CodingAgentCliEntry>>`
- **AND** there is no exported "register a CLI" function in the same module

### Requirement: Each registry entry's `buildArgs` produces a CLI-correct argv that consumes the engineer's prompt and connects the MCP server

For each `KnownCli`, the registry entry's `buildArgs(invocation, mcpConfigPath)` SHALL return an argv array such that, when spawned with `cliBinary` and the engineer's prompt body fed via the entry's `promptInjection` channel, the CLI: (1) accepts the engineer's prompt as input; (2) loads the MCP server from `mcpConfigPath` (the JSON file the role-runtime cycle's invoker writes containing `{ mcpServers: { keni: invocation.mcpServerConfig } }`); (3) runs in a non-interactive mode appropriate for headless invocation; (4) honours `invocation.resumeSessionId` via the entry's `resumeFlag` when the role-runtime cycle prepends it (see the `role-runtime-common` spec).

For the `"claude"` entry, `cliBinary` is `"claude"`, `promptInjection` is `"stdin"`, `resumeFlag` is `"--resume"`, and `buildArgs` SHALL produce an argv that includes `["--mcp-config", mcpConfigPath]` (or the equivalent flag spelling the CLI documents) and a non-interactive flag (e.g. `"--print"` or the documented batch-mode flag). The exact argv is implementation detail covered by unit tests in `codingAgentCliRegistry_test.ts`.

For the `"cursor-agent"` and `"codex"` entries, `buildArgs` SHALL similarly cover non-interactive invocation and MCP-config consumption per each CLI's documented contract. These entries are marked best-effort and the JSDoc on each entry SHALL note the documentation source (a CLI version string or a doc URL) and the caveat that they are not yet covered by an integration test in this change.

#### Scenario: The `claude` entry's `buildArgs` includes the MCP config flag and a non-interactive flag

- **WHEN** `codingAgentCliRegistry["claude"].buildArgs(fakeInvocation, "/tmp/mcp-1234.json")` is called
- **THEN** the resulting argv includes the substring `"/tmp/mcp-1234.json"` exactly once (as the value of the MCP-config flag)
- **AND** the argv contains a non-interactive flag documented by the Claude CLI (e.g. `"--print"`)
- **AND** the argv does NOT contain `--interactive` or any flag that would block on a TTY

#### Scenario: Each entry's `envAllowlist` includes the host basics

- **WHEN** any registry entry is inspected
- **THEN** its `envAllowlist` includes both `"HOME"` and `"PATH"`
- **AND** does NOT include the runtime-mandated `KENI_MCP_AGENT`, `KENI_MCP_SERVER_URL`, or `KENI_MCP_WORKSPACE` (those are added on top by `buildChildEnv` per the `role-runtime-common` spec)
