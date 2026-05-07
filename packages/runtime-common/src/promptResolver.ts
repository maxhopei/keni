/**
 * Bundled-prompt resolution helper (`design.md` Decision 3 / `spec.md`
 * §11#3).
 *
 * The function validates a {@link BundledPrompt} a role's resolver
 * returned. It enforces two invariants:
 *
 * 1. The body MUST be non-empty. An empty body is almost always a wiring
 *    bug — a role accidentally exporting an empty TS string constant —
 *    and rejecting it loudly here costs nothing.
 * 2. When `expectedName` is supplied, the prompt's `name` MUST match.
 *    This is the engineer cycle's defence-in-depth against a contributor
 *    accidentally wiring the PO chat prompt into the engineer flow.
 *
 * On success, the validated prompt is returned verbatim (no copy, no
 * normalisation — the body is passed straight into the subprocess
 * invoker's stdin).
 *
 * No file-IO seam exists in this module: there is no `loadPromptFromPath`
 * or any equivalent. Prompts ship as TypeScript string constants compiled
 * into the binary. A structural test (`integration_test.ts`'s "no `.keni/`
 * reads from the runtime" assertion) catches any future drift.
 *
 * @module
 */

import { type BundledPrompt, RoleRuntimeError } from "./types.ts";

/**
 * Validate a bundled prompt and return it on success. Throws
 * {@link RoleRuntimeError} when the body is empty or (when `expectedName`
 * is supplied) when the name does not match.
 */
export function resolveBundledPrompt(
  prompt: BundledPrompt,
  expectedName?: string,
): BundledPrompt {
  if (prompt.body.length === 0) {
    throw new RoleRuntimeError(
      "empty_prompt_body",
      `Prompt "${prompt.name}" has an empty body — bundled prompts must be non-empty TS string constants.`,
    );
  }
  if (expectedName !== undefined && prompt.name !== expectedName) {
    throw new RoleRuntimeError(
      "prompt_name_mismatch",
      `Expected bundled prompt "${expectedName}" but received "${prompt.name}".`,
    );
  }
  return prompt;
}
