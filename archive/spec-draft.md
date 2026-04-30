# Builder Agent — Product Specification

**Version:** 0.1 (Prototype → MVP)  
**Status:** Draft  
**Last updated:** 2026-04-29

---

## 1. Concept

Builder Agent is a locally-run orchestration system that simulates an autonomous Agile product team. The user acts as the customer. A set of AI agent personas — Product Owner, Engineer(s), QA, and optionally others — operate on a shared ticket board, codebase, and spec documents. Agents run on a schedule, read their environment, decide what to do, and write their results back to that environment. They never communicate with each other directly; all coordination happens through shared state: tickets, specs, PRs, and an activity log.

The system is inspired by the Ralph Loop pattern: each agent session is a fresh context window. Memory is externalised entirely into files. Every run is small and focused.

The primary goal is to make AI-assisted software building accessible to non-engineers, while remaining useful to technical users. The interface is a browser SPA served by a local orchestration server started via CLI.

---

## 2. Core Principles

- **Fresh context per session.** Each agent run is a new subprocess. There is no shared in-memory state between runs. All learning must be written to files.
- **Environment as communication bus.** Agents do not talk to each other. Tickets, spec documents, PR files, and the activity log are the only channels.
- **Ticket status drives behaviour.** An agent's first job on each run is to read the board and decide what, if anything, it can act on. Status transitions are the workflow.
- **Thin wrapper, opinionated agent.** The role runtime (the wrapper around the subprocess) handles infrastructure: logging, prompt loading, env injection, start/stop. The agent itself reasons about what to do.
- **Minimal setup, progressive configuration.** Start with a config file and CLI. Move configuration to UI over time.
- **One step at a time.** Build the prototype first. The MVP extends it. Nothing is over-engineered for a phase that hasn't started.

---

## 3. System Architecture

### 3.1 Runtime Overview

```
User (browser)
    │  HTTP / WebSocket
    ▼
Orchestration Server  (Node / Deno, local)
    ├── Project API
    ├── Kanban API         ◄─── also exposed as MCP
    ├── Backlog API        ◄─── also exposed as MCP
    ├── Spec API           ◄─── also exposed as MCP
    ├── Activity Log API   ◄─── also exposed as MCP
    ├── Scheduler          (cron-based, per role, per project)
    └── Role Runtimes
            └── startEngineerCycle(params)
                    └── spawns subprocess: claude / amp / etc.
                            reads env via MCP tools
                            writes env via MCP tools
                            exits when done
```

### 3.2 Project Folder Structure

```
{project-root}/
├── specs/
│   ├── spec.md              # Primary living specification (source of truth)
│   ├── prd.md               # Product Requirements Document (generated/refined)
│   └── archive/             # Superseded spec snapshots
├── code/                    # Main branch (canonical repo)
│   └── .git/
├── workspaces/
│   ├── alice/               # Engineer agent workspace
│   │   └── .git/            # Clone of code/
│   └── bob/                 # Second engineer workspace (if added)
│       └── .git/
├── prs/                     # Internal PR registry
│   └── pr-0001.md
├── tickets/                 # Ticket store (one file per ticket)
│   └── ticket-0001.md
├── activity/                # Activity log
│   └── 2026-04-29.log
└── .builder/
    └── config.json          # Per-project config
```

All data is plain files. The server reads and writes this structure. Agents access it exclusively through MCP tools — they never get a raw filesystem path to the project (with the exception of their own workspace).

### 3.3 MCP Surface

The orchestration server exposes MCP tools that agents call during their session:

**Kanban / Tickets**
- `list_tickets(filter)` — returns tickets matching status, assignee, priority order
- `get_ticket(id)` — full ticket detail
- `update_ticket(id, fields)` — update status, add comment, set assignee
- `create_ticket(fields)` — PO only

**Spec**
- `get_spec()` — returns current spec.md content
- `get_prd()` — returns prd.md content
- `update_spec(content)` — PO only

**PRs**
- `list_prs(filter)`
- `get_pr(id)`
- `create_pr(fields)`
- `update_pr(id, fields)`

**Activity Log**
- `log_activity(entry)` — append a structured log entry
- `get_activity(filter)` — query log for UI display

**Workspace** (injected per agent, not global)
- `get_workspace_path()` — returns absolute path to this agent's workspace clone

### 3.4 Role Runtime

Each role has a runtime function (e.g. `startEngineerCycle`) that:

1. Logs session start to activity log (deterministic)
2. Resolves the system prompt from the role's configured prompt file
3. Injects environment context: project name, ticket board summary, workspace path, MCP server URL
4. Spawns the coding agent subprocess with the prompt
5. Captures stdout/stderr and streams to activity log
6. On exit: reads the agent's final summary line (last stdout line by convention), logs session end with summary
7. Reports idle (no-op) if agent exits immediately without acting

The runtime owns nothing about *what* the agent decides to do. That is fully the agent's responsibility.

---

## 4. Data Models

### 4.1 Ticket

```
id:           ticket-0001  (sequential, human-readable)
title:        string
description:  markdown (free text, may include acceptance criteria)
status:       enum (see §5)
assignee:     agent-id | null
priority:     integer (lower = higher priority, PO-managed)
created_at:   ISO8601
updated_at:   ISO8601
comments:     append-only list of { author, timestamp, body (markdown) }
impl_plan:    markdown | null  (written by engineer when picking up ticket)
```

Stored as a single markdown file with YAML frontmatter. The markdown body is the description + implementation plan. Comments are appended as markdown sections.

### 4.2 PR

```
id:             pr-0001
ticket_id:      ticket-0001
source_branch:  workspaces/alice  (or feature branch name)
target_branch:  code (main)
status:         open | changes_requested | approved | merged
intent:         markdown (brief description of what this PR does)
created_at:     ISO8601
updated_at:     ISO8601
```

Stored as markdown file in `/prs/`.

### 4.3 Activity Log Entry

```
timestamp:    ISO8601
project_id:   string
agent_id:     string  (alice, po, qa, system)
role:         engineer | po | qa | system
session_id:   uuid
event:        session_start | session_end | status_change | comment | idle
summary:      string (one line)
refs:         list of { type: ticket|pr|spec, id: string }  (standard format for future UI linking)
```

Stored as append-only JSONL per day in `/activity/`.

### 4.4 Project Config (`.builder/config.json`)

```json
{
  "name": "My Project",
  "stack": "typescript-deno-react",
  "agent_command": "claude",
  "agents": {
    "alice": {
      "role": "engineer",
      "workspace": "workspaces/alice",
      "schedule": "* * * * *",
      "enabled": true
    }
  },
  "mcp_port": 3001,
  "server_port": 3000
}
```

### 4.5 Spec Documents

`specs/spec.md` is a free-form markdown document. It is the source of truth for the project. The PO reads it; engineers read it. It is never auto-deleted or overwritten without archiving the previous version first.

---

## 5. Ticket Status Machine

### Engineer-owned transitions

```
open
  └─► in_progress          (engineer picks up ticket)
        └─► ready_for_review   (engineer submits, PR created)
              └─► in_review        (engineer starts review session)
                    ├─► has_comments     (review found issues)
                    │     └─► in_progress   (engineer addresses comments)
                    │           └─► ready_for_review  (loop back)
                    └─► approved        (review passed)
                          └─► merged         (engineer merges to main)
                                └─► ready_for_test
```

### QA-owned transitions

```
ready_for_test
  └─► in_testing
        ├─► tested           (QA passes)
        └─► test_failed      (QA fails → re-opens ticket, engineer picks up again)
```

### PO-owned transitions (MVP+)

```
tested
  └─► verifying
        ├─► done
        └─► rejected         (PO rejects → re-opens, engineer picks up)
```

### Rules

- Only the owning role may transition to their statuses (enforced server-side on `update_ticket`)
- `open` tickets with no assignee are available for any engineer to self-assign
- An engineer checks for their own in-progress tickets first before claiming a new one
- QA and PO transitions are triggered by status reaching their entry state (event or next cron tick)

---

## 6. Agent Behaviour

### 6.1 Engineer

On each scheduled run, the engineer agent:

1. Reads the board via `list_tickets`
2. Checks for tickets assigned to self that are in an actionable status (`in_progress`, `has_comments`, `ready_for_review`, `in_review`)
3. If none, checks for `open` unassigned tickets (top by priority)
4. If nothing to do, writes idle summary and exits
5. Picks one ticket and acts on it:

| Ticket status | Action |
|---|---|
| `open` | Self-assign, move to `in_progress`, write impl plan to ticket, begin coding on feature branch |
| `in_progress` | Read impl plan, continue coding, run checks; if done move to `ready_for_review`, create PR |
| `ready_for_review` | Move to `in_review`, review own PR (new session = fresh eyes), if issues add comments + move to `has_comments`, if clean move to `approved` |
| `has_comments` | Read comments, address them in workspace, run checks, move to `ready_for_review` |
| `approved` | Merge feature branch into main, move ticket to `merged` → `ready_for_test` |

