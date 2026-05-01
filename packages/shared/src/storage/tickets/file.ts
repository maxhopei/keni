/**
 * File-backed `TicketStore` adapter — writes one
 * `<root>/.keni/tickets/ticket-NNNN.md` per ticket as YAML front-matter +
 * markdown body, per `spec.md` §5.1.
 *
 * @module
 */

import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { writeFileAtomic } from "../atomic.ts";
import { InvalidArtifactError, StaleStateError, StoreNotFoundError } from "../errors.ts";
import { generateTicketId, isTicketId } from "../ids.ts";
import type { ProjectPaths } from "../paths.ts";
import type {
  Ticket,
  TicketCreateInput,
  TicketFilter,
  TicketHeader,
  TicketHeaderPatch,
  TicketId,
  TicketStatus,
  TicketStore,
  TicketSummary,
} from "./interface.ts";
import { matchTicket, validateHeaderPatch } from "./shared.ts";

const FRONT_MATTER_DELIMITER = "---";
const VALID_STATUSES = new Set<TicketStatus>([
  "open",
  "in_progress",
  "ready_for_review",
  "in_review",
  "has_comments",
  "approved",
  "merged",
  "ready_for_test",
  "in_testing",
  "tested",
  "test_failed",
  "done",
]);

/**
 * File-backed `TicketStore`. See `./interface.ts` for the full contract;
 * behavioural equivalence with `InMemoryTicketStore` is enforced by
 * `./contract_test.ts`.
 *
 * Single-writer-per-artifact: concurrent writers to the same ticket are
 * undefined behaviour. Serialise at the REST/MCP layer.
 */
export class FileTicketStore implements TicketStore {
  readonly #ticketsDir: string;

  constructor(paths: Pick<ProjectPaths, "tickets">) {
    this.#ticketsDir = paths.tickets;
  }

  async list(filter?: TicketFilter): Promise<TicketSummary[]> {
    const ids = await this.#listTicketIds();
    const out: TicketSummary[] = [];
    for (const id of ids) {
      const ticket = await this.#readById(id);
      if (matchTicket(ticket.header, filter)) {
        out.push({ ...ticket.header });
      }
    }
    return out;
  }

  async read(id: TicketId): Promise<Ticket> {
    return await this.#readById(id);
  }

  async create(input: TicketCreateInput): Promise<Ticket> {
    const ids = await this.#listTicketIds();
    const id = generateTicketId(ids);
    const now = new Date().toISOString();
    const header: TicketHeader = {
      id,
      title: input.title,
      status: "open",
      assignee: input.assignee ?? null,
      priority: input.priority,
      change_request: input.change_request ?? null,
      created_at: now,
      updated_at: now,
    };
    const ticket: Ticket = { header, body: input.body ?? "" };
    await this.#writeTicket(ticket);
    return ticket;
  }

  async updateBody(id: TicketId, body: string): Promise<Ticket> {
    const existing = await this.#readById(id);
    const updated: Ticket = {
      header: { ...existing.header, updated_at: new Date().toISOString() },
      body,
    };
    await this.#writeTicket(updated);
    return updated;
  }

  async updateHeader(
    id: TicketId,
    patch: TicketHeaderPatch,
  ): Promise<Ticket> {
    validateHeaderPatch(patch);
    const existing = await this.#readById(id);
    const newHeader: TicketHeader = {
      ...existing.header,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.change_request !== undefined ? { change_request: patch.change_request } : {}),
      updated_at: new Date().toISOString(),
    };
    const updated: Ticket = { header: newHeader, body: existing.body };
    await this.#writeTicket(updated);
    return updated;
  }

  async transitionStatus(
    id: TicketId,
    from: TicketStatus,
    to: TicketStatus,
  ): Promise<Ticket> {
    const existing = await this.#readById(id);
    if (existing.header.status !== from) {
      throw new StaleStateError(id, from, existing.header.status);
    }
    const updated: Ticket = {
      header: {
        ...existing.header,
        status: to,
        updated_at: new Date().toISOString(),
      },
      body: existing.body,
    };
    await this.#writeTicket(updated);
    return updated;
  }

  async linkChangeRequest(
    id: TicketId,
    changeRequestId: string,
  ): Promise<Ticket> {
    const existing = await this.#readById(id);
    const updated: Ticket = {
      header: {
        ...existing.header,
        change_request: changeRequestId,
        updated_at: new Date().toISOString(),
      },
      body: existing.body,
    };
    await this.#writeTicket(updated);
    return updated;
  }

  #pathFor(id: TicketId): string {
    return join(this.#ticketsDir, `${id}.md`);
  }

  async #listTicketIds(): Promise<string[]> {
    const ids: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.#ticketsDir)) {
        if (!entry.isFile) continue;
        if (!entry.name.endsWith(".md")) continue;
        const id = entry.name.slice(0, -".md".length);
        if (isTicketId(id)) ids.push(id);
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
    return ids;
  }

  async #readById(id: TicketId): Promise<Ticket> {
    const path = this.#pathFor(id);
    let raw: string;
    try {
      raw = await Deno.readTextFile(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new StoreNotFoundError(id, path);
      }
      if (err instanceof Deno.errors.IsADirectory) {
        throw new InvalidArtifactError(
          "is_directory",
          `Expected a ticket file but found a directory at ${path}`,
          path,
        );
      }
      throw err;
    }
    return parseTicketFile(id, raw, path);
  }

  async #writeTicket(ticket: Ticket): Promise<void> {
    const path = this.#pathFor(ticket.header.id);
    const serialised = serialiseTicket(ticket);
    await writeFileAtomic(path, serialised);
  }
}

