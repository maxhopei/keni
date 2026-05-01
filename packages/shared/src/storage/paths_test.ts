import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveGlobalPaths, resolveProjectPaths } from "./paths.ts";

Deno.test("resolveProjectPaths — produces the exact `<root>/.keni/...` layout", () => {
  const paths = resolveProjectPaths("/tmp/my-project");
  assertEquals(paths.root, "/tmp/my-project");
  assertEquals(paths.keni, "/tmp/my-project/.keni");
  assertEquals(paths.tickets, "/tmp/my-project/.keni/tickets");
  assertEquals(paths.prs, "/tmp/my-project/.keni/prs");
  assertEquals(paths.activity, "/tmp/my-project/.keni/activity");
  assertEquals(paths.projectConfig, "/tmp/my-project/.keni/project.yaml");
});

Deno.test("resolveProjectPaths — normalises `.` and `..` segments", () => {
  const paths = resolveProjectPaths("/tmp/a/./b/../my-project");
  assertEquals(paths.root, "/tmp/a/my-project");
  assertEquals(paths.tickets, "/tmp/a/my-project/.keni/tickets");
});

Deno.test("resolveProjectPaths — is idempotent under double resolution", () => {
  const first = resolveProjectPaths("/tmp/proj");
  const second = resolveProjectPaths(first.root);
  assertEquals(second, first);
});

Deno.test("resolveGlobalPaths — produces the exact `<home>/.keni/...` layout", () => {
  const paths = resolveGlobalPaths("/home/alice");
  assertEquals(paths.home, "/home/alice");
  assertEquals(paths.keni, "/home/alice/.keni");
  assertEquals(paths.globalConfig, "/home/alice/.keni/config.yaml");
  assertEquals(paths.workspaces, "/home/alice/.keni/workspaces");
  assertEquals(paths.logs, "/home/alice/.keni/logs");
});

Deno.test("resolveGlobalPaths — normalises the home path", () => {
  const paths = resolveGlobalPaths("/home/./alice/../alice");
  assertEquals(paths.home, "/home/alice");
});

Deno.test("resolveProjectPaths — works with relative roots (caller is responsible for absolutising)", () => {
  const paths = resolveProjectPaths("my-project");
  assertEquals(paths.root, "my-project");
  assertEquals(paths.tickets, join("my-project", ".keni", "tickets"));
});

Deno.test("resolveProjectPaths / resolveGlobalPaths — no environment variables are read", async () => {
  const origHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", "/should/not/be/read");
    const proj = resolveProjectPaths("/explicit/proj");
    const global = resolveGlobalPaths("/explicit/home");
    assertEquals(proj.root, "/explicit/proj");
    assertEquals(global.home, "/explicit/home");
  } finally {
    if (origHome !== undefined) {
      Deno.env.set("HOME", origHome);
    } else {
      Deno.env.delete("HOME");
    }
  }
  await Promise.resolve();
});
