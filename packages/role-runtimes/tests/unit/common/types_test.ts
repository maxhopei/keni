/**
 * Type-level assertions for `types.ts`. These tests do not exercise any
 * runtime behaviour — they are compile-time checks that the public types
 * keep their documented shape. A drift (e.g., dropping a branch from
 * `RoleCycleResult`) fails `deno task check`.
 *
 * Pattern matches the `Expect<Equal<X, Y>>` helper used by
 * `packages/server/src/wire/agents_test.ts` so the workspace stays
 * consistent.
 */

import type { AgentId, Role } from "@keni/shared";
import type {
  BundledPrompt,
  CodingAgentOutcome,
  RoleCycleParams,
  RoleCycleResult,
} from "../../../src/common/types.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true
  : false;
type Expect<T extends true> = T;

type _RoleCycleResultIsFiveMembers = Expect<
  Equal<
    RoleCycleResult["outcome"],
    "completed" | "idle" | "precheck_skipped" | "terminated" | "spawn_failed"
  >
>;

type _CodingAgentOutcomeIsTwoMembers = Expect<
  Equal<CodingAgentOutcome["kind"], "completed" | "terminated">
>;

type _RoleCycleParamsRoleIsRole = Expect<Equal<RoleCycleParams["role"], Role>>;

type _RoleCycleParamsAgentIdIsAgentId = Expect<Equal<RoleCycleParams["agentId"], AgentId>>;

type _BundledPromptHasNameAndBodyOnly = Expect<
  Equal<keyof BundledPrompt, "name" | "body">
>;

type CompletedShape = Extract<RoleCycleResult, { outcome: "completed" }>;
type _CompletedShapeIsExhaustive = Expect<
  Equal<keyof CompletedShape, "outcome" | "sessionId" | "exitCode" | "summary">
>;

type IdleShape = Extract<RoleCycleResult, { outcome: "idle" }>;
type _IdleShapeIsSessionIdOnly = Expect<Equal<keyof IdleShape, "outcome" | "sessionId">>;

type PrecheckSkippedShape = Extract<RoleCycleResult, { outcome: "precheck_skipped" }>;
type _PrecheckSkippedShapeHasNoSessionId = Expect<
  Equal<keyof PrecheckSkippedShape, "outcome" | "reason">
>;

Deno.test("type-level assertions compile (presence smoke)", () => {
  const _typeAssertions: [
    _RoleCycleResultIsFiveMembers,
    _CodingAgentOutcomeIsTwoMembers,
    _RoleCycleParamsRoleIsRole,
    _RoleCycleParamsAgentIdIsAgentId,
    _BundledPromptHasNameAndBodyOnly,
    _CompletedShapeIsExhaustive,
    _IdleShapeIsSessionIdOnly,
    _PrecheckSkippedShapeHasNoSessionId,
  ] = [true, true, true, true, true, true, true, true];
  if (!_typeAssertions.every((v) => v === true)) throw new Error("unreachable");
});

Deno.test("RoleCycleResult exhaustive switch type-checks", () => {
  function describe(result: RoleCycleResult): string {
    switch (result.outcome) {
      case "completed":
        return `completed: ${result.exitCode}`;
      case "idle":
        return `idle: ${result.sessionId}`;
      case "precheck_skipped":
        return `skipped: ${result.reason}`;
      case "terminated":
        return `terminated: ${result.terminatedBy}`;
      case "spawn_failed":
        return `failed: ${result.error.message}`;
    }
  }
  const sample: RoleCycleResult = {
    outcome: "precheck_skipped",
    reason: "no_work",
  };
  if (describe(sample) !== "skipped: no_work") throw new Error("unreachable");
});
