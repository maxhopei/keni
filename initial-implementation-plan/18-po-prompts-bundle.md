# Step 18 — po-prompts-bundle

**Phase:** MVP
**Suggested change name:** `po-prompts-bundle`
**Depends on:** 07

## Goal

Author the four bundled PO system prompts that fully specify the PO's behaviour in each mode, plus the CR file template referenced by the conversation-to-CR prompt. Prompts ship as code (§11#3); after this step, the PO runtime (step 17) and the four mode-specific runtimes (steps 19–22) have prompt content to inject.

## Scope

- **Chat prompt** (§3, §6.2): elicit requirements, ask gap-filling questions, ask the user to confirm wrap-up when ready, decide on its own how to handle still-open questions. Must respect that the same coding-agent session is resumed across user turns within the chat session (the PO doesn't need to re-introduce itself each turn).
- **Conversation-to-CR prompt**: read the messages of one closed chat session, decide whether to emit zero, one, or multiple CRs. **Embeds the CR file template** so the PO writes well-formed `<cr-id>.md` files (proposal + delta in a single template per §5.1, §11#9). Includes the **bootstrap pattern** for a brand-new project: scaffolding → foundations → features (§3, §9). Specifies that an output of zero CRs is acceptable for a conversation that produces no actionable change (§3, §6.2).
- **CR-to-tickets prompt**: take one `proposed` CR, decompose it into tickets, prioritise them (PO-owned integer, lower = higher), link each child ticket to the CR via `change_request:` YAML header (§4.2), and set the CR to `decomposed` via MCP (or via the runtime's post-cycle bookkeeping). Format-of-ticket guidance (user story / imperative / Gherkin) is left flexible; the prompt can iterate (§12 open question — "PO ticket format").
- **Verify-and-fold prompt**: take one CR with all linked tickets at `tested`, fold the CR's deltas into the appropriate de-facto spec files, archive the CR file. **MVP verification is stubbed** (§9): the prompt explicitly does not check whether implemented work satisfies the CR; folding happens unconditionally once tickets reach `tested`. Real verification is post-MVP per §10. The prompt must produce predictable file changes the runtime can commit atomically (step 17 + step 14).
- **CR file template** (referenced by the conv-to-CR prompt): a markdown template with proposal (what & why) and delta (additions, modifications, removals to apply on fold) in a single file. Status field (`proposed` initially, transitioning to `decomposed`, then archived).
- All five artefacts (4 prompts + 1 template) are code — bundled with Keni's binary, NOT loaded from a user-editable file. No FS overrides.
- Each prompt prescribes the one-line summary contract from §6.3.

## Out of scope

- Per-project or per-agent prompt customisation — post-MVP per §10.
- The mode runtimes that consume these prompts — steps 19–22.
- Real PO verification of implemented work — post-MVP per §9 / §10.
- Drift detection — post-MVP per §10.

## Spec references

- §3 (PO) — Each mode's responsibility, including chat session lifecycle and verify-and-fold semantics.
- §6.2 (PO) — Mode-by-mode behaviour the prompts must specify.
- §9 — MVP includes "four bundled PO system prompts (one per mode). Each is opinionated about its job."
- §10 — Real verification, drift detection are deferred; prompts must NOT pretend to do them.
- §11#3 — Prompts as code.
- §11#9 — De-facto spec + change requests; PO owns the lifecycle; CR template carries proposal + delta.
- §12 — Open questions to be aware of: CR granularity from one chat session, PO ticket format.

## Open decisions for the proposer

- **Prompt format.** Plain text, structured sections, XML-ish tags — pick what works best with the target coding-agent CLIs (§6.4). Document.
- **CR template granularity.** How rigid is the template? Tight enough that the runtime can validate post-write; loose enough for the PO to express delta intent. Pick a balance and document.
- **Wrap-up confirmation wording.** The chat prompt has to teach the PO how to ask for wrap-up. Pick natural language, write it down.

## Notes for /opsx:propose

- `proposal.md` should describe this step as the PO's behavioural contract — the prompts ARE the PO.
- `design.md` should: list each prompt's structure, the CR template, the prompts-as-code packaging story, the summary-line contract per prompt.
- `tasks.md` should cover: write each of the four prompts, write the CR template, wire them into the bundle so step 17 can resolve them, golden tests that the prompts compile in / load correctly, dry-run tests with a fake coding agent that the prompts produce expected output shapes.
- Capability spec for `po-prompts` documents the contract; per-prompt sub-specs are optional but useful.
