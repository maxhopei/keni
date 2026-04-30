## Context

Keni's prototype (spec §8) ships a CLI, an orchestration server with REST and WebSocket APIs, a browser SPA, one engineer role runtime, and shared modules. The MVP (§9) adds a PO role runtime with four modes, a chat surface, and MCP tools for the PO — all within the same repo. Every step in the implementation plan (02 – 27) adds code to one of five workspaces: `cli`, `server`, `spa`, `role-runtimes`, `shared`. Before any of that work starts, the monorepo and its toolchain have to exist and be uncontroversially set up, so each subsequent change can focus on features instead of tooling.

The repo is a greenfield: no pre-existing specs under `openspec/specs/`, no code yet. Two characteristics constrain the choice:

- **Multi-surface TypeScript product.** CLI, server, SPA, role runtimes, shared — all TypeScript. Sharing types between `packages/shared`, `packages/server`, and `packages/spa` is the largest concrete benefit of a single language; mixing TS on the frontend and Go/Rust on the backend loses that benefit and doubles the review surface for every full-stack ticket later in the plan.
- **Thin wrapper, prompts as code.** Per spec §11#3, prompts are bundled with Keni's binary and are *importable strings*, not filesystem assets. The repo convention established here must make it trivial to import a string constant from `packages/role-runtimes/src/prompts/...` without ever touching the disk at runtime. That rules out build systems that copy a `prompts/` directory into the dist.

Decisions from the user for this change: license is **MIT**, default branch is **main**, origin is **`git@github.com:maxhopei/keni.git`**, and the stack is **Deno 2.7+ with TypeScript, Deno workspaces, and Vite via `@deno/vite-plugin` for the SPA**. Those inputs narrow the open tooling decisions from six to roughly three, because Deno collapses runtime + package manager + linter + formatter + type-checker + test runner into a single CLI.

## Goals / Non-Goals

**Goals:**

- A fresh clone of `git@github.com:maxhopei/keni.git` produces a green build: one `deno install` followed by the workspace-level tasks `deno task lint`, `deno task check`, `deno task test`, and `deno task build`, each exiting `0`.
- One runtime, one task runner, one lint/format/type-check/test surface — all of it Deno — applied uniformly across five packages.
- Continuous integration runs `deno task lint`, `deno task check`, and `deno task test` on every push and pull request, blocking merge on failure.
- The repo layout makes it obvious where each future change lands — CLI in `packages/cli`, server in `packages/server`, etc.
- Prompt-as-code convention is locked in: no `prompts/` directory at the repo root, documented convention that prompts are TypeScript string constants inside the package that uses them.
- Reproducible installs — `deno.lock` committed and enforced with `--frozen` in CI.
- The SPA stack decision (**React + Vite + `@deno/vite-plugin`**) is recorded here and in the README; the actual Vite wiring lands in step 10 when the SPA gets real code.

**Non-Goals:**

- No feature code. No REST endpoints, no MCP server, no role runtimes, no scheduler, no SPA UI, no CLI feature commands beyond whatever `deno task --help` produces.
- No `.keni/` or `~/.keni/` directories — those are step 03.
- No coding-agent CLI wiring — step 09 (engineer) and step 19 (PO chat proxy).
- No Vite configuration, no React code, no `vite.config.ts`, no `index.html`, no `main.tsx` — those land in step 10. This change only *names* the SPA stack.
- No publishing to a registry — all packages declare `"private": true` in their `deno.json` / `package.json` hybrid (via omitting `"exports"` on the public surface) in this change.
- No pre-commit hooks (Lefthook, Husky equivalents). CI is the enforcement line here; hooks are developer ergonomics to be added later.
- No cross-platform CI matrix. Ubuntu latest only; macOS/Windows runners can be added when a later step needs them.
- No containerisation. Docker for tests/CI is step 08/09's concern (the QA docker-compose is per-project, inside a user's built app — not Keni itself).

## Decisions

