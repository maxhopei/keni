**Max:**

I was think about orchestrating coding agents in a way that simulates a common agaile product team.
A team would have one or more engineers, a QA agent, a technical writer, and a product owner (PO).
The framework would allow to manage project spec, where technical writer agent is responsible. In the background, the PO converts spec into action items — tickets, and puts the on a kanban board. PO monitors spec, the state of the project and manages the backlog and priorities.

Engineer agents pick the top items from the board and implmenent them. QA picks up imeplemented items and verifies them. Maybe, somehow PO also approves the ticket before closing (i.e. verifies the tests written by teh QA against the requirements). This creates multiple level of validation.

The person acts as a customer, providing the requirements.

The framework doesn't have to implement agents, and can use any available cli options.

Is there a similar framework or app already?
Most ones that I've seen just focus on orchestrating parallel agents, and quite tech-centered.

---

**Claude:**

The closest existing thing to what you're describing is **BMAD Method**, and it's worth a close look — but it still has meaningful gaps relative to your vision.

**What BMAD gets right:**

BMAD is an open-source AI-driven agile development framework with 12+ specialized agent personas — PM, Architect, Developer, UX, Scrum Master, QA, Technical Writer — that collaborate through structured agile workflows.  Agents are defined in simple text files (Markdown and YAML) capturing their persona, commands, and dependencies.

It includes a multi-layered PR lifecycle where, when a developer completes a story, a QA Agent and a Product Owner Agent check for adherence to the versioned PRD and architecture  — which mirrors your multi-level validation idea.

It works with any AI coding assistant that supports custom system prompts, with Claude Code being the recommended CLI tool.

**Where BMAD falls short of your vision:**

- **No live kanban board.** BMAD uses story files in a folder structure. There's no visual board tracking ticket states (todo → in progress → in QA → PO review → done). The PO role manages stories but not through an actual board interface.

- **No continuous PO monitoring.** The PO agent doesn't autonomously watch the spec and re-prioritize the backlog. You explicitly invoke each agent turn by turn.

- **No autonomous agent loop.** BMAD is fundamentally human-in-the-loop — you drive each handoff. Engineers don't "pick up" the top ticket on their own; you tell the dev agent which story to work on.

- **Technical writer is passive.** The Tech Writer produces docs but doesn't *own* and *manage* the living spec the way you're describing.

- **Customer/PO distinction is collapsed.** You're the customer *and* effectively the PO. BMAD doesn't cleanly model "customer gives requirements → PO interprets them into tickets."

**Other things worth knowing:**

Most other frameworks (AutoGen, LangGraph, OpenAI Agents SDK, CrewAI) are even further from your vision — they focus on low-level agent coordination primitives, not on simulating a product team's organizational structure and workflow.

A key unsolved problem in this space is conflict resolution: when a coding agent writes something the QA agent rejects, your sprint planning must account for iteration loops, and you need to define the maximum number of iterations allowed before escalating to a human to prevent infinite resource drain.

**Your idea is genuinely novel in a few ways:**

- The **technical writer owning the spec** (not just producing docs) as the source of truth is an uncommon design.

- A **PO that continuously monitors** the spec diff and auto-generates/reprioritizes tickets is not something any current framework does autonomously.

