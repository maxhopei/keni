# Step 16 — mcp-tools-for-po

**Phase:** MVP
**Suggested change name:** `mcp-tools-for-po`
**Depends on:** 06, 15

## Goal

Add the MCP tools the PO subprocess uses for everything that is **not** spec/CR (which it touches directly per §5.3). After this step, the PO can read the chat session, append assistant messages, create tickets that link back to a CR, read PR records, and append to the activity log — all through MCP, all status-machine-guarded.

## Scope

- New MCP tools (added to the server from step 06):
  - **Chat**: `read_chat_messages(session_id?)`, `append_assistant_message(content)`, `close_chat_session()`. Backed by step 15's store.
  - **Tickets**: `create_ticket(title, body, priority, change_request)` — creates a ticket linked to the given CR via the `change_request:` YAML header (§4.2). The owning role for *creation* is the PO (in MVP); enforce it.
  - **PRs**: `read_pr(id)`, `list_prs` — read-only for the PO; writing is engineers' responsibility.
  - **Activity log**: `append_activity_entry` — same surface engineers have, but the PO writes role-tagged entries.
- Identity wiring: PO subprocesses are tagged so the MCP server applies PO-specific permissions (e.g., only the PO can create tickets in MVP).
- Reuse: every tool delegates to existing storage interfaces and API routes — no duplicated business logic.
- Documentation: tool descriptors are concise and unambiguous so they land cleanly in the four PO prompts (step 18).

## Out of scope

- Spec/CR file I/O — explicitly NOT exposed via MCP (§5.3 / §5.4). The PO uses native file tools for those.
- Engineer-only tools (already in step 06).
- The PO subprocess itself or any specific PO mode — steps 17–22.

## Spec references

- §3 (PO) — Responsibilities; what the PO actually does informs the tool list.
- §4.2 — `change_request:` link on tickets created by the PO.
- §4.3 — In MVP the PO creates tickets from CRs; the user can still create directly.
- §5.3 — Write boundary; `.keni/` exception is **only** for de-facto-spec and changes, not for tickets/PRs/chat/activity.
- §5.4 — Engineers are MCP-only (excepting workspace path); the PO has the spec/CR exception, everything else is MCP.
- §9 — MVP MCP surface for tickets, PRs, chat, activity log.

## Open decisions for the proposer

- **Permission model.** Single-flag per-tool-per-role table is simplest. Document the PO's allowed operations vs. the engineer's.
- **Tool naming.** Match step 06's existing naming convention to keep prompts consistent (e.g., `read_chat_messages` aligns with `read_ticket`, `list_tickets`).
- **Ticket creation rules.** Should `create_ticket` require non-empty `change_request`? In MVP the PO always links to a CR. Make it required; document so the prompt knows.

## Notes for /opsx:propose

- `proposal.md` should explain that this step extends the MCP surface specifically for the PO without leaking spec/CR control through MCP.
- `design.md` should: list each new tool with parameters, errors, idempotency, permissions, and example invocations matching the prompts the PO will use.
- `tasks.md` should cover: tool implementations, permission wiring, descriptor refinement, integration tests with a fake PO subprocess.
- Update or extend the `mcp-engineer-surface` capability spec (or split into `mcp-engineer-surface` and `mcp-po-surface`) to keep the contract explicit.
