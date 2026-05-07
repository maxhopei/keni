import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveProjectPaths } from "../../../../src/storage/paths.ts";
import { runActivityLogStoreContract } from "../../../contracts/storage/activity/activityLogStoreContract.ts";
import { FileActivityLogStore } from "../../../../src/storage/activity/file.ts";

const ACTIVE_TEMP_DIRS = new Set<string>();

async function freshFileStore(): Promise<FileActivityLogStore> {
  const root = await Deno.makeTempDir({ prefix: "keni-activity-test-" });
  ACTIVE_TEMP_DIRS.add(root);
  return new FileActivityLogStore(resolveProjectPaths(root));
}

runActivityLogStoreContract("FileActivityLogStore", freshFileStore);

Deno.test("FileActivityLogStore :: cleanup — remove every test temp dir", async () => {
  for (const dir of ACTIVE_TEMP_DIRS) {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
  ACTIVE_TEMP_DIRS.clear();
});

Deno.test("FileActivityLogStore — entries written across day boundaries land in distinct files", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-activity-days-" });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FileActivityLogStore(paths);
    await store.append({
      timestamp: "2026-04-30T23:59:59.000Z",
      session_id: "s",
      agent: "alice",
      role: "engineer",
      event: "x",
    });
    await store.append({
      timestamp: "2026-05-01T00:00:00.001Z",
      session_id: "s",
      agent: "alice",
      role: "engineer",
      event: "y",
    });
    const apr30 = await Deno.readTextFile(
      join(paths.activity, "2026-04-30.jsonl"),
    );
    const may01 = await Deno.readTextFile(
      join(paths.activity, "2026-05-01.jsonl"),
    );
    assertEquals(apr30.split("\n").filter(Boolean).length, 1);
    assertEquals(may01.split("\n").filter(Boolean).length, 1);
    assert(apr30.endsWith("\n"), "JSONL line must end with newline");
    assert(may01.endsWith("\n"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileActivityLogStore — oversized entry rejection leaves no partial line on disk", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-activity-oversize-" });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FileActivityLogStore(paths);
    let threw = false;
    try {
      await store.append({
        session_id: "s",
        agent: "alice",
        role: "engineer",
        event: "x",
        summary: "x".repeat(5000),
      });
    } catch {
      threw = true;
    }
    assert(threw, "expected append to reject oversized entry");

    let dirExists = false;
    try {
      await Deno.stat(paths.activity);
      dirExists = true;
    } catch {
      // expected: never created
    }
    if (dirExists) {
      const entries: string[] = [];
      for await (const e of Deno.readDir(paths.activity)) {
        entries.push(e.name);
      }
      assertEquals(entries, [], "no files should have been created");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileActivityLogStore — query streams across multiple day-files in id order", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-activity-stream-" });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FileActivityLogStore(paths);
    const days = [
      "2026-04-28T12:00:00.000Z",
      "2026-04-29T12:00:00.000Z",
      "2026-04-30T12:00:00.000Z",
      "2026-05-01T12:00:00.000Z",
    ];
    for (const ts of days) {
      await store.append({
        timestamp: ts,
        session_id: "s",
        agent: "alice",
        role: "engineer",
        event: "tick",
      });
    }
    const collected = [];
    for await (
      const entry of store.query({
        from: "2026-04-29T00:00:00.000Z",
        to: "2026-04-30T23:59:59.999Z",
      })
    ) {
      collected.push(entry);
    }
    assertEquals(collected.length, 2);
    assert(collected[0]!.id < collected[1]!.id);
    assertEquals(collected[0]?.timestamp.slice(0, 10), "2026-04-29");
    assertEquals(collected[1]?.timestamp.slice(0, 10), "2026-04-30");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileActivityLogStore — query handles 1000 entries without buffering the whole array (streaming)", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-activity-large-" });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FileActivityLogStore(paths);
    for (let i = 0; i < 1000; i++) {
      await store.append({
        session_id: "s",
        agent: "alice",
        role: "engineer",
        event: `e${i}`,
      });
    }
    let count = 0;
    for await (const _ of store.query()) {
      count++;
      if (count >= 5) break;
    }
    assertEquals(count, 5, "early break stops iteration");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileActivityLogStore — file format is one JSON object per line, newline-terminated", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-activity-format-" });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FileActivityLogStore(paths);
    await store.append({
      timestamp: "2026-04-30T17:00:00.123Z",
      session_id: "s",
      agent: "alice",
      role: "engineer",
      event: "session_start",
      refs: { ticket: "ticket-0001" },
    });
    const text = await Deno.readTextFile(
      join(paths.activity, "2026-04-30.jsonl"),
    );
    const lines = text.split("\n");
    assertEquals(lines.length, 2, "one entry plus trailing newline split");
    assertEquals(lines[1], "");
    const parsed = JSON.parse(lines[0]!);
    assertEquals(parsed.session_id, "s");
    assertEquals(parsed.agent, "alice");
    assertEquals(parsed.event, "session_start");
    assertEquals(parsed.refs, { ticket: "ticket-0001" });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
