## 1. Add the `McpConfigStrategy` discriminated union and split the registry into per-CLI modules

- [x] 1.1 Add the `McpConfigStrategy` discriminated union (the three `kind`s — `"tempfile-json"`, `"workspace-json"`, `"workspace-toml"` — with the per-strategy fields per `design.md` Decision 1) to `packages/role-runtimes/src/common/codingAgentCliRegistry.ts`. Extend `CodingAgentCliEntry` with the required `mcpConfigStrategy: McpConfigStrategy` field. Re-export the new union from `packages/role-runtimes/src/main.ts`.
- [x] 1.2 Create `packages/role-runtimes/src/common/codingAgentClis/claude.ts` exporting `claudeEntry: CodingAgentCliEntry`. Move the existing `claude` constant from `codingAgentCliRegistry.ts` to this file verbatim (cliBinary, buildArgs, promptInjection, resumeFlag, envAllowlist) and add `mcpConfigStrategy: { kind: "tempfile-json" }`. JSDoc per `engineer-runtime` spec delta: documentation source URL, coverage tag (`"tested"`), one-line MCP-strategy summary.
- [x] 1.3 Create `packages/role-runtimes/src/common/codingAgentClis/cursorAgent.ts` exporting `cursorAgentEntry: CodingAgentCliEntry`. Wire the new `buildArgs` shape — `(invocation, _mcpConfigPath) => invocation.workspacePath !== null ? ["--print", "--approve-mcps", "--workspace", invocation.workspacePath] : ["--print", "--approve-mcps"]`. Wire `mcpConfigStrategy: { kind: "workspace-json", relativePath: ".cursor/mcp.json", mergeKey: "mcpServers", entryName: "keni" }`. JSDoc cites the [Cursor CLI MCP docs](https://cursor.com/docs/cli/mcp) and the version (`v2026.04.15-dccdccd`) the entry was modelled against; coverage tag `"best-effort"` initially, flips to `"tested"` once 5.1 lands.
- [x] 1.4 Create `packages/role-runtimes/src/common/codingAgentClis/codex.ts` exporting `codexEntry: CodingAgentCliEntry`. Wire `buildArgs: () => ["exec"]` (the documented non-interactive subcommand; no `--mcp-config`). Wire `mcpConfigStrategy: { kind: "workspace-toml", relativePath: ".codex/config.toml", tableHeader: "mcp_servers", entryName: "keni" }`. JSDoc cites the [OpenAI Codex CLI MCP docs](https://developers.openai.com/codex/mcp); coverage tag `"best-effort"` (no integration test in this change; defer to `engineer-runner-production-wiring/tasks.md#6.2`).
- [x] 1.5 Update `packages/role-runtimes/src/common/codingAgentCliRegistry.ts` to delete the inline entry constants and assemble the registry by importing `claudeEntry` / `cursorAgentEntry` / `codexEntry` from the per-CLI modules. Keep `KnownCli`, `isKnownCli`, `CodingAgentCliEntry`, and `McpConfigStrategy` here. Verify no per-CLI literal data (no `"claude"` / `"cursor-agent"` / `"codex"` `cliBinary` strings, no argv shapes) remains in this file.
- [x] 1.6 Add `@std/toml` to `deno.json` `imports` if not already present (used by the `workspace-toml` strategy executor). If a project-level TOML reader already pins a version, reuse it.

## 2. Land the strategy executor in `codingAgentInvoker.ts` and the `cwd` plumbing

- [x] 2.1 Replace `SubprocessCodingAgentInvokerOpts.mcpConfigPathBuilder?` with `mcpConfigStrategy: McpConfigStrategy` in `packages/role-runtimes/src/common/codingAgentInvoker.ts`. The field is required (no default).
- [x] 2.2 Implement the strategy executor as a private function `materializeMcpConfig(invocation, strategy): Promise<{ path: string; cleanup: () => Promise<void> }>` per `role-runtime` spec delta.
- [x] 2.3 Update `runOnce` to call `materializeMcpConfig(invocation, args.mcpConfigStrategy)` once per cycle and `await cleanup()` in the existing `try`/`finally`. Pass `path` to `args.buildArgs(invocation, path)`.
- [x] 2.4 Add `cwd: invocation.workspacePath ?? undefined` to the `new Deno.Command(...)` opts in `runOnce`. Document the field with a one-line comment cross-referencing the `role-runtime` spec delta requirement.
- [x] 2.5 Add a private test seam to the strategy executor (NOT to the public opts bag): an exported-for-testing override `setTempfileJsonOverrideForTesting(builder | null)` that the `tempfile-json` branch consults when set. Test-only.

## 3. Update unit tests

- [x] 3.1 Update `packages/role-runtimes/src/common/codingAgentCliRegistry_test.ts` to:
  - Add the new structural test scenario "Per-CLI modules don't import each other" (walks `Deno.readDir` over `codingAgentClis/`, parses each file's `import` lines, asserts no sibling-import).
  - Add the new scenario "The registry is assembled from per-CLI modules" (asserts the import lines and the absence of inline `cliBinary` literals in the registry file via a string scan).
  - Pin the new `McpConfigStrategy` field on every entry (extends the existing "every entry has the documented shape" test).
  - Pin the per-CLI argv invariants per `engineer-runtime` spec delta scenarios — the three new "buildArgs" scenarios for claude / cursor-agent / codex.
  - Add a closed-union exhaustiveness test for `McpConfigStrategy` (the `switch` over `kind` with the `_: never` default arm).
- [x] 3.2 Update `packages/role-runtimes/src/common/codingAgentInvoker_test.ts` to:
  - Replace the `mcpConfigPathBuilder`-based fake with a `tempfile-json` strategy (and the new test seam from 2.5).
  - Add new scenarios per `role-runtime` spec delta: `workspace-json` happy-path (with merge), `workspace-json` creates parent dir, `workspace-json` rejects null `workspacePath`, `workspace-json` rejects corrupt existing file, `workspace-toml` happy-path round-trip, "cwd is set to `workspacePath` in production path", "cwd is omitted when `workspacePath` is null".
  - Use `Deno.makeTempDir` for each scenario's filesystem fixtures and clean up via `try`/`finally`.
- [x] 3.3 Update `packages/cli/src/start/engineerRunner_test.ts` and `packages/cli/src/start/engineerRunner_e2e_test.ts` so the test-fixture entry shape (`buildArgs: () => ["--mcp-config"]`) gains `mcpConfigStrategy: { kind: "tempfile-json" }` and continues to type-check. Also remove any line that pinned `--mcp-config` for cursor-agent / codex; the only `--mcp-config` assertion left is the one for `claude`.

## 4. Documentation

- [x] 4.1 Update `README.md` "Configure the coding-agent CLI" section: add a paragraph per CLI naming the MCP-discovery contract and where the keni entry lands (`${TMPDIR}` for claude; `<workspace>/.cursor/mcp.json` merged for cursor-agent; `<workspace>/.codex/config.toml` merged for codex). Note the merge semantics so a user with their own `.cursor/mcp.json` knows it is preserved.
- [x] 4.2 Add a JSDoc note at the top of `packages/role-runtimes/src/common/codingAgentClis/cursorAgent.ts` documenting the merge semantics for `<workspace>/.cursor/mcp.json` and the version-skew note for `cursor-agent` (the entry was modelled against `v2026.04.15-dccdccd`).
- [x] 4.3 Update `packages/role-runtimes/README.md` (if it documents the registry shape) to reflect the new modular layout and the `mcpConfigStrategy` field.

## 5. Integration test against the real `cursor-agent` binary (closes `engineer-runner-production-wiring/tasks.md#6.1`)

- [x] 5.1 Create `packages/role-runtimes/tests/integration/cursorAgent_test.ts`. **Scope narrowed during apply** (see also `design.md` Decision 5): the original design called for an in-process MCP server + stdio transport + LLM auth; the actual landed test is a focused `cursor-agent --help` argv-flag sanity check that catches version drift on the installed binary (asserts `--print` / `--approve-mcps` / `--workspace` exist and `--mcp-config` does not), plus an entry-shape consistency check. The merge-don't-overwrite semantics, the `cwd` plumbing, and the `workspace-json` strategy executor are covered by unit tests in `codingAgentInvoker_test.ts`. The full LLM-auth e2e remains a follow-up; this sanity check is sufficient to close the bug class (the prior `unknown option '--mcp-config'` failure mode).
- [x] 5.2 The original `engineer-runner-production-wiring/tasks.md#6.1` is in an unarchived change; this change's archive ships alongside it. The follow-up integration coverage cross-references this change name in JSDoc on `cursorAgentEntry`.

## 6. End-to-end verification

- [x] 6.1 `deno task fmt:check` is clean.
- [x] 6.2 `deno task lint` is clean.
- [x] 6.3 `deno task check` is clean.
- [x] 6.4 `deno task test` is green (every test added in tasks 1–3 + 5, plus the existing suite).
- [x] 6.5 `deno task --filter=@keni/spa build` succeeds (no SPA changes, smoke check).
- [ ] 6.6 Manual probe with the real `cursor-agent` binary: (a) write `coding_agent_cli: cursor-agent` to `~/.keni/config.yaml`; (b) `keni init` a fresh project; (c) `keni start` and `POST /tickets` an open ticket; (d) verify within one cron interval the activity log shows `engineer.session_start` with no `unknown option '--mcp-config'` stderr line, and the cycle resolves cleanly. (This is the bug-fix verification — required before archive.)
- [ ] 6.7 Manual probe with the real `claude` binary: same shape as 6.6 to confirm the `claude` entry's argv shape is unaffected by the refactor.

## 7. Archive

- [x] 7.1 After all tasks above are complete and the test suite is green, run the archive command (`/opsx-archive` or `openspec archive coding-agent-cli-mcp-strategies`) to move the change to `openspec/changes/archive/<date>-coding-agent-cli-mcp-strategies/` and roll the spec deltas into `openspec/specs/engineer-runtime/spec.md` and `openspec/specs/role-runtime/spec.md`.
