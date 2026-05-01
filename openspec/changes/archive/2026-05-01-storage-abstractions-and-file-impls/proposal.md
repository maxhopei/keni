## Why

Principle §2#6 and key design decision §11#5 commit Keni to a "files first, storage abstracted" architecture: every consumer — REST endpoints, MCP tools, role runtimes, SPA — accesses artifacts through a storage interface, so a future database-backed implementation is an additive new module, not a system rewrite. That commitment must be cashed in **before** any consumer is written; if the REST layer, MCP surface, or SPA binds directly to file paths instead of interfaces, "swap in a database later" becomes a refactor of every caller. Step 02 lands the interfaces, the file-backed defaults that match `spec.md` §5.1, and the in-memory test doubles — so every subsequent step (04 REST, 05 WebSocket, 06 MCP, 07+ role runtimes, 10+ SPA) binds to the contract, not the filesystem.

## What Changes

- Introduce four artifact-type storage interfaces in `packages/shared`, each with a small focused method surface matching what consumers later need:
  - `TicketStore` — `list`, `read`, `create`, `updateBody`, `updateHeader`, `transitionStatus`, `linkChangeRequest` (CR link is a YAML header field; present-but-optional in prototype, populated in MVP per spec §4.2).
  - `PRStore` — `list`, `read`, `create`, `updateIntent`, `updateStatus`.
  - `ActivityLogStore` — `append`, `query` with filters for agent, role, and date range (spec §5.1 date-partitioned JSONL).
  - `ConfigStore` — `readProjectConfig`, `readGlobalConfig`, and a layered `resolve` that overlays project-level values on top of global defaults (spec §5.2).
- Ship file-backed default implementations that match `spec.md` §5.1 exactly:
  - Tickets as `ticket-NNNN.md` (markdown body + YAML front-matter header) under `.keni/tickets/`; header schema aligned with spec §4 (`status`, `assignee`, `priority`, optional `change_request:` link).
  - PRs as `pr-NNNN.md` (markdown body + YAML front-matter) under `.keni/prs/`.
  - Activity log as date-partitioned JSONL (`.keni/activity/YYYY-MM-DD.jsonl`), append-only.
  - Project config as `.keni/project.yaml`; global config as `~/.keni/config.yaml`. `ConfigStore.resolve()` returns the layered view (project overrides global).
- Ship an **atomic-write helper** — write-to-sibling-tempfile followed by `rename()` on POSIX — so any single artifact write is either fully visible or not visible at all; no partial-state corruption is possible on crash or interrupt. Documented as **single-writer per artifact** for the file-backed adapter (acceptable for prototype / MVP; future DB adapter can relax this).
- Ship **in-memory test doubles** for each interface (`InMemoryTicketStore`, `InMemoryPRStore`, `InMemoryActivityLogStore`, `InMemoryConfigStore`) with the same contract, so every downstream package (steps 04 – 27) can unit-test consumers without spinning up a temp filesystem.
- Ship **ID generators** for tickets and PRs producing stable, zero-padded, sequence-based ids (`ticket-0001`, `pr-0001`) consistent with spec §5.1 examples — centralised so file-backed and future DB-backed adapters agree on format.
- Write the **contract documentation** (inside `packages/shared`) that describes the interfaces, their semantics (especially atomicity and the single-writer stance), and when each method is intended to be called. This is the artifact every future consumer reads before binding.
- Add unit tests for every interface: one suite per concrete implementation (file-backed + in-memory), each run against the same shared contract test so the two adapters cannot drift.
- **Nothing else.** No REST endpoints, no MCP tools, no role runtime wiring, no SPA views, no CLI subcommands, no `keni init` bootstrapping of `.keni/` (that's step 03), no ChatMessageStore (step 15), no spec/CR I/O (step 14 covers that, which is the PO's scoped-exception direct-file-I/O per spec §5.3).

## Capabilities

### New Capabilities

