# storage Specification

## Purpose

Defines the storage abstractions for every Keni artifact (tickets, PRs, activity log entries, project config, global config) plus their default file-backed implementations. The capability cements `spec.md` §2#6 and §11#5 ("files first, storage abstracted") by requiring every consumer — REST endpoints, MCP tools, role runtimes, SPA, CLI — to bind to TypeScript interfaces in `@keni/shared` rather than reading or writing artifact files directly. It specifies the four interfaces' method surfaces, the on-disk layout under `<root>/.keni/` and `~/.keni/` per `spec.md` §5.1 and §5.2, atomic write guarantees (write-and-rename for tickets/PRs/config; single-syscall append for activity), the single-writer-per-artifact concurrency model, the centralised id-generation module, the typed error model, and the in-memory test doubles enforced by a shared contract-test suite. Any change that alters this contract must land as a delta spec against this capability.

## Requirements

### Requirement: Per-artifact storage interfaces exist in `@keni/shared`

The `@keni/shared` package SHALL export four TypeScript interfaces — `TicketStore`, `PRStore`, `ActivityLogStore`, and `ConfigStore` — one per artifact type named in `spec.md` §5.1 for the prototype and early MVP. Every future consumer of tickets, PRs, activity log entries, project config, or global config — including REST endpoints, MCP tools, role runtimes, and the SPA — SHALL bind to these interfaces rather than reading or writing artifact files directly. No consumer code SHALL import from `packages/shared/src/storage/tickets/file.ts` (or analogous files for the other artifact types) except for the factory that constructs a `FileTicketStore` at process startup.

#### Scenario: All four interfaces are importable by name from `@keni/shared`

- **WHEN** a consumer writes `import { TicketStore, PRStore, ActivityLogStore, ConfigStore } from "@keni/shared"`
- **THEN** all four names resolve to TypeScript interface types exported by the package
- **AND** each interface has the method surface documented in the capability below
- **AND** each interface is accompanied by its artifact record type (`Ticket`, `PR`, `ActivityEntry`, `ProjectConfig` / `GlobalConfig` / `ResolvedConfig`), also exported from `@keni/shared`

#### Scenario: Consumers do not depend on the file-backed adapter type

- **WHEN** a consumer's source code is searched for imports of concrete adapter classes (`FileTicketStore`, `FilePRStore`, `FileActivityLogStore`, `FileConfigStore`)
- **THEN** those imports exist only at the composition root (CLI / server bootstrap) where the concrete adapter is instantiated once
- **AND** consumer code (REST handlers, MCP tools, role runtimes, SPA data layer) accepts the interface type as a parameter or constructor argument, never the concrete class

### Requirement: `TicketStore` exposes the documented method surface

`TicketStore` SHALL expose, at minimum, the methods `list`, `read`, `create`, `updateBody`, `updateHeader`, `transitionStatus`, and `linkChangeRequest`. `updateHeader` SHALL reject patches that include the `status` field; callers SHALL use `transitionStatus` for status changes. `transitionStatus` SHALL accept both a `from` and a `to` status argument and SHALL fail if the artifact's current status does not equal `from`. `linkChangeRequest` SHALL set the `change_request` header field to the given id and SHALL be callable on any ticket regardless of status. All write methods SHALL return the full updated `Ticket` record.

#### Scenario: `updateHeader` refuses status changes

- **WHEN** a caller invokes `updateHeader(id, { status: "in_progress" })` on a `TicketStore` instance
- **THEN** the call rejects with an error whose name identifies a status-in-patch violation
- **AND** the on-disk (or in-memory) artifact is unchanged
- **AND** the error message names the `status` field and directs the caller to `transitionStatus`

#### Scenario: `transitionStatus` detects stale transitions

- **WHEN** the on-disk status of `ticket-0001` is `in_progress`
- **AND** a caller invokes `transitionStatus("ticket-0001", from: "open", to: "in_progress")`
- **THEN** the call rejects with `StaleStateError`
- **AND** the error carries both the expected (`open`) and actual (`in_progress`) statuses
- **AND** the ticket file is unchanged

#### Scenario: `linkChangeRequest` is equivalent to `updateHeader({ change_request: ... })`

- **WHEN** a caller invokes `linkChangeRequest("ticket-0001", "cr-0007")`
- **THEN** the ticket's YAML header contains `change_request: cr-0007`
- **AND** a subsequent `read("ticket-0001")` returns the record with `header.change_request === "cr-0007"`
- **AND** the ticket's status, body, and other header fields are unchanged

### Requirement: `PRStore` exposes the documented method surface

