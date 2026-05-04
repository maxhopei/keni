/**
 * Typed REST client for the orchestration server's HTTP surface.
 *
 * Single seam: every `fetch(...)` against an orchestration-server endpoint
 * lives in this file. A static-grep for `fetch(` in `packages/spa/src/`
 * outside `apiClient.ts` and `apiClient_test.ts` is a violation of the
 * `spa-shell` capability spec ("`apiClient` is the only place the SPA
 * issues HTTP calls").
 *
 * Method signatures bind directly to the wire types in `@keni/shared`; a
 * server-side wire change cascades into a SPA build error at the
 * destructure / callsite (no client-side re-declaration).
 */

import type {
  ActivityAppendRequest,
  ActivityEntryResponse,
  ActivityEnvelope,
  ActivityQueryResponse,
  AgentEnvelope,
  AgentListResponse,
  ErrorCode,
  ErrorResponse,
  MergePrEnvelope,
  PREnvelope,
  PRIntentPatchRequest,
  PRListResponse,
  PRTransitionRequest,
  Role,
  TicketCreateRequest,
  TicketEnvelope,
  TicketHeaderPatchRequest,
  TicketListResponse,
  TicketTransitionRequest,
} from "@keni/shared";

/**
 * Typed error surfaced by every `apiClient` method on a non-2xx response.
 * `code` is narrowed to the closed `ErrorCode` union from `@keni/shared`.
 */
export class KeniApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "KeniApiError";
  }
}

export interface ListTicketsFilter {
  readonly status?: readonly string[];
}

export interface ListPrsFilter {
  readonly status?: readonly string[];
  /** Narrow to PRs whose parent ticket id equals the given value. */
  readonly ticket?: string;
}

export interface ListActivityFilter {
  readonly agent?: string;
  readonly role?: Role;
  readonly from?: string;
  readonly to?: string;
}

export interface ApiClient {
  /** Resolves the project id once and caches it for the client's lifetime. */
  getProjectId(): Promise<string>;
  listAgents(): Promise<AgentListResponse>;
  pauseAgent(id: string): Promise<AgentEnvelope>;
  resumeAgent(id: string): Promise<AgentEnvelope>;
  /**
   * Abort the agent's in-flight cycle (`interrupt-and-timeout-ux`
   * capability). Resolves with the post-call `AgentResponse` on either
   * a real interrupt or an idempotent no-op (the server returns 200 in
   * both cases — `design.md` Decision 2). Rejects with `KeniApiError`
   * for `403 role_not_owner` (non-user roles) or `404 store_not_found`
   * (unknown agent id).
   */
  interruptAgent(id: string): Promise<AgentEnvelope>;
  listTickets(filter?: ListTicketsFilter): Promise<TicketListResponse>;
  getTicket(id: string): Promise<TicketEnvelope>;
  createTicket(input: TicketCreateRequest): Promise<TicketEnvelope>;
  patchTicket(id: string, patch: TicketHeaderPatchRequest): Promise<TicketEnvelope>;
  transitionTicket(id: string, req: TicketTransitionRequest): Promise<TicketEnvelope>;
  listPrs(filter?: ListPrsFilter): Promise<PRListResponse>;
  getPr(id: string): Promise<PREnvelope>;
  patchPrIntent(id: string, req: PRIntentPatchRequest): Promise<PREnvelope>;
  transitionPr(id: string, req: PRTransitionRequest): Promise<PREnvelope>;
  mergePr(id: string): Promise<MergePrEnvelope>;
  listActivity(filter?: ListActivityFilter): Promise<ActivityQueryResponse>;
  appendActivity(input: ActivityAppendRequest): Promise<ActivityEnvelope>;
}