### Decision 1: Runtime + language — **Deno 2.7 (latest stable) with built-in TypeScript**

**Why:** the user selected Deno; the rationale that makes it a good fit independent of preference is that (a) Deno runs TypeScript natively with no build step for server code, (b) it ships a cohesive toolchain (runtime + linter + formatter + type-checker + test runner + task runner) in one binary, which dramatically reduces the number of config files and decision points compared to the Node ecosystem, and (c) it has first-class support for `jsr:` and `npm:` specifiers, so we can pull in any npm package (notably Vite and its plugins) without a separate `package.json` dance.

**Concrete version:** Deno 2.7.x (latest stable on the 2.7 minor line at the time of each install — 2.7.13 as of 2026-04-22). We pin the minor via `.tool-versions` and `denoland/setup-deno@v2`'s `deno-version` input; we do not pin the patch, so security patches flow through automatically.

**Alternatives considered:**

- **Node.js 22 LTS + pnpm + Turborepo + Biome + Vitest.** The previous baseline. Rejected at user direction; would also have required five config files to Deno's one.
- **Bun.** Shared spirit with Deno (built-in TypeScript, built-in toolchain) but with Node-compat quirks around `child_process.spawn` that are central to the role-runtime subprocess model (spec §6.2). Deno's `Deno.Command` API is first-class and well-documented.

### Decision 2: Monorepo — **Deno workspaces (built into `deno.json`)**

**Why:** Deno 2 ships native workspace support — a `workspace` array in the root `deno.json` lists member directories, each member has its own `deno.json` with a `name` field, and bare specifiers like `@keni/shared` resolve across the workspace via the `exports` field. No separate monorepo tool (Turborepo, Nx, Moon) is required.

**Workspace layout commitment:** five members — `packages/cli`, `packages/server`, `packages/spa`, `packages/role-runtimes`, `packages/shared` — declared as `"workspace": ["./packages/cli", "./packages/server", "./packages/spa", "./packages/role-runtimes", "./packages/shared"]` in the root `deno.json`. Glob (`./packages/*`) works too but we prefer the explicit list so that typos or rogue directories surface loudly.

**Alternatives considered:**

- **Glob pattern `./packages/*`.** Slightly less typing; hides accidental directory additions. Explicit list is safer at five-package scale.
- **Apps/packages split (`apps/*`, `packages/*`).** Unnecessary ceremony at this size; `packages/` for everything keeps imports uniform.

### Decision 3: Built-in toolchain — **`deno lint`, `deno fmt`, `deno check`, `deno test`**

