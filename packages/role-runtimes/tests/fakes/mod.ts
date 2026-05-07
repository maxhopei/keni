/**
 * Test-fakes barrel for `@keni/role-runtimes`. Cross-package consumers
 * import the fakes from `@keni/role-runtimes/test-fakes` (mapped via the
 * `exports` field in this package's `deno.json`). The production barrel
 * (`@keni/role-runtimes`) deliberately does NOT re-export anything from
 * this file — fakes are test-only seams.
 *
 * @module
 */

export type {
  FakeCodingAgentInvokerHandle,
  FakeCodingAgentInvokerOpts,
} from "./common/fakeCodingAgentInvoker.ts";
export { createFakeCodingAgentInvoker } from "./common/fakeCodingAgentInvoker.ts";

export { PLACEHOLDER_PROMPT_BODY, PLACEHOLDER_PROMPT_NAME } from "./common/placeholderPrompt.ts";

export type {
  FakeWorkspaceProvisionerCall,
  FakeWorkspaceProvisionerOpts,
} from "./engineer/workspace/fakeWorkspaceProvisioner.ts";
export { FakeWorkspaceProvisioner } from "./engineer/workspace/fakeWorkspaceProvisioner.ts";
