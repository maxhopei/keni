# Step 02 — storage-abstractions-and-file-impls

**Phase:** Prototype
**Suggested change name:** `storage-abstractions-and-file-impls`
**Depends on:** 01

## Goal

Define the storage interfaces every Keni consumer (REST, MCP, role runtimes, SPA) will bind to, and ship file-backed default implementations that match `spec.md` §5.1. This locks in principle §2#6 ("files first, storage abstracted") so a future database-backed swap is an additive new module, not a rewrite.

## Scope

- Interfaces (one per artifact type), each with a small, focused method surface:
  - `TicketStore` — list, read, create, update body/header, transition status, link to CR (header field used in MVP).
  - `PRStore` — list, read, create, update intent, update status.
  - `ActivityLogStore` — append entry, query by agent / role / date range.
  - `ConfigStore` — read project config, read global config, layered resolution.
- File-backed default implementations:
  - Tickets and PRs as markdown with YAML front-matter under `.keni/tickets/` and `.keni/prs/`.
  - Activity log as date-partitioned JSONL files under `.keni/activity/`.
  - Project config as `.keni/project.yaml`; global config as `~/.keni/config.yaml`.
- Atomic-write helper (write-then-rename or similar) so partial-state corruption is impossible.
- In-memory test doubles for each interface so downstream packages can unit-test without a temp filesystem.
- Naming/ID generators (e.g., `ticket-NNNN`, `pr-NNNN`) consistent with §5.1 examples.

## Out of scope

- `ChatMessageStore` — added in step 15 (MVP) when chat actually exists.
- Spec/CR file I/O — those are PO-direct, governed by step 14.
- Server endpoints, MCP tools, or any consumer code — those bind to these interfaces in later steps.

## Spec references

- §2#6 — "Files first, storage abstracted (with one scoped exception)."
- §5.1 — Project folder layout, including the exact file naming for tickets, PRs, activity, project.yaml.
- §5.3 — Write boundary; the storage layer must not be reachable directly by engineers (engineers go through MCP). This step builds the interfaces; the MCP/REST gating happens in steps 04 and 06.
- §11#5 — Files-first design decision rationale.

## Open decisions for the proposer

- **Atomic write strategy.** Write-and-rename is standard on POSIX; the proposer should confirm it's sufficient on the target runtime (Node/Bun/etc.) and note any caveats.
- **Concurrency model.** What happens if two writers race on the same file? At prototype scope a single writer is realistic, but the interface should be honest about it (e.g., document that the file-backed impl is single-writer per artifact).
- **Schema for ticket and PR YAML headers.** Keep aligned with `spec.md` §4 (status, assignee, priority, `change_request:` link present-but-optional in prototype, populated in MVP).

## Notes for /opsx:propose

- `proposal.md` should frame this as the architectural commitment to storage abstraction and explain why it lands now (before any consumer is written).
- `design.md` should: list interface signatures, sketch the file-backed adapter, document atomic-write semantics, and call out the in-memory test doubles.
- A capability spec for `storage` (or per-artifact specs) is appropriate and useful for later verification.
- `tasks.md` should cover: define each interface, implement file-backed adapter, implement atomic-write helper, implement in-memory doubles, ship unit tests, document the contract.
