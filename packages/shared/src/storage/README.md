# `@keni/shared/src/storage`

Storage interfaces and default file-backed implementations for every Keni artifact a consumer (REST,
MCP, role runtimes, SPA, CLI) reads or writes.

Per [`spec.md`](../../../../spec.md) §2#6 and §11#5 (_files first, storage abstracted_), every
consumer binds to one of these interfaces — never to a filesystem path. The file-backed adapters are
the default implementation; a future database-backed adapter is an additive module, not a rewrite.

The `.keni/de-facto-spec/` and `.keni/changes/` directories are the scoped exception (§5.3) and are
deliberately **not** covered here.

## Overview

Four interfaces, one per artifact type:

| Interface          | Artifact                 | File location                                       |
| ------------------ | ------------------------ | --------------------------------------------------- |
| `TicketStore`      | Tickets (board cards)    | `<root>/.keni/tickets/ticket-NNNN.md`               |
| `PRStore`          | Pull-request records     | `<root>/.keni/prs/pr-NNNN.md`                       |
| `ActivityLogStore` | Append-only activity log | `<root>/.keni/activity/YYYY-MM-DD.jsonl`            |
| `ConfigStore`      | Project / global config  | `<root>/.keni/project.yaml` + `~/.keni/config.yaml` |

The `.keni/` tree itself (the empty `tickets/`, `prs/`, `activity/` directories with their
`.gitkeep` placeholders, plus `project.yaml`, `state.json`, and the merged `.gitignore`) is what
`keni init` produces — see the [`project-layout` capability spec](../../../../openspec/) (in
`openspec/changes/project-and-global-layout-with-init/specs/project-layout/spec.md` until archived,
then under `openspec/specs/project-layout/`). This module is the storage contract those directories
satisfy.

## Wire shapes vs. storage records (HTTP boundary)

Storage records (`Ticket`, `PR`, `ActivityEntry`) carry on-disk concerns: file-implied id, YAML
front-matter shape, the `{ header, body }` split. **Wire shapes**, which live next door under
[`@keni/shared/wire/`](../wire/mod.ts), carry HTTP concerns: a flat JSON object the SPA can render
directly, the standard envelope `{ data, project_id }`, and the documented error envelope
`{ error: { code, message, details? } }`. The orchestration server
([`orchestration-server` capability spec](../../../../openspec/changes/orchestration-server-and-rest-apis/specs/orchestration-server/spec.md),
moving to `openspec/specs/orchestration-server/spec.md` after archive) maps storage records to wire
shapes inside `packages/server/src/routes/*.ts`. The mapping is trivial today (the shapes are nearly
identical), but the seam exists so a future on-disk schema change does not force every API response
to change too. zod schemas for the request shapes live server-side in `packages/server/src/wire/`;
consumers that only need the types (e.g., the SPA) import from `@keni/shared` and tree-shake zod out
of their bundle.

**Events are wire-only.** The orchestration server's WebSocket `/events` endpoint emits an
`EventFrame` (`{ id, event, project_id, timestamp, payload }`) per write — but no on-disk artifact
corresponds to an event. The durable record of agent activity remains the **activity log**
(`ActivityLogStore`); events are a derived live channel that the SPA, MCP push-channel, and future
replay subscribers consume in addition to (not instead of) the activity log on disk. A future change
can ring-buffer events for `?since=<event-id>` replay without touching this module — the wire shape
carries the uuidv7 `id` precisely so that change is additive.

Each interface has two implementations:

- **`FileXStore`** — production default. Reads / writes the on-disk layout documented above.
- **`InMemoryXStore`** — drop-in test double. No filesystem; behaviourally identical, enforced by a
  shared contract test (see _Contract tests_ below).

## On-disk layout

Matches `spec.md` §5.1 (project) and §5.2 (global) exactly:

```
<project root>/
└── .keni/
    ├── project.yaml             # ConfigStore
    ├── tickets/
    │   ├── ticket-0001.md       # TicketStore (YAML front-matter + body)
    │   └── ...
    ├── prs/
    │   ├── pr-0001.md           # PRStore (YAML front-matter + body)
    │   └── ...
    └── activity/
        ├── 2026-04-30.jsonl     # ActivityLogStore (one JSON object per line)
        └── ...

~/                              # user home
└── .keni/
    ├── config.yaml             # ConfigStore (global)
    ├── workspaces/             # used by later steps
    └── logs/                   # used by later steps
```

