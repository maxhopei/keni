## Context

Step 01 landed the Keni monorepo on Deno with five workspace members (`cli`, `server`, `spa`, `role-runtimes`, `shared`). `packages/shared` currently contains a single placeholder export and a trivial test; every later step (04 REST, 05 WebSocket, 06 MCP, 07 role-runtime-common, 08 scheduler, 09 engineer, 10 – 12 SPA, 13 CLI, and the MVP additions in 14 – 27) will bind to interfaces that live in `@keni/shared`.

Two spec principles drive every decision in this document:

- **§2#6 / §11#5 — Files first, storage abstracted.** Every consumer reads and writes tickets, PRs, activity log entries, and project/global config **through an interface**, not through file paths or stream APIs. The file-backed default is an implementation detail; a future database-backed module is an additive adapter, not a rewrite. The scoped exception — the PO reading/writing `.keni/de-facto-spec/` and `.keni/changes/` directly per §5.3 — is **not in this step** (step 14 handles it and deliberately does *not* use a `StorageStore` interface).
- **§5.1 / §5.2 — Exact file layout.** `.keni/tickets/ticket-NNNN.md`, `.keni/prs/pr-NNNN.md`, `.keni/activity/YYYY-MM-DD.jsonl`, `.keni/project.yaml`, `~/.keni/config.yaml`. The file-backed adapter must produce these paths, with these names, with these extensions — this is the contract the rest of the system (including git history inspection and manual user edits per §7.4) depends on.

Constraints and givens:

- Runtime is Deno 2.7+ with built-in TypeScript (from step 01's decisions). No Node-specific APIs.
- The file-backed adapter is a **single-writer-per-artifact** design. Prototype (§8) has one engineer plus the user; MVP (§9) adds a PO whose per-artifact writes are routed through different code paths (CR/spec I/O is the §5.3 exception, not this interface). Multi-writer races on the *same* ticket or PR are not plausible in prototype/MVP.
- Engineer subprocesses **never** see `.keni/` (§5.3) — they write via MCP (step 06) which internally uses these stores. The storage interfaces are an in-process contract; no network, no auth boundary.
- `.keni/project.yaml` is committed; `.keni/state.json` is git-ignored (§5.1). This change touches only config files, not `state.json` (which is a later-step concern for the scheduler and chat queue).
- `keni init` (step 03) is what *creates* `.keni/` and writes the initial `project.yaml`. This change supplies the store that `keni init` will use, but does not itself bootstrap directories.

Non-constraints (explicitly free to choose):

- Internal folder layout under `packages/shared/src/`.
- Choice of YAML parser, JSONL encoding strategy, id-generation mechanism.
- Whether the file-backed adapter caches reads in memory (it does not — see Decision 7).

## Goals / Non-Goals

**Goals:**

- Four artifact-type storage interfaces (`TicketStore`, `PRStore`, `ActivityLogStore`, `ConfigStore`) exist as TypeScript types in `@keni/shared`, each with a minimal method surface tailored to what consumers (REST, MCP, runtimes, SPA) will actually need across steps 03 – 27.
- File-backed implementations of those interfaces exist that produce byte-identical file layouts to `spec.md` §5.1 — the same paths, filenames, and on-disk shapes the user will see in `git log`, `cat .keni/tickets/ticket-0001.md`, etc.
- Every file-backed write is atomic at the per-artifact level (write-then-rename), so interrupts (user pressing Ctrl+C, `SIGTERM` from a timeout per §7.5) never leave a half-written file that later readers or `git` will choke on.
- Every interface has an in-memory test double with the *same* behavioural contract, enforced by a shared contract-test suite run against both adapters — so downstream packages can unit-test consumers without touching the filesystem and cannot accidentally depend on file-specific behaviour.
- Id generation (`ticket-NNNN`, `pr-NNNN`) is centralised in one module and shared by both adapters, so the file-backed and future DB-backed implementations cannot disagree on format.
- The contract is **documented** — the interface types carry JSDoc covering semantics, errors, atomicity, and single-writer constraints, so every downstream change author can bind to the interface without re-reading `spec.md`.

**Non-Goals:**

- No `ChatMessageStore`. Spec §5.1 marks `.keni/chat/messages.jsonl` as MVP-only; step 15 adds the interface and file adapter when chat exists. This change defines a *pattern* that step 15 will follow, not the chat store itself.
- No spec/CR file I/O. Per spec §5.3 and key decision §11#5, the PO touches `.keni/de-facto-spec/` and `.keni/changes/` with native file tools. Step 14 owns whatever utility (atomic-commit helper, path resolution) the PO needs, and it is deliberately **not** a `StorageStore` interface — markdown editing through an abstraction buys nothing.
- No REST, MCP, role runtime, scheduler, or SPA wiring. Consumers bind to these interfaces in their own steps.
- No `keni init` bootstrapping of `.keni/`. This change delivers stores that `keni init` (step 03) uses; it does not create directories, generate a project id, or write the first `project.yaml`.
- No concurrent-writer support. The file-backed adapter is documented single-writer-per-artifact. A future DB adapter (hypothetical, post-MVP) can offer stronger semantics without changing the interface.
- No migration tooling. The point of the abstraction is that the swap is a new adapter, not data migration.
- No performance optimisations (caches, indexes, prepared statements). Prototype / MVP read volumes are low; readability of the file-backed adapter matters more than p99 latency.
- No status-machine enforcement. `TicketStore.transitionStatus` accepts a `from` state (optimistic concurrency check) and a `to` state but does **not** validate that `to` is a legal successor of `from` per §4.1. That validation lives in the caller — MCP (step 06) and REST (step 04) are where the status graph is encoded, because *role* determines which transitions are legal (§4.2), and the store does not know the caller's role. The store only guarantees that the transition is atomic and that a stale `from` is rejected.

## Decisions

### Decision 1: Package placement — everything lives in `@keni/shared/src/storage/`

**Why:** tickets, PRs, activity, and config are shared state every workspace member reads. Putting the interfaces anywhere else (e.g., a dedicated `@keni/storage`) creates a new workspace member that every other member depends on — pointless ceremony at this scale. Step 01 scaffolded `shared` for exactly this purpose.

**Layout:**

```
packages/shared/src/storage/
├── mod.ts                 # barrel: re-exports public types + factories
├── errors.ts              # StoreNotFoundError, StaleStateError, DuplicateIdError, InvalidArtifactError
├── ids.ts                 # generateTicketId, generatePrId, parseId, id format constants
├── atomic.ts              # writeFileAtomic(path, bytes): write-and-rename helper
├── paths.ts               # resolveProjectPaths(projectRoot), resolveGlobalPaths(home)
├── tickets/
│   ├── interface.ts       # TicketStore interface + Ticket, TicketHeader, TicketStatus types
│   ├── file.ts            # FileTicketStore
│   ├── memory.ts          # InMemoryTicketStore
│   ├── contract_test.ts   # shared contract suite (exported as a function taking a store factory)
│   ├── file_test.ts       # calls contract suite + file-specific tests (crash, concurrent readers)
│   └── memory_test.ts     # calls contract suite + memory-specific tests (clone semantics)
├── prs/         { same shape as tickets/ }
├── activity/    { same shape as tickets/ }
└── config/      { interface.ts, file.ts, memory.ts, *_test.ts }
```

The `mod.ts` barrel is re-exported from `packages/shared/src/main.ts` so consumers write `import { TicketStore, FileTicketStore, InMemoryTicketStore } from "@keni/shared";` — the bare specifier already works from step 01.

**Alternatives considered:**

- **Split into `@keni/storage`.** Another workspace member. Overkill for prototype scale; can be extracted later if the module grows large.
- **Flat `packages/shared/src/`.** Works; folders-per-artifact-type scale better as we add `ChatMessageStore` in step 15.

### Decision 2: Interface shape — one interface per artifact type, small method surface

**Why:** the step file mandates this. The operational reason: each artifact has different access patterns (tickets are paged and filtered; activity is append-and-scan; config is read-mostly), so a single "storage" interface would either leak methods or hide them behind generics. Per-type interfaces let each evolve on its own.

**Method surface per interface** (full signatures in the capability spec; semantics summarised here):

- **`TicketStore`**
  - `list(filter?: TicketFilter): Promise<TicketSummary[]>` — `TicketFilter` covers status, assignee, priority range, and optional CR id. Returns headers only (no body) so listing is cheap.
  - `read(id: TicketId): Promise<Ticket>` — full ticket (header + body). Throws `StoreNotFoundError` if missing.
  - `create(input: TicketCreateInput): Promise<Ticket>` — generates the next id, writes atomically, returns the stored record including id and filesystem-resolved fields.
  - `updateBody(id: TicketId, body: string): Promise<Ticket>` — replaces the markdown body. Atomic.
  - `updateHeader(id: TicketId, patch: Partial<TicketHeader>): Promise<Ticket>` — partially updates non-status header fields (`title`, `assignee`, `priority`, `change_request`). **Throws if the patch includes `status`** — use `transitionStatus` for that. Atomic.
  - `transitionStatus(id: TicketId, from: TicketStatus, to: TicketStatus): Promise<Ticket>` — optimistic transition. Throws `StaleStateError` if the on-disk status differs from `from`. Does not validate the status graph (see Non-Goals).
  - `linkChangeRequest(id: TicketId, changeRequestId: string): Promise<Ticket>` — sugar for `updateHeader({ change_request: changeRequestId })`; present because §4.2 calls it out as a distinct operation that the verify-and-fold cycle relies on.
- **`PRStore`**
  - `list(filter?: PRFilter): Promise<PRSummary[]>`, `read(id)`, `create(input)`, `updateIntent(id, intent)`, `updateStatus(id, from, to)` — analogous to `TicketStore`.
- **`ActivityLogStore`**
  - `append(entry: ActivityEntryInput): Promise<ActivityEntry>` — assigns a uuidv7 id, writes a single JSONL line to today's file (by the entry's timestamp; defaults to now). Atomic per line (see Decision 4).
  - `query(filter: ActivityFilter): AsyncIterable<ActivityEntry>` — streams entries matching agent, role, and/or a date range. `AsyncIterable` because the log can grow large and consumers (SPA activity view, step 11) paginate.
