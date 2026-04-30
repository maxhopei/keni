# Step 27 — env-api-key-loading

**Phase:** MVP
**Suggested change name:** `env-api-key-loading`
**Depends on:** 03

## Goal

Make API keys and other secrets loadable from a project-root `.env` file (git-ignored), layered with `~/.keni/config.yaml`, and propagate them safely to the right subprocess(es). After this step, the user can drop `.env` next to their `project.yaml`, and the engineer + PO subprocesses receive the API keys they need without secrets being committed or sprayed across logs.

## Scope

- `.env` loader at project root:
  - Standard `KEY=value` syntax. Quotes, escaping, comments handled per dotenv conventions.
  - Loaded once at server boot (and on `keni init` write a stub `.env.example` if missing).
  - Already git-ignored by step 03's `.gitignore`. Verify and document.
- Layering with `~/.keni/config.yaml`:
  - Global config provides defaults (e.g., a default `OPENAI_API_KEY` for shared projects).
  - `.env` at project root overrides them.
  - Documented precedence: `.env` > `~/.keni/config.yaml` > built-in defaults.
- Propagation:
  - Role runtime (step 07) injects the resolved env into spawned subprocesses, but **only the keys each role needs**. Decide a small allowlist per role (e.g., `ANTHROPIC_API_KEY` to engineer + PO, vendor-specific keys to whichever role uses them). Document.
  - The orchestration server reads its own keys (e.g., for any external service) but does NOT echo them in logs or activity entries.
- `keni init` (from step 03) gains:
  - A `.env.example` written next to `project.yaml` listing expected keys with empty values.
  - A note in the generated README about putting real values into `.env`.
- Redaction in activity log: known API key patterns are redacted before append. (Best-effort — defence in depth, not a security boundary.)

## Out of scope

- UI key management — post-MVP per §10.
- Encrypted secrets at rest — out of MVP.
- Cross-project key sharing UX — out of MVP.

## Spec references

- §7.1 — "API keys live in a `.env` file at the project root (MVP), git-ignored. Global defaults can live in `~/.keni/config.yaml`. Moving key management into the UI is post-MVP."
- §5.1 — `.gitignore` excludes `.env` already.
- §9 — MVP includes "`.env` support for API keys."
- §10 — UI key management is post-MVP.

## Open decisions for the proposer

- **Loader library / implementation.** A minimal hand-roll is fine; using a tiny dotenv lib is also fine. Document.
- **Key allowlist per role.** Concrete list informed by the coding-agent CLIs the project supports (`claude` → `ANTHROPIC_API_KEY`, etc.). Capture in `design.md`.
- **Redaction patterns.** Match common API-key patterns (`sk-...`, `Bearer ...`, etc.). Document.

## Notes for /opsx:propose

- `proposal.md` should explain that this step makes Keni runnable against real coding-agent CLIs without secret-handling hacks.
- `design.md` should pin: layered resolution, allowlists, propagation through role runtime, redaction strategy, the `.env.example` write on init.
- `tasks.md` should cover: loader, layered resolver, allowlist enforcement, role-runtime env-injection update, redaction filter, `.env.example` write, README update, integration tests against a temp project verifying the right keys reach the right subprocess.
- Capability spec for `secrets-loading` documents the contract.
