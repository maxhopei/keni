# Step 17 — po-runtime-and-mode-selection

**Phase:** MVP
**Suggested change name:** `po-runtime-and-mode-selection`
**Depends on:** 07, 08, 14

## Goal

Build the PO's specialised role runtime: the deterministic precheck and mode selection layer that fires every 5 seconds, decides whether *any* mode applies, and only then spawns a coding-agent subprocess. After this step, the PO is ticking but the individual modes are still empty stubs — those land in steps 19–22.

## Scope

- PO runtime built on top of step 07's `RoleRuntime`:
  - Schedule cadence: 5 seconds (configurable).
  - **Deterministic precheck on every scheduled tick** evaluates these conditions in order and runs the *first* applicable mode (per §6.2):
    1. **Conversation-to-CR** — `state.json.conversation_to_cr_queue` non-empty *and* `conversation_to_cr_in_flight` is false (singleton).
    2. **Verify-and-fold** — at least one CR with status `decomposed` has every linked ticket in `tested`.
    3. **CR-to-tickets** — at least one CR has status `proposed`.
  - If none apply, the cycle is idle: no subprocess, no tokens spent.
  - Selection picks ONE mode per cycle.
- Subprocess injection: the runtime selects the mode-specific prompt (from step 18) and spawns the PO with that prompt. Runs against the project root (no workspace clone — §5.3 exception).
- Atomic post-subprocess commit: invoke the helper from step 14 to capture filesystem changes (spec/CR) the PO made and land them as a single commit on `main`. Combine with any API-driven writes (ticket links, status transitions, etc.) into the same commit when possible.
- Singleton enforcement for conv-to-CR: the runtime sets `conversation_to_cr_in_flight: true` before spawning, clears it on exit (success or failure), and refuses to re-enter while it's set.
- Chat mode is event-driven, NOT scheduled. The chat-mode runtime is wired separately in step 19 and lives outside this scheduler tick — but it shares the same role runtime infrastructure (step 07) and the same atomic-commit helper.

## Out of scope

- Mode logic (what each mode actually does) — steps 19–22.
- The four bundled prompts — step 18 (this step references them but does not author them).
- MCP tools — already in step 16; this step assumes them.

## Spec references

- §6.1 — PO ticks every 5 seconds; deterministic precheck so idle ticks burn no LLM tokens.
- §6.2 (PO runtime) — the entire mode-selection algorithm, including the chat-out-of-band rule.
- §3 (PO) — Four modes; chat is event-driven, the other three are scheduled.
- §11#3 — Thin wrapper, prompts as code.

## Open decisions for the proposer

- **Where mode selection lives.** Inside the PO runtime's precheck function (step 07's contract), or as a separate "mode selector" component invoked by precheck. Either is fine; pick the cleaner separation.
- **Atomic-commit error path.** If the helper from step 14 detects a problem, fail the cycle but make sure `conversation_to_cr_in_flight` is cleared and watermarks are sane. Document.
- **Cron watermarks.** §6.2 mentions watermarks in `state.json`. Decide what they store (per-role last-tick timestamp, maybe last-mode-run for diagnostics). Document.

## Notes for /opsx:propose

- `proposal.md` should describe this step as the PO's "skeleton" — running, ticking, choosing modes, but not yet doing any mode-specific work.
- `design.md` should pin: the precheck algorithm with state inputs and outputs, mode selection priority, singleton enforcement, atomic-commit integration, watermark semantics, the seam where steps 19–22 plug in.
- `tasks.md` should cover: PO runtime class, precheck implementation, mode selector, scheduler registration at 5s, atomic-commit invocation, watermark plumbing, integration tests proving idle cycles spawn nothing and applicable cycles spawn the right mode.
- Capability spec for `po-runtime` documents the mode-selection contract.