6. Writes one-line session summary to activity log and exits

**Workspace discipline:**
- All work happens in the agent's own workspace clone (`workspaces/alice/`)
- Feature branch is named `ticket-{id}` by convention
- Before starting work, agent pulls latest main into workspace
- After merge, feature branch is retained (not deleted) for auditability

**Quality gates (prototype stack: TypeScript/Deno/React):**
- Typecheck must pass before moving to `ready_for_review`
- Integration tests must pass before merge
- Checks are run inside the agent's own docker-compose environment

### 6.2 QA (MVP+, stub in prototype)

On each scheduled run:

1. Checks for tickets in `ready_for_test`
2. Picks one, moves to `in_testing`
3. Checks out main branch, spins up docker-compose, runs integration test suite
4. If pass: moves to `tested`, writes summary
5. If fail: adds failure comment to ticket, moves back to `open` (engineer picks up again), flags which tests failed

QA works on the main branch, not a workspace clone. QA does not write code.

### 6.3 Product Owner (MVP)

The PO has multiple session modes, selected by the runtime based on what is pending:

| Mode | Trigger | Action |
|---|---|---|
| `chat` | User sent a message in the chat UI | Respond to user, update spec if needed |
| `spec_to_tickets` | Spec was updated (file mtime or explicit flag) | Diff spec against existing tickets, create/update/close tickets accordingly, re-prioritise backlog |
| `verify` | Ticket in `tested` state (MVP stub) | Move ticket to `done` (no actual verification in MVP) |

PO reads the full spec before any session. PO never touches code or PRs.

---

## 7. Frontend (Browser SPA)

### 7.1 General

- Single-page app served by the orchestration server
- Communicates with server via REST + WebSocket (for live board updates and agent activity stream)
- Technology: React + TypeScript (dogfoods the target stack)
- Minimal, functional UI. Not a design showcase.

### 7.2 Views

**Dashboard (primary view)**

- Left panel: Agent roster
  - Each agent: name, role, status (idle / running), last activity summary, last active timestamp
  - Pause / resume toggle per agent (user-controlled)
- Center: Kanban board
  - Columns map to ticket statuses
  - Cards show: ticket ID, title, assignee avatar/name, priority indicator
  - Cards update live via WebSocket
- Right panel (MVP): PO chat
  - Expandable/collapsible
  - Chat messages with user and PO
  - PO responses stream in

**Activity Log view**

- Filterable by agent, role, date range
- Each entry: timestamp, agent, event type, summary, refs (ticket/PR links as plain text for now)
- Pagination or infinite scroll

**Ticket detail view**

- Full ticket markdown rendered
- Status badge, assignee, priority
- Comment thread (append-only display)
- Implementation plan section (if written)
- Edit button for description/title (user-editable fields only)
- Status history (derived from activity log)
- Linked PR (if any)

**PR detail view**

- Source/target branch, status, intent
- Link to ticket

**Project settings (prototype: config file only)**

- Display current config
- Show agent list with schedule and enabled status
- Pause/resume controls (same as dashboard)

### 7.3 Editable vs Read-only

| Artifact | User-editable fields | Read-only / Danger zone |
|---|---|---|
| Ticket | title, description | status, assignee, priority |
| Spec | entire document | — |
| PRD | entire document | — |
| PR | intent | status, branches |
| Agent config | schedule, enabled | role |

Danger zone actions (status changes, reassignment) are possible but require explicit confirmation and are visually marked. The system records a `manual_override` event in the activity log when they occur.

---

## 8. Prototype Scope

The prototype validates the core loop: a human creates tickets, an engineer agent picks them up, implements, reviews, and moves them through to `ready_for_test`. No PO. No QA automation.

### Prototype: Included

- CLI entry point: `builder start {project-path}`
- Orchestration server with REST API
- Browser SPA: Dashboard (board + agent roster) + Activity Log view
- Kanban API (full CRUD, status machine enforced)
- Activity Log API (append + query)
- MCP server exposing: tickets, activity log, workspace path
- Engineer role runtime (`startEngineerCycle`)
- Engineer agent prompt (TypeScript/Deno/React stack, opinionated)
- Per-project config file (`.builder/config.json`)
- Single engineer agent (`alice`) pre-assigned
- Project folder initialisation (`builder init`)
- Git workspace setup (clone of main into `workspaces/alice/`)
- Docker-compose per workspace (for test runs)
- Ticket file format (markdown + YAML frontmatter)
- PR registry (markdown files in `/prs/`)
- Cron scheduler (1-minute default, configurable)
- Pause/resume agent from UI
- Activity log: session start/end, idle, status change events

