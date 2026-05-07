import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { __setPreRenameHook, writeFileAtomic } from "../../../src/storage/atomic.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "keni-atomic-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function listTempResidue(dir: string): Promise<string[]> {
  const entries: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".keni-tmp-")) entries.push(entry.name);
  }
  return entries;
}

Deno.test("writeFileAtomic — happy path writes the target byte-identically", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "ticket-0001.md");
    const contents = "---\nid: ticket-0001\n---\n\n# hi\n";
    await writeFileAtomic(target, contents);
    const read = await Deno.readTextFile(target);
    assertEquals(read, contents);
    assertEquals(await listTempResidue(dir), []);
  });
});

Deno.test("writeFileAtomic — overwrites an existing file atomically", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "ticket-0001.md");
    await writeFileAtomic(target, "first");
    await writeFileAtomic(target, "second");
    assertEquals(await Deno.readTextFile(target), "second");
    assertEquals(await listTempResidue(dir), []);
  });
});

Deno.test("writeFileAtomic — creates parent directories on first write", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "nested", "deep", "ticket-0001.md");
    await writeFileAtomic(target, "content");
    assertEquals(await Deno.readTextFile(target), "content");
    const parentStat = await Deno.stat(dirname(target));
    assert(parentStat.isDirectory);
  });
});

Deno.test("writeFileAtomic — accepts Uint8Array contents", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "blob.bin");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await writeFileAtomic(target, bytes);
    const read = await Deno.readFile(target);
    assertEquals(read, bytes);
  });
});

Deno.test("writeFileAtomic — pre-rename hook failure preserves the prior version", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "ticket-0001.md");
    await writeFileAtomic(target, "original");
    const originalBytes = await Deno.readTextFile(target);

    __setPreRenameHook(() => {
      throw new Error("simulated crash");
    });
    try {
      await assertRejects(
        () => writeFileAtomic(target, "new contents"),
        Error,
        "simulated crash",
      );
    } finally {
      __setPreRenameHook(undefined);
    }

    assertEquals(await Deno.readTextFile(target), originalBytes);
    assertEquals(
      await listTempResidue(dir),
      [],
      "temp file must be cleaned up after the pre-rename failure",
    );
  });
});

Deno.test("writeFileAtomic — async pre-rename hook is awaited", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "ticket-0001.md");
    await writeFileAtomic(target, "original");

    let hookRan = false;
    __setPreRenameHook(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      hookRan = true;
      throw new Error("async crash");
    });
    try {
      await assertRejects(
        () => writeFileAtomic(target, "new"),
        Error,
        "async crash",
      );
    } finally {
      __setPreRenameHook(undefined);
    }

    assert(hookRan);
    assertEquals(await Deno.readTextFile(target), "original");
  });
});

Deno.test("writeFileAtomic — temp file lives in the target's directory (same-filesystem rename)", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "ticket-0001.md");
    let observedTempDir: string | undefined;
    __setPreRenameHook(async () => {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.name.startsWith(".keni-tmp-")) {
          observedTempDir = dir;
          break;
        }
      }
      throw new Error("abort for observation");
    });
    try {
      await assertRejects(() => writeFileAtomic(target, "x"), Error);
    } finally {
      __setPreRenameHook(undefined);
    }
    assertEquals(
      observedTempDir,
      dir,
      "temp file must be in the target's directory, not /tmp",
    );
    assertEquals(await listTempResidue(dir), []);
  });
});

Deno.test("writeFileAtomic — serial writes to the same target are last-writer-wins, no interleave", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "ticket-0001.md");
    await writeFileAtomic(target, "A".repeat(1000));
    await writeFileAtomic(target, "B".repeat(1000));
    const read = await Deno.readTextFile(target);
    assertEquals(read.length, 1000);
    assert(read === "B".repeat(1000), "content must be fully from writer B");
  });
});

Deno.test("writeFileAtomic — opts.fsync: true succeeds on happy path", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "ticket-0001.md");
    await writeFileAtomic(target, "durable", { fsync: true });
    assertEquals(await Deno.readTextFile(target), "durable");
  });
});

Deno.test("writeFileAtomic — opts.mode sets the file permissions", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "ticket-0001.md");
    await writeFileAtomic(target, "x", { mode: 0o600 });
    const stat = await Deno.stat(target);
    if (stat.mode !== null) {
      assertEquals(stat.mode & 0o777, 0o600);
    }
  });
});
