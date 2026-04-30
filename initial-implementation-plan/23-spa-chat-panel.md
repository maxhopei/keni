# Step 23 — spa-chat-panel

**Phase:** MVP
**Suggested change name:** `spa-chat-panel`
**Depends on:** 11, 15, 19

## Goal

Build the right-panel chat UI that closes the loop with the PO: the user types, sees the PO's reply stream token-by-token, and can wrap up the session at any time. After this step, a non-engineer can drive the team end-to-end through chat.

## Scope

- Right-region panel in the dashboard (collapsible/expandable per §7.2). Hidden in prototype, present and active in MVP.
- Composer: text input + send button. Posts to `POST /chat/messages` (step 15).
- Live transcript:
  - Subscribes to `chat.assistant_message_chunk` and `chat.assistant_message_finalised` events from step 15. Streams the assistant reply token-by-token.
  - On reload, fetches the active session's messages via `GET /chat/messages` and renders them.
  - Distinguishes user vs. assistant messages clearly. Renders `session_closed` markers as visible session boundaries.
- Wrap-up affordance:
  - "Wrap up this conversation" button. Confirmation dialog. Calls `POST /chat/sessions/:id/close`.
  - When the PO itself asks to wrap up (signal detected by step 19), the SPA prompts the user to confirm; on confirm, calls the same close endpoint.
- Concurrent sessions:
  - When a session is closed and the user types a new message, a fresh session starts (the server handles this in step 15). The transcript switches to the new session; the previous (closed) session is accessible via a small history link.
  - The user is allowed to start typing immediately even if the previous session is still being processed by conv-to-CR (§3, §9). Don't block; just show a small status hint.
- Reconnect resilience: on WS reconnect, re-fetch and reconcile.

## Out of scope

- Spec viewer and CR list — step 24.
- Manual override flow — step 25.
- Editing previously-sent user messages — out of MVP.
- Rich content / attachments — out of MVP.

## Spec references

- §3 (PO chat) — Closing rules; wrap-up either by PO-asks-and-user-confirms or user-demands-immediately; subsequent messages start a new session.
- §6.2 (PO chat) — Streaming reply via WS; subprocess exits between turns; thin proxy.
- §7.2 — Right-panel chat is part of the MVP dashboard; expandable.
- §9 — MVP includes the chat API and UI panel; the conv-to-CR queue may be processing while the user starts a new session.
- §11#11 — Chat is a CLI proxy; the SPA must not assume any in-process server-side chat state.

## Open decisions for the proposer

- **Streaming UX details.** Cursor blink, token vs. character display, "PO is typing..." placeholder — pick a feel.
- **History affordance.** How prominent is the "previous closed sessions" history? A simple disclosure in the panel header is sufficient for MVP.
- **PO-initiated wrap-up signal handling.** What does the SPA see when step 19's runtime detects a PO wrap-up signal? Probably a `chat.session_close_requested` event piggybacked on the WS stream; align with step 19's design.

## Notes for /opsx:propose

- `proposal.md` should describe this step as turning chat into a real conversation surface.
- `design.md` should pin: the panel layout, message rendering, streaming UX, wrap-up flow (both user- and PO-driven), concurrent-session UX, reconnect strategy.
- `tasks.md` should cover: panel skeleton, transcript renderer, streaming consumer, composer, wrap-up flow + confirmations, history disclosure, reconnect handling, integration tests against a fake WS.
- Capability spec for `spa-chat-panel` documents the contract.