### Prototype: Excluded

- PO, QA roles
- Chat interface
- Spec documents (user types ticket descriptions manually)
- Multiple engineer agents
- Event-driven scheduling
- UI-based project config
- Spec change detection / re-evaluation
- Danger zone UI for manual overrides (overrides possible via direct file edit only)

---

## 9. MVP Scope (extends Prototype)

The MVP adds the Product Owner as a minimum functional agent, making the system usable without the user writing tickets manually.

### MVP: Added

- PO role runtime (`startPOCycle`) with mode selection logic
- PO agent prompt (chat mode, spec-to-tickets mode, verify stub mode)
- Chat API (message store, append + query)
- Chat UI panel on Dashboard (expandable)
- Spec API (read/write `specs/spec.md`, archive on update)
- Spec-to-tickets cycle (PO reads spec diff, creates/updates tickets)
- PO verify stub (moves `tested` → `done` without actual review)
- Ticket detail view (full)
- PR detail view
- Spec viewer/editor in UI
- Multiple engineer agents (parallel workspaces)
- Per-agent schedule configuration
- `.env` for API keys

### MVP: Excluded

- QA agent (board has `ready_for_test` status, but no agent acts on it — human can manually move to `done`)
- Technical Writer role
- Event-driven triggers (all cron)
- UI-based project config
- Remote git (local only)
- Multi-project switcher in UI (multi-project supported in data model, but no UI for it)

---

## 10. Tech Stack (System)

| Layer | Choice | Rationale |
|---|---|---|
| Orchestration server | Deno + TypeScript | Dogfoods the target app stack; fast startup, good subprocess control |
| SPA | React + TypeScript + Vite | Same as target app stack |
| IPC / API | REST (JSON) + WebSocket | Simple, no special client needed |
| MCP server | Deno MCP SDK | Native to agent tooling ecosystem |
| Scheduler | Cron expression library | Simple, no external deps |
| Ticket / PR store | Markdown files + YAML frontmatter | Human-readable, git-friendly, agent-readable |
| Activity log | JSONL files | Append-only, easy to tail and query |
| Agent subprocess | Any CLI agent (claude, amp, etc.) | Configurable per project |

---

## 11. Engineer Agent Prompt Design (Prototype)

The engineer's system prompt is loaded from a file (`prompts/engineer.md` within the project or a global default). It covers:

- Role and purpose: you are an autonomous engineer. Each session is a fresh start.
- Reading the environment first: always start by calling `list_tickets` and `get_spec`
- Decision logic: which ticket to pick, what to do based on status
- Coding conventions: TypeScript, Deno, React, opinionated patterns (to be defined in a follow-up spec)
- Quality gates: what checks must pass before each status transition
- Output format: last stdout line must be the session summary (one sentence)
- What not to do: don't ask questions, don't wait for input, don't do more than one ticket per session

The prompt is the primary control surface. It can be customised per project by editing the file. The system prompt is never injected programmatically beyond the env variables the runtime resolves.

---

## 12. Open Questions (Deferred)

- **Manual artifact edits:** How does the system detect and react to a user editing spec/ticket files directly on disk? (file watcher + dirty flag on next agent run is the likely answer)
- **Technical Writer role:** Separate agent or a skill inside the PO/engineer? To be decided based on prototype learnings.
- **QA docker environment:** Each agent has their own docker-compose setup. Exact volume/network isolation strategy to be defined.
- **Conflict resolution:** Two engineers working in parallel may both pull main at different points. What happens when engineer B tries to merge after engineer A already merged conflicting changes? (Likely: merge fails, ticket moves back to `in_progress` with a conflict comment.)
- **Brownfield support:** How the engineer agent handles an existing codebase it didn't write. (AGENTS.md / progress.txt conventions from Ralph Loop are the starting point.)
- **PO ticket format:** Imperative task vs user story. Left to PO prompt design.
- **Naming:** The product has no name yet.
- **Integration test strategy:** What integration tests look like for CRUD apps in this stack, and how QA verifies them from a business perspective.
