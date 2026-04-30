## Why

Keni is a locally-run building agent (spec §1); before any runtime, server, SPA, CLI, or prompt code can be written, contributors need a baseline codebase with a green build and consistent tooling across every package they will touch. The spec mandates a prototype-first, one-step-at-a-time approach (§2#9, §8) and a multi-surface product — CLI, orchestration server, browser SPA, role runtimes, shared modules — so the very first change must stand up the monorepo that houses all of them. Without this, every subsequent step (storage interfaces, REST APIs, MCP surface, engineer runtime, SPA, CLI) would either bikeshed tooling on each landing or drift into incompatible choices. Doing it once, up front, unblocks steps 02 through 27 in the implementation plan.

## What Changes

- Create the Keni source repository (`git@github.com:maxhopei/keni.git`, default branch `main`, **MIT** licensed) with a Deno-workspaces monorepo layout containing five packages (empty stubs, no feature code): `cli`, `server`, `spa`, `role-runtimes`, `shared`.
- Standardise on the stack chosen for Keni itself: **Deno 2.7+ with built-in TypeScript, Deno workspaces as the monorepo tool, and Deno's built-ins (`deno lint`, `deno fmt`, `deno check`, `deno test`) as the whole lint / format / type-check / test surface.** For the SPA, record the future wiring (React + Vite via `@deno/vite-plugin`); the actual Vite configuration lands in step 10.
- Wire a single root task set via `deno task`: `lint`, `fmt`, `fmt:check`, `check`, `test`, `build`, each either invoking the built-in (which already recurses across the workspace) or fanning out to workspace members.
- Add minimal continuous integration: one GitHub Actions workflow using `denoland/setup-deno@v2` that runs `deno install --frozen`, `deno task fmt:check`, `deno task lint`, `deno task check`, and `deno task test` on every push to `main` and every pull request against `main`; any non-zero exit blocks merge.
- Add repository hygiene: `.editorconfig` (for non-`deno fmt`-covered files like Dockerfiles and shell scripts), `.gitignore` covering build artefacts and editor / OS cruft, `.tool-versions` pinning Deno 2.7.x for asdf / mise users, `README.md` with a one-paragraph "clone, `deno install`, run the workspace tasks" dev setup, and an MIT `LICENSE` file.
- Commit prompts as **code** (importable string constants) from the outset — no filesystem prompt loading — per spec §11#3 and §6.2. No prompts are authored in this step; the repo convention is set so future steps can add them without introducing a `prompts/` directory.
- **Nothing else.** No Keni feature code lands in this change. No REST endpoints, no MCP tools, no storage interfaces, no role runtimes, no SPA views, no CLI commands beyond what `deno task --help` lists. The `.keni/` project layout and `~/.keni/` global layout are explicitly deferred to step 03.

## Capabilities

### New Capabilities

- `developer-setup`: The contract that a fresh clone of the Keni repo produces a reproducible green build. Covers what the one-time install does, which workspace-level commands must exist, what they must run across packages, what CI must enforce on every push and pull request, and what a contributor can expect from the root `README.md`. This is the only capability in this change; every later change will add its own.

### Modified Capabilities

<!-- None. This is the first change in the project; there are no pre-existing specs under openspec/specs/ to modify. -->

## Impact

- **Affected code**: the entire repository, because it does not yet exist. Creates the root `deno.json` (workspace, imports, tasks, fmt/lint config), `deno.lock` (committed), five workspace members each with their own `deno.json` and a trivial `src/main.ts` + `src/main_test.ts`, `.tool-versions`, `.editorconfig`, `.gitignore`, `README.md`, `LICENSE` (MIT), and one GitHub Actions workflow.
- **Affected APIs / contracts**: none yet (no surfaces are exposed in this step).
- **Dependencies**: Deno itself is the only contributor prerequisite. The only third-party dependencies introduced in this change are whatever `deno.lock` picks up transitively from the trivial workspace — expected to be empty or near-empty, since the scaffolding uses only Deno built-ins. The SPA's future dependencies (`npm:vite`, `npm:@deno/vite-plugin`, `npm:@vitejs/plugin-react-swc`, `npm:react`, `npm:react-dom`) are named in `design.md` but land in step 10.
- **Downstream steps unblocked**: all of steps 02 – 27 in the initial implementation plan, each of which adds code to one of the five workspaces scaffolded here.
- **Non-impact (deliberate)**: no runtime beyond Deno itself, no scheduler, no MCP server, no SPA UI, no Vite configuration yet, no CLI feature commands, no `.keni/` or `~/.keni/` directories, no coding-agent integration. Those are each their own change.

## Spec references

- §2#9 — "One step at a time. Prototype first, MVP next, rest deferred." — justifies scaffolding-only scope.
- §6.4 — coding-agent agnosticism frames what the engineer subprocess will *invoke*, not what Keni itself is written in; the repo hosts Keni, not the coding agents.
- §8 — prototype "Included" list (CLI, orchestration server, SPA, engineer role runtime, shared modules) names the five workspaces this change creates.
- §11#3 — "Thin wrapper, prompts as code" — fixes the convention that prompts are importable string constants, not on-disk assets; honoured here by *not* creating a prompts directory.