- The **three-tier validation** (QA verifies implementation → PO verifies QA's tests against requirements) is a distinctive and smart pattern.

The closest thing to building this today would be BMAD as a scaffold + a lightweight state machine on top (a JSON/markdown kanban file) that agents read from and write to, with Claude Code as the runner. You'd essentially be extending BMAD's persona system with an autonomous loop and a proper ticket lifecycle.

Would you want to think through the architecture for building this, or are you primarily looking to find something off-the-shelf?

---

**Max:**

I’ve looked at BMAD. We have some similar ideas, but their product is very developer oriented. I want to build a “building agent”, usable by a non-engineer. I’m elaborating on the concept of Ralph loop.
And I don’t want to use BMad as a backbone.

How I see it: you run the thing locally, it starts the orchestration server. It serves a browser spa, with a handful ui. Ui talks back to the server for all logic. Backend starts coding agents as sub processes.

The backend includes the kanban api and mcp, the backlog api/mcp, perhaps a couple of other apis for the fronted, like specs, “team” management, project mgmt, control panel, etc.

At the fronted, user starts by creating a project. By default the team includes only a PO. User talks to PO to build the first project spec. In background the same persona creates tickets based on the spec.

The user can add an engineer persona to the team. Engineer starts on schedule, checks the board, picks an item to work on, and proceeds up to creating a pr.

Next cycle engineer checks if there’s anything to review, and does it.

And it continues in this manner. The tickets status is used by agents to understand what needs to be done. Tickets are delegated from one persona to another until they are done.

Example flow: 
Eng: open -> in progress -> ready for review
Eng: ready for review -> in review -> has comments
Eng: has comments -> in progress -> ready for review
Eng: ready for review -> in review -> approved -> merged -> ready for test
Qa: ready for test -> in testing -> tested
PO:  tested -> verifying -> done

The ui shows the kanban board live, and what every agent is doing. Agents start in schedule and check what they can do. Everyone is autonomous, communication through tickets (status, comments) and PRs.

The mvp will focus on a particular type of apps and tech stack, say typescript, deno, react. The app runs in docker and builds in a local filesystem. Git is local with optional remote. Every agent has their workspace.

Coding agents will be opinionated on the application design, testing approaches, and a few other things.

What are your thoughts?
Before architecting, let’s focus on specing it out. Ask questions for gaps.

---

**Claude:**

This is a well-thought-out concept. The Ralph loop framing (build → observe → adjust) as the heartbeat for autonomous agents, combined with a ticket-state-machine as the communication bus, is elegant. A few clarifying questions before spec work:

**Project & Spec**

- When the user "talks to the PO to build the spec" — is that a chat interface, or more structured (forms, guided questions)? Or both, starting conversational and solidifying into a structured doc?

- Who owns spec *changes* after development has started? Can the user edit the spec mid-flight and have the PO automatically re-evaluate tickets?

**The Kanban / Ticket Model**

- You described the eng/QA/PO flow clearly — but where does the *technical writer* fit in your ticket lifecycle? Is doc generation a step inside certain tickets, or a separate ticket type?

- Are tickets always leaf-level tasks, or do you have epics/stories/tasks hierarchy? And does the UI expose that hierarchy or flatten it?

- When an engineer self-assigns a ticket ("picks an item"), is priority purely order-based, or does the PO set explicit priority scores/labels the agent respects?

**Agent Scheduling**

- "Starts on schedule" — are we talking cron-like fixed intervals, or event-driven (e.g. a ticket moves to "ready for review" and that wakes the reviewer)? Or both?

- Can multiple engineer agents run in parallel? If so, how do you handle conflict on the same files?

**Code & Workspace**

- "Every agent has their workspace" — does each agent get its own git branch, or a full clone of the repo? How do PRs work locally — is there a local Git server (like Gitea), or just branch comparison?

- The app runs in Docker — does the QA agent spin up the Docker environment to run tests, or is testing purely unit/static?

**The User's Role Post-Setup**

- After the team is running, can the user intervene on individual tickets (add comments, reject a PO approval, manually move a ticket)? Or is the board read-only for the user?

- Does the user get notified when agents are blocked or need input, or is the expectation that agents never block?

**MVP Scope**

- "A particular type of app" — are you thinking CRUD web apps, CLI tools, libraries? And does the MVP target greenfield only, or also brownfield (adding features to existing code)?

- What's the intended user persona — a solo founder, a small startup team, a non-technical product person? That shapes how much the UI needs to explain what's happening.

---

**Max:**

Project & Spec:
It's a chat interface, that may include some simple forms, such as options for agent's questions.
It should still be possible for the user to directly adjust the spec documents, as well, as any artifacts created by agents: tickets, spec, PRD, docs, etc.
As a technical feature for the later stages — the system must react to these changes, and let the agent know about them, letting them re-evaluate the tickets.

The Kanban / Ticket Model:

- The technical writer is supposed to write the docs, yes. I'm not yet 100% sure this role is needed separately, perhaps a skill would be enough. I'm also right now not sure how exactly the lifecycle will look like. It shouldn't be rigid. Perhaps we'll identify a need for a new role, or find out some roles are extra.
- Tickets are leaf-level tasks. I'm not sure which format is the best (i.e. imperative or a user story), this can also be left up to the PO or be part of the skill/prompt. So it's just a "ticket". A ticket might enclose an optional implementation plan written by the coding agent when starting the work. This one can contain checklists, but I think markdown will give sufficient flexibility, so no need to make specific implementations for that.
- PO orders the tickets by priority. The API/tool must consider this transparently, so that for the coding agent it's simply the top one. However picking a ticket for the "engineer" might be a bit more sophisticated: i.e., they'd check if there are any unfinished tickets on the board where they are assigned.

Agent Scheduling:

- Schedule is cron-based. Event-based triggers can also be considered, but optional.

Code & Workspace:

- Parallel work must be possible. Every ticket is done in a feature branch. And every engineer works in their workspace. They have their own clone of the repo. If that's doable, I'd prefer stick with minimal setup and just compare branches. We can have an internal PRs registry, to hold information about source and target branches, the PRs intent (or a link to the ticket), etc. Simple and plain, maybe even just templated free text (markdown).
- Crucially, two engineers doesn't have to ping-pong comments on PR. Since this are actually "same" coding agent wearing different hats, they can review and fix the code in one sitting.
- Regarding docker for running tests — yes, it's a good point. Most probably, every agent should have their own docker-compose setup as well. I actually leaning towards integration tests over unit tests. Benefit: PO can review integration tests and verify correctness from the business perspective. Unit tests generated from the code that is generated don't bring much value.

The User's Role Post-Setup:

- There's some initial setup, but even after work starts, it remains Agile. Changes are expected all the time. User can change ticket descriptions and requirements. However users should not change "process" things, like assignments, ticket statuses, etc. This may confuse agents and break the process. Technically these changes can be possible, but should be marked as "Danger zone".

MVP Scope

- We start from greenfield, simple apps, i.e. CRUD, or CLI, and see how it can work with more complex apps, that can't be run in docker simply. I.e. using streaming platforms, or proprietary stuff, like Supabase.
- intended user persona: all of these: a solo founder, a small startup team, a non-technical product person. But both: technical and non-technical people

---

**Claude:**

Good, that fills in a lot. A few more targeted gaps before speccing:

**Agents & Personas**

- When you say "engineer wearing different hats" for PR review — does the *same* engineer agent review their own PR, or does a second engineer agent instance do it? The "one sitting" phrasing suggests self-review, but that defeats the purpose of a review. Or is the idea that review is more of a checklist/lint pass rather than a genuine second opinion?

- Is the PO also the one who initially *creates* tickets from the spec, or is there a separate planning/decomposition phase? I.e., does the PO produce the initial backlog in one go, or incrementally as the spec evolves?

- When a new engineer is added mid-project, do they get onboarded somehow (read the spec, existing code, etc.) before picking up tickets?

**Spec & Artifacts**

- What's the relationship between the chat-based spec and the actual spec document? Is the chat a way to *build* the document collaboratively, and the document is the source of truth? Or is the chat history itself the spec?

- When you say the system reacts to manual artifact edits — is that file-watcher based (user edits a markdown file on disk), or through a UI editor, or both?

**The PR / Review Flow**

- You said two engineers can "review and fix in one sitting." Does that mean the reviewing agent directly commits fixes to the branch, or leaves comments and the original agent applies them? Who merges?

- What triggers QA to pick up a ticket — merged to a shared branch, or just "approved" status on the internal PR registry?

**Scheduling & Coordination**

- What's the rough cron cadence you're imagining — minutes, hours? And does every agent run on the same cadence, or different (e.g. PO runs less frequently than eng)?

- When an agent runs and finds nothing to do, does it just sleep, or does it report its idle state somewhere visible in the UI?

**Infrastructure & Local Setup**

- Is this a standalone Electron-style desktop app, or a server process you run via CLI and access in browser? You said "run locally" — does it need to be zero-config, or is a config file + npm start acceptable?

- For the coding agents, are you wrapping Claude Code CLI specifically, or keeping the agent runner model-agnostic with Claude Code as the default?

- Where do API keys live — a .env file, or configured through the UI?

**MVP Boundary**

- Is the MVP single-user only (one human, one project at a time), or multi-project from the start?

- Do you have a rough sense of what "done" looks like for MVP — i.e., what's the one scenario you'd demo to validate the concept?

---

**Max:**

Review happens in a new session, Agent "Alice" and "Bob" are the same coding agents, with the same skills and background. It makes no sense to hand over from Alice to Bob, they won't have different memory. The Alice agent just needs to generate the code and prepare it for the review step. The same Alice starts a new session, reviews the code, and fixes issues. In agent's world the purpose of a review is preserved. It's basically just another critical look. This doesn't map direectly to human world. Additionally this eliminates context switch for agents. Bob can continue on their task. This also allows a single-engineer setup.

PO manages the backlog incrementally. This agent may have several different sessions/modes, i.e. talking to the user, refining the specs, verifying tickets completed by engineers, creating new tickets, or adjusting them.

Reading the specs and code will be a starting point for any agent starting on the new task. Each run is a new session. This eliminates context overflow. All learning must be written to files. This resembles the Ralph Loop approach.

Chat is a way to build the spec documents. Spec is the truth. Chats are archived after being "converted" to the spec. There's no need to have multiple chats or threads in the UI. The "procesed" checkpoint can be constantly moving forward for that. Older messages can be loaded only on demand.

Manual artifacts edits—to be defined later.

Merging is done after the review changes are tested. The same agent merges. Optionally we can consider an extra step of review for the newest changes only.

QA testing is triggered by a status change on the ticket. This must happen after merging is done. Testing happens on main branch. PO approval also.

Cron candece is short, i.e. 1 minute. Can be different for different roles. User can pause any agent or role. User can also interrupt any active session (danger zone)

If an agent has nothing to it exists. Each run will have a one-line summary written somewhere, so that the history is visible. Basically, we need an session/activity log service api/mcp.
User should be able to see activiy history of every agent. When did they start, what did they do, when did the finish, etc.

For the beginning the app runs via CLI and accessed via browser. We can start with a required config file for teh prototype, but later if any config is required, the app should allow doing it via the UI. (i.e. choosing the coding agent's CLI command, entering API keys, etc.)

It should work with any cli-based coding agent that supports the features we need (i.e. providing the custom propmt on startup and exiting after the job is done) and the models those support.

API keys — for the beginning — .env. Keep it simple, we will evolve one step at a time.

MVP is single-user multi-project.

Prototype:

- user can create a project
- user can create tickets manually
- one engineer is pre-assigned.
- engineer picks up tickets and implement them. Testing and review is included.
- No PO, or any other roles yet.
- Activity history view
- Dashboard:
    - List of agents and their latest activity
    - Kanban board

MVP:


- The PO helps manage the tickets with minimum necessary features. So:
    - chat with the user
    - recent chat messages to spec updates background cycle
    - spec to tickets cycle
    - tickets verification stub (no actual verification, moves ticket to Done)
- Chat is on the Dashboard (perhaps expandable).

---

**Claude:**

This is very clear. A few final gaps, then I think we have enough to spec:

**Prototype-specific**

- When the engineer does self-review — is that a separate ticket status/phase explicitly on the board (e.g. "ready for review" → "in review" → back to engineer if issues), or is review invisible to the board and just part of the engineer's internal process before marking "ready for test"?

- For the prototype, where does the engineer's "task context" come from if there's no PO generating rich tickets? Just the ticket title/description the user typed, plus reading the codebase?

- The engineer workspace — each engineer agent has their own git clone on disk. Where do these live relative to the project? Something like ~/.ralphloop/projects/{id}/workspaces/{agent-id}/? And is the "main" repo a separate bare repo, or one of the workspaces is canonical?

**Activity Log**

- Is the one-line summary written by the agent itself at the end of its session (i.e. the agent is prompted to produce it), or derived mechanically (e.g. "Alice picked ticket #3, status changed to in-progress")?

- Session log entries — do they link to artifacts produced? E.g. "Alice completed review of PR #2" links to the PR markdown file?

**Config & CLI**

- Project config (stack, docker-compose path, coding agent CLI command) — is this per-project, or global? I'm assuming per-project.

- When you say "coding agents as subprocesses" — the orchestration server spawns e.g. claude --prompt "..."  and captures stdout? Or is there a more structured protocol (the agent writes files, exits, server reads the output files)?

**One naming question** — are you calling this "Ralph Loop" as the product name, or is that just the conceptual reference? Do you have a working name?

---

**Max:**

Review steps are all reflected in the ticket status. Status help agents figure out what to do on each scheduled run.

Task context always comes from the ticket, spec and code. In the prototype user types it in. Later PO does that, but this changes nothing for the engineer.

Project is encapsulated in a folder. You specify the path when creating a project (or it is taken from the cli). Folder structure I'm thinking:

- Root
-- specs
-- code (main branch)
--- .git
-- workspaces
--- alice
---- .git
--- bob
---- .git

Agent produces the status summary line at the end. It can be generated deterministitcally at other steps.

Session log entries: for now just text. References use common standard format, so that links can be generated later for the UI.

Project config is per-project.

Orchestration server spawns agents and captures stdout/err. Any communication between the orchestrator and the agents is purely technical (control plane). If the prompt needs ot be passed an argument, the orchestrator reads the prompt from the configured file. The data plane-communication happens strictly via the environemnt: tickets, spec, even bus (if any). Actually, we may want to wrap an agent into some additional runtime, handling role-specific things. So that the orchestrator doesn't actually starts a new subprocess, but runs something like startEngineerCycle(...params) . This runs some deterministic logic, like reporting the activity to the activitiy log on start and finish. Inside it starts the subprocess, takes care about the system prompt, tools, and the rest of the agent's context.

Ralph Loop is the method for workign with coding agents: https://raw.githubusercontent.com/snarktank/ralph/refs/heads/main/README.md
I'm borrowing some concepts from it. I see my builder agent as an evolution of the Ralph Loop.
I don't have a name for it yet.

---

**Claude:**

Good, I have full context now. I have enough to write the spec. One last question before I do:

**The agent wrapper / role runtime** — you described startEngineerCycle(...params) as a deterministic shell around the subprocess. Does this wrapper also own *deciding which ticket to pick*, or does the agent decide that itself by reading the board via MCP tools?

I'm asking because this is a fork in the architecture:

- **Option A:** The wrapper is thin — it starts the agent, gives it MCP access to the board, and the agent reasons about what to do. Flexible, but the agent might make unexpected choices.

- **Option B:** The wrapper is opinionated — it pre-selects the ticket (top of backlog, assigned, right status) and injects that into the agent's context. The agent just executes. Deterministic, easier to debug, but less "agentic."

Option B feels more consistent with your Ralph Loop philosophy (small, focused sessions, no reasoning overhead on process decisions). But it's your call — and this choice ripples into how much the agent prompt needs to cover "what should I do" vs "here's what you're doing, do it well."

---

**Max:**

Option A, the wrapper is thin.

---

**Claude:**

Good. I have everything I need. Let me write the spec.
Viewed a file, created a file, read a file
Viewed a file, created a file, read a fileThe spec is there. A few things worth calling out:

**Decisions baked in that you should review:**

- The **ticket file format** (markdown + YAML frontmatter) doubles as the agent's reading material and the UI's data source. This avoids a separate database for the prototype but means the server needs a lightweight markdown parser with frontmatter support. If you want a proper query layer later, the file format is still the source of truth and a DB is a read cache.

- The **activity log as JSONL** (one JSON object per line, one file per day) is the simplest append-only structure that's also queryable. Agents write to it via MCP; the UI reads it via REST. No DB needed.

- **Option A (thin wrapper)** is fully reflected — the runtime only handles infrastructure, and the agent's prompt drives all decision logic. This means the prompt file is the most critical artifact in the system. It's worth treating it like code: versioned, reviewed, iterated on.

- I put **multi-project in the data model from the start** (project_id in every log entry, per-project config) but excluded multi-project UI from MVP. This costs nothing now and avoids painful migrations later.

**The biggest risk I see:** the engineer prompt. Everything else in the system is deterministic. The prompt is where the whole thing can silently fail — agent picks the wrong ticket, skips quality gates, writes a bad summary. I'd recommend making prompt iteration a first-class activity from day one, with the activity log as your debugging tool.

Want to start on the architecture next, or go deeper on any section of the spec first?
