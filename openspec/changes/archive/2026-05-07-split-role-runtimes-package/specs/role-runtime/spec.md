## REMOVED Requirements

### Requirement: `@keni/role-runtimes` exposes a `startCycle(params)` function that runs one role cycle end-to-end

**Reason**: The `role-runtime` capability is renamed to `runtime-common` as part of the package split. The behaviour and surface are preserved verbatim; only the package name and source paths change.
**Migration**: See the new `runtime-common` capability spec. Replace every `from "@keni/role-runtimes"` import specifier in production and test code with `from "@keni/runtime-common"`. The `startCycle` function's signature and behaviour are unchanged.

### Requirement: The cycle algorithm follows `spec.md` §6.2 step-for-step, with precheck as the first step and idle-detection short-circuiting `session_end`

**Reason**: Folded into the `runtime-common` capability per the package rename.
**Migration**: The seven-step cycle is preserved verbatim in `runtime-common`. No code-level migration beyond the import-specifier flip.

### Requirement: The role's `promptResolver` returns a TS-constant `BundledPrompt`; the helper validates name and non-empty body

**Reason**: Folded into the `runtime-common` capability per the package rename. The forbidden-path-literal scope updates from `packages/role-runtimes/src/common/` to `packages/runtime-common/src/`.
**Migration**: `resolveBundledPrompt` is exported from `@keni/runtime-common` with identical signature and behaviour.

### Requirement: The cycle reaches the activity log only through `POST /activity`; no direct `.keni/` read or write

**Reason**: Folded into the `runtime-common` capability. The forbidden-path-literal scope updates to `packages/runtime-common/src/`.
**Migration**: No call-site changes; behaviour is preserved.

### Requirement: Subprocess stdout / stderr is streamed to the activity log per line, with hard size and count caps

**Reason**: Folded into the `runtime-common` capability.
**Migration**: No call-site changes.

### Requirement: The summary line is the last non-empty trimmed stdout line; absence yields `null`

**Reason**: Folded into the `runtime-common` capability.
**Migration**: `extractSummaryLine` is preserved.

### Requirement: The subprocess utility provides graceful termination — SIGTERM, then SIGKILL after a configurable grace period

**Reason**: Folded into the `runtime-common` capability.
**Migration**: The `terminate(child, opts)` utility is preserved.

### Requirement: The subprocess utility's environment-variable forwarding is allowlist-only

**Reason**: Folded into the `runtime-common` capability.
**Migration**: The allowlist behaviour is preserved verbatim.

### Requirement: `CodingAgentInvoker` decouples spawn-mechanics from the cycle; the default factory drives `Deno.Command` with documented opts

**Reason**: Folded into the `runtime-common` capability.
**Migration**: `CodingAgentInvoker` and `createSubprocessCodingAgentInvoker` are exported from `@keni/runtime-common`.

### Requirement: The default subprocess invoker spawns the CLI with `cwd` set to the per-agent workspace

**Reason**: Folded into the `runtime-common` capability.
**Migration**: No call-site changes; `cwd` semantics preserved.

### Requirement: The default invoker materialises the MCP-config per the entry's `mcpConfigStrategy` discriminated union

**Reason**: Folded into the `runtime-common` capability.
**Migration**: The strategy executor's behaviour for `tempfile-json`, `workspace-json`, and `workspace-toml` is preserved.

### Requirement: `resumeSessionId` is plumbed through `RoleCycleParams` → `CodingAgentInvocation` → invoker; default flag `--resume`

**Reason**: Folded into the `runtime-common` capability.
**Migration**: No call-site changes.

### Requirement: `RoleCycleResult` is a discriminated union with five outcomes; every callsite type-narrows by `outcome`

**Reason**: Folded into the `runtime-common` capability.
**Migration**: The five-outcome union is preserved; consumers update import specifiers only.

### Requirement: An end-to-end integration test exercises the cycle against a real orchestration server and a Deno-script "coding agent"

**Reason**: Folded into the `runtime-common` capability. The integration test moves from `packages/role-runtimes/src/common/integration_test.ts` to `packages/runtime-common/tests/integration/integration_test.ts` (per the `tests/` discipline locked in `developer-setup`).
**Migration**: Move the test file accordingly; update import specifiers; the assertions are unchanged.

### Requirement: The package introduces no new runtime dependencies; every primitive is built-in or already in `deno.json`

**Reason**: Folded into the `runtime-common` capability with the same constraint applied to all four new packages (`runtime-common`, `runtime-workspace`, `runtime-engineer`, `runtime-po`).
**Migration**: The change SHALL NOT add any third-party dependency to the workspace `deno.json`'s `imports` map.

### Requirement: The runtime is engineer / QA / PO -agnostic; role specifics live in downstream changes

**Reason**: Folded into the `runtime-common` capability. The role-agnosticism constraint becomes structural via package boundaries: `runtime-common` cannot import from `runtime-engineer` or `runtime-po`.
**Migration**: No call-site changes; the package-boundary enforcement is stricter.

### Requirement: The capability spec documents the in-process / stateless / single-cycle invariants

**Reason**: Folded into the `runtime-common` capability. The repo-root README's "role-runtime subsection" updates to name the new package `@keni/runtime-common`.
**Migration**: Update README references.
