/**
 * Activity-log REST routes — append-only log queryable by agent / role / date.
 *
 * Two endpoints (`spec.md` §5.4):
 *  - `GET /` — materialises `ActivityLogStore.query(filter)` (an
 *    `AsyncIterable`) into a single page in increasing-id order. The
 *    prototype does not paginate; the envelope leaves room for a future
 *    `next_cursor` field per design.md Decision 11.
 *  - `POST /` — validates with `ActivityAppendRequestSchema` and delegates
 *    to `ActivityLogStore.append`. `InvalidArtifactError("size_exceeded")`
 *    surfaces as `422 invalid_artifact` via the central error mapper.
 *
 * No role guard is applied here: append/read access is identical for every
 * authenticated role. Each entry carries its own `role`/`agent` fields,
 * which are taken at face value from the request body in the prototype
 * (`spec.md` §3.6, deferred to a stricter check in step 25).
 *
 * @module
 */

import { Hono } from "@hono/hono";
import type {
  ActivityEntry,
  ActivityEntryInput,
  ActivityEntryResponse,
  ActivityEnvelope,
  ActivityLogStore,
  ActivityQueryResponse,
} from "@keni/shared";
import { ActivityAppendRequestSchema, parseActivityQuery } from "../wire/activity.ts";
import type { ServerVariables } from "../middleware/types.ts";

/** Build the `/activity` sub-app. */
export function activityRoutes(
  store: ActivityLogStore,
  projectId: string,
): Hono<{ Variables: ServerVariables }> {
  const app = new Hono<{ Variables: ServerVariables }>();

  app.get("/", async (c) => {
    const filter = parseActivityQuery(new URL(c.req.url).searchParams);
    const entries: ActivityEntryResponse[] = [];
    for await (const entry of store.query(filter)) {
      entries.push(toEntryResponse(entry));
    }
    const body: ActivityQueryResponse = { data: entries, project_id: projectId };
    return c.json(body);
  });

  app.post("/", async (c) => {
    const input = ActivityAppendRequestSchema.parse(await c.req.json());
    const entry = await store.append(input as ActivityEntryInput);
    const body: ActivityEnvelope = { data: toEntryResponse(entry), project_id: projectId };
    return c.json(body, 201);
  });

  return app;
}

function toEntryResponse(entry: ActivityEntry): ActivityEntryResponse {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    session_id: entry.session_id,
    agent: entry.agent,
    role: entry.role,
    event: entry.event,
    summary: entry.summary,
    refs: entry.refs,
  };
}
