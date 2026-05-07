import { assertEquals, assertGreater } from "@std/assert";
import { buildChildEnv, readLines, terminate } from "../../src/subprocess.ts";

const isPosix = Deno.build.os !== "windows";

function spawn(code: string): Deno.ChildProcess {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["eval", code],
    stdout: "piped",
    stderr: "piped",
  });
  return cmd.spawn();
}

Deno.test({
  name: "terminate — graceful SIGTERM (clean exit before grace expires)",
  ignore: !isPosix,
  fn: async () => {
    const child = spawn(
      `Deno.addSignalListener("SIGTERM", () => Deno.exit(0)); await new Promise((r) => setTimeout(r, 60000));`,
    );
    await new Promise((r) => setTimeout(r, 200));
    const t0 = performance.now();
    const result = await terminate(child, { graceMs: 5000 });
    const elapsed = performance.now() - t0;
    assertEquals(result.terminatedBy, "sigterm");
    assertEquals(result.exitCode, 0);
    if (elapsed > 4000) {
      throw new Error(`terminate took ${elapsed}ms — should be well under graceMs`);
    }
    await drain(child);
  },
});

Deno.test({
  name: "terminate — SIGKILL after grace expires on a slow child",
  ignore: !isPosix,
  fn: async () => {
    const child = spawn(
      `Deno.addSignalListener("SIGTERM", () => {}); await new Promise((r) => setTimeout(r, 60000));`,
    );
    await new Promise((r) => setTimeout(r, 200));
    const t0 = performance.now();
    const result = await terminate(child, { graceMs: 200 });
    const elapsed = performance.now() - t0;
    assertEquals(result.terminatedBy, "sigkill");
    if (elapsed > 1500) {
      throw new Error(`terminate took ${elapsed}ms — should be well under 1500ms`);
    }
    await drain(child);
  },
});

Deno.test("terminate — already-exited child returns terminatedBy: exit", async () => {
  const child = spawn(`Deno.exit(7)`);
  const status = await child.status;
  assertEquals(status.code, 7);
  const result = await terminate(child, { graceMs: 5000 });
  assertEquals(result.terminatedBy, "exit");
  assertEquals(result.exitCode, 7);
  await drain(child);
});

Deno.test("buildChildEnv — empty allowlist gives only the runtime-mandated entries", () => {
  const env = buildChildEnv([], { KENI_MCP_AGENT: "alice", KENI_MCP_SERVER_URL: "http://x" });
  assertEquals(env, { KENI_MCP_AGENT: "alice", KENI_MCP_SERVER_URL: "http://x" });
});

Deno.test("buildChildEnv — allowlist forwards set host vars and skips unset ones", () => {
  Deno.env.set("FOO_ALLOWED_FOR_TEST", "x");
  try {
    const env = buildChildEnv(
      ["FOO_ALLOWED_FOR_TEST", "BAR_NEVER_SET_VAR_XYZ"],
      { KENI_MCP_AGENT: "alice" },
    );
    assertEquals(env, { FOO_ALLOWED_FOR_TEST: "x", KENI_MCP_AGENT: "alice" });
  } finally {
    Deno.env.delete("FOO_ALLOWED_FOR_TEST");
  }
});

Deno.test("buildChildEnv — runtime-mandated entries override allowlist on collision", () => {
  Deno.env.set("KENI_MCP_AGENT", "host-value");
  try {
    const env = buildChildEnv(["KENI_MCP_AGENT"], { KENI_MCP_AGENT: "runtime-value" });
    assertEquals(env, { KENI_MCP_AGENT: "runtime-value" });
  } finally {
    Deno.env.delete("KENI_MCP_AGENT");
  }
});

Deno.test("readLines — chunked stream emits lines in arrival order", async () => {
  const lines: string[] = [];
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode("a\nb"));
      controller.enqueue(enc.encode("c\n"));
      controller.close();
    },
  });
  await readLines(stream, (line) => {
    lines.push(line);
  }, () => {
    closed = true;
  });
  assertEquals(lines, ["a", "bc"]);
  assertEquals(closed, true);
});

Deno.test("readLines — skips empty lines", async () => {
  const lines: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode("\n\nhello\n\n"));
      controller.close();
    },
  });
  await readLines(stream, (line) => {
    lines.push(line);
  });
  assertEquals(lines, ["hello"]);
});

Deno.test("readLines — emits a final partial line when stream closes without newline", async () => {
  const lines: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode("only line"));
      controller.close();
    },
  });
  await readLines(stream, (line) => {
    lines.push(line);
  });
  assertEquals(lines, ["only line"]);
});

Deno.test("readLines — handles single-byte arrival of multibyte characters", async () => {
  const lines: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const bytes = enc.encode("café\n");
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  await readLines(stream, (line) => {
    lines.push(line);
  });
  assertEquals(lines, ["café"]);
});

async function drain(child: Deno.ChildProcess): Promise<void> {
  try {
    await child.stdout.cancel();
  } catch { /* ignore */ }
  try {
    await child.stderr.cancel();
  } catch { /* ignore */ }
  try {
    await child.status;
  } catch { /* ignore */ }
  // Touch the value to satisfy linters that complain about unused imports
  // when this helper isn't exercised.
  assertGreater(Date.now(), 0);
}
