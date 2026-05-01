import { assert, assertEquals } from "@std/assert";
import { GitOperationError, InitTargetError, ProjectStateError, UsageError } from "./errors.ts";

Deno.test("UsageError — instanceof Error and stable name", () => {
  const err = new UsageError("bad args");
  assert(err instanceof Error);
  assert(err instanceof UsageError);
  assertEquals(err.name, "UsageError");
  assertEquals(err.message, "bad args");
});

Deno.test("InitTargetError — carries reason, targetDir, optional osError", () => {
  const err = new InitTargetError(
    "not_writable",
    "/tmp/foo",
    "/tmp/foo is not writable",
    "PermissionDenied",
  );
  assert(err instanceof Error);
  assert(err instanceof InitTargetError);
  assertEquals(err.name, "InitTargetError");
  assertEquals(err.reason, "not_writable");
  assertEquals(err.targetDir, "/tmp/foo");
  assertEquals(err.osError, "PermissionDenied");
});

Deno.test("InitTargetError — `osError` is omitted when not supplied", () => {
  const err = new InitTargetError("not_found", "/tmp/missing", "missing");
  assertEquals(err.osError, undefined);
});

Deno.test("GitOperationError — carries command, args, exitCode, stderr", () => {
  const err = new GitOperationError(
    "commit",
    ["-m", "msg"],
    128,
    "fatal: please tell me who you are",
    "git commit failed",
  );
  assert(err instanceof Error);
  assert(err instanceof GitOperationError);
  assertEquals(err.name, "GitOperationError");
  assertEquals(err.command, "commit");
  assertEquals(err.args, ["-m", "msg"]);
  assertEquals(err.exitCode, 128);
  assertEquals(err.stderr, "fatal: please tell me who you are");
});

Deno.test("GitOperationError — accepts null exitCode for ENOENT-style failures", () => {
  const err = new GitOperationError("init", [], null, "", "git not on PATH");
  assertEquals(err.exitCode, null);
});

Deno.test("ProjectStateError — carries reason and optional path", () => {
  const err = new ProjectStateError(
    "malformed_project_yaml",
    "yaml parse failed",
    "/tmp/proj/.keni/project.yaml",
  );
  assert(err instanceof Error);
  assert(err instanceof ProjectStateError);
  assertEquals(err.name, "ProjectStateError");
  assertEquals(err.reason, "malformed_project_yaml");
  assertEquals(err.path, "/tmp/proj/.keni/project.yaml");
});

Deno.test("error names survive JSON.stringify (log-friendly)", () => {
  const errs = [
    new UsageError("u"),
    new InitTargetError("not_found", "/tmp/x", "msg"),
    new GitOperationError("init", [], 1, "stderr", "msg"),
    new ProjectStateError("malformed_project_yaml", "msg", "/tmp/x"),
  ];
  for (const err of errs) {
    const json = JSON.stringify({ name: err.name, message: err.message });
    const parsed = JSON.parse(json);
    assertEquals(parsed.name, err.name);
    assertEquals(parsed.message, err.message);
  }
});

Deno.test("instanceof narrowing differentiates the four classes", () => {
  const errs: Error[] = [
    new UsageError("u"),
    new InitTargetError("not_found", "/tmp/x", "msg"),
    new GitOperationError("init", [], 1, "stderr", "msg"),
    new ProjectStateError("r", "msg"),
  ];
  const matches = errs.map((err) =>
    err instanceof UsageError
      ? "u"
      : err instanceof InitTargetError
      ? "t"
      : err instanceof GitOperationError
      ? "g"
      : err instanceof ProjectStateError
      ? "p"
      : "?"
  );
  assertEquals(matches, ["u", "t", "g", "p"]);
});
