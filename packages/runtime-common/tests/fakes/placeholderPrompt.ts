/**
 * Placeholder bundled prompt — test-only stand-in for what real roles
 * (`engineer`, the four PO prompts, …) export under `src/<role>/prompts/`.
 *
 * Used by the role-runtime-common integration test (in this package) and
 * the scheduler integration test (in `@keni/server`) to drive
 * `startCycle` / a fake `AgentRunner` without depending on a specific
 * role's bundled prompt. No production code path imports these
 * constants — `RoleCycleParams.promptResolver` is supplied by the role.
 *
 * Cross-package callers SHALL import from `@keni/runtime-common/test-fakes`
 * (the secondary export entry); this module is re-exported via
 * `packages/runtime-common/tests/fakes/mod.ts`.
 *
 * @module
 */

export const PLACEHOLDER_PROMPT_BODY =
  "PLACEHOLDER PROMPT — used by the role-runtime-common integration test only. Replace per role in steps 09 / 18.\n";

export const PLACEHOLDER_PROMPT_NAME = "placeholder";
