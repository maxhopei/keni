/**
 * Core types for the role-runtime cycle.
 *
 * Every interface here is a parameter shape — none of them carry runtime
 * behaviour. The cycle (`startCycle.ts`) reads these shapes; the default
 * subprocess invoker (`codingAgentInvoker.ts`) builds a `Deno.Command`
 * from them; the activity-log adapter (`activityClient.ts`) stamps the
 * role / agent fields onto every `POST /activity`. Splitting them out
 * keeps the cycle's signature greppable in one place.
 *
 * No imports from `@keni/server` or any sibling runtime package —
 * these types are the public surface of `@keni/runtime-common`,
 * re-exported by `packages/runtime-common/src/main.ts`.
 *
 * @module
 */

import type { AgentId, Role } from "@keni/shared";

/**
 * A prompt body bundled into the binary as a TypeScript string constant
 * (`spec.md` §11#3). The `name` field is a defensive cross-check — the
 * cycle's `expectedPromptName` opt asserts `name === expectedName` so a
 * contributor who accidentally wires the PO chat prompt into the engineer
 * cycle gets caught at runtime rather than at agent-output time.
 *
 * The shape SHALL stay exactly two fields: any further metadata (versions,
 * provenance, etc.) lives in the file that exports the constant, not on
 * the wire shape.
 */
export interface BundledPrompt {
  readonly name: string;
  readonly body: string;
}

/**
 * Read-only context passed to `precheck` and `promptResolver`. A separate
 * type (rather than `RoleCycleParams` itself) so a future field added for
 * one of the two callbacks doesn't change the other's signature, and so
 * the callbacks cannot mutate the cycle's params.
 */
export interface CyclePrepCtx {
  readonly role: Role;
  readonly agentId: AgentId;
  readonly projectName: string;
  readonly workspacePath: string | null;
  readonly serverUrl: string;
}

/**
 * The precheck's return shape. `skip` short-circuits the entire cycle
 * (no `session_start`, no subprocess) per `spec.md` §6.1; `proceed` lets
 * the cycle continue and may carry an optional `summary` that becomes
 * the `session_start.summary` field.
 */
export type PrecheckResult =
  | { readonly kind: "skip"; readonly reason: string }
  | {
    readonly kind: "proceed";
    readonly roleContext?: { readonly summary?: string | null };
  };

/**
 * `mcpServers` config entry consumed by the coding-agent CLI. Matches the
 * documented `claude` / `cursor-agent` `--mcp-config` JSON shape so the
 * default invoker can write the file directly without a translation layer.
 */
export interface McpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The value the cycle hands to the invoker. The invoker reads this to
 * build its `Deno.Command`; the cycle does not look inside.
 */
export interface CodingAgentInvocation {
  readonly promptBody: string;
  readonly role: Role;
  readonly agentId: AgentId;
  readonly projectName: string;
  readonly workspacePath: string | null;
  readonly mcpServerConfig: McpServerConfig;
  readonly resumeSessionId: string | null;
  readonly envAllowlist: readonly string[];
}

/**
 * Callback bag the cycle hands the invoker. The invoker reads from the
 * subprocess's stdout / stderr line-by-line and calls the matching
 * callback; the cycle's callback wires the line into both an in-memory
 * buffer (used for summary extraction) and `POST /activity`.
 */
export interface CodingAgentLifecycle {
  readonly onStdoutLine: (line: string) => void | Promise<void>;
  readonly onStderrLine: (line: string) => void | Promise<void>;
  readonly onSpawn?: (info: { readonly pid: number }) => void;
  readonly abortSignal?: AbortSignal;
}

/**
 * The invoker's resolved outcome. `terminated` carries `terminatedBy`
 * for the activity-log entry's `refs.terminated_by` field.
 */
export type CodingAgentOutcome =
  | { readonly kind: "completed"; readonly exitCode: number }
  | {
    readonly kind: "terminated";
    readonly exitCode: number;
    readonly terminatedBy: "sigterm" | "sigkill";
  };