- **`ConfigStore`**
  - `readProjectConfig(): Promise<ProjectConfig>` — parses `.keni/project.yaml`; throws `InvalidArtifactError` on schema violation.
  - `readGlobalConfig(): Promise<GlobalConfig>` — parses `~/.keni/config.yaml`; returns defaults if the file does not exist (first-run case).
  - `resolve(): Promise<ResolvedConfig>` — calls both and merges: project values override global values field-by-field (shallow merge on known fields).

**Alternatives considered:**

- **One `Store<T>` generic with CRUD.** Neat in types, awful in practice: `activity` has no update, `config` has no create, and ticket transitions need optimistic checks. Special-casing bloats the generic.
- **Direct reactive/subscribable surface** (`TicketStore.subscribe(onChange)`). Tempting for the live SPA (§7.2), but the SPA updates via the WebSocket in step 05, not via the store; the store has no business knowing about subscribers. Keep it pull-based.

### Decision 3: On-disk layout — markdown + YAML front-matter for tickets / PRs, JSONL for activity, YAML for config

**Why:** matches `spec.md` §5.1 and §5.2 literally. The user inspecting `cat .keni/tickets/ticket-0001.md` or reading it in a code-review diff should see something unsurprising.

**Ticket file shape** (`.keni/tickets/ticket-0001.md`):

```markdown
---
id: ticket-0001
title: "Add login page"
status: open
assignee: null
priority: 100
change_request: null   # optional, populated in MVP
created_at: 2026-04-30T17:00:00.000Z
updated_at: 2026-04-30T17:00:00.000Z
---

# Add login page

Ticket body in markdown — implementation plan, comments, whatever the agent writes.
```

The YAML header uses `---` / `---` delimiters (standard front-matter, supported by every markdown renderer). The body is plain markdown. `created_at` / `updated_at` are ISO 8601 UTC.

**PR file shape** (`.keni/prs/pr-0001.md`): same pattern. Header fields: `id`, `title`, `status`, `ticket` (linked ticket id), `branch`, `author`, `created_at`, `updated_at`. Body contains the intent / description.

**Activity JSONL** (`.keni/activity/2026-04-30.jsonl`): one JSON object per line, schema:

```json
{"id":"01HXY...","timestamp":"2026-04-30T17:00:00.123Z","session_id":"...","agent":"alice","role":"engineer","event":"session_start","summary":null,"refs":{"ticket":"ticket-0001"}}
```

`id` is uuidv7 (ordering-stable, matches the chat `messages.jsonl` convention in §5.1). `event` is a string; no closed enum in this step (future events land additively). `refs` is an open map.

**Project config** (`.keni/project.yaml`) and **global config** (`~/.keni/config.yaml`): plain YAML. Schemas aligned with spec §5.1 / §5.2 (project id, name, stack, agent roster, schedules for project; preferred coding-agent CLI, default port range, log level for global). The exact field set is read-only for this step; `keni init` (step 03) writes them.