`paths.ts` is the single source of truth for these locations. Adapters never read environment
variables or `Deno.cwd()` — every path is resolved upfront by `resolveProjectPaths(root)` /
`resolveGlobalPaths(home)` and injected into the store constructor. This keeps adapters trivially
testable (`Deno.makeTempDir()` + `resolveProjectPaths`) and explicit about which paths will be
touched.

## Atomicity guarantee

- **Tickets, PRs, project config, global config** — atomic via `writeFileAtomic` (`atomic.ts`):
  write to a same-directory `.keni-tmp-*` file, then `rename()` onto the target. POSIX `rename()` is
  atomic when source and destination are on the same filesystem; readers always observe either the
  pre-write or the post-write state, never a partial write. `writeGlobalConfig` (used by `keni init`
  to bootstrap `~/.keni/config.yaml` per `spec.md` §7.1) lazy-creates the parent `~/.keni/`
  directory before the rename so the temp file always lands on the same filesystem as its target.
- **Activity log entries** — atomic via a single `O_APPEND` `write()`. POSIX guarantees an
  `O_APPEND` write of less than `PIPE_BUF` (4096 bytes) is atomic with respect to other appenders.
  Entries whose serialised JSON exceeds 4096 bytes are rejected with `InvalidArtifactError`
  (`reason: "size_exceeded"`) to stay safely below that bound.

`writeFileAtomic` exposes a test-only `__setPreRenameHook` so adapter tests can simulate a crash
mid-write and verify the previous file version is preserved.

## Single-writer-per-artifact

The file-backed adapters are documented as **single-writer-per-artifact**. Concurrent writers to the
same ticket / PR / project-config / global-config file from different processes are undefined
behaviour beyond what `rename()` guarantees; `O_APPEND` writes to the activity log are safe for
concurrent appenders (within the 4 KB bound) but cross-process activity readers may see entries out
of insertion order if the underlying file system reorders writes across writers.

The same constraint applies to the **global config** at `~/.keni/config.yaml`. The user typically
never has two Keni processes writing the global file simultaneously, but `writeGlobalConfig` makes
no attempt at cross-process locking; the file-backed adapter's atomicity guarantee (write-and-rename
with a same-directory temp file) is the only protection. `keni init` is structurally a single
writer; future config-edit flows are expected to serialise.

Higher layers (REST, MCP) serialise concurrent mutations on the same artifact id when needed — that
responsibility is **not** the storage adapter's. The `transitionStatus` (tickets) and `updateStatus`
(PRs) methods use an optimistic `from` check that reads the current state and throws
`StaleStateError` if it does not match, allowing callers to detect concurrent overwrites without
holding a lock.

## Status-machine enforcement

`transitionStatus` / `updateStatus` do **not** validate the status graph (which transitions are
legal). That validation belongs to the caller (REST / MCP), where the role context determines
legality per `spec.md` §4.2. The storage layer's only assertion is the optimistic `from` check.

`updateHeader` (tickets) rejects patches that include a `status` field with `InvalidArtifactError`
(`reason: "status_in_patch"`) — status changes must go through `transitionStatus`.

## In-memory vs. file-backed

Use the **in-memory adapter** for unit tests of consumer code (REST handlers, MCP tools,
role-runtime drivers) where you want the storage contract without filesystem I/O. The in-memory
adapter is behaviourally identical to the file adapter — every behaviour difference would cause one
of them to fail the shared contract test.

Use the **file adapter** for production, integration tests that exercise the full I/O path, and any
test that needs to verify on-disk format.

## Contract tests

Each artifact directory ships a `contract_test.ts` exporting a single function
`runXStoreContract(name, factory)`. Both `memory_test.ts` and `file_test.ts` invoke it with their
respective adapter factories. If either adapter drifts from the documented contract — missing a
field, throwing the wrong error, returning summaries with body content, etc. — the contract test
fails for that adapter (and only that adapter), pointing directly at the divergence.