/**
 * The seam between the cycle and "spawn the binary". The default
 * implementation (`createSubprocessCodingAgentInvoker`) drives
 * `Deno.Command`; tests inject a fake invoker that pushes lines and
 * resolves the outcome explicitly (see `fakes/fakeCodingAgentInvoker.ts`).
 */
export interface CodingAgentInvoker {
  invoke(
    invocation: CodingAgentInvocation,
    lifecycle: CodingAgentLifecycle,
  ): Promise<CodingAgentOutcome>;
}

/**
 * Single typed bag for `startCycle`. Every field is `readonly` so the
 * cycle cannot mutate its inputs (a property the spec scenario "does not
 * mutate the params bag" exercises).
 */
export interface RoleCycleParams {
  readonly role: Role;
  readonly agentId: AgentId;
  readonly serverUrl: string;
  readonly projectName: string;
  readonly workspacePath?: string;
  readonly mcpServerConfig: McpServerConfig;
  readonly precheck: (ctx: CyclePrepCtx) => Promise<PrecheckResult> | PrecheckResult;
  readonly promptResolver: (ctx: CyclePrepCtx) => BundledPrompt;
  readonly expectedPromptName?: string;
  readonly codingAgentInvoker: CodingAgentInvoker;
  readonly resumeSessionId?: string;
  readonly signal?: AbortSignal;
  readonly idleThresholdMs?: number;
  readonly terminationGraceMs?: number;
  readonly maxLinesPerStream?: number;
  readonly envAllowlist?: readonly string[];
}

/**
 * Discriminated union covering every cycle outcome (`design.md`
 * Decision 10). Callers `switch` on `outcome` and the compiler enforces
 * exhaustiveness under `verbatimModuleSyntax`.
 *
 * `precheck_skipped` carries no `sessionId` (the cycle did not generate
 * one — `spec.md` §6.1 "no LLM tokens are spent"); every other outcome
 * carries a `sessionId` because the cycle emitted at least
 * `session_start` before the outcome was decided.
 */
export type RoleCycleResult =
  | {
    readonly outcome: "completed";
    readonly sessionId: string;
    readonly exitCode: number;
    readonly summary: string | null;
  }
  | { readonly outcome: "idle"; readonly sessionId: string }
  | { readonly outcome: "precheck_skipped"; readonly reason: string }
  | {
    readonly outcome: "terminated";
    readonly sessionId: string;
    readonly terminatedBy: "sigterm" | "sigkill";
    readonly exitCode: number;
  }
  | {
    readonly outcome: "spawn_failed";
    readonly sessionId: string;
    readonly error: Error;
  };

/** Codes for {@link RoleRuntimeError}. */
export type RoleRuntimeErrorCode =
  | "empty_prompt_body"
  | "prompt_name_mismatch"
  | "invalid_resume_session_id"
  | "workspace_required_for_strategy"
  | "mcp_config_corrupt";

/**
 * Typed error class for cycle-internal validation failures. Distinct from
 * {@link RoleRuntimeHttpError} (HTTP-shaped) so a caller can distinguish
 * "the cycle's input was wrong" from "the orchestration server rejected
 * a request".
 */
export class RoleRuntimeError extends Error {
  override readonly name = "RoleRuntimeError";
  readonly code: RoleRuntimeErrorCode;

  constructor(code: RoleRuntimeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Typed error class for activity-log HTTP failures. The `code` mirrors
 * the orchestration server's `ErrorResponse.error.code` when the server
 * responded; `httpStatus: 0` plus `code: "internal_error"` represents a
 * network-level failure (`fetch` rejected before a status was received).
 */
export class RoleRuntimeHttpError extends Error {
  override readonly name = "RoleRuntimeHttpError";
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly httpStatus: number;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> | undefined,
    httpStatus: number,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}
