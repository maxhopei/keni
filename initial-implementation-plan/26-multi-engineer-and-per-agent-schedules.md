# Step 26 — multi-engineer-and-per-agent-schedules

**Phase:** MVP
**Suggested change name:** `multi-engineer-and-per-agent-schedules`
**Depends on:** 09, 8

## Goal

Run more than one engineer in parallel and let each agent have its own tick cadence in config. After this step, the project roster can hold multiple engineers (e.g., `alice`, `bob`), each with its own workspace clone and schedule, and the scheduler ticks them independently.

## Scope

- Project config (`project.yaml` from step 03) supports an N-engineer roster:
  - Each engineer entry: `id`, `role` (`engineer` for now), `enabled`, `schedule` (cadence override), optional `coding_agent_cli` override.
  - Default seed remains a single engineer (`alice`); adding `bob` etc. is a config change.
- Workspace provisioning (step 09) runs per engineer:
  - `~/.keni/workspaces/<project-id>/<agent-id>/` — one clone per engineer, `.keni/` excluded.
  - Adding an engineer triggers provisioning on next boot (or via a `keni agents add` command if the proposer chooses to surface it; spec doesn't mandate one).
  - Removing an engineer cleans up the clone.
- Scheduler (step 08) ticks each engineer independently using its per-agent cadence (falls back to a role default).
- Engineer precheck (step 09) already does "check own in-flight tickets before claiming a new one" — this step verifies that contract holds with multiple engineers in flight.
- API additions (where needed): `GET /agents` already returns the roster; ensure pause/resume, interrupt, and timeout work per agent in a multi-engineer setup.

## Out of scope

- Resolving merge races between two engineers — open question (§12). For MVP, document the known race and let it surface (loud failure is acceptable; spec calls this out as an open question).
- Multi-engineer-aware UI affordances beyond what step 10/11 already render — the existing roster and board scale.
- Specialised role mixes (e.g., front-end vs. back-end engineers) — out of scope.

## Spec references

- §4.2 — Engineer always checks own in-flight tickets before claiming a new one; priority is PO-owned integer; engineers pick top of their queue.
- §5.2 — Workspace path includes `<agent-id>` so multiple engineers don't collide.
- §9 — MVP includes "Multiple engineer agents running in parallel, each with their own workspace; per-agent schedule configuration in the config file."
- §11#10 — Workspaces are sparse and don't share `.keni/`; two engineers cannot race on the same ticket file because neither can see one.
- §12 — Open question: parallel engineer conflicts on merge to `main`. MVP behaviour: surface, do not silently retry.

## Open decisions for the proposer

- **Default for new engineers.** Inherit the role default cadence unless overridden. Document.
- **Provisioning trigger.** On `keni start` boot, on every tick, or on explicit add command. Boot is simplest; document.
- **Interrupt scope.** Interrupt of one engineer must not affect others. Verify in tests.

## Notes for /opsx:propose

- `proposal.md` should describe this step as turning the team from a soloist into an ensemble.
- `design.md` should pin: roster schema, per-agent schedule fall-through, provisioning lifecycle, interrupt isolation, the documented race for merge collisions and how it surfaces.
- `tasks.md` should cover: config schema update, provisioning per agent on boot, scheduler per-agent cadence, integration test running two engineers concurrently (against fake coding-agent CLIs) on different tickets, document the merge-race behaviour.
- Capability spec for `multi-engineer-team` documents the contract.
