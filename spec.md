# Keni — Vision Spec

**Status:** Vision — draft v2 (Prototype + MVP scope)
**Last updated:** 2026-04-30
**Name:** *Keni* — "Nike" spelled backwards. A nod to *Just do it.*

---

## 1. The Idea

Keni is a **building agent** — a locally-run orchestration system that simulates an autonomous Agile product team and ships software end-to-end. We use *building agent* deliberately, to set Keni apart from the *coding agents* (Claude Code, amp, and the like) it uses as subprocesses. A coding agent writes code when prompted. A building agent owns the whole pipeline: requirements, planning, implementation, review, testing, and verification.

The human user acts as the **customer**. A set of AI agent personas — a Product Owner, one or more Engineers, a QA, and (later) a Technical Writer — operate on a shared set of artifacts: a living specification, a kanban board of tickets, a code repository, a pull request registry, and an activity log.

Agents run on a schedule. On each run, an agent reads the environment, decides what it can act on, performs one focused piece of work, writes the result back to the environment, and exits. Agents never talk to each other directly; all coordination happens through the artifacts they share. Tickets flow between roles through status transitions. The user watches the team work, steers when needed, and reviews what comes out.

The primary goal is to make AI-assisted software building **accessible to non-engineers**, while remaining useful to technical users. The user opens a browser, creates a project, talks to the Product Owner to describe what they want built, and watches the team deliver it — one ticket at a time.

### Problem being solved

Today's AI coding tools either:
- Focus on single-turn code generation inside an IDE (Copilot, Cursor), requiring the user to drive every decision, or
- Orchestrate technical agents in parallel, which is powerful but developer-oriented and assumes the user knows what to build.

Neither models what a software product team actually looks like: a customer with an idea, a product owner who decomposes the idea, engineers who build, and quality gates before shipping. Keni models that structure so that a non-engineer can describe a product and have a functioning software team deliver it.

### Target user

- A non-engineer founder or domain expert with a clear problem to solve
- A solo technical maker who wants an autonomous team rather than a prompting partner
- Explicitly *not* a replacement for enterprise engineering — this is for building small, focused products

---

## 2. Guiding Principles

