/**
 * Barrel for MCP-internal wire schemas and types. The `tools/` layer
 * imports from here; nothing outside `packages/server/src/mcp/` should
 * touch this barrel (the SPA / role runtimes use the orchestration
 * server's wire types via `@keni/shared`).
 *
 * @module
 */

export type {
  ListTicketsInput,
  ReadTicketInput,
  TransitionTicketInput,
  UpdateTicketBodyInput,
} from "./tickets.ts";
export {
  ListTicketsInputSchema,
  ReadTicketInputSchema,
  TICKET_STATUSES,
  TransitionTicketInputSchema,
  UpdateTicketBodyInputSchema,
} from "./tickets.ts";

export type { AppendActivityInput, QueryActivityInput } from "./activity.ts";
export {
  AppendActivityInputSchema,
  QUERY_ACTIVITY_DEFAULT_LIMIT,
  QUERY_ACTIVITY_MAX_LIMIT,
  QueryActivityInputSchema,
} from "./activity.ts";

export type { GetWorkspacePathInput, WorkspacePathResponse } from "./workspace.ts";
export { GetWorkspacePathInputSchema } from "./workspace.ts";

export type { MergePrInput } from "./prs.ts";
export { MergePrInputSchema, PR_ID_PATTERN } from "./prs.ts";
