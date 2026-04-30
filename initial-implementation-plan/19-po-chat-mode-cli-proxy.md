# Step 19 — po-chat-mode-cli-proxy

**Phase:** MVP
**Suggested change name:** `po-chat-mode-cli-proxy`
**Depends on:** 17, 18, 15, 16

## Goal

Wire the event-driven chat-mode runtime: every new user message wakes the PO via a fresh subprocess that resumes the session-id, the reply streams to the SPA via WS, the conversation persists in `messages.jsonl`, and closing a session enqueues it for conversation-to-CR. No long-lived subprocess, no HTTP layer, no in-process state — exactly the "thin CLI proxy" of §11#11.

## Scope

- Event subscription: listens for `chat.user_message_appended` events from step 15. Each event triggers one chat-mode cycle.
- Cycle algorithm (per §6.2 chat steps):
  1. Read `state.json.active_chat_session_id`. If absent, fresh chat session: spawn the PO subprocess WITHOUT `--resume`; capture the coding-agent session id from the subprocess's structured output; persist to `state.json` and **back-fill** that session id onto the just-written user message (so `messages.jsonl` is correct from the first message).
  2. If present, spawn the PO subprocess with `--resume <session_id>` (or the equivalent flag of the configured coding-agent CLI per §6.4).
  3. Inject the bundled chat-mode prompt from step 18.
  4. The PO replies; output streams to the SPA via WS as `chat.assistant_message_chunk` events. On finalise, append the assistant message to `messages.jsonl` with the same `session_id` and emit `chat.assistant_message_finalised`.
  5. Subprocess exits between user turns. There is no long-running subprocess.
- Closing a chat session (user demand or PO-driven and user confirms):
  - The closing path can be triggered (a) by the user clicking "wrap up" in the SPA (step 23) which calls `POST /chat/sessions/:id/close` from step 15, or (b) by the PO emitting a structured signal in its reply that the runtime detects → calls the same close endpoint.
  - Either path: write `session_closed` marker to `messages.jsonl`, clear `active_chat_session_id`, push the closed `session_id` onto `conversation_to_cr_queue` in `state.json`. (All of this is already implemented in step 15; this step ensures the chat-mode runtime cooperates correctly.)
- Concurrency: subsequent user messages CAN start a brand-new chat session and accumulate in `messages.jsonl` even while the previous session is still being processed by conv-to-CR (step 20). The chat runtime never blocks on conv-to-CR.
- Coding-agent CLI agnosticism (§6.4): `--resume`/`--continue` flags differ across `claude` / `cursor-agent` / `opencode`; this step picks the configured CLI and applies the right flag. The session-id-extraction parser is CLI-specific.

## Out of scope

- The chat-mode prompt content — step 18.
- Conversation-to-CR processing — step 20.
- The SPA chat panel — step 23.
- Real-time presence / typing indicators — out of MVP.

## Spec references

- §3 (PO chat) — Resumes the same coding-agent session id across user turns within one chat session; closing writes `session_closed`, clears active id, enqueues for conv-to-CR.
- §6.2 (PO chat steps 1–4) — The exact algorithm.
- §6.4 — `--resume`/`--continue` requirement for the chat-mode coding agent.
- §11#11 — Chat is a CLI proxy, not a stateful daemon. No long-lived subprocess, no HTTP layer to the coding agent, no in-process chat state.

## Open decisions for the proposer

- **Coding-agent session-id extraction.** Each CLI emits structured output differently. Pick the format the configured CLI uses; document and parse defensively.
- **PO-initiated wrap-up signal.** What does the PO emit so the runtime knows to close? A structured trailing token, a tool call, a specific summary-line prefix? Decide and capture in step 18's chat prompt as well as here.
- **Streaming back-pressure.** If the SPA is slow / disconnected, what happens to the stream? Buffer locally then flush, drop, or block the subprocess? Pick the simplest correct option; document.

## Notes for /opsx:propose

- `proposal.md` should explain the event-driven loop and stress that nothing about it is stateful: `state.json` + `messages.jsonl` are the ONLY shared state.
- `design.md` should pin: event subscription, cycle algorithm with success/failure paths, `--resume` plumbing per CLI, session-id back-fill, close-flow integration with step 15, streaming protocol on the SPA-bound WS.
- `tasks.md` should cover: event subscriber, runtime cycle, CLI-specific `--resume` adapter, session-id parser, close detection (both user- and PO-driven), integration test against a fake coding-agent CLI that exercises both fresh-session and resume paths.
- Capability spec for `po-chat-mode` documents the cycle contract.
