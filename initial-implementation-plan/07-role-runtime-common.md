# Step 07 — role-runtime-common

**Phase:** Prototype
**Suggested change name:** `role-runtime-common`
**Depends on:** 05, 06

## Goal

Build the deterministic thin wrapper that every role's runtime extends — `startCycle(params)` and friends. After this step, any role can be plugged in by providing (a) a precheck function, (b) a bundled prompt to inject, and (c) optional pre/post hooks. The wrapper owns subprocess lifecycle, logging, prompt resolution, and summary capture; nothing else.

## Scope

- A common `RoleRuntime` interface exposing `startCycle(params)`. `params` includes role identity, agent id, project id, scheduling context, and any role-specific extras.
- Cycle steps (mirroring `spec.md` §6.2 step list for engineer/QA, generalised):
  1. Log session start to the activity log via the API/storage interface (NOT direct file write).
  2. Resolve the role's bundled system prompt — a string compiled into the binary, **never loaded from a user-editable file** (§11#3).
  3. Inject environment context: project name, agent id, workspace path (when applicable), MCP endpoint.
  4. Spawn the coding-agent subprocess (CLI from config: `claude` / `cursor-agent` / `opencode` / etc.) with the prompt.
  5. Stream stdout and stderr to the activity log as it runs.
  6. On exit, capture the agent's final stdout line as the session's summary; log session end with exit code and summary.
  7. If the agent exits immediately without acting, record an `idle` event.
- Subprocess utilities: graceful termination (SIGTERM grace period → SIGKILL), exit-code handling, environment variable propagation.
- Pluggability: each role provides a precheck function called before spawning. The PO uses precheck heavily for mode selection (step 17); the engineer uses it for "is there a ticket I can pick up?" (step 09).
- A tiny adapter that lets the runtime emit `agent.state_changed` events through the orchestration server (step 05) without depending on transport details.

## Out of scope

- Scheduling / tick loop (step 08).
- Engineer-specific concerns (workspace, prompt content, integration tests) — step 09.
- PO-specific extensions: precheck-driven mode selection, atomic post-subprocess commit — step 17 builds these on top of this wrapper.
- `--resume` plumbing for chat — handled by step 19, but the runtime in this step accepts an optional `resume_session_id` parameter and forwards it to the subprocess so step 19 doesn't need to refactor.

## Spec references

- §2#2 — Fresh session per run; the runtime guarantees this.
- §2#4 — Thin wrapper, agentic decisions; the runtime never decides what the agent works on or interprets output beyond the summary line.
- §2#5 — One concern per session; the runtime returns after one cycle.
- §6.2 — Step-by-step contract this step implements (for engineer/QA shape; PO extends).
- §6.3 — Session outputs (artifact writes, log entries, one-line summary).
- §6.4 — Subprocess agnosticism; the runtime must not assume a specific CLI.
- §11#3 — Prompts as code, bundled with the binary.

## Open decisions for the proposer

- **Bundled prompt resolution.** Decide how prompts are compiled in (e.g., string constants, embedded resources). Affects how step 09 ships the engineer prompt and step 18 ships the PO prompts.
- **Activity log streaming granularity.** Per stdout chunk vs. per line vs. periodic flush. Per-line is the obvious default; document the choice.
- **Summary line extraction.** The agent emits a single final line per §6.3. Be explicit: how do you identify "the final line" — last non-empty line of stdout? Document in `design.md`.

## Notes for /opsx:propose

- `proposal.md` should frame this as the spine that every role runs on, and emphasise its determinism.
- `design.md` should pin the `RoleRuntime` interface, the cycle algorithm with each step's guarantees, error handling (subprocess crashes, timeouts will be enforced at scheduler level in step 08), and prompt resolution.
- `tasks.md` should cover: interface + types, cycle implementation, subprocess utilities, summary-line extraction, prompt resolution, unit tests with a fake subprocess, integration test that drives a no-op subprocess end-to-end and verifies activity log entries.
- Capability spec for `role-runtime` documents the lifecycle contract.
