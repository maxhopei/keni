/**
 * Tests for `roleIdentity` middleware.
 */

import { Hono } from "@hono/hono";
import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { MissingRoleError } from "../../../src/errors.ts";
import { roleIdentity } from "../../../src/middleware/roleIdentity.ts";
import type { ServerVariables } from "../../../src/middleware/types.ts";

function makeApp(captureErr?: (err: unknown) => void) {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(roleIdentity());
  app.get("/", (c) => c.json({ role: c.var.role, agent: c.var.agent }));
  if (captureErr !== undefined) {
    app.onError((err, c) => {
      captureErr(err);
      return c.json({ error: { code: "missing_role", message: err.message } }, 400);
    });
  }
  return app;
}

Deno.test("roleIdentity — missing X-Keni-Role throws MissingRoleError(undefined)", async () => {
  let thrown: unknown;
  const app = makeApp((err) => (thrown = err));
  await app.fetch(new Request("http://x/"));
  assertInstanceOf(thrown, MissingRoleError);
  assertEquals((thrown as MissingRoleError).received, undefined);
});

Deno.test("roleIdentity — unknown role throws MissingRoleError('super-user')", async () => {
  let thrown: unknown;
  const app = makeApp((err) => (thrown = err));
  await app.fetch(new Request("http://x/", { headers: { "X-Keni-Role": "super-user" } }));
  assertInstanceOf(thrown, MissingRoleError);
  assertEquals((thrown as MissingRoleError).received, "super-user");
});

Deno.test("roleIdentity — valid role + agent populates c.var", async () => {
  const app = makeApp();
  const res = await app.fetch(
    new Request("http://x/", {
      headers: { "X-Keni-Role": "engineer", "X-Keni-Agent": "alice" },
    }),
  );
  assertEquals(await res.json(), { role: "engineer", agent: "alice" });
});

Deno.test("roleIdentity — valid role with no agent sets c.var.agent to null", async () => {
  const app = makeApp();
  const res = await app.fetch(
    new Request("http://x/", { headers: { "X-Keni-Role": "user" } }),
  );
  assertEquals(await res.json(), { role: "user", agent: null });
});

Deno.test("roleIdentity — typed Role flows through to handlers (compile-time)", async () => {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(roleIdentity());
  let captured: string | undefined;
  app.get("/", (c) => {
    const r: "user" | "engineer" | "qa" | "po" | "writer" = c.var.role;
    captured = r;
    return c.text("ok");
  });
  await app.fetch(new Request("http://x/", { headers: { "X-Keni-Role": "qa" } }));
  assert(captured === "qa");
});