1. **Environment is the communication bus.** Agents do not message each other. Tickets, spec, PRs, and the activity log are the only shared channels. If information isn't written to an artifact, it doesn't exist.
2. **Fresh session per run.** Every agent cycle starts a new subprocess with no carried-over memory. All learning must be written to the shared environment (via storage interfaces; see #6). This follows the Ralph Loop pattern and eliminates context-overflow failures. *(Narrow exception: the PO chat mode resumes the same coding-agent session id across consecutive user turns within one chat session — necessary to give the user a coherent conversation. Each user turn still spawns a fresh subprocess; only the agent's session state carries over. See §6.2.)*
3. **Status drives behaviour.** An agent's first job on any run is to read the board and decide whether there is anything it can do. Transitions between statuses are the workflow.
4. **Thin wrapper, agentic decisions.** A deterministic role runtime handles infrastructure (logging, prompt selection, environment setup, subprocess lifecycle). The agent itself decides what to pick up and how to approach it.
5. **One concern per session.** An agent cycle addresses one ticket, advances one status, writes one summary line, and exits. No multi-ticket sessions. No blocking on input.
6. **Files first, storage abstracted (with one scoped exception).** The default storage is plain files — markdown for long-form, YAML for structured headers, JSONL for append-only logs. Human-readable, git-friendly, agent-readable. For tickets, PRs, chat messages, activity log, and config this is an *implementation detail*: every consumer (APIs, MCP tools, role runtimes, the SPA) goes through a storage interface, so swapping in a database is an additive new module, not a refactor. The exception: the de-facto spec and change requests are read and written by the PO subprocess as plain files, not via an interface (§5.3 and §11 #5). Everywhere else, no component may rely on the fact that an artifact is a file.
7. **The user can always override.** Any artifact can be edited by the user directly. Status changes by the user are possible but flagged as manual overrides in the log.
8. **Progressive configuration.** Start with a config file and CLI. Move configuration into the UI as each surface stabilises. No UI config in the prototype.
9. **One step at a time.** Prototype first, MVP next, rest deferred. Nothing is built for a phase that hasn't started.

---

## 3. The Team

Each role is an agent persona with a specific responsibility, its own prompt, and its own schedule. A project always has at least a Product Owner. Engineers, QA, and Writer are added on top.

### Product Owner (PO) — owns the spec, change requests, and the backlog

The PO works against two artifacts that together describe the product over time:

- The **de-facto spec** under `.keni/de-facto-spec/` — a set of markdown files describing how the system actually works today. The PO chooses the file organisation (e.g., one file per cross-cutting concern, one per feature). For a brand-new project this is empty; the PO is prompted to bootstrap it by breaking initial requirements into a sequence of CRs (project scaffolding, foundations, then features).
- **Change requests (CRs)** under `.keni/changes/` — one markdown file per proposed modification to the de-facto spec, containing both *proposal* (what & why) and *delta* (the additions, modifications, and removals to apply when accepted). The structure is supplied to the PO as a template in its system prompt.

Responsibilities:

- Converse with the user to elicit what the product should be and do; ask questions to fill gaps; decide on its own how to handle still-open questions.
- When the PO has enough to proceed, ask the user to confirm wrapping up the conversation. The user can also demand wrap-up at any moment.
- Author CRs from closed chat sessions.
- Decompose accepted CRs into tickets, prioritise them, and link them back to the parent CR.
- Fold completed CRs back into the de-facto spec (final gate before tickets in a CR move to `done`).

The PO never touches code, branches, or PRs.

The PO operates in **four modes**. Chat runs event-driven, out-of-band from the scheduler. The other three are picked deterministically by the role runtime on each scheduled cycle (see §6.2):

- **Chat** *(event-driven)* — a user message has arrived. The PO resumes the same coding-agent session id across user turns within one chat session (the id lives in `state.json`, the canonical conversation lives in `chat/messages.jsonl`). Closing a chat session — either when the PO asks and the user confirms, or when the user demands wrap-up — writes a session-end marker, clears the active session id, and enqueues the closed session for conversation-to-CR. Any further user messages start a *new* chat session and accumulate in `messages.jsonl` even while the previous session is still being processed.
- **Conversation-to-CR** *(scheduled, queue-driven, singleton)* — the conversation-to-CR queue contains one or more closed chat sessions waiting to be processed. The runtime picks the oldest, the PO reads its messages, emits zero, one, or many CR files, and advances the message checkpoint past that session. Only one conversation-to-CR run executes at a time; remaining queued sessions wait for the next cycle. A conversation that produces no actionable change still advances the checkpoint and writes nothing.
- **CR-to-tickets** *(scheduled)* — at most one CR with status `proposed` per cycle. The PO decomposes it into tickets, links them to the CR, and sets the CR to `decomposed`.
- **Verify-and-fold** *(scheduled)* — a single combined cycle. When every ticket linked to a `decomposed` CR is `tested`, the PO verifies the work against the CR (see MVP stub in §9; real verification is post-MVP per §10), folds the CR's deltas into the de-facto spec, archives the CR under `.keni/changes/archive/YYYY-MM-DD-<id>/`, and moves all linked tickets to `done` atomically.

### Engineer — owns the code and the reviews

- Picks a ticket from the board (self-assigned, top of priority queue)
- Writes code in a per-agent workspace clone of the repo
- Submits a PR against the main branch
- **Reviews their own PR** in a separate session — critically, as fresh eyes. This is not a human-style peer review (two agents with the same skills and memory gain nothing from passing work back and forth). It is a second-pass check that catches what the first pass missed, benefits from a fresh context window, and lets us ship a single-engineer team.
- Addresses review comments; merges when approved; moves the ticket to `ready_for_test`
- If QA returns the ticket as `test_failed`, picks it back up and fixes it

An engineer works on **one ticket per session**. The next session is a fresh start.

### QA — owns automated verification

- Picks tickets in `ready_for_test`
- Runs the integration test suite on the main branch in a reproducible environment (docker-compose)
- If tests pass, moves to `tested`. If they fail, moves to `test_failed` with a failure summary.
- Does not write code. Does not review code. Does not write tests (engineers do).

QA works on the main branch, not a workspace clone.

### Technical Writer — owns user-facing documentation *(post-MVP)*

- Watches for merged tickets that change observable behaviour
- Updates user-facing docs (`docs/` — separate from the internal spec)
- Does not touch the spec (that's the PO's). Does not touch code.

In the original concept the Technical Writer owns the spec. We've diverged: the **PO owns the spec** (because the spec is product intent, which the PO negotiates with the user), and the **Writer owns the docs** (which describe what was built, derived from code and tickets). This separation keeps each role's responsibility clean.

### The user — customer, not teammate

The user is not an agent. They:
- Describe the product (primarily through chat with the PO; power users may also drop CR files into `.keni/changes/` by hand)
- Watch the board
- Pause, resume, or interrupt agents when needed
- Edit any user-editable artifact when they want to steer (see §7.4)
- Answer the PO's questions in chat (the PO does ask); other agents do not ask in MVP — they decide

---

## 4. How Work Flows

### 4.1 Ticket lifecycle

```
open
 └─► in_progress         (engineer self-assigns, writes impl plan, starts coding)
       └─► ready_for_review   (engineer submits PR)
             └─► in_review          (engineer begins self-review in a fresh session)
                   ├─► has_comments       (review found issues)
                   │     └─► in_progress     (engineer addresses them, loops back)
                   └─► approved           (review clean)
                         └─► merged             (engineer merges to main)
                               └─► ready_for_test
                                     └─► in_testing    (QA picks up)
                                           ├─► tested        (held until PO folds the parent CR)
                                           │     └─► done    (PO verify-and-fold; entire CR at once)
                                           └─► test_failed   (engineer picks up again)
```

A ticket reaches `tested` and stays there until *every* sibling ticket linked to the same CR is also `tested`. At that point the PO's verify-and-fold cycle moves all of them to `done` in one atomic step (see §3 and §6.2). There is no per-ticket `rejected` status — QA can only return work for fixes via `test_failed`, and the PO does not reject individual tickets. Everything that gets built must end up in `tested`, then `done`.

### 4.2 Rules

- Only the **owning role** may transition into their own statuses. The server enforces this. (E.g., the engineer cannot set `tested`; the PO cannot set `merged`.)
- **Failure paths are explicit statuses**, not reverts. `test_failed` is visible on the board; when an engineer picks one up they move it to `in_progress` and proceed.
- **`open` tickets are unassigned**. Any engineer can self-assign. An engineer always checks for their own in-flight tickets before claiming a new one.
- **Priority is a PO-owned integer**. Lower is higher priority. Engineers pick top of their queue.
- **Tickets link back to their CR.** Decomposed tickets carry a `change_request:` property in their YAML header; the verify-and-fold cycle uses this link to gather siblings.
- **User overrides are allowed and logged**. The user can move a ticket to any status from the UI; the event is recorded as `manual_override` in the activity log.

### 4.3 Who creates tickets?

- In the **prototype**, the user creates tickets directly in the UI. There is no PO.
- In the **MVP**, the PO creates tickets from accepted CRs (one CR decomposed per CR-to-tickets cycle). The user can still create tickets directly but is expected to primarily drive via chat. The user may also author a CR by hand by writing a markdown file under `.keni/changes/`; the next CR-to-tickets cycle will pick it up.

---

## 5. The Environment

A project is a folder on the user's machine. **The folder is the code repository** for the app being built — running `ls` inside it shows the app's source files as you'd expect in any git repo. Keni's per-project state lives in a hidden `.keni/` subdirectory at the repo root and is committed alongside the code. Engineer workspaces, which need their own independent git repositories, live **outside** the project tree under `~/.keni/workspaces/`, so nested-git awkwardness is avoided and the project folder stays clean.

The file layout below is Keni's **default file-backed storage**. Per principle #6 in §2, consumers bind to storage interfaces (not to file paths) for tickets, PRs, chat messages, activity log, and config — a future database-backed implementation can replace any of those without touching agents, runtimes, or the SPA. The de-facto spec and change requests are the scoped exception: the PO touches them as files (§5.3).

### 5.1 Project folder

```
my-project/                  ← the project; also the canonical code repo (one .git)
├── .git/                    ← tracks code AND .keni/ together
├── .gitignore               ← excludes .env, .keni/state.json, build artefacts
├── .env                     ← API keys (git-ignored)
├── src/                     ← application source (whatever the stack dictates)
├── docker-compose.yml       ← integration-test environment (part of the app)
├── ...                      ← other code files
└── .keni/                   ← Keni's per-project state, all versioned
    ├── project.yaml         ← project id, name, stack, agent roster, schedules
    ├── de-facto-spec/       ← living description of how the system works today
    │   ├── overview.md      ← multiple .md files; the PO picks the organisation
    │   ├── feature-x.md
    │   └── ...
    ├── changes/             ← change requests (proposed modifications to the de-facto spec)
    │   ├── cr-0001.md       ← one file per CR; proposal + delta in a single template
    │   └── archive/
    │       └── 2026-04-30-cr-0001.md
    ├── tickets/
    │   └── ticket-0001.md   ← one file per ticket (markdown + YAML header; `change_request:` links to its CR)
    ├── prs/
    │   └── pr-0001.md       ← one file per PR record
    ├── chat/                ← (MVP) conversation with the PO
    │   └── messages.jsonl   ← append-only; every entry carries an ever-increasing id
    │                          (uuidv7) and the chat session_id it belongs to
    ├── activity/            ← append-only session log
    │   └── 2026-04-30.jsonl
    └── state.json           ← transient: active chat session id, conversation-to-CR
                                checkpoint (last processed message id), conversation-to-CR
                                queue, cron watermarks — git-ignored
```

Everything under `.keni/` except `state.json` is committed. The project's git history becomes a single inspectable record of what was built, why, and how the team decided to build it.

Both the de-facto spec and change requests are split across multiple markdown files at the PO's discretion; the system prompt teaches the PO how to organise them, including how to bootstrap a brand-new project (typically a sequence of CRs: project scaffolding → foundations → features). There is no single canonical `spec.md` file — wherever this document refers to "the spec" it means the contents of `.keni/de-facto-spec/` taken as a whole.

### 5.2 The global Keni directory

```
~/.keni/
├── config.yaml              ← user-level defaults
├── workspaces/              ← engineer workspaces, one subtree per project
│   └── <project-id>/
│       ├── alice/           ← sparse clone of the project repo (excludes .keni/)
│       │   └── .git/
│       └── bob/
│           └── .git/
└── logs/                    ← server-level logs (not per-session activity)
```

- `~/.keni/config.yaml` holds user-level defaults: preferred coding-agent CLI command, default port range, log level, and any keys/paths shared across projects. Per-project `.keni/project.yaml` overrides globals for that project.
- `~/.keni/workspaces/<project-id>/<agent-id>/` is a fresh clone of the project repo, created when an engineer is added and discarded when removed. Branches are named `ticket-{id}` by convention. `<project-id>` is a stable identifier stored in `.keni/project.yaml` so renaming or moving the project folder does not orphan workspaces.

Note: role prompts are **not** files on disk. They are bundled with Keni's binary or Docker image; see §6.2.

### 5.3 The `.keni/` write boundary

This is a load-bearing rule, with one scoped exception (last bullet):

- Agents **never** write to `.keni/` themselves — not in workspaces, not anywhere. Every change to tickets, PRs, chat messages, activity log, or project config goes through Keni's API (REST for the UI, MCP for agents).
- Keni applies those writes to `.keni/` on the **main branch** of the project repo, atomically.
- Workspace clones are **sparse**: `.keni/` is excluded from checkout. The agent's workspace contains code only. There is no copy of `.keni/` for the agent to accidentally edit, and no chance of two engineers racing on the same ticket file.
- A consequence the user can rely on: feature-branch diffs and code reviews never contain `.keni/` changes. Reviews are about code, full stop.
- **Exception: the PO writes spec and CR files directly.** The PO subprocess runs against the project root (it has no workspace clone) and reads/writes `.keni/de-facto-spec/` and `.keni/changes/` using its native file tools. Markdown editing through MCP is awkward, the spec/CR contents are inherently file-shaped, and forcing them through an interface buys nothing today (per principle #5 below, this is a deliberate concession). Tickets, PRs, status transitions, chat messages, and the activity log still go through MCP — those are the surfaces the status machine guards. The role runtime captures the PO's filesystem changes after the subprocess exits and commits them as a single atomic commit on `main`. Concurrency on spec/CR files is acceptable for MVP because conversation-to-CR is a singleton, CR-to-tickets processes one CR per cycle, and verify-and-fold targets a single CR's deltas at a time.

Status changes propagate naturally through MCP — every agent reads from main's `.keni/` on each cycle, so the view is always fresh and there is nothing to merge.

### 5.4 How agents access the environment

- Engineers receive raw filesystem paths to one place only: their own workspace directory (`~/.keni/workspaces/<project-id>/<agent-id>/`), where they run git, build, and test commands.
- All other reads and writes happen through **MCP tools** exposed by Keni — list/read/update tickets, read spec, create/update PRs, append to activity log.
- Keni is the single gatekeeper for those surfaces. The status machine is enforced in one place; agents cannot bypass it by touching files directly.
- **Exception for the PO.** The PO subprocess runs at the project root and accesses `.keni/de-facto-spec/` and `.keni/changes/` directly with native file tools (read and write). All other PO interactions — listing tickets, creating tickets, reading the chat history, appending to the activity log — still go through MCP. See §5.3 for the rationale.

### 5.5 Git

The project folder is a single git repository. The app's code, `.keni/` state, and the team's full history of decisions are committed together. Engineer workspaces are sparse clones of this repo (origin = the project folder on disk, `.keni/` excluded); their only job is to carry feature branches. Merges land back in the project repo's `main`; the exact mechanism is an architecture concern.

Remote git (GitHub, GitLab, etc.) is optional and out of scope for MVP. The prototype and MVP run entirely against the local filesystem.

---

## 6. How Agents Run

### 6.1 The scheduler

- Each role has a configurable tick schedule. Default cadence: every minute for engineers and QA, **every 5 seconds for the PO**.
- The scheduler ticks; for each enabled agent, it invokes the role runtime.
- The user can pause or resume any individual agent from the UI. Paused agents are skipped by the scheduler.
- **Deterministic precheck.** A short tick interval is only safe because the runtime decides whether there is work *before* spawning a coding-agent subprocess. The PO runtime inspects the conversation-to-CR queue, CR statuses, and ticket statuses on every tick; if no scheduled mode is applicable, the cycle is idle and no LLM tokens are spent. Engineer and QA runtimes apply the same idea: cheap precheck against ticket statuses, spawn only if there is something to pick up.
- **Chat is event-driven, not scheduled.** The chat-mode PO runtime is woken by user-message events from the chat API, independent of the scheduler. Other PO modes wait for the next 5-second tick.

Event-driven triggers for the *engineer* and *QA* roles (e.g., "a ticket moved to `ready_for_test` → wake QA") are **not** in the MVP. Cron-style ticks for those roles keep the system simple and debuggable first.

### 6.2 The role runtime

Each role has a small deterministic wrapper function (e.g., `startEngineerCycle(params)`) that owns *infrastructure only*. For the engineer and QA, every cycle:

1. Log session start to the activity log.
2. Resolve the role's system prompt — bundled with Keni (compiled into the binary or shipped in the Docker image), **not** loaded from a user-editable file.
3. Inject environment context: project name, workspace path, MCP server endpoint.
4. Spawn the coding-agent subprocess (`claude`, `cursor-agent`, `opencode`, or whichever CLI is configured) with the prompt as input.
5. Stream stdout/stderr to the activity log as it runs.
6. On exit, capture the agent's final summary line and log session end.
7. If the agent exits immediately without acting, record an `idle` event.

The runtime **never decides which ticket the agent works on**, **never tells the agent what status to pick**, and **never interprets the agent's output beyond the summary line**. The agent reads the board through MCP, reasons, and writes back. The runtime only handles surrounding concerns.

This is a deliberate "thin wrapper" choice. The agent's prompts are the primary control surface — bundled with Keni's source, so they are versioned and iterated as part of Keni itself, not as per-project assets.

#### PO runtime — precheck, mode selection, and the chat proxy

The PO runtime is shaped slightly differently because it has four modes (§3) and operates against richer state. It still owns infrastructure only — it does not interpret the LLM's output beyond the summary line — but it carries one additional responsibility: **deterministic mode selection before spawning a subprocess**, so a 5-second tick doesn't burn LLM tokens on idle cycles.

A single PO bundle ships **four system prompts**, one per mode. The runtime selects which one to use; the agent decides everything inside that mode.

**On every scheduled tick** (every 5 seconds by default), the PO runtime evaluates these conditions in order and runs the *first* applicable mode for that tick. If none apply, the cycle is idle (no subprocess spawned, no tokens spent):

1. **Conversation-to-CR** — the conversation-to-CR queue is non-empty *and* no conversation-to-CR run is currently active (singleton). The runtime pops the oldest queued session, gathers its messages from `messages.jsonl` (filtered by `session_id`), spawns the PO subprocess with the conversation-to-CR prompt and the messages as input, and on subprocess exit advances the message checkpoint past that session's last id.
2. **Verify-and-fold** — at least one CR with status `decomposed` has every linked ticket in `tested`. The runtime spawns the PO subprocess with the verify-and-fold prompt for that CR (one CR per cycle); on subprocess exit, the runtime atomically moves linked tickets to `done`, archives the CR file under `.keni/changes/archive/YYYY-MM-DD-<id>/`, and commits the de-facto-spec changes.
3. **CR-to-tickets** — at least one CR has status `proposed`. The runtime spawns the PO subprocess with the CR-to-tickets prompt for the highest-priority `proposed` CR (one CR per cycle).

**Chat-mode runs out-of-band** — it is woken by user-message events on the chat API, never by the scheduler:

1. The chat API appends the new user message to `messages.jsonl` with a fresh uuidv7 id and the active `session_id` (or, if `state.json` has no active session id, generates a new chat session by leaving the field empty for now).
2. The runtime spawns the PO subprocess with the chat-mode prompt. If `state.json` has an active coding-agent session id for chat, the runtime passes `--resume <id>` so the coding agent rejoins the same conversation; otherwise it spawns fresh, captures the session id from the agent's structured output, and persists it to `state.json` and back-fills it on the just-written user message.
3. The agent's reply streams to the UI (via WebSocket) and is appended to `messages.jsonl` with the same `session_id`. The subprocess exits between user turns — there is no long-running subprocess. This keeps the implementation a thin CLI proxy with no HTTP layer (per §11 #11 below).
4. **Closing a chat session** happens when either the PO asks the user to wrap up and the user confirms, or the user demands wrap-up at any moment. The chat API writes a `session_closed` marker to `messages.jsonl`, clears the active session id from `state.json`, and pushes the just-closed session id onto the conversation-to-CR queue. Subsequent user messages start a brand-new chat session and accumulate in `messages.jsonl` even if the prior session is still being processed by conversation-to-CR.

The chat session id, the conversation-to-CR queue, and the message checkpoint all live in `state.json` (transient, git-ignored). `messages.jsonl` is the durable record; `state.json` holds the runtime's working state to drive the queue.

### 6.3 Session outputs

Every session produces:
- Zero or more artifact writes (ticket status changes, PR files, code commits, spec updates)
- A series of activity log entries streamed during the run
- A final one-line summary, written by the agent as its last stdout line, captured as the session's headline

The one-line summary is the primary human-readable trace. It shows up in the activity feed and the agent roster ("last activity" label).

### 6.4 Agent-runner agnosticism

The subprocess is any CLI-based coding agent that supports:
- Receiving a system prompt at startup (stdin or file)
- Exiting when its task is done
- Using MCP tools
- For the PO chat mode specifically: resuming a prior session by id (`--resume`/`--continue` or equivalent) and emitting that session id in structured output so the runtime can persist it

Claude Code, Cursor agent, and OpenCode all meet these requirements as of v2026.04. The prototype ships with defaults for one agent; others are configurable per project.

---

## 7. The User Experience

### 7.1 Getting started

1. Install the CLI (`keni`). On first use, Keni creates `~/.keni/` with an empty global `config.yaml`. Role prompts ship with the binary itself, not as files.
2. Run `keni init` in an empty or existing folder. This initialises git if needed, creates the `.keni/` metadata directory, writes a `project.yaml` with a generated project id, and stages initial commits.
3. Run `keni start` in the project folder to boot the orchestration server. It prints a browser URL.
4. Open the URL. The SPA loads.
5. In the prototype: the user creates tickets directly. In the MVP: the user chats with the PO.

One server instance manages one project. For multiple projects, the user runs `keni start` in each project folder separately, each on its own port. Every artifact in the data model carries a project id so that a future multi-project server or UI switcher is a pure additive change.

API keys live in a `.env` file at the project root (MVP), git-ignored. Global defaults can live in `~/.keni/config.yaml`. Moving key management into the UI is post-MVP.

### 7.2 The dashboard

The primary view has three regions:

- **Agent roster (left).** Each agent shows: name, role, current status (idle / running), last activity summary, last active timestamp, and a pause/resume toggle.
- **Kanban board (center).** Columns map to ticket statuses. Cards show ticket id, title, assignee, priority. The board updates live as agents move tickets.
- **PO chat (right, MVP).** Expandable panel. User types; the PO chat-mode runtime (event-driven, not on the scheduler) wakes immediately, streams the response token-by-token to the panel via WebSocket, and persists every turn to `messages.jsonl`. The user, or the PO when it has enough information, can wrap up the session at any time; that closes the chat session and queues it for conversation-to-CR.

### 7.3 Other views

- **Activity log** — filterable by agent, role, date range. The primary debug surface. Every session is visible. References to tickets, PRs, and CRs are rendered as links.
- **Ticket detail** — full ticket content, status history, comment thread, implementation plan, linked PR, link to its parent CR, edit controls.
- **PR detail** — source/target branches, intent, linked ticket, status.
- **Spec viewer** *(MVP)* — read-only browser of `.keni/de-facto-spec/` as a multi-file document tree. Direct UI editing of the de-facto spec is post-MVP (see §10).
- **Change requests view** *(MVP)* — list of pending and archived CRs with status (`proposed`, `decomposed`, archived); click-through to the CR's contents and its decomposed tickets.
- **Project settings** — shows current config. Pause/resume agents, view schedules. UI-level editing of config is post-MVP; for now the config file is the source of truth.

### 7.4 What the user can edit

| Artifact          | User-editable                 | System-managed (override possible, logged) |
| ----------------- | ----------------------------- | ------------------------------------------ |
| De-facto spec     | Not in MVP (see §10)          | Yes (PO writes via fold)                   |
| Change request    | Authoring by hand: yes (write a file under `.keni/changes/`); editing after decomposition: post-MVP | Yes (PO writes via conversation-to-CR) |
| Ticket title/body | Yes                           | —                                          |
| Ticket status     | (override, confirmation)      | Yes                                        |
| Ticket assignee   | (override, confirmation)      | Yes                                        |
| PR intent         | Yes                           | —                                          |
| PR status         | (override, confirmation)      | Yes                                        |
| Agent config      | Schedule, enabled             | Role, workspace path                       |

Override actions show a confirmation prompt and are recorded as `manual_override` events in the activity log. A user-authored CR in `.keni/changes/` will be picked up by the next CR-to-tickets cycle just like a PO-authored one.

### 7.5 Interruption and timeouts

The user can interrupt an active agent session from the UI. The runtime sends `SIGTERM` to the subprocess, waits a short grace period, and then `SIGKILL`s if needed. A `session_interrupted` event is recorded.

Each role runtime also enforces a per-role session timeout (default on the order of tens of minutes, configurable). Timed-out sessions are terminated the same way and logged as `session_timeout`.

In both cases the ticket's status is **not** auto-reverted. Because all state writes go through MCP and are atomic at the artifact level, there is no partial-state corruption — the ticket simply reflects whatever the agent last committed. A human reviews if something looks stuck.

---

## 8. Scope — Prototype

The prototype validates the core loop: **user → ticket → engineer → PR → merge → ready_for_test**.

### Included

- CLI: `keni init`, `keni start <project-path>`.
- Orchestration server with REST + WebSocket API.
- Browser SPA: dashboard (board + agent roster) + activity log view + ticket detail view.
- Kanban capabilities (create, update, list, status-transition enforcement).
- Activity log capabilities (append, query).
- MCP surface for: tickets, activity log, workspace path.
- One Engineer role runtime with an opinionated TS/Deno/React prompt.
- Per-project config file (`.keni/project.yaml`) and global config file (`~/.keni/config.yaml`).
- One pre-configured engineer agent (default name: `alice`).
- Project folder layout with versioned `.keni/` directory (see §5.1).
- Global `~/.keni/` directory for user-level config and workspace clones (see §5.2).
- Git workspace provisioning: clone of the project repo into `~/.keni/workspaces/<project-id>/alice/` on agent add.
- Docker-compose (project-level) used by each workspace for integration-test runs.
- Ticket files (markdown + YAML header) under `.keni/tickets/`.
- PR registry (markdown files) under `.keni/prs/`.
- Cron-driven scheduler (1-minute default).
- Pause/resume per agent in UI.

### Excluded from prototype

- PO, QA, Writer roles.
- Chat interface.
- Spec document workflow (user writes tickets directly; no spec file is maintained).
- Multiple engineers.
- Event-driven scheduling.
- UI-driven project configuration.
- Manual artifact change detection (file watchers, spec diffing).
- Override confirmations and `manual_override` flow (direct file edit only).

---

## 9. Scope — MVP (extends Prototype)

The MVP makes the system usable by a non-engineer by introducing the Product Owner. The user no longer writes tickets directly; they describe the product in chat, the PO captures the conversation as change requests, and CRs become tickets that the engineer team builds.

### Added in MVP

- PO role runtime with **four modes**: chat (event-driven), conversation-to-CR (scheduled, singleton, queue-driven), CR-to-tickets (scheduled), verify-and-fold (scheduled). Tick cadence: every 5 seconds, with deterministic precheck so idle ticks burn no LLM tokens.
- Four bundled PO system prompts (one per mode). Each is opinionated about its job:
  - chat — eliciting requirements, asking gap-filling questions, asking the user to confirm wrap-up when ready;
  - conversation-to-CR — turning a closed chat session into one or more CR files, including the new-project bootstrap pattern (scaffolding → foundations → features);
  - CR-to-tickets — decomposing a `proposed` CR into linked tickets;
  - verify-and-fold — folding an accepted CR into the de-facto spec.
- Chat API and UI panel on the dashboard. The chat-mode runtime is a CLI proxy: each user turn spawns a fresh coding-agent subprocess with `--resume <session_id>`; the session id is stored in `state.json` and persisted on every message in `messages.jsonl`. No HTTP layer to the coding agent.
- `.keni/de-facto-spec/` — multi-file markdown directory; the PO chooses the layout (typically one file per cross-cutting concern or feature).
- `.keni/changes/<cr-id>.md` — one file per CR, holding *proposal* and *delta* in a single template (template comes from the PO system prompt). Archive at `.keni/changes/archive/YYYY-MM-DD-<cr-id>/`.
- Conversation-to-CR queue in `state.json`: closed chat sessions enqueue here; the runtime processes one per cycle and enforces singleton execution. Further user messages can wrap up new sessions while a previous CR cycle is running — they simply queue.
- `messages.jsonl` schema: every entry carries an ever-increasing `id` (uuidv7), the `session_id` it belongs to, role (user / assistant), and content. Session boundaries are recorded as explicit `session_closed` markers. The conversation-to-CR checkpoint is the last processed `id`.
- MCP surface for tickets, PRs, chat (read messages, append messages, close session), and activity log. **Spec and CR files are read/written by the PO directly via the project root** — no MCP layer for those (see §5.3).
- Verify-and-fold flow. Real verification is **stubbed in MVP**: the PO does not check whether the implemented tickets actually satisfy the CR; it folds the CR's deltas into the de-facto spec and moves all linked tickets from `tested` to `done` as soon as the fold predicate is satisfied. Real verification (and drift detection) is post-MVP — see §10.
- Atomic fold: rewriting de-facto-spec files, archiving the CR file, and updating linked ticket statuses land in a single git commit on `main`.
- Ticket detail and PR detail views; spec viewer (read-only); CR list view.
- Multiple engineer agents running in parallel, each with their own workspace.
- Per-agent schedule configuration in the config file.
- `.env` support for API keys.
- `manual_override` event logging for user-triggered status changes.

### Excluded from MVP

- QA agent (the `ready_for_test` column exists; tickets sit there until the user manually moves them, or tooling moves them, or the MVP is extended).
- Technical Writer role.
- Event-driven triggers for engineer/QA roles (PO chat is the only event-driven path; engineer/QA still tick on their cron).
- UI-based project configuration editing.
- UI editing of the de-facto spec or of decomposed CRs.
- Real PO verification of implemented work against the CR (folding happens unconditionally once tickets are `tested`).
- Drift detection between de-facto spec and actual code.
- Remote git (everything local).
- Multi-project switcher in the UI (data model supports multiple projects; UI does not).
- File-watcher reactivity on manual artifact edits (the user edits through the UI in MVP; direct edits to the de-facto spec or to a `decomposed` CR are not re-derived).
- Multi-CR processing per cycle (one CR per CR-to-tickets cycle, one CR per verify-and-fold cycle).
- Resolution of fold conflicts between two CRs touching the same area (MVP fails loudly and asks the user to resolve manually).

---

## 10. Beyond MVP

The following are known directions and deliberately out of scope for MVP:

- **QA agent.** Fully automates the `ready_for_test → tested / test_failed` transition.
- **Real PO verification of implemented CRs.** Replaces the MVP fold-stub: before folding a CR, the PO actually checks completed work against the CR's intent. Mismatches do not change ticket status (no `rejected` — see §4) but produce follow-up tickets linked to the same CR; the fold blocks until those land.
- **Drift detection.** A periodic PO cycle that walks the de-facto spec against the actual code and flags drift (built things the spec doesn't describe; spec sections the code no longer matches). Drifts produce new tickets so the implementation matches the spec; user approval is likely required before drift-resolution tickets are created.
- **Direct user edits to the de-facto spec or to a `decomposed` CR.** A file watcher detects manual edits, marks artifacts dirty, and either re-derives downstream tickets or queues a reconciliation cycle. Out of MVP — the MVP simply ignores these edits until the next natural touchpoint.
- **User-authored CR UI affordance.** A "create change request" button in the dashboard. (In MVP, a power user can still drop a markdown file into `.keni/changes/` by hand and the next CR-to-tickets cycle will pick it up.)
- **Multi-CR throughput.** Process more than one CR per cycle when applicable; resolve fold conflicts between two CRs that both touch the same area of the de-facto spec.
- **Technical Writer role.** Maintains user-facing `docs/` as code lands.
- **Event-driven scheduling for engineer/QA.** Status transitions wake the appropriate next role; cron becomes a fallback.
- **UI-based configuration.** Fully editable project config, agent roster, API keys from the browser.
- **Remote git.** Optional remote origin; PRs on real platforms (GitHub/GitLab).
- **Multi-project UI.** Switcher, multiple boards, cross-project views.
- **Brownfield support.** Onboarding an agent onto an existing codebase it didn't write.
- **Additional stacks.** Beyond the MVP's TS/Deno/React web-app target.
- **Prompt customisation and iteration tooling.** Per-project (and possibly per-agent) prompt overrides; first-class surface for versioning, testing, and A/B-comparing prompts. (The PO already ships four prompts in MVP; this work generalises that to other roles and to user-defined variants.)

---

## 11. Key Design Decisions

A few choices are load-bearing and worth surfacing explicitly:

1. **Environment as communication bus, not message-passing.** Agents never call each other. This means a single well-modelled ticket board is the entire coordination layer, which is simple to reason about and observe.

2. **Fresh context per session.** Every cycle spawns a new subprocess with no carried-over memory. This eliminates context-window runaway, makes failures isolated, and forces all learning into externalised state — which doubles as our audit trail.

3. **Thin wrapper, agentic decisions.** The runtime handles process lifecycle; the agent handles decisions. The agent's prompts are the primary tuning surface — and they *are* code: bundled with Keni's binary/Docker image, no FS-based overrides. They evolve with Keni itself. Failures typically show up in the prompt rather than the infrastructure, which is easier to debug. Per-project prompt customisation is a deliberate post-MVP choice.

4. **Engineer self-review in a new session.** Two agent instances with identical skill and zero shared memory gain nothing from a human-style handoff. A second-pass review in a fresh session captures the value of "fresh eyes" and works for single-engineer teams.

5. **Files first, storage abstracted — with one scoped exception.** Default storage is markdown + YAML for tickets, PRs, and configs; plain markdown for specs and CRs; JSONL for activity logs and chat. The benefit today is zero infra, full diff-ability, and a project git history that doubles as a team-decision record. The architectural commitment: every consumer accesses storage through an interface, so a database-backed implementation (for any artifact type) is an additive new module, not a system rewrite. The exception: the de-facto spec and change requests are read and written by the PO subprocess as plain files, not via an interface (§5.3). Markdown editing through an interface buys nothing useful, and the PO is structurally a single writer for those artifacts. Everywhere else the abstraction holds.

6. **Explicit failure statuses.** `test_failed` is a first-class board column (or badge), not a silent revert. The user sees at a glance which tickets are stuck and why. There is no `rejected` status — QA returns work for fixes via `test_failed`, and the PO does not reject individual tickets; everything that gets built lands in `tested` and then `done` via CR fold.

7. **One ticket per session.** An engineer run does one thing: pick, work, exit. No multi-ticket batches. This caps blast radius, keeps sessions short, and makes scheduling predictable.

8. **Whole project in one git repo** *(a benefit of the file-backed default; see #5)*. With files in `.keni/`, code + tickets + specs + activity log + config are committed together, and the project's own git history becomes the team's decision record. A future DB-backed swap would replace this with whatever audit mechanism that store provides.

9. **De-facto spec + change requests; PO owns the lifecycle.** The spec is split in two artifacts: the **de-facto spec** (`.keni/de-facto-spec/`) describes how the system works today; **change requests** (`.keni/changes/`) describe proposed modifications. The PO converts user conversations into CRs (one or many per session), decomposes accepted CRs into tickets, and folds completed CRs back into the de-facto spec. The pattern is borrowed from OpenSpec and gives Keni a clean separation between intent-in-flight and intent-already-built. The Writer (post-MVP) owns user-facing docs derived from code — different role, different input, different audience.

10. **Engineer workspaces are code-only; metadata is API-managed.** Engineer workspaces are sparse clones with `.keni/` excluded from checkout, so two engineers cannot race on a ticket file because neither can see one — and code reviews are inherently `.keni/`-free. Tickets, PRs, statuses, chat messages, and the activity log all flow through Keni's API on `main`. The PO is the one scoped exception (#5 above and §5.3): it reads and writes `.keni/de-facto-spec/` and `.keni/changes/` directly. Everything else stays API-only.

11. **Chat is a CLI proxy, not a stateful daemon.** The chat-mode PO runtime is a thin event-driven proxy: each user turn spawns a fresh coding-agent subprocess with `--resume <session_id>`. The session id lives in `state.json`; the conversation is durably stored in `chat/messages.jsonl`. We deliberately do not run an HTTP server in front of the coding agent, do not keep a long-lived subprocess, and do not maintain any in-process chat state — all of that is premature optimisation for the MVP. The agent CLI's native session-resume is sufficient.

12. **Prototype is intentionally bare.** No PO, no chat, no spec file. Just a user and an engineer. If that loop doesn't work smoothly, nothing else will. Every MVP feature extends this validated core.

---

## 12. Open Questions

Things we know we don't know. Each is non-blocking for MVP but will need a decision as we build.

- **Fold conflict resolution.** Two CRs touch the same area of the de-facto spec and both reach the foldable state — the second fold needs a 3-way merge. MVP fails loudly and asks the user to resolve manually. Post-MVP needs a real strategy.
- **CR granularity from one chat session.** Conversation-to-CR may emit one or many CRs from a single session. The split heuristic lives in the system prompt; iterate once we see real output.
- **PO ticket format.** User story vs. imperative task vs. Gherkin-style acceptance criteria. Left to the PO prompt; iterate once we see real output.
- **Drift between built and described.** When engineers ship something off-target, the de-facto spec lies. MVP trusts the engineers. Post-MVP introduces a drift-detection cycle that produces follow-up tickets — exact UX (auto-create vs require user approval) is open. See §10.
- **Manual artifact edits.** How does the system react to the user editing the de-facto spec or a `decomposed` CR file directly on disk? MVP ignores. Post-MVP likely a lightweight file watcher that marks artifacts dirty and nudges the relevant agent on its next run.
- **Parallel engineer conflicts.** Two engineers working in different workspaces may both pull `main`, commit, and race on merge. Candidate resolution: merge attempts are atomic on the server; a loser sees a conflict, the ticket goes back to `in_progress` with a `merge_conflict` comment, the agent re-plans on its next run.
- **Brownfield onboarding.** How does an engineer start on a codebase it didn't author? Conventions from Ralph Loop (AGENTS.md, progress.txt) are a starting point. Out of scope for MVP but shapes prompt design.
- **QA integration-test strategy.** What does an integration test look like for a CRUD-shaped TS/Deno/React app, and how does QA evaluate "passed" versus "actually satisfies the spec"? Design when we build QA.
- **Interrupt safety.** When the user kills an active session, a partially-complete operation (e.g., half-written file in the workspace) may be left on disk. How do we signal or clean that up? Likely: on the next session, the agent reads the ticket state, sees `in_progress` with stale work, and either continues or restarts.
- **Coding-agent capability ceiling.** Which coding agents actually work well as Keni engineers and as the PO chat proxy? We'll maintain a compatibility note as we test.

---

## 13. Glossary

- **Agent (Keni agent)** — an AI persona (PO, Engineer, QA, Writer) realised as a role runtime + one or more prompts + subprocess invocation.
- **Artifact** — any file the agents or user read and write: de-facto spec, change request, ticket, PR, activity log entry, chat message, config.
- **Board** — the kanban view of all tickets in a project, grouped by status.
- **Building agent** — a product-level orchestration agent that simulates a software team and ships an application end-to-end. Keni is a building agent. Distinct from a coding agent.
- **Change request (CR)** — a markdown file under `.keni/changes/` describing a proposed modification to the de-facto spec. Holds *proposal* (what & why) and *delta* (the additions/modifications/removals to apply on fold) in a single template. Statuses: `proposed` (just authored, awaiting decomposition), `decomposed` (tickets exist), then archived after fold.
- **Coding agent** — a CLI tool that generates code from a prompt (Claude Code, Cursor agent, OpenCode, etc.). Keni invokes coding agents as subprocesses inside its role runtimes; the coding agent is the engine, Keni is the team around it.
- **Conversation-to-CR** — the PO mode that turns a closed chat session into one or more CR files. Singleton; queue-driven.
- **Cycle** — one scheduled run of a Keni agent. Begins when the scheduler invokes the role runtime; ends when the subprocess exits. (The chat-mode PO is event-driven and not strictly a "cycle" in this sense — see §6.2.)
- **De-facto spec** — the contents of `.keni/de-facto-spec/`. A multi-file markdown description of how the system works today. Updated only by the PO's verify-and-fold cycle, never written speculatively. Replaces the original single-file `spec.md` notion.
- **Environment** — the full set of project artifacts a Keni agent can read from and write to.
- **Fold** — applying an accepted CR's deltas into the de-facto spec, archiving the CR, and moving its linked tickets to `done`. Atomic (one git commit). Performed by the verify-and-fold PO mode.
- **MCP** — Model Context Protocol; the mechanism by which coding-agent subprocesses interact with Keni's APIs (excluding the de-facto spec and CRs, which the PO touches as plain files — see §5.3).
- **Ralph Loop** — the underlying pattern: short, fresh, single-purpose agent sessions driven by external state. Keni is an evolution of that idea into a full team simulation.
- **Role runtime** — the thin deterministic wrapper that owns subprocess lifecycle and logging for a given role (e.g., `startEngineerCycle`). The PO's runtime additionally performs deterministic mode selection on every tick (§6.2).
- **Spec** — short for de-facto spec. (In the original design this was a single file; in the current design it is a directory of markdown files.)
- **Verify-and-fold** — combined PO mode: verify completed work against its CR, then fold the CR into the de-facto spec. Verification is stubbed in MVP (the fold happens unconditionally once tickets reach `tested`); real verification is post-MVP.
- **Workspace** — an engineer agent's own clone of the code repo, where it runs git and build commands.
