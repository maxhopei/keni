/**
 * File-backed `PRStore` adapter — writes one
 * `<root>/.keni/prs/pr-NNNN.md` per PR as YAML front-matter + markdown
 * intent body, per `spec.md` §5.1.
 *
 * @module
 */

import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { writeFileAtomic } from "../atomic.ts";
import { InvalidArtifactError, StaleStateError, StoreNotFoundError } from "../errors.ts";
import { generatePrId, isPrId } from "../ids.ts";
import type { ProjectPaths } from "../paths.ts";
import type {
  PR,
  PRCreateInput,
  PRFilter,
  PRHeader,
  PRId,
  PRStatus,
  PRStore,
  PRSummary,
} from "./interface.ts";
import { matchPR } from "./shared.ts";

const FRONT_MATTER_DELIMITER = "---";
const VALID_STATUSES = new Set<PRStatus>([
  "open",
  "in_review",
  "has_comments",
  "approved",
  "merged",
]);

/**
 * File-backed `PRStore`. See `./interface.ts` for the contract; behavioural
 * equivalence with `InMemoryPRStore` enforced by `./contract_test.ts`.
 */
export class FilePRStore implements PRStore {
  readonly #prsDir: string;

  constructor(paths: Pick<ProjectPaths, "prs">) {
    this.#prsDir = paths.prs;
  }

  async list(filter?: PRFilter): Promise<PRSummary[]> {
    const ids = await this.#listPrIds();
    const out: PRSummary[] = [];
    for (const id of ids) {
      const pr = await this.#readById(id);
      if (matchPR(pr.header, filter)) out.push({ ...pr.header });
    }
    return out;
  }

  async read(id: PRId): Promise<PR> {
    return await this.#readById(id);
  }

  async create(input: PRCreateInput): Promise<PR> {
    const ids = await this.#listPrIds();
    const id = generatePrId(ids);
    const now = new Date().toISOString();
    const header: PRHeader = {
      id,
      title: input.title,
      status: "open",
      ticket: input.ticket,
      branch: input.branch,
      author: input.author,
      created_at: now,
      updated_at: now,
    };
    const pr: PR = { header, body: input.body ?? "" };
    await this.#writePR(pr);
    return pr;
  }

  async updateIntent(id: PRId, intent: string): Promise<PR> {
    const existing = await this.#readById(id);
    const updated: PR = {
      header: { ...existing.header, updated_at: new Date().toISOString() },
      body: intent,
    };
    await this.#writePR(updated);
    return updated;
  }

  async updateStatus(id: PRId, from: PRStatus, to: PRStatus): Promise<PR> {
    const existing = await this.#readById(id);
    if (existing.header.status !== from) {
      throw new StaleStateError(id, from, existing.header.status);
    }
    const updated: PR = {
      header: {
        ...existing.header,
        status: to,
        updated_at: new Date().toISOString(),
      },
      body: existing.body,
    };
    await this.#writePR(updated);
    return updated;
  }

  #pathFor(id: PRId): string {
    return join(this.#prsDir, `${id}.md`);
  }

  async #listPrIds(): Promise<string[]> {
    const ids: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.#prsDir)) {
        if (!entry.isFile) continue;
        if (!entry.name.endsWith(".md")) continue;
        const id = entry.name.slice(0, -".md".length);
        if (isPrId(id)) ids.push(id);
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
    return ids;
  }

  async #readById(id: PRId): Promise<PR> {
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
          `Expected a PR file but found a directory at ${path}`,
          path,
        );
      }
      throw err;
    }
    return parsePRFile(id, raw, path);
  }

  async #writePR(pr: PR): Promise<void> {
    await writeFileAtomic(this.#pathFor(pr.header.id), serialisePR(pr));
  }
}

function serialisePR(pr: PR): string {
  const orderedHeader = {
    id: pr.header.id,
    title: pr.header.title,
    status: pr.header.status,
    ticket: pr.header.ticket,
    branch: pr.header.branch,
    author: pr.header.author,
    created_at: pr.header.created_at,
    updated_at: pr.header.updated_at,
  };
  const yaml = stringifyYaml(orderedHeader).trimEnd();
  const body = pr.body === "" ? "" : pr.body.endsWith("\n") ? pr.body : pr.body + "\n";
  return `${FRONT_MATTER_DELIMITER}\n${yaml}\n${FRONT_MATTER_DELIMITER}\n\n${body}`;
}

function parsePRFile(id: PRId, raw: string, path: string): PR {
  const lines = raw.split("\n");
  if (lines[0] !== FRONT_MATTER_DELIMITER) {
    throw new InvalidArtifactError(
      "missing_front_matter",
      `PR file ${path} does not start with '---' front-matter delimiter`,
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
      `PR file ${path} has an unterminated front-matter block`,
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

function coerceHeader(raw: unknown, expectedId: PRId, path: string): PRHeader {
  if (raw === null || typeof raw !== "object") {
    throw new InvalidArtifactError(
      "invalid_header_shape",
      `PR header in ${path} is not a YAML mapping`,
      path,
    );
  }
  const r = raw as Record<string, unknown>;
  const id = expectString(r, "id", path);
  if (id !== expectedId) {
    throw new InvalidArtifactError(
      "id_mismatch",
      `PR id in header (${id}) does not match filename (${expectedId}) at ${path}`,
      path,
    );
  }
  const status = expectString(r, "status", path);
  if (!VALID_STATUSES.has(status as PRStatus)) {
    throw new InvalidArtifactError(
      "invalid_status",
      `Unknown PR status '${status}' in ${path}`,
      path,
    );
  }
  return {
    id,
    title: expectString(r, "title", path),
    status: status as PRStatus,
    ticket: expectString(r, "ticket", path),
    branch: expectString(r, "branch", path),
    author: expectString(r, "author", path),
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
