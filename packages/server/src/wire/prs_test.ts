/**
 * Tests for `prs.ts` zod schemas.
 *
 * Same shape and conventions as `tickets_test.ts`.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import type {
  MergePrResponse,
  PRCreateRequest,
  PRIntentPatchRequest,
  PRTransitionRequest,
} from "@keni/shared";
import {
  MergePrResponseSchema,
  PR_STATUSES,
  PRCreateRequestSchema,
  PRIntentPatchRequestSchema,
  PRTransitionRequestSchema,
} from "./prs.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true
  : false;
type Expect<T extends true> = T;

type _CheckCreate = Expect<Equal<z.infer<typeof PRCreateRequestSchema>, PRCreateRequest>>;
type _CheckIntent = Expect<
  Equal<z.infer<typeof PRIntentPatchRequestSchema>, PRIntentPatchRequest>
>;
type _CheckTransition = Expect<
  Equal<z.infer<typeof PRTransitionRequestSchema>, PRTransitionRequest>
>;
type _CheckMerge = Expect<Equal<z.infer<typeof MergePrResponseSchema>, MergePrResponse>>;

Deno.test("PRCreateRequestSchema accepts the documented good example", () => {
  const parsed = PRCreateRequestSchema.parse({
    title: "Wire OAuth login",
    body: "Implements ticket-0007",
    ticket: "ticket-0007",
    branch: "engineer/oauth-login",
    author: "alice",
  });
  assertEquals(parsed.ticket, "ticket-0007");
  assertEquals(parsed.author, "alice");
});

Deno.test("PRCreateRequestSchema rejects a missing ticket", () => {
  assertThrows(
    () =>
      PRCreateRequestSchema.parse({
        title: "x",
        branch: "b",
        author: "a",
      }),
    z.ZodError,
  );
});

Deno.test("PRCreateRequestSchema rejects an empty branch", () => {
  assertThrows(
    () =>
      PRCreateRequestSchema.parse({
        title: "x",
        ticket: "ticket-0001",
        branch: "",
        author: "a",
      }),
    z.ZodError,
  );
});

Deno.test("PRIntentPatchRequestSchema accepts a non-empty intent string", () => {
  const parsed = PRIntentPatchRequestSchema.parse({ intent: "Refined description" });
  assertEquals(parsed.intent, "Refined description");
});

Deno.test("PRIntentPatchRequestSchema rejects a missing intent", () => {
  assertThrows(() => PRIntentPatchRequestSchema.parse({}), z.ZodError);
});

Deno.test("PRTransitionRequestSchema accepts a documented good transition", () => {
  const parsed = PRTransitionRequestSchema.parse({ from: "open", to: "in_review" });
  assertEquals(parsed.from, "open");
  assertEquals(parsed.to, "in_review");
});

Deno.test("PRTransitionRequestSchema rejects an unknown status literal", () => {
  assertThrows(
    () => PRTransitionRequestSchema.parse({ from: "draft", to: "in_review" }),
    z.ZodError,
  );
});

Deno.test("PR_STATUSES enumerates the §4.1 PR lifecycle in order", () => {
  assertEquals(PR_STATUSES, ["open", "in_review", "has_comments", "approved", "merged"]);
});

Deno.test("MergePrResponseSchema accepts a 40-char lower-case hex SHA", () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  const parsed = MergePrResponseSchema.parse({ merge_commit_sha: sha });
  assertEquals(parsed.merge_commit_sha, sha);
});

Deno.test("MergePrResponseSchema rejects an empty SHA", () => {
  assertThrows(() => MergePrResponseSchema.parse({ merge_commit_sha: "" }), z.ZodError);
});

Deno.test("MergePrResponseSchema rejects a non-hex SHA", () => {
  assertThrows(
    () => MergePrResponseSchema.parse({ merge_commit_sha: "g".repeat(40) }),
    z.ZodError,
  );
});

Deno.test("MergePrResponseSchema rejects a too-short SHA", () => {
  assertThrows(
    () => MergePrResponseSchema.parse({ merge_commit_sha: "abcdef0123" }),
    z.ZodError,
  );
});

Deno.test("MergePrResponseSchema rejects extra keys (.strict())", () => {
  assertThrows(
    () =>
      MergePrResponseSchema.parse({
        merge_commit_sha: "0".repeat(40),
        extra: "nope",
      }),
    z.ZodError,
  );
});
