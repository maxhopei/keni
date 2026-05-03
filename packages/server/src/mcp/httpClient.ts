/**
 * Typed HTTP adapter from the MCP layer to the orchestration server's
 * REST surface. Every tool handler delegates here; no tool reads or
 * writes `.keni/` directly (design.md Decision 6 / spec scenario "no
 * tool reads `.keni/` directly").
 *
 * Identity propagation lives in this module — the closure returned by
 * {@link createMcpHttpClient} captures `agentId` and `serverUrl` at boot
 * and stamps `X-Keni-Role: engineer` and `X-Keni-Agent: <agentId>` on
 * every outbound request. Tool input has no surface to override either.
 *
 * On a 2xx response the `{ data, project_id }` envelope is unwrapped and
 * `data` is returned. On a non-2xx the `{ error: { code, message,
 * details } }` envelope is parsed and surfaced as a typed
 * {@link McpHttpError}; on a network-level rejection the wrapper produces
 * `McpHttpError("internal_error", "Network error talking to <url>: ...",
 * undefined, 0)`.
 *
 * @module
 */

import type {
  ActivityAppendRequest,
  ActivityEntryResponse,
  ActivityFilter,
  ErrorCode,
  MergePrResponse,
  TicketResponse,
  TicketStatus,
  TicketSummaryResponse,
} from "@keni/shared";
import { McpHttpError } from "./errors.ts";
import type { ListTicketsInput } from "./wire/tickets.ts";

/**
 * Public surface of the typed HTTP client. Every method composes a URL,
 * stamps headers, parses the envelope, and either returns the inner
 * `data` or throws {@link McpHttpError}.
 */
export interface McpHttpClient {
  listTickets(filter: ListTicketsInput): Promise<readonly TicketSummaryResponse[]>;
  readTicket(id: string): Promise<TicketResponse>;
  updateTicketBody(id: string, body: string): Promise<TicketResponse>;
  transitionTicket(id: string, from: TicketStatus, to: TicketStatus): Promise<TicketResponse>;
  appendActivity(input: ActivityAppendRequest): Promise<ActivityEntryResponse>;
  queryActivity(
    filter: ActivityFilter,
    limit: number,
  ): Promise<readonly ActivityEntryResponse[]>;
  /**
   * `POST /prs/:id/merge` — request a fast-forward merge of an
   * `approved` PR's branch into `main`. Empty body. Returns the
   * resulting `merge_commit_sha` from the unwrapped envelope; throws
   * {@link McpHttpError} (`code: "merge_conflict"`) when git refuses
   * a fast-forward.
   */
  mergePr(prId: string): Promise<MergePrResponse>;
}

/** Constructor options. */
export interface McpHttpClientOptions {
  /** Base URL of the orchestration server, e.g. `http://127.0.0.1:8080`. */
  readonly serverUrl: string;
  /** Agent id stamped into `X-Keni-Agent` and into the `agent` body of activity appends. */
  readonly agentId: string;
}