- `storage`: The contract that every Keni artifact consumer — REST endpoints, MCP tools, role runtimes, SPA — reads and writes tickets, PRs, activity log entries, and project/global config through per-type interfaces, with file-backed default implementations, atomic per-artifact writes, consistent id generation, and in-memory test doubles. Covers what each interface must expose, the atomicity guarantee (write-and-rename), the single-writer stance of the file-backed adapter, the file layout under `.keni/` and `~/.keni/`, the YAML header / JSONL line / YAML config schemas, and the contract-equivalence between file-backed and in-memory implementations. This capability will later be extended — additively, in their own changes — to add `ChatMessageStore` (step 15, MVP) and whatever else future artifacts require. Spec and CR files are deliberately **not** covered by this capability; spec §5.3 makes them a scoped exception that the PO subprocess touches directly.

### Modified Capabilities

<!-- None. The only pre-existing capability is `developer-setup` (from change `setup-monorepo-and-tooling`), whose requirements are not affected by this change. -->

## Impact

- **Affected code**: additive only; all new code lives under `packages/shared/src/storage/` (one module per artifact type, a `FileBackedAdapter` submodule per store, an `InMemory` submodule per store, plus `atomic.ts` for the write-and-rename helper and `ids.ts` for id generation). No existing files are modified beyond re-exporting the new modules from `packages/shared/src/main.ts` if needed for ergonomics.
- **Affected APIs / contracts**: introduces the canonical `TicketStore`, `PRStore`, `ActivityLogStore`, `ConfigStore` TypeScript interfaces that every later change binds to. No HTTP or MCP surface exists yet, so there is no external API to version.
- **Affected dependencies**: one or two dependencies land at root `deno.json` — a YAML parser/serialiser (e.g., `jsr:@std/yaml`) for ticket/PR headers and config files. JSONL is line-delimited JSON (no library needed). The atomic-write helper uses `Deno.makeTempFile` + `Deno.rename`, both stdlib. `deno.lock` is regenerated accordingly and committed.
- **Affected tests**: unit-test count grows meaningfully; each interface has a shared contract-test suite applied to both concrete implementations, plus adapter-specific tests (e.g., file-backed atomic-write crash behaviour via fault injection, in-memory concurrency-is-a-noop).
- **Downstream steps unblocked**: steps 04 (REST APIs), 05 (agents + WS), 06 (MCP), 07 (role-runtime-common), 08 (scheduler), 09 (engineer runtime), 10 – 12 (SPA), and 13 (keni start) all depend on these interfaces existing; 03 (`keni init`) writes `project.yaml` via `ConfigStore` rather than raw filesystem calls. The MVP additions in steps 14 (spec/CR — deliberately outside this abstraction per §5.3), 15 (chat messages — adds `ChatMessageStore` as a new requirement on this capability), 16+ all build on top.
- **Non-impact (deliberate)**:
  - No `.keni/` bootstrapping — this change implements the stores that `keni init` (step 03) will use; it does not create directories, a project id, or an initial `project.yaml`.
  - No server, MCP, role-runtime, or SPA code — those are later steps that bind to these interfaces.
  - No ChatMessageStore — spec §5.1 documents `.keni/chat/messages.jsonl` as MVP-only; step 15 adds the interface and file-backed implementation when chat actually exists.
  - No spec/CR file I/O abstraction — spec §5.3 makes the PO's direct file access an architectural exception; step 14 owns whatever utility (atomic commit, path helpers) the PO needs, and that utility is explicitly **not** a `StorageStore` interface.
  - No migration utilities (no "swap file-backed for DB-backed" tooling) — the whole point of the abstraction is that the swap is a new adapter, not a migration of the interface.

## Spec references

- §2#6 — "Files first, storage abstracted (with one scoped exception)." — the architectural principle this change cements.
- §5.1 — Project folder layout (`.keni/tickets/ticket-NNNN.md`, `.keni/prs/pr-NNNN.md`, `.keni/activity/YYYY-MM-DD.jsonl`, `.keni/project.yaml`) — the exact file layout the file-backed adapter produces.
- §5.2 — Global directory (`~/.keni/config.yaml`) — the layout `ConfigStore` reads the global layer from.
- §5.3 — `.keni/` write boundary — informs the single-writer stance and clarifies that the storage layer is not reachable by engineer subprocesses; the gating (REST/MCP) lands in steps 04 and 06, but the interfaces must already exist for that gating to have something to guard.
- §11#5 — Design-decision rationale for files-first + interface-level abstraction — the *why* behind the capability.
