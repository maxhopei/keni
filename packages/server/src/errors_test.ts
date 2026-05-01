/**
 * Tests for `errors.ts`: each typed error and the central
 * `mapErrorToResponse` table from design.md Decision 8.
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  DuplicateIdError,
  InvalidArtifactError,
  StaleStateError,
  StoreNotFoundError,
} from "@keni/shared";
import { z } from "zod";
import {
  mapErrorToResponse,
  MissingRoleError,
  RoleNotOwnerError,
  StatusGraphViolationError,
} from "./errors.ts";

const PROJECT_ID = "project-test";

Deno.test("StoreNotFoundError → 404 store_not_found", () => {
  const { status, body } = mapErrorToResponse(
    new StoreNotFoundError("ticket-0001"),
    PROJECT_ID,
  );
  assertEquals(status, 404);
  assertEquals(body.error.code, "store_not_found");
  assertEquals(body.project_id, PROJECT_ID);
  assertEquals(body.error.details, { id: "ticket-0001" });
});

Deno.test("StaleStateError → 409 stale_state with details", () => {
  const { status, body } = mapErrorToResponse(
    new StaleStateError("ticket-0001", "open", "in_progress"),
    PROJECT_ID,
  );
  assertEquals(status, 409);
  assertEquals(body.error.code, "stale_state");
  assertEquals(body.error.details, {
    id: "ticket-0001",
    expected: "open",
    actual: "in_progress",
  });
});

Deno.test("DuplicateIdError → 409 duplicate_id", () => {
  const { status, body } = mapErrorToResponse(
    new DuplicateIdError("ticket-0001"),
    PROJECT_ID,
  );
  assertEquals(status, 409);
  assertEquals(body.error.code, "duplicate_id");
});

Deno.test("InvalidArtifactError generic → 422 invalid_artifact", () => {
  const { status, body } = mapErrorToResponse(
    new InvalidArtifactError("size_exceeded", "Entry exceeds 4096 bytes"),
    PROJECT_ID,
  );
  assertEquals(status, 422);
  assertEquals(body.error.code, "invalid_artifact");
  assertEquals(body.error.details, { reason: "size_exceeded" });
});

Deno.test("InvalidArtifactError(status_in_patch) → 400 status_in_patch", () => {
  const { status, body } = mapErrorToResponse(
    new InvalidArtifactError("status_in_patch", "Patch must not include 'status'"),
    PROJECT_ID,
  );
  assertEquals(status, 400);
  assertEquals(body.error.code, "status_in_patch");
  assertEquals(body.error.details, { reason: "status_in_patch" });
});

Deno.test("StatusGraphViolationError → 403 status_graph_violation with from/to", () => {
  const { status, body } = mapErrorToResponse(
    new StatusGraphViolationError("open", "merged"),
    PROJECT_ID,
  );
  assertEquals(status, 403);
  assertEquals(body.error.code, "status_graph_violation");
  assertEquals(body.error.details, { from: "open", to: "merged" });
});

Deno.test("RoleNotOwnerError → 403 role_not_owner with role/target", () => {
  const { status, body } = mapErrorToResponse(
    new RoleNotOwnerError("engineer", "tested"),
    PROJECT_ID,
  );
  assertEquals(status, 403);
  assertEquals(body.error.code, "role_not_owner");
  assertEquals(body.error.details, { role: "engineer", target: "tested" });
});

Deno.test("MissingRoleError(undefined) → 400 missing_role with received: null", () => {
  const { status, body } = mapErrorToResponse(
    new MissingRoleError(undefined),
    PROJECT_ID,
  );
  assertEquals(status, 400);
  assertEquals(body.error.code, "missing_role");
  assertEquals(body.error.details, { received: null });
});

Deno.test("MissingRoleError(unknown) → 400 missing_role with the bogus value", () => {
  const { status, body } = mapErrorToResponse(
    new MissingRoleError("admin"),
    PROJECT_ID,
  );
  assertEquals(status, 400);
  assertEquals(body.error.code, "missing_role");
  assertEquals(body.error.details, { received: "admin" });
});

Deno.test("ZodError → 400 validation_failed with the issues array", () => {
  const schema = z.object({ a: z.string() });
  let zodErr: z.ZodError | undefined;
  try {
    schema.parse({ a: 1 });
  } catch (err) {
    zodErr = err as z.ZodError;
  }
  assertExists(zodErr);
  const { status, body } = mapErrorToResponse(zodErr, PROJECT_ID);
  assertEquals(status, 400);
  assertEquals(body.error.code, "validation_failed");
  const details = body.error.details as { issues: unknown[] };
  assertExists(details.issues);
  assertEquals(Array.isArray(details.issues), true);
  assertEquals(details.issues.length, 1);
});

Deno.test("Unknown error → 500 internal_error with redacted message", () => {
  const { status, body } = mapErrorToResponse(
    new Error("Database is on fire — secret://path/to/secret"),
    PROJECT_ID,
  );
  assertEquals(status, 500);
  assertEquals(body.error.code, "internal_error");
  assertEquals(body.error.message, "An unexpected error occurred");
  assertEquals(body.project_id, PROJECT_ID);
});

Deno.test("Non-Error thrown value → 500 internal_error", () => {
  const { status, body } = mapErrorToResponse("a bare string", PROJECT_ID);
  assertEquals(status, 500);
  assertEquals(body.error.code, "internal_error");
});

Deno.test("Every mapped response carries project_id", () => {
  const cases = [
    new StoreNotFoundError("x"),
    new StaleStateError("x", "a", "b"),
    new DuplicateIdError("x"),
    new InvalidArtifactError("x", "y"),
    new InvalidArtifactError("status_in_patch", "y"),
    new StatusGraphViolationError("a", "b"),
    new RoleNotOwnerError("engineer", "tested"),
    new MissingRoleError(undefined),
    new Error("boom"),
  ];
  for (const err of cases) {
    const { body } = mapErrorToResponse(err, PROJECT_ID);
    assertEquals(body.project_id, PROJECT_ID, `missing project_id on ${(err as Error).name}`);
  }
});
