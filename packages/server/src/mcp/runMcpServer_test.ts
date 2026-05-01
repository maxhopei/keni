/**
 * Tests for `runMcpServer` — the argv-level CLI entry point.
 *
 * The happy-path test (last block) uses the SDK's
 * `InMemoryTransport.createLinkedPair()` rather than a `Deno.Command`
 * subprocess: simpler to reason about, no PID/lifecycle leak risk, and
 * still exercises the full `connect → tool-call → close → exit` round
 * trip through the real Server / Protocol stack. The subprocess
 * variant is exercised by the end-to-end integration test (Group 9)
 * — duplicating that work here would buy nothing.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMcpServer } from "./runMcpServer.ts";

interface CapturedIO {
  readonly outLines: string[];
  readonly errLines: string[];
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function makeIo(): CapturedIO {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => {
      outLines.push(line);
    },
    err: (line) => {
      errLines.push(line);
    },
  };
}

function fakeStat(info: Partial<Deno.FileInfo>): (path: string) => Promise<Deno.FileInfo> {
  /*
   * Build a minimal Deno.FileInfo shape. The runMcpServer code path
   * only ever reads `isDirectory`, so most fields can be stubs.
   */
  const base = {
    isFile: false,
    isDirectory: false,
    isSymlink: false,
    size: 0,
    mtime: null,
    atime: null,
    birthtime: null,
    ctime: null,
    dev: 0,
    ino: null,
    mode: null,
    nlink: null,
    uid: null,
    gid: null,
    rdev: null,
    blksize: null,
    blocks: null,
    isBlockDevice: null,
    isCharDevice: null,
    isFifo: null,
    isSocket: null,
  } as unknown as Deno.FileInfo;
  // deno-lint-ignore no-explicit-any
  return () => Promise.resolve({ ...(base as any), ...info } as Deno.FileInfo);
}

function statThrows(error: Error): (path: string) => Promise<Deno.FileInfo> {
  return () => Promise.reject(error);
}

Deno.test("runMcpServer([]) returns 2 and stderr names every required flag", async () => {
  const io = makeIo();
  const code = await runMcpServer([], { out: io.out, err: io.err });
  assertEquals(code, 2);
  const stderr = io.errLines.join("\n");
  assertStringIncludes(stderr, "--agent");
  assertStringIncludes(stderr, "--server-url");
  assertStringIncludes(stderr, "--workspace");
});

Deno.test("runMcpServer rejects malformed --agent with exit 2 and a regex-named message", async () => {
  const io = makeIo();
  const code = await runMcpServer(
    [
      "--agent=Bad Agent!",
      "--server-url=http://127.0.0.1:1",
      "--workspace=/tmp",
    ],
    { out: io.out, err: io.err },
  );
  assertEquals(code, 2);
  const stderr = io.errLines.join("\n");
  assertStringIncludes(stderr, "--agent");
  assertStringIncludes(stderr, "[a-z0-9_-]+");
});

Deno.test("runMcpServer rejects an unparseable --server-url with exit 2", async () => {
  const io = makeIo();
  const code = await runMcpServer(
    [
      "--agent=alice",
      "--server-url=not-a-url",
      "--workspace=/tmp",
    ],
    { out: io.out, err: io.err },
  );
  assertEquals(code, 2);
  assertStringIncludes(io.errLines.join("\n"), "--server-url");
});

Deno.test("runMcpServer rejects a non-http(s) --server-url with exit 2", async () => {
  const io = makeIo();
  const code = await runMcpServer(
    [
      "--agent=alice",
      "--server-url=ftp://example.com/x",
      "--workspace=/tmp",
    ],
    { out: io.out, err: io.err },
  );
  assertEquals(code, 2);
  assertStringIncludes(io.errLines.join("\n"), "http:");
});

Deno.test("runMcpServer returns 1 when --workspace does not exist", async () => {
  const io = makeIo();
  const code = await runMcpServer(
    [
      "--agent=alice",
      "--server-url=http://127.0.0.1:1",
      "--workspace=/does/not/exist",
    ],
    {
      out: io.out,
      err: io.err,
      stat: statThrows(new Deno.errors.NotFound("file not found: /does/not/exist")),
    },
  );
  assertEquals(code, 1);
  const stderr = io.errLines.join("\n");
  assertStringIncludes(stderr, "/does/not/exist");
  assertStringIncludes(stderr, "does not exist");
});

Deno.test("runMcpServer returns 1 with a 'not a directory' message when --workspace is a regular file", async () => {
  const io = makeIo();
  const code = await runMcpServer(
    [
      "--agent=alice",
      "--server-url=http://127.0.0.1:1",
      "--workspace=/tmp/some-file.txt",
    ],
    {
      out: io.out,
      err: io.err,
      stat: fakeStat({ isFile: true, isDirectory: false }),
    },
  );
  assertEquals(code, 1);
  const stderr = io.errLines.join("\n");
  assertStringIncludes(stderr, "not a directory");
  assertStringIncludes(stderr, "/tmp/some-file.txt");
});

Deno.test("runMcpServer rejects an unknown flag (e.g. --role) with exit 2", async () => {
  const io = makeIo();
  const code = await runMcpServer(
    [
      "--agent=alice",
      "--server-url=http://127.0.0.1:1",
      "--workspace=/tmp",
      "--role=po",
    ],
    { out: io.out, err: io.err },
  );
  assertEquals(code, 2);
  assertStringIncludes(io.errLines.join("\n"), "--role");
});

Deno.test("runMcpServer happy path — connects via in-memory transport and exits 0 when the client closes", async () => {
  const io = makeIo();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  /*
   * Drive the server side from a real Client over the linked pair.
   * The runMcpServer promise stays pending until we close the client
   * side; closing the client transport bubbles a close event through
   * the linked pair into the server's Protocol layer, which resolves
   * the wait promise inside runMcpServer.
   */
  const runPromise = runMcpServer(
    [
      "--agent=alice",
      "--server-url=http://127.0.0.1:1",
      "--workspace=/tmp/ws",
    ],
    {
      out: io.out,
      err: io.err,
      stat: fakeStat({ isDirectory: true, isFile: false }),
      transport: serverTransport,
    },
  );

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const tools = await client.listTools();
  assertEquals(tools.tools.length, 7);
  const toolNames = tools.tools.map((t: { name: string }) => t.name).sort();
  assertEquals(toolNames, [
    "append_activity_entry",
    "get_workspace_path",
    "list_tickets",
    "query_activity",
    "read_ticket",
    "transition_ticket_status",
    "update_ticket_body",
  ]);

  await client.close();

  const code = await runPromise;
  assertEquals(code, 0);
  assertStringIncludes(
    io.outLines.join("\n"),
    "Engineer MCP server connected (agent=alice, server-url=http://127.0.0.1:1).",
  );
});