To author a new adapter (e.g., a future `PostgresTicketStore`), implement the interface, then create
`tickets/postgres_test.ts` that calls
`runTicketStoreContract("PostgresTicketStore", () => makeIt())`. Passing the contract is the entry
ticket.

## Id formats

| Artifact       | Generator            | Format                        |
| -------------- | -------------------- | ----------------------------- |
| Ticket         | `generateTicketId`   | `ticket-NNNN` (4+ digits)     |
| PR             | `generatePrId`       | `pr-NNNN` (4+ digits)         |
| Activity entry | `generateActivityId` | uuidv7 (sortable by creation) |

Sequence ids start at `0001`, grow to five digits at `10000` and beyond. The generator scans the
existing id list and returns `max + 1`; callers MUST invoke it inside their single-writer critical
section (e.g., the file adapter does this inside `create()` between listing the directory and
writing the new file).

`generateActivityId()` wraps `@std/uuid/v7` with a process-local monotonic guarantee — when two
calls land in the same millisecond, the 48-bit `rand_b` tail is bumped by 1 to force ordering. This
preserves the v7 version + variant structure and gives 2⁴⁸ headroom of intra-millisecond appends
before overflow, vastly more than any realistic activity-log cadence.

## Error model

Four typed error classes live in `errors.ts`. Each extends `Error`, sets `this.name` to the class
name, and carries a JSON-serialisable context blob (via `toJSON`) for log surfacing:

| Class                  | When                                                                    | Carries                    |
| ---------------------- | ----------------------------------------------------------------------- | -------------------------- |
| `StoreNotFoundError`   | `read` / `update*` / `transitionStatus` targets a missing id            | `id`, `path?`              |
| `StaleStateError`      | `transitionStatus` / `updateStatus` `from` does not match on-disk state | `id`, `expected`, `actual` |
| `DuplicateIdError`     | `create()` would assign an id that already exists (defensive)           | `id`                       |
| `InvalidArtifactError` | On-disk file malformed, or caller-supplied input violates a constraint  | `reason`, `path?`          |

Callers narrow with `instanceof`:

```ts
try {
  await store.read(id);
} catch (err) {
  if (err instanceof StoreNotFoundError) { /* handle */ }
}
```

## Non-goals

This module deliberately does **not** ship:

- **`ChatMessageStore`** — chat persistence (`messages.jsonl`) is owned by the chat / session layer
  in a later step. The storage interfaces here are for the four artifact types named above.
- **Spec / change-request file I/O** — per `spec.md` §5.3, the PO has scoped direct access to
  `.keni/de-facto-spec/spec.md` and `.keni/changes/CR-NNNN.md` (and only there). Those files are
  intentionally not abstracted.
- **Status-graph enforcement** — the storage layer accepts any `(from, to)` pair that matches
  on-disk state. Role-aware status validation lives in the REST / MCP layer.
- **Concurrent multi-writer support** — single-writer-per-artifact is the documented contract.
- **Pagination on `list` / `query`** — added when a real consumer demands it (REST will likely be
  the first).

## Module map

```
storage/
├── README.md           ← this file
├── mod.ts              ← public barrel — every export the world sees
├── errors.ts           ← four error classes
├── ids.ts              ← generateTicketId / generatePrId / generateActivityId
├── atomic.ts           ← writeFileAtomic + __setPreRenameHook
├── paths.ts            ← resolveProjectPaths / resolveGlobalPaths
├── tickets/
│   ├── interface.ts    ← TicketStore, Ticket, TicketHeader, ...
│   ├── shared.ts       ← matchTicket, validateHeaderPatch
│   ├── memory.ts       ← InMemoryTicketStore
│   ├── file.ts         ← FileTicketStore
│   ├── contract_test.ts← runTicketStoreContract
│   ├── memory_test.ts  ← contract + mem-specific
│   └── file_test.ts    ← contract + file-specific
├── prs/
│   └── ...             ← same structure as tickets/
├── activity/
│   └── ...
└── config/
    └── ...
```
