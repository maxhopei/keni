/**
 * Test-fakes barrel for `@keni/runtime-workspace`. Cross-package
 * consumers import the fake from `@keni/runtime-workspace/test-fakes`.
 *
 * @module
 */

export type {
  FakeWorkspaceProvisionerCall,
  FakeWorkspaceProvisionerOpts,
} from "./fakeWorkspaceProvisioner.ts";
export { FakeWorkspaceProvisioner } from "./fakeWorkspaceProvisioner.ts";
