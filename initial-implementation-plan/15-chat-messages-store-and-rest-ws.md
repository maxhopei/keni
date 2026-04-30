# Step 15 — chat-messages-store-and-rest-ws

**Phase:** MVP
**Suggested change name:** `chat-messages-store-and-rest-ws`
**Depends on:** 04, 05

## Goal

Persist the user-PO conversation and surface it on the API. After this step, the SPA can post user messages, receive streamed PO replies via WebSocket, and the durable record (`chat/messages.jsonl`) is the single source of truth that conv-to-CR (step 20) processes later.

## Scope

- `ChatMessageStore` interface (extending the storage abstraction set from step 02):
  - `append(message)`, `list(session_id?, since_id?, limit?)`, `markSessionClosed(session_id)`.
  - Entries: `id` (uuidv7, ever-increasing), `session_id`, `role` (`user` | `assistant`), `content`, `created_at`, optional `meta` (e.g., for `session_closed` markers).
- File-backed implementation: `.keni/chat/messages.jsonl` — append-only JSONL. `session_closed` markers are entries with `role: "system"` (or similar) and a typed payload.
- REST chat API:
  - `POST /chat/messages` — user posts a new message. Server appends to `messages.jsonl`. Resolves the active session id (from `state.json` per step 14) or starts a new session if none. Returns the just-written message.
  - `GET /chat/messages?session_id&since_id&limit` — list messages for a session.
  - `POST /chat/sessions/:id/close` — write a `session_closed` marker, clear `active_chat_session_id` in `state.json`, push the closed session id onto the conv-to-CR queue. (User-initiated; PO-initiated wrap-up follows the same flow from step 19.)
- WebSocket additions:
  - `chat.user_message_appended` event so the PO chat-mode runtime (step 19) wakes immediately.
  - `chat.assistant_message_chunk` and `chat.assistant_message_finalised` for streaming PO replies to the SPA. The chunk shape supports token-by-token streaming.
  - `chat.session_closed` event for the SPA chat panel (step 23) to render correctly.

## Out of scope

- The PO subprocess that produces replies — step 19 (chat-mode CLI proxy).
- MCP tools for the PO to read/append messages — step 16.
- SPA chat panel — step 23.
- Conv-to-CR queue processor — step 20 (just enqueues here; popping happens there).

## Spec references

- §2#1 — Environment as communication bus; `messages.jsonl` is the durable channel.
- §2#6 — Chat is one of the "files first, storage abstracted" surfaces; the interface lives here.
- §3 (PO chat) — Closing a chat session writes a `session_closed` marker, clears the active session id, enqueues for conversation-to-CR; further user messages start a new chat session.
- §6.2 (PO chat) — Steps 1–4 describe the message append → wake → response flow.
- §9 — MVP includes `messages.jsonl` schema (uuidv7 id, session_id, role, content, `session_closed` markers); the conv-to-CR checkpoint is the last processed id.
- §11#11 — Chat is a CLI proxy, not a stateful daemon; `messages.jsonl` is the durable record.

## Open decisions for the proposer

- **uuidv7 generator.** Pick a library/implementation. Confirm monotonicity assumption.
- **Streaming chunk shape.** What's the smallest unit — token, character, line? Lean on whatever the coding-agent CLI supports natively (claude / cursor-agent / opencode all stream); document the wire format the SPA consumes.
- **What "system" markers look like in JSONL.** A separate `role: "system"` entry vs. a structured `kind: "session_closed"` field. Pick one and apply consistently.

## Notes for /opsx:propose

- `proposal.md` should frame this as introducing the conversation surface — the user can now send messages and see assistant replies stream back, even though the PO that produces them isn't wired yet (step 19).
- `design.md` should pin: the `ChatMessageStore` interface, JSONL schema, REST endpoints, WS event shapes, session lifecycle on the server side.
- `tasks.md` should cover: store interface + file impl + tests, REST endpoints + tests, WS event additions, queue update on close (against `state.json` from step 14), integration test posting a message and verifying it appears via WS.
- Capability spec for `chat-conversation` documents the contract.
