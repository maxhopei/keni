## ADDED Requirements

### Requirement: The CLI registry's per-CLI entries live in single-file modules under `codingAgentClis/`; the registry assembly lives in `codingAgentCliRegistry.ts`

The `@keni/role-runtimes` package SHALL physically split the CLI registry: each `KnownCli` entry SHALL be the default export of a single-purpose module under `packages/role-runtimes/src/common/codingAgentClis/`, and the registry constant SHALL be assembled in `packages/role-runtimes/src/common/codingAgentCliRegistry.ts` by importing each per-CLI module and binding it to its `KnownCli` key.

The per-CLI modules SHALL be:

- `codingAgentClis/claude.ts` — exports `claudeEntry: CodingAgentCliEntry`
- `codingAgentClis/cursorAgent.ts` — exports `cursorAgentEntry: CodingAgentCliEntry`
- `codingAgentClis/codex.ts` — exports `codexEntry: CodingAgentCliEntry`

The per-CLI modules SHALL NOT import each other. They MAY import `CodingAgentCliEntry`, `McpConfigStrategy`, and `CodingAgentInvocation` from `codingAgentCliRegistry.ts` (or the shared `types.ts`), and MAY import `@std/path` for path joining at construction time. The per-CLI module SHALL JSDoc the entry with: (a) the CLI binary name and a documentation-source link (URL or version string the entry was modelled against); (b) a `coverage: "tested" | "best-effort"` tag matching the existing convention; (c) a one-line summary of the MCP-config strategy in human language (e.g. `"Reads <workspace>/.cursor/mcp.json; merge our entry under mcpServers.keni"`).

`codingAgentCliRegistry.ts` SHALL keep: the `McpConfigStrategy` discriminated union, the `CodingAgentCliEntry` interface, the `KnownCli` literal union, the `isKnownCli` type guard, and the `codingAgentCliRegistry` constant (now assembled from imports). It SHALL NOT contain any per-CLI literal data (no `cliBinary` strings, no argv shapes, no env-allowlist values for specific CLIs).

#### Scenario: The registry is assembled from per-CLI modules

- **WHEN** a static analyser inspects `packages/role-runtimes/src/common/codingAgentCliRegistry.ts`
- **THEN** the file imports `claudeEntry` from `./codingAgentClis/claude.ts`, `cursorAgentEntry` from `./codingAgentClis/cursorAgent.ts`, and `codexEntry` from `./codingAgentClis/codex.ts`
- **AND** the `codingAgentCliRegistry` constant binds each import to its `KnownCli` key (e.g. `{ "claude": claudeEntry, "cursor-agent": cursorAgentEntry, "codex": codexEntry }`)
- **AND** the file does NOT contain any `cliBinary: "claude" | "cursor-agent" | "codex"` literal (no inline entry construction)

#### Scenario: Per-CLI modules don't import each other

- **WHEN** the imports of any file under `packages/role-runtimes/src/common/codingAgentClis/` (excluding `*_test.ts`) are inspected
- **THEN** no file imports from another sibling file in the same directory
- **AND** every file's exports include exactly one constant assignable to `CodingAgentCliEntry`

### Requirement: Each `CodingAgentCliEntry` carries an `mcpConfigStrategy` field that names the per-CLI MCP-config materialisation contract

The `CodingAgentCliEntry` interface SHALL include a non-optional field `mcpConfigStrategy: McpConfigStrategy` where `McpConfigStrategy` is a closed discriminated union:

```ts
type McpConfigStrategy =
  | { readonly kind: "tempfile-json" }
  | {
      readonly kind: "workspace-json";
      readonly relativePath: string;
      readonly mergeKey: string;
      readonly entryName: string;
    }
  | {
      readonly kind: "workspace-toml";
      readonly relativePath: string;
      readonly tableHeader: string;
      readonly entryName: string;
    };
```

The strategy is a value type — every field is a string literal or a discriminator. The strategy SHALL NOT carry function-typed fields (no closures inside the entry); the runtime executor in `codingAgentInvoker.ts` interprets the `kind` and the strategy-specific fields. Adding a fourth strategy is a deliberate type-level change and SHALL require updating the union, the executor, and at least one structural test scenario.

The `entryName` field across `workspace-json` and `workspace-toml` SHALL be the merge key under which the keni MCP server config is written (e.g. `"keni"`); the executor SHALL use this verbatim — neither uppercasing it, prefixing it, nor namespacing it.

#### Scenario: `McpConfigStrategy` is a closed discriminated union

- **WHEN** a TypeScript exhaustiveness check (`switch (strategy.kind) { case "tempfile-json": ... case "workspace-json": ... case "workspace-toml": ... default: const _: never = strategy.kind; }`) is compiled
- **THEN** the `default` arm's `_: never` assignment type-checks
- **AND** removing any of the three `case` arms produces a compile error

