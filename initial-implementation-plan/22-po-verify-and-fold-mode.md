# Step 22 — po-verify-and-fold-mode

**Phase:** MVP
**Suggested change name:** `po-verify-and-fold-mode`
**Depends on:** 17, 18, 14

## Goal

Implement the scheduled mode that folds an accepted CR into the de-facto spec — atomically. After this step, when every linked ticket is `tested` the PO rewrites the appropriate spec files, archives the CR, moves all sibling tickets from `tested` to `done`, and lands all of it as a single git commit on `main`. **Verification is stubbed** in MVP per §9; real verification is post-MVP per §10.

## Scope

- Plug into the PO runtime (step 17) as the "verify-and-fold" mode; selected when at least one `decomposed` CR has every linked ticket in `tested` (§3, §6.2). One CR per cycle.
- Cycle algorithm:
  1. Find a `decomposed` CR whose linked tickets (located via the `change_request:` YAML header from step 21) are ALL `tested`.
  2. Spawn the PO subprocess with the verify-and-fold prompt (step 18) and the CR contents + relevant de-facto-spec files as input.
  3. The PO modifies the de-facto-spec files according to the CR's delta (additions, modifications, removals). Stub verification: the PO does NOT validate that completed work satisfies the CR — folding happens unconditionally (§9, §10).
  4. After the subprocess exits successfully, the runtime atomically:
     - Confirms the spec files were modified per the CR's delta intent (basic shape check, not real verification).
     - Moves the CR file from `.keni/changes/<cr-id>.md` to `.keni/changes/archive/YYYY-MM-DD-<cr-id>/`.
     - Transitions ALL linked tickets from `tested` to `done` via the storage interface (the PO is the owning role for `done`).
     - Lands the spec rewrites + CR archive move + ticket status changes as a SINGLE git commit on `main` via step 14's helper.
  5. On failure (subprocess error, malformed delta, conflicting fold target), abort cleanly: leave the CR `decomposed`, do NOT move tickets, log loudly. The user resolves manually (§9 — "MVP fails loudly and asks the user to resolve manually" for fold conflicts).
- "Tickets are held until the PO folds the parent CR": ticket status `tested` is the holding pen; only verify-and-fold moves them to `done` (§4.1). This step enforces that — no other code path may set `tested → done`.
- Concurrency: only one CR at a time (one CR per cycle per §6.2). Two CRs touching the same area = MVP fails loudly per §9 / §12.

## Out of scope

- Real PO verification of implemented work against the CR — post-MVP per §10.
- Drift detection — post-MVP per §10.
- Fold conflict resolution between two CRs touching the same area — post-MVP per §10, §12.
- File-watcher reactivity if the user edits the de-facto spec directly between fold cycles — post-MVP per §10.

## Spec references

- §3 (PO verify-and-fold) — Single combined cycle; runs when every ticket linked to a `decomposed` CR is `tested`; verifies (stubbed in MVP), folds the CR's deltas, archives the CR, moves all linked tickets to `done` atomically.
- §4.1 — Ticket lifecycle; `tested` is the holding pen; the PO's verify-and-fold moves the entire CR's tickets to `done` at once.
- §4.2 — Owning-role rule; the PO is the owning role for `done`.
- §5.1 — Archive path `.keni/changes/archive/YYYY-MM-DD-<id>/`.
- §5.3 — Atomic commit; spec/CR files are PO-direct.
- §6.2 (verify-and-fold) — Step-by-step algorithm.
- §9 — Fold-stub semantics: "the PO does not check whether the implemented tickets actually satisfy the CR; it folds the CR's deltas into the de-facto spec and moves all linked tickets from `tested` to `done` as soon as the fold predicate is satisfied."
- §10 — Real verification, drift detection, conflict resolution are explicitly deferred.
- §12 — Open questions: fold conflict resolution, drift detection.

## Open decisions for the proposer

- **Delta application strategy.** Does the PO write the new spec files in full, or does the runtime parse a structured delta from the CR and apply it? §11#5 says spec/CR are PO-direct files. The simplest approach: the PO writes the new spec file(s) directly; the runtime confirms the changeset shape and commits. Document.
- **"Basic shape check."** What is the minimum the runtime validates before committing? Spec files are non-empty, archive directory was created, ticket statuses can transition cleanly. Document.
- **Atomic commit composition.** Per step 14, file changes + API-driven status updates land in one commit. Confirm the order: (a) PO subprocess runs, makes file changes; (b) runtime stages them; (c) runtime makes API-driven status updates (which write to the same files via storage interfaces); (d) runtime commits everything as one. Document.

## Notes for /opsx:propose

- `proposal.md` should describe the fold as the closing valve of the CR lifecycle and stress that verification is stubbed in MVP (no false sense of safety).
- `design.md` should pin: fold-predicate detection, delta application, archive move, ticket status batch update, atomic-commit composition with step 14, failure paths and the "fail loudly" contract.
- `tasks.md` should cover: predicate detection, mode implementation, archive utility, batch ticket-status transition, integration tests covering happy path, malformed-delta failure, partial-failure rollback safety.
- Capability spec for `po-verify-and-fold-mode` documents the contract.