/** Build a typed HTTP client with identity captured in the closure. */
export function createMcpHttpClient(opts: McpHttpClientOptions): McpHttpClient {
  const base = new URL(opts.serverUrl);
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    "X-Keni-Role": "engineer",
    "X-Keni-Agent": opts.agentId,
    ...(extra ?? {}),
  });

  const buildUrl = (path: string, search?: URLSearchParams): URL => {
    const url = new URL(path.startsWith("/") ? path.slice(1) : path, base);
    if (search !== undefined && [...search.keys()].length > 0) {
      url.search = search.toString();
    }
    return url;
  };

  /**
   * Issue a `fetch`, parse the envelope, and either return `data` (typed
   * as `T`) or throw {@link McpHttpError}. Wraps every network-level
   * rejection in `McpHttpError("internal_error", ..., 0)` whose message
   * names the URL — the spec's "names the URL that was being targeted"
   * scenario.
   */
  const send = async <T>(url: URL, init: RequestInit): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      const causeMessage = cause instanceof Error ? cause.message : String(cause);
      throw new McpHttpError(
        "internal_error",
        `Network error talking to ${url.toString()}: ${causeMessage}`,
        undefined,
        0,
      );
    }

    if (response.ok) {
      const body = await readJson(response, url);
      return extractData<T>(body, url);
    }

    const errBody = await readJsonOrText(response);
    const code = pickStringField(errBody, "error.code") ?? "internal_error";
    const message = pickStringField(errBody, "error.message") ?? response.statusText;
    const details = pickRecordField(errBody, "error.details");
    throw new McpHttpError(code, message, details, response.status);
  };

  return {
    listTickets: (filter) => {
      const search = new URLSearchParams();
      if (filter.status !== undefined) {
        const status = filter.status;
        const value: string = typeof status === "string" ? status : status.join(",");
        search.set("status", value);
      }
      if (filter.assignee !== undefined) {
        search.set("assignee", filter.assignee === null ? "null" : filter.assignee);
      }
      if (filter.priorityMin !== undefined) {
        search.set("priorityMin", String(filter.priorityMin));
      }
      if (filter.priorityMax !== undefined) {
        search.set("priorityMax", String(filter.priorityMax));
      }
      if (filter.change_request !== undefined) {
        search.set(
          "change_request",
          filter.change_request === null ? "null" : filter.change_request,
        );
      }
      const url = buildUrl("/tickets", search);
      return send<readonly TicketSummaryResponse[]>(url, {
        method: "GET",
        headers: headers(),
      });
    },

    readTicket: (id) => {
      const url = buildUrl(`/tickets/${encodeURIComponent(id)}`);
      return send<TicketResponse>(url, { method: "GET", headers: headers() });
    },

    updateTicketBody: (id, body) => {
      const url = buildUrl(`/tickets/${encodeURIComponent(id)}`);
      return send<TicketResponse>(url, {
        method: "PATCH",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ body }),
      });
    },

    transitionTicket: (id, from, to) => {
      const url = buildUrl(`/tickets/${encodeURIComponent(id)}/transition`);
      return send<TicketResponse>(url, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ from, to }),
      });
    },

    appendActivity: (input) => {
      const stamped: ActivityAppendRequest = {
        ...input,
        agent: opts.agentId,
        role: "engineer",
      };
      const url = buildUrl("/activity");
      return send<ActivityEntryResponse>(url, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(stamped),
      });
    },

    queryActivity: async (filter, limit) => {
      const search = new URLSearchParams();
      if (filter.agent !== undefined) search.set("agent", filter.agent);
      if (filter.role !== undefined) search.set("role", filter.role);
      if (filter.from !== undefined) search.set("from", filter.from);
      if (filter.to !== undefined) search.set("to", filter.to);
      const url = buildUrl("/activity", search);
      const all = await send<readonly ActivityEntryResponse[]>(url, {
        method: "GET",
        headers: headers(),
      });
      return all.slice(0, limit);
    },

    mergePr: (prId) => {
      const url = buildUrl(`/prs/${encodeURIComponent(prId)}/merge`);
      return send<MergePrResponse>(url, {
        method: "POST",
        headers: headers(),
      });
    },
  };
}

/** Typed `unknown` envelope produced by `response.json()`. */
type Envelope<T> = { readonly data: T; readonly project_id: string };

async function readJson(response: Response, url: URL): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    throw new McpHttpError(
      "internal_error",
      `Malformed JSON from ${url.toString()}: ${causeMessage}`,
      undefined,
      response.status,
    );
  }
}

async function readJsonOrText(response: Response): Promise<unknown> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return {
      error: {
        code: "internal_error" satisfies ErrorCode,
        message: response.statusText,
      },
    };
  }
  if (raw.length === 0) {
    return {
      error: {
        code: "internal_error" satisfies ErrorCode,
        message: response.statusText,
      },
    };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {
      error: {
        code: "internal_error" satisfies ErrorCode,
        message: raw,
      },
    };
  }
}

function extractData<T>(body: unknown, url: URL): T {
  if (
    typeof body === "object" && body !== null && "data" in body
  ) {
    return (body as Envelope<T>).data;
  }
  throw new McpHttpError(
    "internal_error",
    `Malformed response from ${url.toString()}: missing 'data' envelope field`,
    undefined,
    200,
  );
}

function pickStringField(body: unknown, path: string): string | undefined {
  const value = pick(body, path);
  return typeof value === "string" ? value : undefined;
}

function pickRecordField(
  body: unknown,
  path: string,
): Record<string, unknown> | undefined {
  const value = pick(body, path);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function pick(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const segment of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}
