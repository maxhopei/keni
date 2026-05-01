import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  DuplicateIdError,
  InvalidArtifactError,
  StaleStateError,
  StoreNotFoundError,
} from "./errors.ts";

Deno.test("StoreNotFoundError — extends Error and carries id + path", () => {
  const err = new StoreNotFoundError("ticket-0001", "/tmp/.keni/tickets");
  assert(err instanceof Error);
  assert(err instanceof StoreNotFoundError);
  assertStrictEquals(err.name, "StoreNotFoundError");
  assertStrictEquals(err.id, "ticket-0001");
  assertStrictEquals(err.path, "/tmp/.keni/tickets");
  assert(err.message.includes("ticket-0001"));
  assert(err.message.includes("/tmp/.keni/tickets"));
});

Deno.test("StoreNotFoundError — message without path", () => {
  const err = new StoreNotFoundError("pr-0001");
  assertStrictEquals(err.path, undefined);
  assert(err.message.includes("pr-0001"));
});

Deno.test("StoreNotFoundError — JSON round-trip preserves context", () => {
  const err = new StoreNotFoundError("ticket-0001", "/p");
  const json = JSON.parse(JSON.stringify(err));
  assertEquals(json, {
    name: "StoreNotFoundError",
    message: err.message,
    id: "ticket-0001",
    path: "/p",
  });
});

Deno.test("StaleStateError — carries id, expected, actual", () => {
  const err = new StaleStateError("ticket-0001", "open", "in_progress");
  assert(err instanceof Error);
  assert(err instanceof StaleStateError);
  assertStrictEquals(err.name, "StaleStateError");
  assertStrictEquals(err.id, "ticket-0001");
  assertStrictEquals(err.expected, "open");
  assertStrictEquals(err.actual, "in_progress");
  assert(err.message.includes("open"));
  assert(err.message.includes("in_progress"));
});

Deno.test("StaleStateError — JSON round-trip preserves context", () => {
  const err = new StaleStateError("ticket-1", "a", "b");
  const json = JSON.parse(JSON.stringify(err));
  assertEquals(json, {
    name: "StaleStateError",
    message: err.message,
    id: "ticket-1",
    expected: "a",
    actual: "b",
  });
});

Deno.test("DuplicateIdError — carries id", () => {
  const err = new DuplicateIdError("ticket-0001");
  assert(err instanceof Error);
  assert(err instanceof DuplicateIdError);
  assertStrictEquals(err.name, "DuplicateIdError");
  assertStrictEquals(err.id, "ticket-0001");
});

Deno.test("DuplicateIdError — JSON round-trip preserves context", () => {
  const err = new DuplicateIdError("pr-0001");
  const json = JSON.parse(JSON.stringify(err));
  assertEquals(json, {
    name: "DuplicateIdError",
    message: err.message,
    id: "pr-0001",
  });
});

Deno.test("InvalidArtifactError — carries reason, message, optional path", () => {
  const err = new InvalidArtifactError(
    "malformed_yaml",
    "unclosed quote",
    "/p/ticket-0001.md",
  );
  assert(err instanceof Error);
  assert(err instanceof InvalidArtifactError);
  assertStrictEquals(err.name, "InvalidArtifactError");
  assertStrictEquals(err.reason, "malformed_yaml");
  assertStrictEquals(err.path, "/p/ticket-0001.md");
  assertEquals(err.message, "unclosed quote");
});

Deno.test("InvalidArtifactError — omits path when not supplied", () => {
  const err = new InvalidArtifactError("size_exceeded", "too big");
  assertStrictEquals(err.path, undefined);
});

Deno.test("InvalidArtifactError — JSON round-trip preserves context", () => {
  const err = new InvalidArtifactError("a", "b", "/p");
  const json = JSON.parse(JSON.stringify(err));
  assertEquals(json, {
    name: "InvalidArtifactError",
    message: "b",
    reason: "a",
    path: "/p",
  });
});

Deno.test("Error classes narrow with instanceof after a plain `throw` catch", () => {
  function doThrow(): never {
    throw new StoreNotFoundError("x");
  }
  try {
    doThrow();
  } catch (err) {
    if (err instanceof StoreNotFoundError) {
      assertStrictEquals(err.id, "x");
    } else {
      throw new Error("expected StoreNotFoundError");
    }
  }
});
