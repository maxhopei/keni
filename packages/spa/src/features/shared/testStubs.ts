/**
 * Shared test helpers for SPA feature tests.
 *
 * Exposes `unusedApiStubs()` — a factory that returns default no-op
 * implementations of the nine `ApiClient` methods a particular test may
 * not care about. Individual tests assemble a full `ApiClient` by
 * spreading these stubs and overriding the handful of methods they
 * exercise, which keeps test files focused on the under-test behaviour
 * and keeps them from going stale whenever the `ApiClient` interface
 * grows (e.g., a new endpoint in a follow-on change).
 *
 * Consumers deliberately pay the cost of calling this factory inside
 * each test: the returned object is mutable by design (spread into a
 * larger literal), and the `project_id` is set to `"proj-test"` so tests
 * can assert envelope shape without per-test plumbing.
 */

import type {
  ActivityEntryResponse,
  ActivityEnvelope,
  MergePrEnvelope,
  PREnvelope,
  PRResponse,
  TicketEnvelope,
  TicketResponse,
} from "@keni/shared";
import type { ApiClient as SpaApiClient } from "../../transport/apiClient.ts";

const PROJECT_ID = "proj-test";

const PLACEHOLDER_TICKET: TicketResponse = {
  id: "ticket-stub",
  title: "stub",
  status: "open",
  assignee: null,
  priority: 100,
  change_request: null,
  created_at: "2026-05-04T00:00:00.000Z",
  updated_at: "2026-05-04T00:00:00.000Z",
  body: "",
};

const PLACEHOLDER_PR: PRResponse = {
  id: "pr-stub",
  title: "stub",
  status: "open",
  ticket: "ticket-stub",
  branch: "ticket-stub",
  author: "alice",
  created_at: "2026-05-04T00:00:00.000Z",
  updated_at: "2026-05-04T00:00:00.000Z",
  body: "",
};

const PLACEHOLDER_ACTIVITY: ActivityEntryResponse = {
  id: "01HW000000000000000000STUB",
  timestamp: "2026-05-04T00:00:00.000Z",
  session_id: "stub",
  agent: "stub",
  role: "user",
  event: "session_start",
  summary: null,
  refs: {},
};

/**
 * Returns default stubs for every `ApiClient` method. Tests that already
 * declare their own `ApiClient` literal spread this at the top and
 * override the fields they exercise.
 */
export function unusedApiStubs(): SpaApiClient {
  return {
    getProjectId: () => Promise.resolve(PROJECT_ID),
    listAgents: () => Promise.resolve({ data: [], project_id: PROJECT_ID }),
    pauseAgent: (id) =>
      Promise.resolve({
        data: {
          id,
          role: "engineer",
          status: "idle",
          last_activity: null,
          last_active_at: null,
          paused: true,
        },
        project_id: PROJECT_ID,
      }),
    resumeAgent: (id) =>
      Promise.resolve({
        data: {
          id,
          role: "engineer",
          status: "idle",
          last_activity: null,
          last_active_at: null,
          paused: false,
        },
        project_id: PROJECT_ID,
      }),
    listTickets: () => Promise.resolve({ data: [], project_id: PROJECT_ID }),
    getTicket: (id): Promise<TicketEnvelope> =>
      Promise.resolve({ data: { ...PLACEHOLDER_TICKET, id }, project_id: PROJECT_ID }),
    createTicket: (input): Promise<TicketEnvelope> =>
      Promise.resolve({
        data: {
          ...PLACEHOLDER_TICKET,
          id: "ticket-new",
          title: input.title,
          priority: input.priority,
          assignee: input.assignee ?? null,
          change_request: input.change_request ?? null,
          body: input.body ?? "",
        },
        project_id: PROJECT_ID,
      }),
    patchTicket: (id): Promise<TicketEnvelope> =>
      Promise.resolve({ data: { ...PLACEHOLDER_TICKET, id }, project_id: PROJECT_ID }),
    transitionTicket: (id, req): Promise<TicketEnvelope> =>
      Promise.resolve({
        data: { ...PLACEHOLDER_TICKET, id, status: req.to },
        project_id: PROJECT_ID,
      }),
    listPrs: () => Promise.resolve({ data: [], project_id: PROJECT_ID }),
    getPr: (id): Promise<PREnvelope> =>
      Promise.resolve({ data: { ...PLACEHOLDER_PR, id }, project_id: PROJECT_ID }),
    patchPrIntent: (id): Promise<PREnvelope> =>
      Promise.resolve({ data: { ...PLACEHOLDER_PR, id }, project_id: PROJECT_ID }),
    transitionPr: (id, req): Promise<PREnvelope> =>
      Promise.resolve({
        data: { ...PLACEHOLDER_PR, id, status: req.to },
        project_id: PROJECT_ID,
      }),
    mergePr: (): Promise<MergePrEnvelope> =>
      Promise.resolve({
        data: { merge_commit_sha: "deadbeef" },
        project_id: PROJECT_ID,
      }),
    listActivity: () => Promise.resolve({ data: [], project_id: PROJECT_ID }),
    appendActivity: (input): Promise<ActivityEnvelope> =>
      Promise.resolve({
        data: {
          ...PLACEHOLDER_ACTIVITY,
          agent: input.agent,
          role: input.role,
          event: input.event,
          summary: input.summary ?? null,
          refs: input.refs ?? {},
        },
        project_id: PROJECT_ID,
      }),
  };
}
