/**
 * Test-fakes barrel for `@keni/runtime-common`. Cross-package consumers
 * import the fakes from `@keni/runtime-common/test-fakes` (mapped via
 * the `exports` field in this package's `deno.json`). The production
 * barrel (`@keni/runtime-common`) deliberately does NOT re-export
 * anything from this file — fakes are test-only seams.
 *
 * @module
 */

export type {
  FakeCodingAgentInvokerHandle,
  FakeCodingAgentInvokerOpts,
} from "./fakeCodingAgentInvoker.ts";
export { createFakeCodingAgentInvoker } from "./fakeCodingAgentInvoker.ts";

export { PLACEHOLDER_PROMPT_BODY, PLACEHOLDER_PROMPT_NAME } from "./placeholderPrompt.ts";
