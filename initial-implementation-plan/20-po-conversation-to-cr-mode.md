# Step 20 — po-conversation-to-cr-mode

**Phase:** MVP
**Suggested change name:** `po-conversation-to-cr-mode`
**Depends on:** 17, 18, 16

## Goal

Implement the scheduled, queue-driven, singleton mode that turns each closed chat session into zero, one, or many CR files. After this step, anything the user negotiated with the PO in chat eventually shows up as concrete change requests on disk — and the message checkpoint advances so the same session is never reprocessed.

## Scope

- Plug into the PO runtime (step 17) as the "conversation-to-CR" mode; selected when the queue is non-empty AND `conversation_to_cr_in_flight` is false.
- Cycle algorithm (per §3, §6.2):
  1. Pop the oldest closed `session_id` from `state.json.conversation_to_cr_queue`. Set `conversation_to_cr_in_flight: true` (singleton lock — set by step 17 but the mode confirms it before proceeding).
  2. Gather messages for that `session_id` from `messages.jsonl` (filtered by `session_id`).
  3. Spawn the PO subprocess with the conversation-to-CR prompt (step 18) and the messages as input. Inject project context (project name, existing CR ids if useful, current de-facto spec layout pointer).
  4. The PO writes zero, one, or many CR files into `.keni/changes/` natively (file tools, not MCP).
  5. On subprocess exit (success):
     - Validate any CR files produced match the template (basic shape check; loud failure if not).
     - Set initial CR status (`proposed`) on each new file (if the prompt didn't).
     - Advance `state.json.message_checkpoint` past the last message id of the processed session.
     - Clear `conversation_to_cr_in_flight`.
     - Trigger atomic commit via step 14's helper.
  6. A conversation that produces zero CRs still advances the checkpoint and writes nothing — that is a valid, expected outcome (§3, §6.2).
- Bootstrap pattern handling: if the de-facto spec is empty (brand-new project), the PO is expected to emit a sequence of CRs (scaffolding → foundations → features) per §3 / §9. This is owned by the prompt (step 18); the mode runtime simply runs it.
- Singleton enforcement: only one conv-to-CR cycle runs at a time. Remaining queued sessions wait for the next tick (§3 / §6.2).
- Failure handling: if the subprocess fails or files are malformed, do NOT advance the checkpoint, do NOT advance the queue (re-process on next cycle), log loudly, clear the in-flight flag.

## Out of scope

- The chat mode that fills the queue — step 19.
- CR-to-tickets and verify-and-fold modes — steps 21 and 22.
- Re-decomposing edited CRs — post-MVP per §9 ("UI editing of decomposed CRs" excluded).

## Spec references

- §3 (PO conversation-to-CR) — Singleton, queue-driven; pops oldest; emits zero/one/many CRs; advances checkpoint past the session.
- §6.2 (Conversation-to-CR) — Detailed algorithm; runtime advances message checkpoint on subprocess exit.
- §9 — MVP includes the conv-to-CR queue in `state.json`; one CR per cycle; further user messages can wrap up new sessions while a previous CR cycle is running.
- §11#9 — De-facto spec + change requests pattern.
- §12 — Open question on CR granularity from one chat session; this step does not resolve it but leaves room for prompt iteration.

## Open decisions for the proposer

- **CR id allocation.** Sequential `cr-NNNN` from a counter or content-derived. Sequential is cleaner and matches §5.1 examples. Confirm with step 14's storage layout.
- **CR file validation.** What's the minimum shape check? Check that proposal and delta sections exist, status is `proposed`. Document.
- **Subprocess input.** How are messages handed to the subprocess — argv, stdin, file? File is cleanest for long sessions; document.

## Notes for /opsx:propose

- `proposal.md` should describe the bridge from a closed conversation to actionable change requests on disk.
- `design.md` should pin: queue-pop algorithm, message gathering, prompt invocation, post-exit validation, checkpoint advance, atomic-commit handoff, failure paths.
- `tasks.md` should cover: mode implementation, validator, checkpoint update, integration tests covering happy path, zero-CR path, malformed-CR path, subprocess-failure path.
- Capability spec for `po-conversation-to-cr-mode` documents the contract.
