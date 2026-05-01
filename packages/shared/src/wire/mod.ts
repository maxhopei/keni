/**
 * Wire shapes for the orchestration server's HTTP API.
 *
 * These are the request/response types every typed consumer (SPA, role
 * runtimes, integration tests) imports. They are deliberately separate from
 * the storage records in `@keni/shared/storage/*`; the server maps between
 * them in `packages/server/src/routes/*.ts` (design.md Decision 6).
 *
 * No runtime symbols live here — this barrel re-exports types only, so a
 * `import type { ... } from "@keni/shared"` in the SPA tree-shakes zod out
 * of the bundle (zod schemas live in `packages/server/src/wire/`).
 *
 * @module
 */

export type { AgentId, Role } from "./role.ts";
export { isRole, ROLES } from "./role.ts";

export type { ErrorCode, ErrorResponse } from "./errors.ts";
export { ERROR_CODES, isErrorCode } from "./errors.ts";

export type {
  TicketCreateRequest,
  TicketEnvelope,
  TicketHeaderPatchRequest,
  TicketListResponse,
  TicketResponse,
  TicketSummaryResponse,
  TicketTransitionRequest,
} from "./tickets.ts";

export type {
  PRCreateRequest,
  PREnvelope,
  PRIntentPatchRequest,
  PRListResponse,
  PRResponse,
  PRSummaryResponse,
  PRTransitionRequest,
} from "./prs.ts";

export type {
  ActivityAppendRequest,
  ActivityEntryResponse,
  ActivityEnvelope,
  ActivityQueryResponse,
} from "./activity.ts";
