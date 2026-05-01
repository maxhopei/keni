/**
 * Storage module for Keni — interfaces and default implementations for every
 * artifact type a consumer (REST, MCP, role runtimes, SPA) reads or writes.
 *
 * Per `spec.md` §2#6 and §11#5 ("files first, storage abstracted"), every
 * consumer binds to these interfaces. The file-backed adapters are the default
 * implementation; a future database-backed adapter is an additive module, not a
 * rewrite. The `.keni/de-facto-spec/` and `.keni/changes/` directories are the
 * scoped exception (§5.3) and are deliberately not covered here.
 *
 * See `./README.md` for the full contract, atomicity guarantee, and
 * single-writer-per-artifact constraint.
 *
 * @module
 */

export {
  DuplicateIdError,
  InvalidArtifactError,
  StaleStateError,
  StoreNotFoundError,
} from "./errors.ts";

export {
  generateActivityId,
  generatePrId,
  generateTicketId,
  isPrId,
  isTicketId,
  parsePrSequence,
  parseTicketSequence,
} from "./ids.ts";

export type { GlobalPaths, ProjectPaths } from "./paths.ts";
export { resolveGlobalPaths, resolveProjectPaths } from "./paths.ts";

export type {
  Ticket,
  TicketCreateInput,
  TicketFilter,
  TicketHeader,
  TicketHeaderPatch,
  TicketId,
  TicketStatus,
  TicketStore,
  TicketSummary,
} from "./tickets/interface.ts";
export { FileTicketStore } from "./tickets/file.ts";
export { InMemoryTicketStore } from "./tickets/memory.ts";

export type {
  PR,
  PRCreateInput,
  PRFilter,
  PRHeader,
  PRId,
  PRStatus,
  PRStore,
  PRSummary,
} from "./prs/interface.ts";
export { FilePRStore } from "./prs/file.ts";
export { InMemoryPRStore } from "./prs/memory.ts";

export type {
  ActivityEntry,
  ActivityEntryId,
  ActivityEntryInput,
  ActivityFilter,
  ActivityLogStore,
} from "./activity/interface.ts";
export { FileActivityLogStore } from "./activity/file.ts";
export { InMemoryActivityLogStore } from "./activity/memory.ts";

export type {
  AgentConfig,
  ConfigStore,
  GlobalConfig,
  ProjectConfig,
  ResolvedConfig,
} from "./config/interface.ts";
export { FileConfigStore } from "./config/file.ts";
export { InMemoryConfigStore } from "./config/memory.ts";
