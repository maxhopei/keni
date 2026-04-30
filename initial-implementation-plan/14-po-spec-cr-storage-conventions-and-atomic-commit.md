# Step 14 — po-spec-cr-storage-conventions-and-atomic-commit

**Phase:** MVP
**Suggested change name:** `po-spec-cr-storage-conventions-and-atomic-commit`
**Depends on:** 03, 04

## Goal

Lay down the on-disk conventions for `.keni/de-facto-spec/`, `.keni/changes/`, and `state.json`, and ship the atomic-commit helper that captures filesystem changes the PO subprocess made and lands them as a single commit on `main`. This is the file-shaped foundation every PO mode (steps 19–22) depends on.

## Scope

- `.keni/de-facto-spec/` directory created on first PO use; the PO chooses the file organisation (typically one file per cross-cutting concern or feature) per §5.1. No mandated layout.
- `.keni/changes/<cr-id>.md` — one markdown file per CR with proposal + delta in a single template. Template literal lives in step 18 (the conversation-to-CR prompt) but **the directory contract is here**.
- `.keni/changes/archive/YYYY-MM-DD-<cr-id>/` — fold step (22) moves CR files here; this step defines the convention.
- `state.json` schema (transient, git-ignored):
  - `active_chat_session_id`
  - `conversation_to_cr_queue` — array of closed chat session ids waiting for processing
  - `conversation_to_cr_in_flight` — singleton lock flag (set when a conv-to-CR cycle is running)
  - `message_checkpoint` — last processed `messages.jsonl` id past which conv-to-CR has advanced
  - `cron_watermarks` — per-role last-tick timestamps (used by step 17 for deterministic precheck)
- Atomic-commit helper (the spec's §5.3 exception):
  - Snapshot `.keni/de-facto-spec/`, `.keni/changes/`, and any other PO-touched paths before the PO subprocess starts.
  - After exit (success path), produce a single git commit on `main` with all PO-introduced changes plus any API-driven writes that happened during the cycle (ticket links, etc.) — atomic from the user's perspective.
  - Detect failures (subprocess error, dirty unrelated paths, git lock) and abort cleanly without partial commits.
  - Compose with the role-runtime hook contract (added in step 17).
- Token-friendly file utilities the PO can use natively (read, list, write) — these are *NOT* MCP tools (per §5.3 and §5.4 the PO uses its native file tools); this step ensures the directory layout is easy to navigate.

## Out of scope

- The PO subprocess itself, mode selection, or any specific PO mode — steps 17–22.
- CR template content — step 18 (lives inside the conversation-to-CR prompt).
- MCP tools for tickets/PRs/chat the PO uses — step 16. Spec/CR are NOT exposed via MCP.
- File-watcher reactivity to manual user edits of spec/CR — post-MVP per §10.
- Multi-CR fold conflicts — post-MVP; loud failure is the MVP behaviour (§9).

## Spec references

- §5.1 — Project folder layout, including `de-facto-spec/`, `changes/`, `archive/`, `state.json`.
- §5.3 — The PO write boundary exception. The runtime captures filesystem changes after subprocess exit and commits them atomically on `main`.
- §6.2 — `state.json` holds the runtime's working state to drive the queue; `messages.jsonl` is the durable record.
- §9 (MVP) — `.keni/de-facto-spec/`, `.keni/changes/<cr-id>.md`, archive path, atomic fold commit.
- §11#5, §11#9 — De-facto spec + change requests pattern; PO-direct exception rationale.
- §11#10 — Engineer workspaces are code-only; metadata is API-managed; PO is the scoped exception.

## Open decisions for the proposer

- **Snapshot mechanism.** `git stash`, file mtimes + path tracking, or compare against the commit `main` was at when the cycle started. The last is cleanest. Document.
- **Failure handling.** What if the PO subprocess wrote partial files? MVP: abort the commit, log loudly, do not lose the work — keep it on disk for the user to review. Document.
- **Concurrency.** §5.3 explains why MVP gets away with this: conv-to-CR is singleton, CR-to-tickets processes one CR per cycle, verify-and-fold targets one CR. Confirm in `design.md`.

## Notes for /opsx:propose

- `proposal.md` should explain that this step builds the file-shaped surface every PO mode reads and writes against, plus the safety net that turns the PO's filesystem changes into atomic git commits.
- `design.md` should pin: directory layout, `state.json` schema, the atomic-commit algorithm with failure paths, the integration seam with step 07's role runtime (so step 17 plugs in cleanly).
- `tasks.md` should cover: directory bootstrap helper, `state.json` schema + readers/writers, atomic-commit utility + tests against a temp git repo, integration test that simulates a PO subprocess writing spec/CR files and verifies a single commit lands.
- Capability spec for `po-spec-cr-storage` documents the contract.