export interface CreateApiClientOpts {
  /**
   * Base URL prefix for every request. Default `""` — the SPA hits relative
   * paths and the dev-server proxy (or, in production, the same-origin
   * orchestration server) routes them. Tests override this with their
   * mock backend URL.
   */
  readonly baseUrl?: string;
  /** Role stamped onto every request as `X-Keni-Role`. Default `"user"`. */
  readonly role?: Role;
  /** Test seam — defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

interface EnvelopeWithProjectId {
  readonly project_id: string;
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string";
}

function buildQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "",
  );
  if (entries.length === 0) return "";
  const search = new URLSearchParams(entries);
  return `?${search.toString()}`;
}

function joinUrl(baseUrl: string, path: string): string {
  if (baseUrl === "") return path;
  if (baseUrl.endsWith("/")) return `${baseUrl.slice(0, -1)}${path}`;
  return `${baseUrl}${path}`;
}

export function createApiClient(opts: CreateApiClientOpts = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? "";
  const role: Role = opts.role ?? "user";
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  let projectIdPromise: Promise<string> | null = null;

  async function request<T extends EnvelopeWithProjectId>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "X-Keni-Role": role,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetchImpl(joinUrl(baseUrl, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed: unknown = text === "" ? {} : JSON.parse(text);
    if (!response.ok) {
      if (isErrorResponse(parsed)) {
        throw new KeniApiError(
          response.status,
          parsed.error.code,
          parsed.error.message,
          parsed.error.details,
        );
      }
      throw new KeniApiError(
        response.status,
        "internal_error",
        `${method} ${path} failed with status ${response.status}`,
      );
    }
    return parsed as T;
  }

  return {
    getProjectId(): Promise<string> {
      // Cached: a single `GET /agents` round-trip returns the project id;
      // every subsequent call returns the cached promise without re-fetching.
      if (projectIdPromise === null) {
        projectIdPromise = request<AgentListResponse>("GET", "/api/agents").then(
          (envelope) => envelope.project_id,
        );
      }
      return projectIdPromise;
    },

    async listAgents(): Promise<AgentListResponse> {
      return await request<AgentListResponse>("GET", "/api/agents");
    },

    async pauseAgent(id: string): Promise<AgentEnvelope> {
      return await request<AgentEnvelope>("POST", `/api/agents/${encodeURIComponent(id)}/pause`);
    },

    async resumeAgent(id: string): Promise<AgentEnvelope> {
      return await request<AgentEnvelope>("POST", `/api/agents/${encodeURIComponent(id)}/resume`);
    },

    async interruptAgent(id: string): Promise<AgentEnvelope> {
      return await request<AgentEnvelope>(
        "POST",
        `/api/agents/${encodeURIComponent(id)}/interrupt`,
      );
    },

    async listTickets(filter?: ListTicketsFilter): Promise<TicketListResponse> {
      const query = buildQuery({ status: filter?.status?.join(",") });
      return await request<TicketListResponse>("GET", `/api/tickets${query}`);
    },

    async getTicket(id: string): Promise<TicketEnvelope> {
      return await request<TicketEnvelope>("GET", `/api/tickets/${encodeURIComponent(id)}`);
    },

    async createTicket(input: TicketCreateRequest): Promise<TicketEnvelope> {
      return await request<TicketEnvelope>("POST", "/api/tickets", input);
    },

    async patchTicket(
      id: string,
      patch: TicketHeaderPatchRequest,
    ): Promise<TicketEnvelope> {
      return await request<TicketEnvelope>(
        "PATCH",
        `/api/tickets/${encodeURIComponent(id)}`,
        patch,
      );
    },

    async transitionTicket(
      id: string,
      req: TicketTransitionRequest,
    ): Promise<TicketEnvelope> {
      return await request<TicketEnvelope>(
        "POST",
        `/api/tickets/${encodeURIComponent(id)}/transition`,
        req,
      );
    },

    async listPrs(filter?: ListPrsFilter): Promise<PRListResponse> {
      const query = buildQuery({
        status: filter?.status?.join(","),
        ticket: filter?.ticket,
      });
      return await request<PRListResponse>("GET", `/api/prs${query}`);
    },

    async getPr(id: string): Promise<PREnvelope> {
      return await request<PREnvelope>("GET", `/api/prs/${encodeURIComponent(id)}`);
    },

    async patchPrIntent(id: string, req: PRIntentPatchRequest): Promise<PREnvelope> {
      return await request<PREnvelope>(
        "PATCH",
        `/api/prs/${encodeURIComponent(id)}/intent`,
        req,
      );
    },

    async transitionPr(id: string, req: PRTransitionRequest): Promise<PREnvelope> {
      return await request<PREnvelope>(
        "POST",
        `/api/prs/${encodeURIComponent(id)}/transition`,
        req,
      );
    },

    async mergePr(id: string): Promise<MergePrEnvelope> {
      return await request<MergePrEnvelope>(
        "POST",
        `/api/prs/${encodeURIComponent(id)}/merge`,
      );
    },

    async listActivity(filter?: ListActivityFilter): Promise<ActivityQueryResponse> {
      const query = buildQuery({
        agent: filter?.agent,
        role: filter?.role,
        from: filter?.from,
        to: filter?.to,
      });
      return await request<ActivityQueryResponse>("GET", `/api/activity${query}`);
    },

    async appendActivity(input: ActivityAppendRequest): Promise<ActivityEnvelope> {
      return await request<ActivityEnvelope>("POST", "/api/activity", input);
    },
  };
}

// Type-only re-export so consumers can `import type { ActivityEntryResponse }
// from "../transport/apiClient.ts"` for narrow API surfaces. Kept here so the
// transport seam remains a single import for callers.
export type { ActivityEntryResponse };