/**
 * Serialise a ticket to its on-disk form: YAML front-matter (with the header
 * fields in `spec.md` §5.1's documented order) followed by the body.
 */
function serialiseTicket(ticket: Ticket): string {
  const orderedHeader = {
    id: ticket.header.id,
    title: ticket.header.title,
    status: ticket.header.status,
    assignee: ticket.header.assignee,
    priority: ticket.header.priority,
    change_request: ticket.header.change_request,
    created_at: ticket.header.created_at,
    updated_at: ticket.header.updated_at,
  };
  const yaml = stringifyYaml(orderedHeader).trimEnd();
  const body = ticket.body.endsWith("\n")
    ? ticket.body
    : ticket.body === ""
    ? ""
    : ticket.body + "\n";
  return `${FRONT_MATTER_DELIMITER}\n${yaml}\n${FRONT_MATTER_DELIMITER}\n\n${body}`;
}

/**
 * Parse a ticket file's text into a {@link Ticket}. Throws
 * {@link InvalidArtifactError} on malformed front-matter or schema violations.
 */
function parseTicketFile(id: TicketId, raw: string, path: string): Ticket {
  const lines = raw.split("\n");
  if (lines[0] !== FRONT_MATTER_DELIMITER) {
    throw new InvalidArtifactError(
      "missing_front_matter",
      `Ticket file ${path} does not start with '---' front-matter delimiter`,
      path,
    );
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONT_MATTER_DELIMITER) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new InvalidArtifactError(
      "unterminated_front_matter",
      `Ticket file ${path} has an unterminated front-matter block`,
      path,
    );
  }
  const yaml = lines.slice(1, endIdx).join("\n");
  let header: unknown;
  try {
    header = parseYaml(yaml);
  } catch (err) {
    throw new InvalidArtifactError(
      "malformed_yaml",
      `Failed to parse YAML header in ${path}: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }
  const validHeader = coerceHeader(header, id, path);
  const bodyStart = endIdx + 1;
  let body = lines.slice(bodyStart).join("\n");
  if (body.startsWith("\n")) body = body.slice(1);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return { header: validHeader, body };
}

function coerceHeader(
  raw: unknown,
  expectedId: TicketId,
  path: string,
): TicketHeader {
  if (raw === null || typeof raw !== "object") {
    throw new InvalidArtifactError(
      "invalid_header_shape",
      `Ticket header in ${path} is not a YAML mapping`,
      path,
    );
  }
  const r = raw as Record<string, unknown>;
  const id = expectString(r, "id", path);
  if (id !== expectedId) {
    throw new InvalidArtifactError(
      "id_mismatch",
      `Ticket id in header (${id}) does not match filename (${expectedId}) at ${path}`,
      path,
    );
  }
  const status = expectString(r, "status", path);
  if (!VALID_STATUSES.has(status as TicketStatus)) {
    throw new InvalidArtifactError(
      "invalid_status",
      `Unknown status '${status}' in ${path}`,
      path,
    );
  }
  return {
    id,
    title: expectString(r, "title", path),
    status: status as TicketStatus,
    assignee: expectStringOrNull(r, "assignee", path),
    priority: expectNumber(r, "priority", path),
    change_request: expectStringOrNull(r, "change_request", path),
    created_at: expectString(r, "created_at", path),
    updated_at: expectString(r, "updated_at", path),
  };
}

function expectString(
  r: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const v = r[key];
  if (typeof v !== "string") {
    throw new InvalidArtifactError(
      "missing_or_invalid_field",
      `Expected string for '${key}' in ${path}, got ${typeof v}`,
      path,
    );
  }
  return v;
}

function expectStringOrNull(
  r: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const v = r[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new InvalidArtifactError(
      "missing_or_invalid_field",
      `Expected string or null for '${key}' in ${path}, got ${typeof v}`,
      path,
    );
  }
  return v;
}

function expectNumber(
  r: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const v = r[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new InvalidArtifactError(
      "missing_or_invalid_field",
      `Expected finite number for '${key}' in ${path}, got ${typeof v}`,
      path,
    );
  }
  return v;
}