`PRStore` SHALL expose, at minimum, the methods `list`, `read`, `create`, `updateIntent`, and `updateStatus`. `updateIntent` SHALL replace the PR's intent/body field atomically. `updateStatus` SHALL accept a `from` and `to` and SHALL fail with `StaleStateError` if the current status differs from `from`. All write methods SHALL return the full updated `PR` record.

#### Scenario: `updateIntent` replaces the body atomically

- **WHEN** a caller invokes `updateIntent("pr-0001", "new description")`
- **THEN** the call resolves with the updated `PR` record whose body equals `"new description"`
- **AND** a subsequent `read("pr-0001")` returns the same body
- **AND** no partial-write state is observable by any concurrent reader

#### Scenario: `updateStatus` detects stale transitions

- **WHEN** the on-disk status of `pr-0001` is `approved`
- **AND** a caller invokes `updateStatus("pr-0001", from: "in_review", to: "approved")`
- **THEN** the call rejects with `StaleStateError`
- **AND** the PR file is unchanged

### Requirement: `ActivityLogStore` appends entries and streams query results

`ActivityLogStore` SHALL expose an `append(entry)` method that assigns a uuidv7 id, persists the entry, and returns the stored `ActivityEntry`. It SHALL expose a `query(filter)` method returning an `AsyncIterable<ActivityEntry>` that yields entries matching the filter in increasing-id (thus chronological) order. The filter SHALL support, at minimum, `agent`, `role`, and a date range (`from`, `to`).

#### Scenario: `append` assigns a uuidv7 id

- **WHEN** a caller invokes `append({ timestamp, session_id, agent, role, event, summary, refs })` without supplying an id
- **THEN** the returned `ActivityEntry` carries a uuidv7 `id`
- **AND** two successive appends produce ids that sort lexicographically in the order they were appended

#### Scenario: `query` filters by agent and date range

- **WHEN** the activity log contains entries from three agents across two days
- **AND** a caller iterates `query({ agent: "alice", from: "2026-04-30T00:00:00Z", to: "2026-04-30T23:59:59Z" })`
- **THEN** the iterator yields only `alice`'s entries from that day
- **AND** the entries are yielded in increasing-id order
- **AND** entries from other agents or other days are not yielded

#### Scenario: `append` rejects an oversized entry

- **WHEN** a caller attempts to `append` an entry whose serialised JSON exceeds 4 KB
- **THEN** the call rejects with `InvalidArtifactError`
- **AND** nothing is written to disk
- **AND** the error message identifies the size limit

### Requirement: `ConfigStore` reads project and global config and resolves a layered view

`ConfigStore` SHALL expose `readProjectConfig()`, `readGlobalConfig()`, and `resolve()`. `readProjectConfig` SHALL parse `.keni/project.yaml` and SHALL throw `StoreNotFoundError` if the file does not exist (i.e., `keni init` has not run). `readGlobalConfig` SHALL parse `~/.keni/config.yaml` and SHALL return typed defaults if the file does not exist (first-use case; the global file is optional). `resolve()` SHALL return a `ResolvedConfig` in which project-level values override global-level values field-by-field via shallow merge. `ConfigStore` SHALL also expose `writeProjectConfig(ProjectConfig)` so that `keni init` (step 03) and future project-config flows can persist changes atomically.

#### Scenario: `resolve` overlays project on global

- **WHEN** `~/.keni/config.yaml` declares `log_level: info` and `default_port: 8080`
- **AND** `.keni/project.yaml` declares `log_level: debug` and `project_id: proj-42`
- **AND** a caller invokes `resolve()`
- **THEN** the returned `ResolvedConfig` has `log_level: debug` (project overrides)
- **AND** `default_port: 8080` (inherited from global)
- **AND** `project_id: proj-42` (project-only)

#### Scenario: `readGlobalConfig` returns defaults when the global file is missing

- **WHEN** no file exists at `~/.keni/config.yaml`
- **AND** a caller invokes `readGlobalConfig()`
- **THEN** the call resolves with a typed `GlobalConfig` whose fields hold documented defaults
- **AND** no error is thrown
- **AND** the filesystem is unchanged (no lazy file creation)

#### Scenario: `readProjectConfig` fails loudly when the project file is missing

- **WHEN** no file exists at `.keni/project.yaml`
- **AND** a caller invokes `readProjectConfig()`
- **THEN** the call rejects with `StoreNotFoundError`
- **AND** the error identifies the missing path

### Requirement: File-backed adapters produce the exact on-disk layout documented in `spec.md` §5.1 and §5.2

