# Step 06 — mcp-server-for-engineers

**Phase:** Prototype
**Suggested change name:** `mcp-server-for-engineers`
**Depends on:** 04

## Goal

Expose Keni's API to coding-agent subprocesses through an MCP server. After this step, an engineer subprocess can list and read tickets, transition statuses (subject to the same role guards from step 04), append activity log entries, and resolve its workspace path — and **only** those — using MCP tools.

## Scope

- MCP server (stdio or local transport) hosted by the orchestration server from step 04.
- Tools exposed:
  - **Tickets**: `list_tickets`, `read_ticket`, `update_ticket_body`, `transition_ticket_status`. Status transitions go through the same enforcement as REST.
  - **Activity log**: `append_activity_entry`, `query_activity` (with sensible default limits).
  - **Workspace**: `get_workspace_path` — returns the absolute path of the current agent's workspace clone (set up by the role runtime in step 07; populated for engineers in step 09).
- Identity: each subprocess receives an `agent_id` so the MCP server can attribute writes and enforce the owning-role rule.
- Each tool descriptor is precise about parameters, errors, and idempotency, and is concise enough to fit in a system prompt without burning tokens.
- The MCP server reuses the storage interfaces / API layer from steps 02 and 04 — no duplicate logic.

## Out of scope

- PO-specific tools (chat, ticket-create-from-CR, PR-read) — step 16.
- Any tool that reads or writes `.keni/de-facto-spec/` or `.keni/changes/` — those are PO-direct (§5.3) and not MCP-served.
- Tools for editing PR records — engineers create/update PRs through the role runtime's git/PR handling, not MCP, in the prototype. (PR record CRUD is on the REST surface for the SPA; engineer-initiated PR record creation can go through a future MCP tool if needed — flag this in `design.md` if it complicates step 09.)
- WebSocket tools — MCP is request/response.

## Spec references

- §5.3 — `.keni/` write boundary; engineers go through the API. MCP is the API for engineers.
- §5.4 — "All other reads and writes happen through MCP tools exposed by Keni."
- §6.4 — Subprocess agnosticism; the MCP surface is what makes that possible.
- §8 — Prototype "Included" list specifies MCP for tickets, activity log, and workspace path.

## Open decisions for the proposer

- **Transport.** Stdio is the standard for MCP and the natural fit because the role runtime spawns the subprocess; HTTP is also a valid option. Pick stdio for now and document.
- **Tool granularity.** Aggregate tools (e.g., a single `update_ticket` that accepts a partial) vs. focused tools. Focused is easier for prompts to reason about; pick that and document.
- **Concurrency / locking.** Two engineers in MVP could race on the same ticket. Step 26 introduces multi-engineer; for now ensure the MCP layer composes cleanly with step 04's request-level guards. Note in `design.md` what survives multi-engineer.

## Notes for /opsx:propose

- `proposal.md` should describe MCP as the engineer's only legitimate write surface beyond their workspace.
- `design.md` should: list each tool with parameters and errors, sketch the agent-id propagation, and clarify how the role runtime hands the MCP endpoint to the subprocess.
- `tasks.md` should cover: MCP server bootstrap, each tool implementation + tests, agent-id propagation, integration test that wires a fake "agent" using the MCP tools end-to-end against a temp `.keni/`.
- Capability spec for `mcp-engineer-surface` documents the tool contract for verification later.
