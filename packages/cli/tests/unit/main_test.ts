import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { packageName, runDispatcher } from "../../src/main.ts";

Deno.test("@keni/cli exposes its package name", () => {
  assertEquals(packageName, "@keni/cli");
});

async function isGitOnPath(): Promise<boolean> {
  try {
    const proc = new Deno.Command("git", { args: ["--version"], stdout: "null", stderr: "null" });
    return (await proc.output()).code === 0;
  } catch {
    return false;
  }
}
const GIT_AVAILABLE = await isGitOnPath();

const itGit = (label: string, fn: () => Promise<void>) => {
  if (GIT_AVAILABLE) {
    Deno.test(label, fn);
  } else {
    Deno.test.ignore(`${label} (skipped: git not on PATH)`, fn);
  }
};

Deno.test("runDispatcher: --help returns exit code 0 and prints usage", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDispatcher(["--help"], {
    out: (m) => out.push(m),
    err: (m) => err.push(m),
  });
  assertEquals(code, 0);
  assert(out.some((m) => m.includes("keni init")));
  assert(out.some((m) => m.includes("keni start")), "help text must list `keni start`");
  assertEquals(err, []);
});

Deno.test(
  "runDispatcher: start --unknown-flag returns exit code 2 with the usage error",
  async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDispatcher(["start", "--unknown-flag"], {
      out: (m) => out.push(m),
      err: (m) => err.push(m),
    });
    assertEquals(code, 2);
    assert(err.some((m) => m.includes("Unknown flag")));
  },
);

Deno.test("runDispatcher: -h is an alias for --help", async () => {
  const out: string[] = [];
  const code = await runDispatcher(["-h"], { out: (m) => out.push(m), err: () => {} });
  assertEquals(code, 0);
  assert(out.some((m) => m.includes("keni init")));
});

Deno.test("runDispatcher: no subcommand prints help and returns 0", async () => {
  const out: string[] = [];
  const code = await runDispatcher([], { out: (m) => out.push(m), err: () => {} });
  assertEquals(code, 0);
  assert(out.some((m) => m.includes("keni init")));
});

Deno.test("runDispatcher: unknown subcommand returns exit code 2", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDispatcher(["frobnicate"], {
    out: (m) => out.push(m),
    err: (m) => err.push(m),
  });
  assertEquals(code, 2);
  assert(err.some((m) => m.includes("unknown subcommand: frobnicate")));
  assert(out.some((m) => m.includes("keni init")));
});

Deno.test("runDispatcher: init with too many args returns exit code 2 (UsageError path)", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDispatcher(["init", "a", "b"], {
    out: (m) => out.push(m),
    err: (m) => err.push(m),
  });
  assertEquals(code, 2);
  assert(err.some((m) => m.includes("at most one")));
});

Deno.test("runDispatcher: init with a flag returns exit code 2 (UsageError path)", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDispatcher(["init", "--name=foo"], {
    out: (m) => out.push(m),
    err: (m) => err.push(m),
  });
  assertEquals(code, 2);
  assert(err.some((m) => m.includes("--name=foo")));
});

itGit("runDispatcher: init <tempDir> succeeds end-to-end (smoke)", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-cli-main-init-" });
  const home = await Deno.makeTempDir({ prefix: "keni-cli-main-home-" });
  try {
    // Inject HOME via env so runInit picks up our temp home.
    const origHome = Deno.env.get("HOME");
    Deno.env.set("HOME", home);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runDispatcher(["init", root], {
        out: (m) => out.push(m),
        err: (m) => err.push(m),
      });
      assertEquals(code, 0, `init failed; stderr=${err.join("\n")}`);
      // Verify the layout
      const projectYaml = await Deno.stat(join(root, ".keni/project.yaml"));
      assert(projectYaml.isFile);
      const stateJson = await Deno.stat(join(root, ".keni/state.json"));
      assert(stateJson.isFile);
      const globalConfig = await Deno.stat(join(home, ".keni/config.yaml"));
      assert(globalConfig.isFile);
      assert(out.some((m) => m.includes("Initialised Keni project")));
    } finally {
      if (origHome === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", origHome);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

itGit("runDispatcher: init in a non-existent target returns exit code 1", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDispatcher(["init", "/this/path/should/not/exist/keni-test"], {
    out: (m) => out.push(m),
    err: (m) => err.push(m),
  });
  assertEquals(code, 1);
  assert(err.some((m) => m.includes("not_found") || m.includes("does not exist")));
});