The file-backed adapters SHALL write tickets to `<project-root>/.keni/tickets/ticket-NNNN.md`, PRs to `<project-root>/.keni/prs/pr-NNNN.md`, activity entries to `<project-root>/.keni/activity/YYYY-MM-DD.jsonl` (partitioned by the entry's UTC date), project config to `<project-root>/.keni/project.yaml`, and read global config from `<home>/.keni/config.yaml`. Ticket and PR files SHALL use YAML front-matter delimited by `---` lines, followed by a markdown body. Activity files SHALL contain one JSON object per line with a trailing newline. Adapter constructors SHALL accept injected paths (no hardcoded paths inside the adapter code).

#### Scenario: Ticket files match the documented layout

- **WHEN** a caller invokes `create({ title: "Add login page", priority: 100 })` on a `FileTicketStore` rooted at `<project-root>`
- **THEN** a new file exists at `<project-root>/.keni/tickets/ticket-0001.md`
- **AND** the file begins with `---`, followed by YAML containing at least `id: ticket-0001`, `title: "Add login page"`, `status: open`, `priority: 100`, `created_at`, and `updated_at`, followed by `---`, followed by the markdown body
- **AND** `deno fmt` does not rewrite the file
- **AND** `cat` of the file is human-readable

#### Scenario: Activity entries partition by UTC date

- **WHEN** a caller invokes `append({ timestamp: "2026-04-30T23:59:59.000Z", ... })` and then `append({ timestamp: "2026-05-01T00:00:00.001Z", ... })`
- **THEN** the first entry is appended to `<project-root>/.keni/activity/2026-04-30.jsonl`
- **AND** the second entry is appended to `<project-root>/.keni/activity/2026-05-01.jsonl`
- **AND** each file contains one line per entry with a trailing newline

#### Scenario: Adapter constructors accept injected paths

- **WHEN** a test instantiates `FileTicketStore` with a `ProjectPaths` object pointing to `Deno.makeTempDir()` output
- **THEN** all subsequent reads and writes occur under that temp directory
- **AND** the adapter does not touch `Deno.env.get("HOME")`, the current working directory, or any path outside the supplied paths

### Requirement: File-backed writes are atomic per artifact

Every write performed by a file-backed store SHALL be atomic at the per-artifact level: a concurrent reader SHALL observe either the pre-write or the post-write contents, never a partial write. Ticket / PR / project-config writes SHALL be implemented via write-to-temp-file-then-`rename`, with the temp file created in the same directory as the target so that `rename` is same-filesystem. Activity log appends SHALL use a single append-mode write of the serialised-line bytes, bounded to the single-syscall-atomic size limit on POSIX (4096 bytes). On write failure before the final `rename`, the adapter SHALL remove the temp file on a best-effort basis.

#### Scenario: Interrupt during a ticket write leaves the previous version intact

- **WHEN** a test simulates a crash (via an injected error hook) between writing the temp file and renaming it
- **AND** a second reader calls `read("ticket-0001")` after the crash
- **THEN** the reader sees the previous, committed contents of `ticket-0001.md`
- **AND** no `.keni-tmp-*` file remains in `<project-root>/.keni/tickets/` after the adapter's error-handler runs
- **AND** `git status` shows no unexpected tracked changes

#### Scenario: Atomic write uses a same-directory temp file

- **WHEN** `writeFileAtomic` is called with a target path `<dir>/ticket-0001.md`
- **THEN** the temp file is created inside `<dir>/` (not `/tmp`, not the OS tempdir)
- **AND** the subsequent `rename` operates on two paths inside the same filesystem
- **AND** the adapter never attempts a cross-filesystem rename

### Requirement: File-backed adapters are single-writer-per-artifact and document that constraint

The file-backed adapter's public documentation (JSDoc on the interface and class, plus the `packages/shared/src/storage/README.md`) SHALL state that concurrent writers to the same artifact produce undefined behaviour. The interface itself SHALL NOT attempt cross-process file locking. Consumers SHALL serialise writes at a higher layer (REST, MCP) when they need stronger guarantees.

#### Scenario: Documentation calls out single-writer

- **WHEN** a contributor opens `packages/shared/src/storage/README.md`
- **THEN** a section explicitly states that the file-backed adapter is single-writer-per-artifact
- **AND** the section lists the two existing escape hatches: the optimistic `from` check on `transitionStatus` / `updateStatus` (detects stale reads, not concurrent writes), and the expectation that the REST / MCP layer is the serialisation point

#### Scenario: Interface JSDoc reinforces single-writer

- **WHEN** a contributor hovers any write method of `TicketStore` or `PRStore` in their editor
- **THEN** the JSDoc surfaces the single-writer assumption and points to the README for details

### Requirement: In-memory test doubles are behaviourally equivalent to the file-backed adapters

For each of the four interfaces, `@keni/shared` SHALL export an in-memory test double — `InMemoryTicketStore`, `InMemoryPRStore`, `InMemoryActivityLogStore`, `InMemoryConfigStore` — that implements the interface with the same externally-visible behaviour as the file-backed adapter. A shared contract-test suite SHALL exist for each interface and SHALL be run against both adapters in CI. Any observable behavioural divergence (different error type, different return shape, different ordering guarantee) SHALL cause the contract test to fail.

#### Scenario: Contract test runs against both adapters

- **WHEN** `deno task test` runs at the repo root
- **THEN** the contract test for `TicketStore` executes once against a `FileTicketStore` rooted at a temp directory
- **AND** executes once against an `InMemoryTicketStore`
- **AND** the same applies for `PRStore`, `ActivityLogStore`, and `ConfigStore`
- **AND** every assertion in the contract test passes for both adapters

#### Scenario: A divergent change to one adapter fails CI

- **WHEN** a contributor modifies `FileTicketStore.create` to return a record missing the `created_at` field
- **AND** pushes the change
- **THEN** the contract test fails on the `FileTicketStore` run
- **AND** the failure names the missing field
- **AND** the `InMemoryTicketStore` run continues to pass (proving the contract test is the drift-detector)

### Requirement: Artifact ids are generated by a centralised module

`packages/shared/src/storage/ids.ts` SHALL export the id-generation and id-parsing functions used by every store adapter. Ticket ids SHALL have the format `ticket-` followed by a zero-padded decimal sequence number of at least four digits (`ticket-0001`, `ticket-0042`, `ticket-9999`, `ticket-10000`). PR ids SHALL use the same format with the `pr-` prefix. Activity log entry ids SHALL be uuidv7 strings. No store adapter SHALL embed its own id-generation logic; all adapters SHALL delegate to this module.

#### Scenario: Ticket ids zero-pad to at least four digits

- **WHEN** a newly-initialised `FileTicketStore` has no existing tickets and `create(...)` is called
- **THEN** the assigned id is `ticket-0001`
- **AND** a 999th call assigns `ticket-0999`
- **AND** a 1000th call assigns `ticket-1000`
- **AND** a 10000th call assigns `ticket-10000` (five digits, still zero-padded on the left of the sequence boundary)

#### Scenario: File and in-memory adapters produce identical id formats

- **WHEN** both `FileTicketStore` and `InMemoryTicketStore` are created fresh
- **AND** both have `create(...)` invoked once with the same input
- **THEN** both assign the id `ticket-0001`
- **AND** both are rejected by the same regex (`/^ticket-\d{4,}$/`)

### Requirement: Typed errors identify missing, stale, duplicate, and malformed artifacts

`@keni/shared` SHALL export the error classes `StoreNotFoundError`, `StaleStateError`, `DuplicateIdError`, and `InvalidArtifactError`, each extending `Error` with a stable `name` equal to the class name. Every store method SHALL throw the matching class for the corresponding failure mode. Error instances SHALL carry enough context (artifact id, path, expected vs. actual state, parse error) for callers to log or surface in the UI.

#### Scenario: `read` on a missing id throws `StoreNotFoundError`

- **WHEN** `FileTicketStore.read("ticket-9999")` is called and no such file exists
- **THEN** the call rejects with a `StoreNotFoundError` instance
- **AND** `error.name === "StoreNotFoundError"`
- **AND** `error instanceof StoreNotFoundError` is true
- **AND** the error message contains the id `ticket-9999`

#### Scenario: A corrupt YAML header throws `InvalidArtifactError`

- **WHEN** a ticket file on disk has a malformed YAML header (e.g., unclosed quote)
- **AND** a caller invokes `read("ticket-0001")`
- **THEN** the call rejects with `InvalidArtifactError`
- **AND** the error carries the file path and the underlying parse error

### Requirement: Storage interface semantics are documented via JSDoc and a folder README

Every public type, method, and error class exported from `packages/shared/src/storage/` SHALL carry JSDoc that describes its purpose, its inputs, its return shape, and the errors it may throw. `packages/shared/src/storage/README.md` SHALL exist and SHALL cover: the four interfaces, the atomic-write guarantee, the single-writer constraint, the in-memory vs. file-backed choice, and the id-generation format. The repository root `README.md` SHALL contain a one-line pointer to the storage folder README.

#### Scenario: IDE hover surfaces JSDoc on every store method

- **WHEN** a contributor hovers `TicketStore.transitionStatus` in their editor
- **THEN** the editor shows JSDoc naming the `from` / `to` parameters, the `StaleStateError` failure mode, and the atomic-write guarantee

#### Scenario: Storage README exists and covers the contract

- **WHEN** a contributor opens `packages/shared/src/storage/README.md`
- **THEN** the file exists
- **AND** contains sections describing the four interfaces, atomicity, single-writer constraint, in-memory doubles, and id format
- **AND** the repository-root `README.md` contains a pointer to this file
