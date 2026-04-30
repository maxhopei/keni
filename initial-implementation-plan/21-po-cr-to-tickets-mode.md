# Step 21 — po-cr-to-tickets-mode

**Phase:** MVP
**Suggested change name:** `po-cr-to-tickets-mode`
**Depends on:** 17, 18, 16

## Goal

Implement the scheduled mode that decomposes a `proposed` CR into prioritised, linked tickets. After this step, when a CR shows up on disk it gets turned into work the engineer can pick up.

## Scope

- Plug into the PO runtime (step 17) as the "CR-to-tickets" mode; selected when there is at least one CR with status `proposed`. One CR per cycle (§3, §6.2).
- Cycle algorithm:
  1. Pick the highest-priority CR with status `proposed`. Priority can come from the CR's own front matter; if absent, FIFO by creation time. Document the choice.
  2. Spawn the PO subprocess with the CR-to-tickets prompt (step 18) and the CR's contents as input.
  3. The PO calls `create_ticket` via MCP (step 16) for each child ticket, supplying `change_request: <cr-id>` in the YAML header so links are unambiguous.
  4. PO sets per-ticket priority (PO-owned integer; lower = higher per §4.2).
  5. On successful subprocess exit, mark the CR `decomposed`. If the prompt didn't update the CR's status itself (it's a file the PO writes natively), the runtime updates it as part of the post-exit bookkeeping.
  6. Trigger atomic commit via step 14's helper — single commit covering the new tickets + the CR status flip.
- Failure handling: if the subprocess fails before producing any tickets, leave the CR `proposed` and try again on the next applicable cycle. If it produces *some* tickets and then fails, the runtime keeps what was created (tickets are durable artefacts) and re-runs CR-to-tickets on the same CR next cycle — the prompt should be idempotent enough to recognise existing children. Document.

## Out of scope

- Re-decomposing already-`decomposed` CRs (e.g., after the user edits them) — post-MVP per §9 "UI editing of decomposed CRs" excluded.
- Re-prioritising tickets after creation — engineers pick top-of-queue; the user can edit priority manually via the UI but reactive re-decomp is not in scope.
- Any tooling around format-of-ticket (user story / imperative / Gherkin) — left to prompt iteration per §12.

## Spec references

- §3 (PO CR-to-tickets) — At most one CR with status `proposed` per cycle; decomposes, links to CR, sets `decomposed`.
- §4.2 — Tickets link back to their CR via `change_request:` YAML header; priority is a PO-owned integer; engineers pick top of their queue.
- §4.3 — In MVP the PO creates tickets from accepted CRs; user can still create directly.
- §6.2 (CR-to-tickets) — One CR per cycle.
- §9 — MVP includes "CR-to-tickets — decomposing a `proposed` CR into linked tickets."
- §12 — Open questions: CR granularity, PO ticket format.

## Open decisions for the proposer

- **CR priority signal.** Embedded field in the CR file vs. queue-style FIFO. FIFO is fine for MVP; document.
- **Idempotency on re-run after partial failure.** Either let the prompt handle "I see existing tickets for this CR" or have the runtime delete partial tickets before retry. The first is cleaner — ticket existence + linkage is observable to the prompt.
- **Atomic commit boundary.** Tickets created via MCP land through the storage interface. Confirm the atomic-commit helper from step 14 captures both the file changes (CR status flip) and the API-driven changes (new tickets) in one commit.

## Notes for /opsx:propose

- `proposal.md` should explain that this step is the bridge between intent (CR) and work (tickets).
- `design.md` should pin: CR selection algorithm, MCP-mediated ticket creation, CR status update, atomic-commit cooperation, idempotency strategy.
- `tasks.md` should cover: mode implementation, CR selection, post-exit status flip, integration tests covering happy path, partial-failure retry, multiple-CR-pending fairness.
- Capability spec for `po-cr-to-tickets-mode` documents the contract.
