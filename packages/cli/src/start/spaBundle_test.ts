/**
 * Tests for `spaBundle.ts` — the SPA-bundle resolver.
 *
 * Covers the four scenarios in the `cli-start` capability spec's
 * "SPA bundle" requirement.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { resolveSpaBundle, SpaBundleMissingError } from "./spaBundle.ts";

interface Fixture {
  readonly repoRoot: string;
  readonly projectDir: string;
  readonly distRoot: string;
  readonly cleanup: () => Promise<void>;
}

async function makeFixture(opts: { withDist: boolean }): Promise<Fixture> {
  const repoRoot = await Deno.makeTempDir({ prefix: "keni-spa-repo-" });
  const projectDir = await Deno.makeTempDir({ prefix: "keni-spa-proj-" });
  const distRoot = join(repoRoot, "packages", "spa", "dist");
  if (opts.withDist) {
    await Deno.mkdir(distRoot, { recursive: true });
    await Deno.writeTextFile(
      join(distRoot, "index.html"),
      '<!doctype html><div id="root"></div>',
    );
  }
  return {
    repoRoot,
    projectDir,
    distRoot,
    async cleanup() {
      await Deno.remove(repoRoot, { recursive: true });
      await Deno.remove(projectDir, { recursive: true });
    },
  };
}

Deno.test("resolveSpaBundle: bundled mode resolves workspace-relative dist/", async () => {
  const fx = await makeFixture({ withDist: true });
  try {
    const out = resolveSpaBundle({
      spa: { mode: "bundled" },
      projectDir: fx.projectDir,
      repoRoot: fx.repoRoot,
    });
    assertEquals(out, { mode: "bundled", root: fx.distRoot });
  } finally {
    await fx.cleanup();
  }
});

Deno.test(
  "resolveSpaBundle: missing dist/ throws SpaBundleMissingError naming the path and `deno task build`",
  async () => {
    const fx = await makeFixture({ withDist: false });
    try {
      let thrown: unknown;
      try {
        resolveSpaBundle({
          spa: { mode: "bundled" },
          projectDir: fx.projectDir,
          repoRoot: fx.repoRoot,
        });
      } catch (e) {
        thrown = e;
      }
      if (!(thrown instanceof SpaBundleMissingError)) {
        throw new Error(`expected SpaBundleMissingError, got ${thrown}`);
      }
      assertEquals(thrown.expectedRoot, fx.distRoot);
      // The user-visible message names `deno task build`.
      if (!thrown.message.includes("deno task build")) {
        throw new Error(
          `expected message to mention 'deno task build', got: ${thrown.message}`,
        );
      }
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test("resolveSpaBundle: --spa-dev-url returns the dev-mode descriptor", () => {
  const out = resolveSpaBundle({
    spa: { mode: "dev", dev_url: "http://localhost:5173" },
    projectDir: "/unused",
    repoRoot: "/unused",
  });
  assertEquals(out, { mode: "dev", devUrl: "http://localhost:5173" });
});

Deno.test("resolveSpaBundle: explicit --spa-bundle path overrides the workspace resolution", async () => {
  const repoRoot = await Deno.makeTempDir({ prefix: "keni-spa-repo-2-" });
  const explicitDist = await Deno.makeTempDir({ prefix: "keni-spa-explicit-" });
  await Deno.writeTextFile(
    join(explicitDist, "index.html"),
    '<!doctype html><div id="root"></div>',
  );
  try {
    const out = resolveSpaBundle({
      spa: { mode: "bundled", bundle: explicitDist },
      projectDir: "/unused",
      repoRoot,
    });
    assertEquals(out, { mode: "bundled", root: explicitDist });
  } finally {
    await Deno.remove(repoRoot, { recursive: true });
    await Deno.remove(explicitDist, { recursive: true });
  }
});

Deno.test("resolveSpaBundle: explicit relative --spa-bundle resolves under projectDir", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "keni-spa-proj-rel-" });
  const distRoot = join(projectDir, "my-dist");
  await Deno.mkdir(distRoot, { recursive: true });
  await Deno.writeTextFile(
    join(distRoot, "index.html"),
    '<!doctype html><div id="root"></div>',
  );
  try {
    const out = resolveSpaBundle({
      spa: { mode: "bundled", bundle: "my-dist" },
      projectDir,
      repoRoot: "/unused",
    });
    assertEquals(out, { mode: "bundled", root: distRoot });
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test(
  "resolveSpaBundle: bundled with explicit path missing index.html → SpaBundleMissingError",
  async () => {
    const empty = await Deno.makeTempDir({ prefix: "keni-spa-empty-" });
    try {
      assertThrows(
        () =>
          resolveSpaBundle({
            spa: { mode: "bundled", bundle: empty },
            projectDir: "/unused",
            repoRoot: "/unused",
          }),
        SpaBundleMissingError,
      );
    } finally {
      await Deno.remove(empty, { recursive: true });
    }
  },
);