#### Scenario: Every registry entry has a strategy field with a documented `kind`

- **WHEN** any entry of `codingAgentCliRegistry` is inspected
- **THEN** `entry.mcpConfigStrategy` is defined
- **AND** `entry.mcpConfigStrategy.kind` is one of `"tempfile-json"`, `"workspace-json"`, or `"workspace-toml"`
- **AND** when `kind === "workspace-json"`, the entry has `relativePath: string`, `mergeKey: string`, `entryName: string`
- **AND** when `kind === "workspace-toml"`, the entry has `relativePath: string`, `tableHeader: string`, `entryName: string`

## MODIFIED Requirements

### Requirement: `@keni/role-runtimes` exposes a `codingAgentCliRegistry` mapping known CLI names to their subprocess spawn shapes

The `@keni/role-runtimes` package SHALL export, from `packages/role-runtimes/src/common/codingAgentCliRegistry.ts` (re-exported through `packages/role-runtimes/src/main.ts`), a constant `codingAgentCliRegistry` of type `Readonly<Record<KnownCli, CodingAgentCliEntry>>` where `KnownCli` is the closed string-literal union `"claude" | "cursor-agent" | "codex"`. The package SHALL also export the `KnownCli` type alias, the `isKnownCli(value: string): value is KnownCli` type guard, the `CodingAgentCliEntry` interface, and the `McpConfigStrategy` discriminated union.

Each `CodingAgentCliEntry` SHALL have shape `{ cliBinary: string; buildArgs: (invocation: CodingAgentInvocation, mcpConfigPath: string) => readonly string[]; promptInjection: "stdin" | "arg"; resumeFlag: string; envAllowlist: readonly string[]; mcpConfigStrategy: McpConfigStrategy }`. The shape SHALL be a strict subset of the new `SubprocessCodingAgentInvokerOpts` (per the `role-runtime` capability) so a caller can spread an entry into `createSubprocessCodingAgentInvoker(opts)` directly. The `envAllowlist` SHALL be the per-CLI minimum set of host env variables the CLI needs to authenticate and run (e.g. `HOME`, `PATH`, `ANTHROPIC_API_KEY` for `"claude"`); the role-runtime cycle's existing `KENI_MCP_*` mandates SHALL be added on top by `buildChildEnv` and SHALL NOT be duplicated in the per-CLI allowlist.

The registry SHALL be a constant value — it SHALL NOT be a function or a class instance, and adding a new entry SHALL require a code change with tests (no plugin loader, no path-resolved import). The registry SHALL be referentially stable across imports (importers SHALL be able to use entries by reference and rely on identity for caching).

#### Scenario: The registry exposes the documented entries with the documented shape

- **WHEN** a caller imports `codingAgentCliRegistry` from `@keni/role-runtimes`
- **THEN** `Object.keys(codingAgentCliRegistry)` is the closed set `["claude", "cursor-agent", "codex"]` (order is irrelevant)
- **AND** every entry has the keys `cliBinary`, `buildArgs`, `promptInjection`, `resumeFlag`, `envAllowlist`, `mcpConfigStrategy`
- **AND** `cliBinary` is a non-empty string
- **AND** `buildArgs` is a function with arity 2
- **AND** `promptInjection` is one of `"stdin"` or `"arg"`
- **AND** `resumeFlag` is a non-empty string starting with `--`
- **AND** `envAllowlist` is a `readonly string[]` containing at least `"HOME"` and `"PATH"`
- **AND** `mcpConfigStrategy.kind` is one of `"tempfile-json"`, `"workspace-json"`, or `"workspace-toml"`

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

For each `KnownCli`, the registry entry's `buildArgs(invocation, mcpConfigPath)` SHALL return an argv array such that, when spawned with `cliBinary`, the engineer's prompt body fed via the entry's `promptInjection` channel, and the MCP-config materialised per the entry's `mcpConfigStrategy`, the CLI: (1) accepts the engineer's prompt as input; (2) loads the keni MCP server (whether via the `mcpConfigPath` argv slot or via on-disk discovery is a per-CLI implementation detail captured by the strategy); (3) runs in a non-interactive mode appropriate for headless invocation; (4) honours `invocation.resumeSessionId` via the entry's `resumeFlag` when the role-runtime cycle prepends it (see the `role-runtime` spec).

For the `"claude"` entry, `cliBinary` SHALL be `"claude"`, `promptInjection` SHALL be `"stdin"`, `resumeFlag` SHALL be `"--resume"`, `mcpConfigStrategy.kind` SHALL be `"tempfile-json"`, and `buildArgs` SHALL produce an argv that includes `["--mcp-config", mcpConfigPath]` and the documented non-interactive flag `"--print"`. The argv SHALL NOT contain `--interactive` or any flag that would block on a TTY. Coverage SHALL be `"tested"` (verified against the documented `claude --help` and the unit test in `codingAgentCliRegistry_test.ts`).

