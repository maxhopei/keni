## 1. Dependency bootstrap

- [x] 1.1 Add `@std/yaml`, `@std/uuid`, `@std/path`, and `@std/fs` entries to the `imports` map in the root `deno.json`, each pinned at `^1` via `jsr:` specifiers
- [x] 1.2 Run `deno install` at the repo root and verify that `deno.lock` is regenerated to include the new stdlib packages; commit the updated lockfile — lockfile now carries `@std/fs@1.0.23`, `@std/path@1.1.4`, `@std/uuid@1.1.0`, `@std/yaml@1.0.10` plus transitives `@std/bytes`, `@std/crypto`; `deno install --frozen` exits `0`
- [x] 1.3 Run `deno task fmt:check`, `deno task lint`, `deno task check`, and `deno task test` and confirm all exit `0` — the dependency addition has not broken the monorepo baseline — verified: 5 tests passed across all workspace members

## 2. Module scaffolding under `packages/shared/src/storage/`

- [x] 2.1 Create the directory tree: `packages/shared/src/storage/{,tickets/,prs/,activity/,config/}` — directories created; per-subfolder `interface.ts`/`file.ts`/`memory.ts` deferred to §§5 – 8 where each lands with real code (empty stubs would violate `deno lint`'s unused-module rules and add no value)
- [x] 2.2 Author `packages/shared/src/storage/mod.ts` as the barrel re-export surface (initially empty; filled in as each sub-module lands) — doc-comment only, `export {}` to satisfy `deno check`
- [x] 2.3 Re-export `./storage/mod.ts` from `packages/shared/src/main.ts` so bare-specifier imports like `import { TicketStore } from "@keni/shared"` compile as soon as the types exist
- [x] 2.4 Run `deno task check` and confirm the empty scaffolding compiles; run `deno task test` and confirm the existing `main_test.ts` still passes — verified: 5 passed, 0 failed

## 3. Cross-cutting modules (errors, ids, atomic, paths)

- [x] 3.1 Implement `packages/shared/src/storage/errors.ts` with `StoreNotFoundError`, `StaleStateError`, `DuplicateIdError`, and `InvalidArtifactError` classes, each extending `Error`, each setting `this.name` to the class name, each carrying the documented context fields (id, path, expected/actual state, parse error); add JSDoc describing when each is thrown
- [x] 3.2 Add `errors_test.ts` covering: every class is `instanceof Error`, every class's `.name` matches its class name, `instanceof StoreNotFoundError` narrows types, the context fields survive a `JSON.stringify` round-trip (for log serialisation) — 11 tests, all pass
- [x] 3.3 Implement `packages/shared/src/storage/ids.ts` with `generateTicketId`, `generatePrId`, `isTicketId`, `isPrId`, `parseTicketSequence`, `parsePrSequence`, plus `generateActivityId` that wraps `@std/uuid/v7` with a process-local monotonic guarantee (bumps the 48-bit `rand_b` tail when two calls land in the same millisecond, preserving the v7 version + variant structure); full JSDoc
- [x] 3.4 Add `ids_test.ts` covering: empty list → `ticket-0001` / `pr-0001`, skipping gaps → `max + 1`, four-digit pad → five-digit pad at the 10 000th id, invalid strings fail `isTicketId` / `isPrId`, parse round-trip, uuidv7 strict-monotonic over 100 + 10 000 calls, v7 version nibble preserved after tail bump — 17 tests, all pass
- [x] 3.5 Implement `packages/shared/src/storage/atomic.ts` exporting `writeFileAtomic(targetPath, contents, opts?)`: same-directory temp file (`.keni-tmp-*`), write contents, optional fsync, `Deno.rename`, best-effort cleanup on failure, `__setPreRenameHook` test-only injection hook
- [x] 3.6 Add `atomic_test.ts` covering: happy path writes byte-identical content; overwrite keeps atomicity; missing parent dir is created via `Deno.mkdir({ recursive: true })`; `Uint8Array` contents supported; sync + async crash injection preserve the prior version and clean up temp; temp file lives in `dirname(target)` (same-filesystem rename); serial writes are last-writer-wins; `fsync` / `mode` options honoured — 10 tests, all pass
- [x] 3.7 Implement `packages/shared/src/storage/paths.ts` exporting `ProjectPaths`, `GlobalPaths`, `resolveProjectPaths(root)`, `resolveGlobalPaths(home)`, using `@std/path` `join` / `normalize`
- [x] 3.8 Add `paths_test.ts` covering: exact `.keni/` layout for project and global paths, `.` / `..` normalisation, idempotence under double resolution, relative-root pass-through, no environment variable reads — 7 tests, all pass
- [x] 3.9 Run `deno task fmt`, `deno task lint`, `deno task check`, `deno task test` — all green; **50 tests pass** (5 placeholders + 11 errors + 17 ids + 10 atomic + 7 paths)

## 4. Shared contract-test harness

- [x] 4.1 Create `packages/shared/src/storage/tickets/contract_test.ts` exporting `runTicketStoreContract(name, factory)` — 24 behavioural tests covering CRUD happy paths, list filters (status/assignee/priority/changeRequest), missing-id `StoreNotFoundError`, `updateHeader` rejects status, `transitionStatus` stale-state, `linkChangeRequest`, body/header preservation across cross-cutting updates
- [x] 4.2 Created analogous `contract_test.ts` files: `prs/contract_test.ts` (16 tests), `activity/contract_test.ts` (13 tests), `config/contract_test.ts` (11 tests), each exporting `runXStoreContract`
- [x] 4.3 All four contract-test files compile under `deno task check` and run cleanly under `deno task test` (in-memory and file adapters call them in §§5 – 8 test files)

## 5. `TicketStore` — interface + adapters + tests

- [x] 5.1 Implement `packages/shared/src/storage/tickets/interface.ts` with full `TicketId`, `TicketStatus` (12-status union per `spec.md` §4.1), `TicketHeader`, `Ticket`, `TicketSummary`, `TicketFilter`, `TicketCreateInput`, `TicketHeaderPatch`, and `TicketStore` interface; full JSDoc on every type and method
- [x] 5.2 Implement `packages/shared/src/storage/tickets/memory.ts` — `InMemoryTicketStore` backed by a `Map<TicketId, Ticket>`, with deep-cloning on read and on list summaries to prevent caller-side mutation; shares `matchTicket` / `validateHeaderPatch` from `./shared.ts`
- [x] 5.3 Implement `packages/shared/src/storage/tickets/file.ts` — `FileTicketStore` with `list` / `read` / `create` / `updateBody` / `updateHeader` / `transitionStatus` / `linkChangeRequest`; YAML front-matter + markdown body via `@std/yaml`; persists via `writeFileAtomic`; `read` throws `InvalidArtifactError` on every parse-failure mode (malformed YAML, missing front-matter, unterminated front-matter, id mismatch, schema violations); `list` ignores non-ticket files in the directory and gracefully handles a missing directory
- [x] 5.4 Create `packages/shared/src/storage/tickets/memory_test.ts` invoking `runTicketStoreContract` plus three memory-specific tests (mutating returned ticket / list array / list summary does not affect the store)
- [x] 5.5 Create `packages/shared/src/storage/tickets/file_test.ts` invoking `runTicketStoreContract` plus seven file-specific tests (pre-rename crash preserves prior version + cleans temp; corrupt YAML throws `InvalidArtifactError`; directory-at-path throws `InvalidArtifactError`; id mismatch throws `InvalidArtifactError`; on-disk format matches `spec.md` §5.1 layout; list ignores non-ticket files; list returns `[]` when directory absent)
- [x] 5.6 Add `TicketStore`, `Ticket`, `TicketHeader`, `TicketSummary`, `TicketFilter`, `TicketCreateInput`, `TicketHeaderPatch`, `TicketStatus`, `TicketId`, `FileTicketStore`, `InMemoryTicketStore`, all four error classes, all id helpers, and `ProjectPaths`/`GlobalPaths` exports to `packages/shared/src/storage/mod.ts`
- [x] 5.7 Run `deno task check` / `deno task test`; both adapters pass the contract — **109 tests pass** (5 placeholders + 11 errors + 17 ids + 10 atomic + 7 paths + 27 InMemoryTicketStore (24 contract + 3 mem-specific) + 31 FileTicketStore (24 contract + 7 file-specific) + 1 cleanup)

## 6. `PRStore` — interface + adapters + tests

- [x] 6.1 Implement `packages/shared/src/storage/prs/interface.ts` — `PRId`, `PRStatus` (`open | in_review | has_comments | approved | merged`), `PRHeader` (with `ticket: TicketId`, `branch`, `author`, timestamps), `PR`, `PRSummary`, `PRFilter` (status / ticket / author), `PRCreateInput`, `PRStore` (`list`, `read`, `create`, `updateIntent`, `updateStatus`); full JSDoc
- [x] 6.2 Implement `packages/shared/src/storage/prs/memory.ts` — `InMemoryPRStore` with shallow clone on read/list
- [x] 6.3 Implement `packages/shared/src/storage/prs/file.ts` — `FilePRStore` using YAML front-matter + body, `writeFileAtomic`, robust parse-error coverage (missing/unterminated front-matter, malformed YAML, id mismatch, invalid status, missing/wrong-typed fields), graceful empty-list when directory absent
- [x] 6.4 Added `prs/memory_test.ts` (contract + 1 mem-specific clone test) and `prs/file_test.ts` (contract + crash-during-`updateStatus` preserves prior version)
- [x] 6.5 Extended `mod.ts` with `PRStore`, `PR`, `PRHeader`, `PRSummary`, `PRFilter`, `PRCreateInput`, `PRId`, `PRStatus`, `FilePRStore`, `InMemoryPRStore`
- [x] 6.6 `deno task check` / `deno task test` — **144 tests pass** (109 prior + 16 PRStore contract × 2 adapters + 2 adapter-specific + 1 cleanup)

## 7. `ActivityLogStore` — interface + adapters + tests

- [x] 7.1 Implement `packages/shared/src/storage/activity/interface.ts` — `ActivityEntryId` (uuidv7 string), `ActivityEntryInput` (with optional `timestamp` defaulting to now), `ActivityEntry`, `ActivityFilter` (agent / role / from / to), `ActivityLogStore` with `append` and `query` (`AsyncIterable`); full JSDoc on 4 KB limit and atomicity
- [x] 7.2 Implement `packages/shared/src/storage/activity/memory.ts` — `InMemoryActivityLogStore` with sorted array, refs cloning on append + query, lazy iterator semantics matching the file adapter
- [x] 7.3 Implement `packages/shared/src/storage/activity/file.ts` — `FileActivityLogStore` partitioning by UTC date, single-syscall `O_APPEND` write per entry, oversize rejection (no I/O performed before the size check), lazy directory creation via `@std/fs` `ensureDir`, robust JSONL parse-error coverage; `query` filters day-files by `from` / `to` date prefix before reading, streams entries in id order
- [x] 7.4 Added `activity/memory_test.ts` (contract + 1 mem-specific refs-clone) and `activity/file_test.ts` (contract + 5 file-specific tests: day-boundary partitioning, oversize rejection leaves no files, multi-day streaming with date filter, early-break iteration, on-disk JSONL format)
- [x] 7.5 Extended `mod.ts` with `ActivityLogStore`, `ActivityEntry`, `ActivityEntryId`, `ActivityEntryInput`, `ActivityFilter`, `FileActivityLogStore`, `InMemoryActivityLogStore`
- [x] 7.6 `deno task check` / `deno task test` — **175 tests pass** (144 prior + 13 contract × 2 adapters + 1 mem-specific + 5 file-specific + 1 cleanup, accounting for shared in-mod fixtures)

## 8. `ConfigStore` — interface + adapters + tests

- [x] 8.1 Implement `packages/shared/src/storage/config/interface.ts` — `ProjectConfig` (`project_id`, `name`, `stack`, `agents`, `schedules`), `GlobalConfig` (`coding_agent_cli`, `default_port_range`, `log_level`), `AgentConfig`, `ResolvedConfig`, `ConfigStore` with `readProjectConfig` / `readGlobalConfig` / `resolve` / `writeProjectConfig`; full JSDoc on defaults policy, atomicity, and additive-extension expectation
- [x] 8.2 Implement `packages/shared/src/storage/config/memory.ts` — `InMemoryConfigStore` with optional initial values, `seedGlobalConfig` test helper, `structuredClone` on every read/write so mutating returned configs cannot leak back into the store
- [x] 8.3 Implement `packages/shared/src/storage/config/file.ts` — `FileConfigStore` constructor takes `ProjectPaths` + `GlobalPaths`; `readProjectConfig` throws `StoreNotFoundError` on missing file, `InvalidArtifactError` on malformed YAML or non-mapping top-level; `readGlobalConfig` returns `{}` when missing; `resolve` reads both in parallel; `writeProjectConfig` persists via `writeFileAtomic`; preserves unknown extra fields (forward compat)
- [x] 8.4 Added `config/memory_test.ts` (contract via in-memory fixture + 2 mem-specific: seeded values returned, deep-clone on writeProjectConfig isolates input mutation) and `config/file_test.ts` (contract via file fixture + 1 file-specific: YAML output shape and trailing newline)
- [x] 8.5 Extended `mod.ts` with `ConfigStore`, `ProjectConfig`, `GlobalConfig`, `AgentConfig`, `ResolvedConfig`, `FileConfigStore`, `InMemoryConfigStore`
- [x] 8.6 `deno task check` / `deno task test` — **201 tests pass** (175 prior + 11 contract × 2 adapters + 2 mem-specific + 1 file-specific + 1 cleanup, accounting for shared fixtures)

## 9. Module surface polish and documentation

- [x] 9.1 `mod.ts` re-exports every public type, every adapter (`FileTicketStore`, `InMemoryTicketStore`, `FilePRStore`, `InMemoryPRStore`, `FileActivityLogStore`, `InMemoryActivityLogStore`, `FileConfigStore`, `InMemoryConfigStore`), four error classes, six id helpers, two path resolvers, and `ProjectPaths` / `GlobalPaths`
- [x] 9.2 `main.ts` re-exports everything from `./storage/mod.ts`; added a permanent smoke test in `packages/server/src/main_test.ts` that imports `InMemoryTicketStore` and `TicketStore` via `@keni/shared` and round-trips a `create()`. Test passes; left in place as a regression guard for future export-surface changes
- [x] 9.3 Authored `packages/shared/src/storage/README.md` with sections: Overview (table of four interfaces × file paths), On-disk layout (ASCII tree mirroring `spec.md` §5.1 + §5.2), Atomicity guarantee (write-and-rename for tickets/PRs/config; single-syscall append for activity, with the 4 KB bound), Single-writer-per-artifact constraint, Status-machine non-enforcement, In-memory vs. file-backed, Contract tests (how to author a future adapter), Id formats table, Error model table, Non-goals (no `ChatMessageStore`, no spec/CR I/O, no status-graph enforcement, no concurrent multi-writer, no pagination), Module map ASCII tree
- [x] 9.4 Added a "Storage abstractions" section to root `README.md` with a one-paragraph overview and a link to the storage README
- [x] 9.5 Re-ran `deno task fmt`, `deno task lint`, `deno task check`, `deno task test` — all green; **202 tests pass** (added cross-workspace smoke test to the count)

## 10. Capability-spec verification

- [x] 10.1 Walked every requirement in `specs/storage/spec.md`; see verification block at the bottom of this file
- [x] 10.2 Drift detector verified: introduced `updated_at: "DRIFT-INTRODUCED-FOR-CONTRACT-TEST"` in `FileTicketStore.create`. The `FileTicketStore :: create assigns id ticket-0001 to the first ticket` contract test failed with the expected diff (`updated_at` mismatch); the `InMemoryTicketStore` run continued to pass. Reverted; full suite green.
- [x] 10.3 Corrupt-YAML detection verified: `FileTicketStore — read on a corrupt YAML header throws InvalidArtifactError carrying the path` passes (1 ms), and the error carries `path` plus a `reason` of either `malformed_yaml` or `unterminated_front_matter` depending on which parse stage trips first
- [x] 10.4 Crash-simulation verified: `FileTicketStore — pre-rename crash during transitionStatus preserves prior version` passes (4 ms). The test injects a throwing `__setPreRenameHook`, asserts the ticket file is byte-identical to the pre-write version, asserts a re-read returns the original `open` status, and asserts `readDir` of the tickets directory shows zero `.keni-tmp-*` residue

---

### Spec walk verification (10.1)

| Requirement | Coverage |
| --- | --- |
| R1 — Per-artifact storage interfaces exist in `@keni/shared` | `mod.ts` re-exports all four interfaces + record types; `packages/server/src/main_test.ts` smoke test imports them via `@keni/shared` (cross-workspace) and round-trips `create()` |
| R2 — `TicketStore` method surface | Contract scenarios: `updateHeader rejects status-in-patch`, `transitionStatus throws StaleStateError`, `linkChangeRequest sets the field` — pass on both adapters (24 contract tests × 2 adapters) |
| R3 — `PRStore` method surface | Contract scenarios: `updateIntent replaces body`, `updateStatus throws StaleStateError` — pass on both adapters (16 contract tests × 2 adapters) |
| R4 — `ActivityLogStore` append + query | Contract scenarios: `append assigns uuidv7`, `two successive appends sort lexicographically`, `query filters by agent / role / date range`, `append rejects oversized` — pass on both adapters (13 contract tests × 2 adapters) |
| R5 — `ConfigStore` reads + resolves layered view | Contract scenarios: `readProjectConfig throws StoreNotFoundError when missing`, `readGlobalConfig returns {} when missing`, `resolve produces flat shallow-merged view`, `resolve gives project precedence on overlap` — pass on both adapters (11 contract tests × 2 adapters) |
| R6 — File-backed adapters produce documented on-disk layout | `tickets/file_test.ts :: file format matches the documented spec.md §5.1 layout`; `activity/file_test.ts :: entries written across day boundaries land in distinct files`; `paths_test.ts :: no environment variables are read inside the functions`; constructors take `ProjectPaths` / `GlobalPaths` — verified by every `*_test.ts` |
| R7 — File-backed writes are atomic per artifact | `atomic_test.ts :: pre-rename hook failure preserves the prior version` + `temp file lives in the target's directory`; `tickets/file_test.ts :: pre-rename crash during transitionStatus preserves prior version`; `prs/file_test.ts :: pre-rename crash during updateStatus preserves prior version` |
| R8 — File-backed adapters single-writer-per-artifact (documented) | `packages/shared/src/storage/README.md` "Single-writer-per-artifact" section names the constraint and the optimistic-`from`-check escape hatch; class JSDoc on `FileTicketStore` and `FilePRStore` repeats the rule and links to the README |
| R9 — In-memory test doubles behaviourally equivalent | All four contract tests run × 2 adapters in `deno task test`; verified by 10.2 drift injection |
| R10 — Centralised id generation in `ids.ts` | `ids_test.ts` covers `ticket-0001` start, `9999 → 10000` width transition, regex acceptance, parse round-trip, uuidv7 strict monotonicity over 10 000 calls; both adapters delegate to `generateTicketId` / `generatePrId` / `generateActivityId` (verified by file inspection — no inline id construction) |
| R11 — Typed errors | `errors_test.ts` covers `instanceof` narrowing, `name` stability, `JSON.stringify` round-trip, all four classes; `tickets/file_test.ts :: read on a corrupt YAML header` verifies `InvalidArtifactError` carries the path; contract tests verify `StoreNotFoundError` / `StaleStateError` (both adapters) |
| R12 — JSDoc + README documentation | Every public type / method / class in `packages/shared/src/storage/` carries JSDoc; `packages/shared/src/storage/README.md` covers all required sections (Overview, On-disk layout, Atomicity, Single-writer, In-memory vs. file-backed, Id formats, Error model, Non-goals); root `README.md` adds a "Storage abstractions" section pointing at the storage README |

## 11. CI and hand-off

- [x] 11.1 Local CI dry-run is green — `deno install --frozen`, `deno task fmt:check`, `deno task lint`, `deno task check`, `deno task test` (204 tests, 0 failed) — every step matches `.github/workflows/ci.yml` exactly. Pushing to a feature branch and observing the GitHub Actions run is left for the user (per repo's git-safety policy, the agent does not push without explicit instruction)
- [x] 11.2 Diff is additive: only `README.md`, `deno.json`, `deno.lock`, `packages/shared/src/main.ts`, `packages/server/src/main_test.ts` (cross-workspace import smoke test — small extension to the allowed list, justified in §9.2), the new `packages/shared/src/storage/` tree (37 files), and the new `openspec/changes/storage-abstractions-and-file-impls/` tree (5 files) are touched. No file outside this set is modified
- [x] 11.3 Step 03 (`project-and-global-layout-with-init`) is now unblocked: `keni init` can construct a `FileConfigStore(resolveProjectPaths(root), resolveGlobalPaths(home))` and call `writeProjectConfig(initial)`. The `.keni/` directory tree is lazy-created by the file adapters' first writes (via `Deno.mkdir({ recursive: true })` inside `writeFileAtomic` and `@std/fs` `ensureDir` inside `FileActivityLogStore`), so step 03 SHOULD NOT call raw `Deno.writeTextFile` on `.keni/project.yaml` — go through `ConfigStore.writeProjectConfig` instead. Steps 04 (REST), 05 (MCP), and onward consume the same interfaces and gain the same atomicity / single-writer / typed-error contracts for free
- [x] 11.4 No file under `initial-implementation-plan/` is modified by this change (verified via `git status --short`); the change is strictly additive on `main` relative to step 01