**Alternatives considered:**

- **TOML instead of YAML for config.** TOML is arguably more readable for flat configs, but the spec uses `.yaml` extensions in §5.1 / §5.2 — align with the spec.
- **JSON for everything.** Loses the human-readable markdown bodies the user sees in `git log`; the whole point of "files first" is that the git history is inspectable.
- **A single tickets.json instead of one file per ticket.** Makes the happy path faster but breaks the promise that each ticket is an independently-diffable artifact. Spec §5.1 names the per-file layout explicitly.

### Decision 4: Atomic writes — write-to-tempfile-then-rename; per-line append for JSONL

**Why:** `rename()` is atomic on POSIX when source and destination are on the same filesystem; this is the well-trodden pattern for safe file replacement. A `SIGTERM` (per §7.5's interrupt flow) during the write leaves the temp file as garbage but never corrupts the destination.

**Helper API:**

```ts
// atomic.ts
export async function writeFileAtomic(
  targetPath: string,
  contents: string | Uint8Array,
  opts?: { mode?: number; fsync?: boolean },
): Promise<void>;
```

Implementation:

1. `Deno.makeTempFile({ dir: dirname(targetPath), prefix: ".keni-tmp-" })` — same directory, so rename is same-filesystem.
2. Write contents to the temp file.
3. Optionally `fsync` the temp file (opt-in via `opts.fsync`; default off — prototype scope does not warrant the cost).
4. `Deno.rename(tempPath, targetPath)`.
5. On any failure before step 4, `Deno.remove(tempPath)` in a `finally` (best-effort; a residual temp file is cheap garbage).

**JSONL append:** the activity log is append-only. Full-file rewrite on every entry would be wasteful; instead, `ActivityLogStore.append`:

1. Serialises the entry to a single `JSON.stringify` + `\n` string.
2. Opens the target day-file with `Deno.open(path, { append: true, create: true })` and `write()`s in one call. On POSIX, a single `write()` of less than `PIPE_BUF` (4096 bytes) to a file opened with `O_APPEND` is atomic with respect to other appenders — and we are single-writer anyway, so atomicity is trivially satisfied.
3. Entries exceeding 4096 bytes are technically not single-syscall-atomic; we defensively reject `ActivityEntryInput` whose serialised form exceeds 4 KB with `InvalidArtifactError`. Spec activity entries are small (§6.3: one-line summary + a few refs); nothing legitimate hits the ceiling.

**Alternatives considered:**

- **Write entire JSONL day-file via `writeFileAtomic` on each append.** Correct but O(n) per append, with n days' worth of entries rewritten per session. Rejected.
- **WAL-style journaling.** Massive overkill for the load pattern; adds a replay layer the prototype will not exercise.
- **Skip `fsync`.** We do skip it by default (see `opts.fsync`). Power-loss durability is not a stated requirement; `rename()` atomicity alone handles the far-more-likely SIGTERM case.
- **File locking (`flock`).** Not portable (no `Deno.flock`), not needed given single-writer design. If a later adapter needs multi-writer, it will not be the file adapter.

### Decision 5: Concurrency model — documented single-writer-per-artifact for the file adapter

**Why:** prototype and MVP have one engineer (§8) initially, later "multiple engineer agents running in parallel" (step 26 / §9). Multi-engineer parallelism writes to *different* tickets (each engineer picks one, works it, merges) — so per-artifact single-writer is realistic. The PO's spec/CR writes are the §5.3 exception and go through a different path. Activity log appends are serialised through a single `ActivityLogStore` instance.

**What the interface promises:**

- All writes are atomic: a reader never sees a half-written file.
- Concurrent writers to the *same* artifact are **undefined behaviour** in the file adapter. The last writer wins; optimistic `from` checks in `transitionStatus` / `updateStatus` detect stale reads but cannot serialise overlapping writes.
- The in-memory double does not have this race (synchronous mutation), so it happens to be stronger; callers should not rely on the stronger semantics.

This is **documented loudly** in the interface JSDoc, in `packages/shared/src/storage/mod.ts` module docs, and in the capability spec. The prototype / MVP contract is "we do not race; if you need concurrent writers, you do not use the file adapter."

**Alternatives considered:**

- **Promise-queueing per artifact id inside the store.** Adds serialisation for sequential writes from the same process but does nothing across processes — and within a process we already have one caller. Premature.
- **File locks.** Portability nightmare (see Decision 4) and not needed for prototype/MVP load.
- **Pretend the interface supports multi-writer, then hope.** Silent incorrectness is worse than documented single-writer.

### Decision 6: Id generation — zero-padded sequence per artifact type, centralised in `ids.ts`

**Why:** spec §5.1 shows `ticket-0001` and `pr-0001` as the canonical format. Consistency matters because ids end up in filenames (`.keni/tickets/ticket-0001.md`), branch names (§5.2: "Branches are named `ticket-{id}` by convention"), activity log refs, and CR cross-links. A single module owns the format so the file adapter and any future adapter cannot disagree.

**Algorithm (file adapter):**

1. `list()` the target directory (e.g., `.keni/tickets/`).
2. Extract numeric suffixes from `ticket-NNNN.md` filenames.
3. Next id is `max(existing) + 1`, four-digit zero-padded until it overflows; then five digits, etc.
4. Collision is impossible because this runs *inside* `create()`, which holds the single-writer invariant.

This is not a cryptographic id — it's a human-readable one. Spec §5.1 already shows four-digit padding.

**In-memory adapter:** same algorithm over its internal array; effectively `this.nextId`.

**Activity log ids:** uuidv7 (not sequence). Same rationale as chat `messages.jsonl` in §5.1: ordering-stable, collision-resistant, suitable for unbounded append streams.

**Alternatives considered:**

- **ULID for tickets/PRs.** Unnecessarily opaque for an id the user sees in the URL bar and the branch name.
- **Atomic counter file** (`.keni/tickets/.next-id`). Adds a file without a clear win; directory scan is O(n) but n is tens / hundreds, trivially fast.
- **Per-day reset.** Breaks `ticket-0001` stability; rejected.

### Decision 7: In-memory test doubles — behaviourally equivalent, enforced by a shared contract test

**Why:** downstream packages (steps 04 onward) will have many unit tests that exercise consumers of these stores. Forcing every test to spin up a temp directory is slow and gives tests filesystem-specific failure modes. An in-memory double with the same contract lets consumer tests be pure.

**Behavioural equivalence is enforced, not hoped for:** each store's `contract_test.ts` exports a function like `runTicketStoreContract(factory: () => Promise<TicketStore>)`. `file_test.ts` calls it with a factory that returns a `FileTicketStore` rooted at `Deno.makeTempDir()`; `memory_test.ts` calls it with an `InMemoryTicketStore` factory. Any divergence is caught in CI.

The shared contract covers: CRUD happy paths, not-found errors, optimistic-transition errors, id-generation monotonicity, and the "update does not drop body" / "update does not drop header fields" round-trip invariants.

**Adapter-specific tests:**

- **File:** atomic-write crash simulation (write a tempfile, kill the process mid-rename, verify next reader still sees the previous version; this uses a controlled injection — `atomic.ts` exposes a test-only hook to throw between step 3 and step 4), directory-creation-on-first-write, cross-platform path handling on macOS and Linux (CI runs Ubuntu; local dev includes macOS).
- **Memory:** clone semantics (mutations through a returned `Ticket` do not mutate the store), iterator drain for `query()` with large batches.

**Alternatives considered:**

- **No in-memory double; use a fake filesystem.** Deno does not ship one; writing our own is more work than an in-memory double.
- **Only test the file adapter, mock in consumers.** Encourages inconsistent mocks across consumer tests and drifts from the real contract.
- **Contract test as runtime assertion inside every call.** A development mode where the double validates against the file adapter in parallel. Cute; unnecessary for the prototype.

### Decision 8: Error model — typed error classes, not tagged unions

**Why:** `throw` interop with async/await and stack traces is better than `Result<T, E>` in Deno's idiomatic style. Typed errors (subclasses of `Error` with stable `name` strings) let callers narrow with `instanceof`.

**Classes** (in `errors.ts`):

- `StoreNotFoundError` — `read(id)` / `update*(id, ...)` on a missing artifact. Carries the id and store name.
- `StaleStateError` — optimistic transition with a `from` that no longer matches. Carries expected vs. actual.
- `DuplicateIdError` — id collision at `create()` time (should be impossible under single-writer, but the check is cheap and defensive).
- `InvalidArtifactError` — on-disk file fails to parse (malformed YAML header, invalid JSONL line, schema violation). Carries the path and parse error.

Each subclass sets `this.name` to its class name so narrow error logs without `instanceof` still identify the class.

**Alternatives considered:**

- **`Result<T, StoreError>` algebraic type.** Clean in Rust; awkward in TS/Deno because every consumer must unwrap. Library convention in the JS ecosystem is throws.
- **Plain `Error` with a `.code` property.** Works but loses autocomplete; the custom classes give better IDE ergonomics.

### Decision 9: YAML and JSONL — use `jsr:@std/yaml`; hand-roll JSONL

**Why:** `@std/yaml` is the official Deno stdlib YAML parser/serialiser, maintained alongside the runtime, no npm dependency. JSONL is line-delimited JSON — `JSON.stringify(x) + "\n"` on write, `text.split("\n").filter(Boolean).map(JSON.parse)` on read (or a streaming equivalent for large files).

**Import contract** (root `deno.json`):

```jsonc
"imports": {
  "@std/assert": "jsr:@std/assert@^1",
  "@std/yaml": "jsr:@std/yaml@^1",
  "@std/uuid": "jsr:@std/uuid@^1",       // for uuidv7 on activity + future chat
  "@std/path": "jsr:@std/path@^1",       // cross-platform path join
  "@std/fs": "jsr:@std/fs@^1"            // ensureDir (for lazy directory creation)
}
```

`deno.lock` regenerates; CI's `deno install --frozen` verifies.

**Alternatives considered:**

- **`npm:js-yaml`.** Works via Deno's npm-compat but adds an npm shim. `@std/yaml` is first-class.
- **Custom minimal YAML parser.** Front-matter headers are simple, but we also need to parse `project.yaml` / `config.yaml` which may have nested structures. Use the stdlib.
- **Streaming JSONL library.** Overkill for prototype log sizes; a straightforward async iterator over line reads is enough.

### Decision 10: Path resolution — injected roots, never hardcoded

**Why:** tests need temp directories; `keni init` (step 03) knows where the project root is; the global dir can be overridden in tests with `HOME` or explicit injection. Hardcoded paths in the store bodies are untestable.

**`paths.ts` API:**

```ts
export type ProjectPaths = {
  tickets: string;        // <root>/.keni/tickets/
  prs: string;            // <root>/.keni/prs/
  activity: string;       // <root>/.keni/activity/
  projectConfig: string;  // <root>/.keni/project.yaml
};

export type GlobalPaths = {
  globalConfig: string;   // <home>/.keni/config.yaml
  workspaces: string;     // <home>/.keni/workspaces/ (used by later steps)
  logs: string;           // <home>/.keni/logs/
};

export function resolveProjectPaths(projectRoot: string): ProjectPaths;
export function resolveGlobalPaths(home: string): GlobalPaths;
```

Each `FileXStore` takes a `ProjectPaths` (or `GlobalPaths` for `FileConfigStore`) in its constructor. No `Deno.env.get("HOME")` calls inside the stores.

**Alternatives considered:**

- **`process.cwd()` / `Deno.cwd()` in the store.** Makes tests flaky and `keni start <path>` (step 13) awkward.
- **Store the project root once at module init.** Module-global state; fights the test doubles.

### Decision 11: Documentation — JSDoc on every interface, plus a `README.md` for `packages/shared/src/storage/`

**Why:** every future change reads these types before binding. JSDoc renders in the editor without any doc-generation step and covers ~90% of consumer questions. A short `README.md` next to the code covers the cross-cutting concerns (atomicity, single-writer, when to use file vs. memory) that don't fit on any one type.

**Scope of docs in this change:**

- JSDoc on every public type, method, and error class.
- `packages/shared/src/storage/README.md` explaining the contract and the file-vs-memory choice.
- Root `README.md` gets a one-paragraph pointer ("Storage interfaces live in `@keni/shared/src/storage/`; see that folder's README for the contract.").

No generated API docs in this step. If we add `deno doc` output later, it will work automatically from the JSDoc.

## Risks / Trade-offs

- **[Single-writer is a real constraint, not a theoretical one.]** A future step could accidentally spawn two writers for the same ticket (e.g., a careless scheduler change in step 08, or parallel engineers in step 26 both self-assigning the same ticket due to a race). → Mitigation: the interface docs call this out; the REST layer (step 04) is the single in-process serialisation point for web/MCP-driven writes, so concurrent writers from different processes is the only real risk. If that ever becomes real, we gate it at the REST layer (a short in-process mutex per artifact id), not in the store.
- **[`rename()` is not atomic across filesystems.]** If `.keni/tickets/` and the temp file somehow end up on different filesystems (the user mounts a bind), `Deno.rename` returns `EXDEV`. → Mitigation: `writeFileAtomic` creates the temp file in the *target's* directory, not `/tmp`, so they are always on the same filesystem by construction.
- **[JSONL append atomicity has a 4 KB cliff.]** Entries larger than 4 KB are not guaranteed atomic on POSIX; we reject them. → Mitigation: document the limit, reject with `InvalidArtifactError` at `append()` time, and note it in the capability spec. Realistic entries are well under 1 KB.
- **[YAML parser compatibility with the "de-facto" PO workflow.]** The PO (step 14+) also writes YAML-like files (CRs have optional headers) but via native file tools, not this store. Our parser choice does not constrain the PO. If the PO emits YAML we cannot round-trip (comments, quoting quirks), that is the PO's problem to fix in its prompt, not ours.
- **[UUID v7 stability across Deno versions.]** `@std/uuid` v1 supports v7 as of 2026-04; pin a range (`^1`) and rely on Deno's stable stdlib. → Mitigation: if `@std/uuid` ever breaks, one-file swap to another generator; callers only see `string`.
- **[Test suite growth.]** Four stores × three test files × shared contract = ~12 new test files in this change, plus the atomic-write tests. CI runtime grows. → Mitigation: Deno's test runner is fast; prototype-scale suites run in seconds. Revisit if CI time becomes noticeable.
- **[In-memory double can diverge.]** If a maintainer adds behaviour to the file adapter without updating the in-memory one (or vice versa), consumer tests silently pass against the wrong contract. → Mitigation: shared contract test is the enforcement mechanism — any divergence fails in CI.
- **[Error messages for malformed files are user-facing via `git blame`.]** A corrupt `ticket-0001.md` (someone hand-edited and broke the YAML) throws `InvalidArtifactError`. The SPA (step 11) needs to render this gracefully. → This is the SPA's problem (handle the error); the store's job is to throw a clearly-identified, path-carrying error, which it does.
- **[`project.yaml` / `config.yaml` schema evolution.]** As later steps add fields (schedules in step 08, engineer roster in step 09, PO config in step 17), the `ConfigStore`'s typed return shape has to grow. → Mitigation: each change that adds a config field also adds a requirement to this capability (modifies `storage`) with the new field; `ConfigStore` parses forward-compatibly (unknown fields preserved, missing fields defaulted).

## Migration Plan

Not applicable — additive to a greenfield `packages/shared`. No data exists under `.keni/` yet (step 03 creates it). Rollback is `git revert`.

## Open Questions

- **`ConfigStore` write surface.** `project.yaml` is written by `keni init` (step 03) and possibly by a future "config editor" UI (post-MVP per §7.4). Should `ConfigStore` expose `writeProjectConfig` in this change, or add it in step 03? → **Decision for this change:** expose `writeProjectConfig(ProjectConfig): Promise<void>` but do *not* expose `writeGlobalConfig` yet — the global file is created on install and edited manually in prototype. Step 03 can add the method if needed; the capability spec requires only reads.
- **Filter expressiveness.** `TicketFilter` covers status / assignee / priority / CR; future UIs may want free-text search or tag filters. → Add additively when a consumer actually needs it; do not pre-design.
- **Pagination on `list()`.** Prototype-scale projects have tens to hundreds of tickets; return-everything is fine. → If SPA (step 11) needs pagination, that's an additive method, not a breaking change.
- **Archived tickets.** Spec §4.1 has `done` as a terminal status; no "archive" concept yet. `list()` returns all tickets including `done`. → If the board becomes cluttered, the SPA filters by status client-side; no store change needed.
- **Observability hooks.** Should every mutation emit an event that the WebSocket (step 05) consumes, or is the activity log entry enough? → **Out of scope for this step.** Step 05 decides whether the server wraps the store with an emitter or appends its own events. The store stays pull-based.
- **`ConfigStore` layered merge for nested objects.** Shallow merge is easy; deep merge has the usual ambiguities. → Start shallow; extend to deep merge (with a clear policy: arrays replace, objects deep-merge) only when a real config field demands it.