**Why:** every tool Keni needs for lint, format, type-check, and unit tests ships inside the Deno CLI. Running them at the repo root recurses into the workspace automatically. No third-party lint rules, no Prettier config, no `tsconfig.json` per package (Deno's own TypeScript config lives in `deno.json`), no Vitest/Jest setup. The decision count collapses from "lint + format + type-check + test" to one.

**Configuration surface (all in root `deno.json`):**

- `"lint"`: include globs (`packages/*/src`), exclude globs (`**/dist`, `**/node_modules`). Rule tweaks only if a default rule fights us during scaffolding; start with Deno's default recommended set.
- `"fmt"`: include the same globs plus markdown/JSON, trailing commas, line width 100 (Deno default is 80, widen slightly for readability of type signatures).
- `"compilerOptions"`: strict by default. `"noImplicitOverride": true`, `"noUncheckedIndexedAccess": true`, `"verbatimModuleSyntax": true`. JSX preset lives in the SPA workspace later.
- `"test"`: no special config at root; per-package test files live next to sources as `*_test.ts` (Deno convention — note: underscore, not dot).

**Alternatives considered:**

- **ESLint / Prettier / tsc / Vitest layered on top of Deno.** Possible (Deno can run npm binaries), but loses the "one tool" benefit. If a later package genuinely needs an ESLint rule Deno lint doesn't provide, we add it locally in that package without breaking the root-level contract — but we don't pre-emptively bring it in.
- **Biome.** Rejected along with the Node stack; Deno's built-ins are faster and one less tool to install.

### Decision 4: Task orchestration — **`deno task` with root-level aggregator tasks**

**Why:** Deno's `deno task` is the monorepo task runner we get for free. The root `deno.json` declares named tasks (`lint`, `check`, `test`, `fmt`, `fmt:check`, `build`) that either invoke the built-in (e.g., `deno lint`) directly — which already recurses — or fan out to workspace members (`build`).

**Root tasks in `deno.json`:**

```jsonc
{
  "tasks": {
    "lint": "deno lint",
    "fmt": "deno fmt",
    "fmt:check": "deno fmt --check",
    "check": "deno check packages",
    "test": "deno test -A",
    "build": "deno task --filter=@keni/* build"
  }
}
```

Each package `deno.json` defines its own `build` task (initially `echo noop` — real build wiring lands per-package in its own step, e.g., `deno task build` for the SPA becomes `deno run -A npm:vite build` in step 10).

**Alternatives considered:**

- **A single shell script at the root (`scripts/ci.sh`).** Works; harder to compose per-task, less self-documenting, and loses the Deno-native task-discovery UX (`deno task` with no args lists all tasks).
- **`--recursive` instead of `--filter`.** Both work in Deno 2.7; `--filter=@keni/*` is explicit about scope and ignores unrelated workspace members should they ever exist.

### Decision 5: CI — **GitHub Actions + `denoland/setup-deno@v2`, single `ci.yml` workflow**

**Why:** the repo lives on GitHub (`git@github.com:maxhopei/keni.git`); Actions is the default. `denoland/setup-deno@v2` installs Deno and enables the DENO_DIR cache from the Actions cache — straightforward, one step.

**The workflow:**

1. Checkout
2. `denoland/setup-deno@v2` with `deno-version: v2.7.x`
3. `deno install --frozen` — fails if `deno.lock` doesn't match `deno.json` imports
4. `deno task fmt:check` — fails if anything is unformatted
5. `deno task lint`
6. `deno task check`
7. `deno task test`

Triggers: `push` to `main`, `pull_request` against `main`. Ubuntu latest only.

**Alternatives considered:**

- **Split workflows per task.** Unnecessary for five linear steps; one workflow is easier to read.
- **Skip `fmt:check` in CI.** Tempting (deno fmt is opinionated, contributors might disagree with defaults), but formatter drift corrupts diffs quickly. Enforce from day one.

### Decision 6: Repository layout — **`packages/` with five members, `@keni/*` bare specifier scope**

```
rocky-n-grace/
├── deno.json                  # workspace, imports, tasks, fmt/lint config
├── deno.lock                  # committed
├── .tool-versions             # pins Deno for asdf / mise users
├── .gitignore                 # node_modules (should not exist but cheap to guard), DENO_DIR if cached at repo root, dist/, .vscode/ etc.
├── .editorconfig              # fallback for non-Deno-formatted files (.env, shell, Dockerfile)
├── .github/workflows/ci.yml
├── README.md                  # onboarding + layout + conventions
├── LICENSE                    # MIT
└── packages/
    ├── cli/
    │   ├── deno.json          # "name": "@keni/cli", exports, tasks
    │   ├── src/
    │   │   ├── main.ts
    │   │   └── main_test.ts
    │   └── README.md          # optional, one-paragraph package purpose
    ├── server/                # @keni/server
    ├── spa/                   # @keni/spa (Vite + @deno/vite-plugin wired in step 10)
    ├── role-runtimes/         # @keni/role-runtimes
    └── shared/                # @keni/shared
```

Each package's `deno.json` in this change:

```jsonc
{
  "name": "@keni/<pkg>",
  "version": "0.0.0",
  "exports": "./src/main.ts",
  "tasks": {
    "build": "echo noop"
  }
}
```

The per-package `build` stub is a deliberate placeholder — real build behaviour lands per-package. `lint`, `fmt`, `check`, `test` are not redefined per package because `deno <tool>` at root already recurses into them.

Test files follow Deno's **underscore convention**: `main_test.ts` (not `main.test.ts`). This matters because `deno test` auto-discovers `*_test.ts` out of the box.

**Alternatives considered:**

- **Flat layout, no `packages/`.** Works for small repos; confusing past three members.
- **Single `@keni/root` package publishing a barrel.** Overkill; each surface imports from `@keni/shared` directly.

### Decision 7: SPA stack — **React + Vite + `@deno/vite-plugin` (stack recorded; wiring in step 10)**

**Why:** the user specified Vite via `@deno/vite-plugin`. As of 2026-04, `@deno/vite-plugin` 1.0.6 is the official Deno plugin for Vite; it teaches Vite how to resolve `jsr:`, `npm:`, and `http(s):` specifiers plus `deno.json` import-map aliases. It supports Vite 5/6/7. React on Vite in a Deno workspace follows Deno's own tutorial (`deno add npm:@deno/vite-plugin npm:@vitejs/plugin-react-swc npm:vite`).

**What this change does:** records the decision in README and design.md, and scaffolds `packages/spa/` as a plain Deno workspace member. Nothing Vite-specific is created here (no `vite.config.ts`, no `index.html`, no React deps).

**What step 10 does:** adds `vite.config.ts` importing `@deno/vite-plugin` and `@vitejs/plugin-react-swc`, adds `index.html`, `src/main.tsx`, real `npm:` imports, and `dev`/`build` tasks in `packages/spa/deno.json`.

**Rationale for splitting:** step 10 owns "the SPA's build pipeline" per the implementation plan. Pre-wiring Vite in step 01 would (a) add unused dependencies to the lockfile, (b) require placeholder React code that step 10 would immediately rewrite, and (c) blur the responsibility boundary between "scaffolding" and "SPA shell."

**Alternatives considered:**

- **Fresh (Deno's own SSR framework).** Rejected: spec §7.2 wants a live-updating SPA with WebSocket state, not server-rendered pages; Vite + React is the path of least resistance for that UX.
- **SolidJS / Svelte + Vite.** Smaller runtimes, but React's ecosystem is what the engineer prompt targets (§8) and what most future UI libraries assume.
- **`@vitejs/plugin-react` (Babel) instead of `@vitejs/plugin-react-swc`.** `-swc` is faster HMR and fewer deps; prefer it as the default. This is revisitable in step 10.

### Decision 8: Prompts-as-code convention — **no `prompts/` directory; prompts are TS module exports**

**Why:** spec §11#3 and §6.2 require prompts to be bundled and *not* loaded from the filesystem at runtime. Never creating a `prompts/` directory prevents the wrong pattern (`Deno.readTextFile(...)` on a prompt) from being easy.

**Convention (documented in README):** when a later change introduces its first prompt (step 07 / 09 for the engineer, step 18 for the four PO prompts), it lives as `export const engineerSystemPrompt = \`...\`;` inside `packages/role-runtimes/src/prompts/` or similar in-code location, imported by the runtime via the normal module system. No runtime file I/O for prompts, ever.

This change does not add any prompt files — it only locks the convention.

**Alternatives considered:**

- **`prompts/` at repo root with Vite's `?raw` import for bundling.** Possible; unnecessary indirection when TS string literals are already type-safe and plain.

### Decision 9: Lockfile policy — **commit `deno.lock`, CI uses `deno install --frozen`**

**Why:** deterministic installs are table stakes for "fresh clone produces a green build." CI must fail loudly when `deno.json` is changed but `deno.lock` isn't regenerated.

**What `--frozen` does:** refuses to modify `deno.lock`; if the lock doesn't match the declared imports, `deno install` exits non-zero. This is the Deno equivalent of `npm ci` or `pnpm install --frozen-lockfile`.

**Alternatives considered:**

- **No lockfile (rely on semver ranges).** Violates reproducibility; trivially rejected.
- **Lockfile only for npm deps.** `deno.lock` already covers both `jsr:` and `npm:` specifiers; no split needed.

### Decision 10: Deno version enforcement — **`.tool-versions` + CI `deno-version` input + README**

**Why:** three layers of defence.

1. `.tool-versions` at the repo root pins `deno 2.7.x` for contributors using `asdf` or `mise` (the two widely-used 2026 version managers; `dvm` is second-tier).
2. `denoland/setup-deno@v2` in CI pins `deno-version: v2.7.x` so a CI runner always gets the expected minor.
3. README's onboarding paragraph states the required version explicitly, so contributors without a version manager know what to install.

Deno itself has no manifest-level `"engines"` field as of 2.7. That is the weak link; if a contributor runs a 2.5 install by accident, they'll get some cryptic errors. Mitigation: the README shows `deno --version` as the first smoke step.

**Alternatives considered:**

- **`dvm` / Deno's own version manager.** Less commonly installed than asdf / mise. `.tool-versions` works for both.
- **A shell wrapper that rejects wrong Deno versions before running tasks.** Belt-and-braces; skip until a real drift bites us.

## Risks / Trade-offs

- **`@deno/vite-plugin` can't be used inside `vite.config.ts` itself** → step 10 must keep `vite.config.ts` free of `npm:`/`jsr:` specifiers (use only bare npm imports, which Deno resolves via `deno.json`'s imports map). Documented in the plugin's README; we mirror the note in step 10's design. Not a concern for this scaffolding change.
- **Deno has no standard `"engines"` field** → the three-layer `.tool-versions` + CI-input + README mitigation is our answer; small risk that a wrong-version contributor gets confused before CI catches them. Acceptable for a five-person (or agent) team.
- **`deno fmt` defaults are opinionated and not fully configurable** (e.g., single-quote vs double-quote is fixed) → everyone on the team lives with Deno's choices. Fine; that's the point of picking Deno.
- **Some npm packages still trip Deno's Node-compat shim** → known issue for a narrowing set. Mitigation: if a dep doesn't work, swap to a jsr equivalent or the Deno-native alternative. For this change, the only npm dep we actually use is in step 10 (Vite + @deno/vite-plugin + React plugin), all of which are known to work.
- **`deno test -A` grants full permissions during tests** → fine for unit tests in the prototype. Tightening per-file permissions is a post-scaffolding cleanup if it becomes a real concern.
- **`.editorconfig` is partly redundant with `deno fmt`** → kept anyway for files `deno fmt` doesn't touch (Dockerfile, shell, `.env.example`). Tiny file; no cost.
- **No pre-commit hooks → formatter/lint drift can reach PRs** → CI rejects those PRs within seconds; hooks can be added as a DX improvement without changing the contract.
- **Single-OS CI (Ubuntu)** → macOS/Windows contributors might hit OS-specific bugs that CI misses. Broadening the matrix is a one-line change when needed.

## Migration Plan

Not applicable — this is the first change in a greenfield repo. Rollback is `git reset --hard` to the empty initial commit.

## Open Questions

- **SPA state management library.** Zustand, Jotai, Redux Toolkit, or local React state? Deferred to step 10 where the first store actually matters.
- **`@vitejs/plugin-react-swc` vs `@vitejs/plugin-react`.** Proposed `-swc` in Decision 7; step 10 can revisit once we see real HMR ergonomics.
- **Whether to use `jsr:` over `npm:` by default.** No universal answer. For Keni's own code we publish nothing; for dependencies we pick whichever registry has the best version of each package. No project-wide policy needed today.
- **`CONTRIBUTING.md`.** Useful once there are more than a handful of contributors. Skip in this change.
- **Dependency-upgrade cadence.** Renovate / Dependabot config is useful but not in scope here; can be added in a later hygiene change.