For the `"cursor-agent"` entry, `cliBinary` SHALL be `"cursor-agent"`, `promptInjection` SHALL be `"stdin"`, `resumeFlag` SHALL be `"--resume"`, `mcpConfigStrategy` SHALL be `{ kind: "workspace-json", relativePath: ".cursor/mcp.json", mergeKey: "mcpServers", entryName: "keni" }`, and `buildArgs` SHALL produce an argv that includes `["--print", "--approve-mcps"]` and `["--workspace", invocation.workspacePath]` when `invocation.workspacePath !== null`. The argv SHALL NOT include `--mcp-config` (the CLI does not accept it, per [Cursor CLI MCP docs](https://cursor.com/docs/cli/mcp) and the installed `cursor-agent v2026.04.15-dccdccd`). Coverage SHALL be `"tested"` once the integration test in this change lands; until then `"best-effort"`.

For the `"codex"` entry, `cliBinary` SHALL be `"codex"`, `promptInjection` SHALL be `"stdin"`, `resumeFlag` SHALL be `"--resume"`, `mcpConfigStrategy` SHALL be `{ kind: "workspace-toml", relativePath: ".codex/config.toml", tableHeader: "mcp_servers", entryName: "keni" }`, and `buildArgs` SHALL produce an argv whose first element is `"exec"` (the documented non-interactive subcommand) and whose remaining elements set the appropriate non-interactive switches per the [OpenAI Codex CLI MCP docs](https://developers.openai.com/codex/mcp). The argv SHALL NOT include `--mcp-config` (the CLI does not accept it; see [openai/codex#9550](https://github.com/openai/codex/issues/9550)). Coverage SHALL remain `"best-effort"` (no integration test in this change; the follow-up `engineer-runner-production-wiring/tasks.md#6.2` tracks the gap).

#### Scenario: The `claude` entry's `buildArgs` uses `--mcp-config` and `--print`, and its strategy is tempfile-json

- **WHEN** `codingAgentCliRegistry["claude"].buildArgs(fakeInvocation, "/tmp/mcp-1234.json")` is called
- **THEN** the resulting argv includes the substring `"/tmp/mcp-1234.json"` exactly once (as the value of `--mcp-config`)
- **AND** the argv contains `"--print"`
- **AND** the argv does NOT contain `--interactive` or `--mcp-debug` or any flag that would block on a TTY
- **AND** `codingAgentCliRegistry["claude"].mcpConfigStrategy.kind === "tempfile-json"`

#### Scenario: The `cursor-agent` entry's `buildArgs` uses `--print --approve-mcps --workspace`, and its strategy is workspace-json under `.cursor/mcp.json`

- **WHEN** `codingAgentCliRegistry["cursor-agent"].buildArgs(invocation, "<ignored>")` is called with `invocation.workspacePath === "/tmp/ws"`
- **THEN** the resulting argv contains `"--print"`, `"--approve-mcps"`, and the consecutive pair `["--workspace", "/tmp/ws"]`
- **AND** the argv does NOT contain `"--mcp-config"`
- **AND** `codingAgentCliRegistry["cursor-agent"].mcpConfigStrategy.kind === "workspace-json"`
- **AND** `codingAgentCliRegistry["cursor-agent"].mcpConfigStrategy.relativePath === ".cursor/mcp.json"`
- **AND** `codingAgentCliRegistry["cursor-agent"].mcpConfigStrategy.mergeKey === "mcpServers"`
- **AND** `codingAgentCliRegistry["cursor-agent"].mcpConfigStrategy.entryName === "keni"`

#### Scenario: The `codex` entry's `buildArgs` uses `exec` (no `--mcp-config`), and its strategy is workspace-toml under `.codex/config.toml`

- **WHEN** `codingAgentCliRegistry["codex"].buildArgs(invocation, "<ignored>")` is called
- **THEN** the resulting argv's first element is `"exec"`
- **AND** the argv does NOT contain `"--mcp-config"`
- **AND** `codingAgentCliRegistry["codex"].mcpConfigStrategy.kind === "workspace-toml"`
- **AND** `codingAgentCliRegistry["codex"].mcpConfigStrategy.relativePath === ".codex/config.toml"`
- **AND** `codingAgentCliRegistry["codex"].mcpConfigStrategy.tableHeader === "mcp_servers"`
- **AND** `codingAgentCliRegistry["codex"].mcpConfigStrategy.entryName === "keni"`

#### Scenario: Each entry's `envAllowlist` includes the host basics

- **WHEN** any registry entry is inspected
- **THEN** its `envAllowlist` includes both `"HOME"` and `"PATH"`
- **AND** does NOT include the runtime-mandated `KENI_MCP_AGENT`, `KENI_MCP_SERVER_URL`, or `KENI_MCP_WORKSPACE` (those are added on top by `buildChildEnv` per the `role-runtime` spec)
