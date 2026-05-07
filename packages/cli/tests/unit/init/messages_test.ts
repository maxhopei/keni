import { assert, assertEquals } from "@std/assert";
import {
  formatAlreadyInitialised,
  formatFreshInit,
  formatGitFailure,
  formatHelp,
  formatMalformedProjectYaml,
  formatPartialRepair,
  formatUnwritableTarget,
  formatUsageError,
} from "../../../src/init/messages.ts";

Deno.test("formatFreshInit — names path, project_id, agent, and next-step hint", () => {
  const out = formatFreshInit({
    targetDir: "/tmp/proj",
    projectId: "a3f5b1c7-8e29-4d1a-9c4b-f5e7d8a9b0c1",
    defaultAgent: { id: "alice", role: "engineer" },
  });
  assert(out.includes("Initialised Keni project at /tmp/proj"));
  assert(out.includes("project_id: a3f5b1c7-8e29-4d1a-9c4b-f5e7d8a9b0c1"));
  assert(out.includes("default agent: alice (engineer)"));
  assert(out.includes("keni start"));
});

Deno.test("formatAlreadyInitialised — names path and project_id, mentions 'already initialised'", () => {
  const out = formatAlreadyInitialised({
    targetDir: "/tmp/proj",
    projectId: "a3f5b1c7-8e29-4d1a-9c4b-f5e7d8a9b0c1",
  });
  assert(out.includes("already initialised"));
  assert(out.includes("/tmp/proj"));
  assert(out.includes("project_id: a3f5b1c7-8e29-4d1a-9c4b-f5e7d8a9b0c1"));
  assert(out.includes("Nothing to do."));
});

Deno.test("formatPartialRepair — names project_id, recreated paths, commit status", () => {
  const committed = formatPartialRepair({
    targetDir: "/tmp/proj",
    projectId: "id-x",
    recreated: [".keni/tickets/", ".keni/activity/"],
    committed: true,
  });
  assert(committed.includes("Repaired Keni project"));
  assert(committed.includes("project_id: id-x"));
  assert(committed.includes(".keni/tickets/"));
  assert(committed.includes(".keni/activity/"));
  assert(committed.includes("Committed."));

  const noCommit = formatPartialRepair({
    targetDir: "/tmp/proj",
    projectId: "id-x",
    recreated: [".keni/prs/"],
    committed: false,
  });
  assert(!noCommit.includes("Committed."));
});

Deno.test("formatMalformedProjectYaml — names path and underlying parse error", () => {
  const out = formatMalformedProjectYaml({
    path: "/tmp/proj/.keni/project.yaml",
    underlyingMessage: "unclosed string at line 3",
  });
  assert(out.startsWith("Error:"));
  assert(out.includes("/tmp/proj/.keni/project.yaml"));
  assert(out.includes("unclosed string at line 3"));
  assert(out.includes("keni init"));
});

Deno.test("formatUnwritableTarget — names targetDir, reason, optional osError", () => {
  const withCause = formatUnwritableTarget({
    targetDir: "/tmp/locked",
    reason: "not_writable",
    osError: "PermissionDenied",
  });
  assert(withCause.includes("/tmp/locked"));
  assert(withCause.includes("not_writable"));
  assert(withCause.includes("PermissionDenied"));

  const noCause = formatUnwritableTarget({
    targetDir: "/tmp/missing",
    reason: "not_found",
  });
  assert(noCause.includes("/tmp/missing"));
  assert(noCause.includes("not_found"));
  assert(!noCause.includes("undefined"));
});

Deno.test("formatGitFailure — names command, exit code, stderr; handles empty stderr", () => {
  const out = formatGitFailure({
    command: "commit",
    stderr: "fatal: please tell me who you are",
    exitCode: 128,
  });
  assert(out.includes("git commit failed"));
  assert(out.includes("(exit 128)"));
  assert(out.includes("please tell me who you are"));

  const noStderr = formatGitFailure({ command: "init", stderr: "", exitCode: 1 });
  assert(noStderr.includes("(empty)"));

  const noExit = formatGitFailure({ command: "init", stderr: "", exitCode: null });
  assert(noExit.includes("(no exit code)"));
});

Deno.test("formatUsageError — wraps the message with the standard 'Error:' prefix", () => {
  assertEquals(
    formatUsageError("unknown subcommand: foo"),
    "Error: unknown subcommand: foo",
  );
});

Deno.test("formatHelp — lists the available subcommands and the prototype init usage", () => {
  const out = formatHelp();
  assert(out.includes("keni init"));
  assert(out.includes("keni start"));
  assert(out.includes("[path]"));
  assert(out.includes("--help"));
});
