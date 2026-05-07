import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { __setPreRenameHook } from "../../../../src/storage/atomic.ts";
import { resolveProjectPaths } from "../../../../src/storage/paths.ts";
import { runPRStoreContract } from "../../../contracts/storage/prs/prStoreContract.ts";
import { FilePRStore } from "../../../../src/storage/prs/file.ts";

const ACTIVE_TEMP_DIRS = new Set<string>();

async function freshFileStore(): Promise<FilePRStore> {
  const root = await Deno.makeTempDir({ prefix: "keni-prs-test-" });
  ACTIVE_TEMP_DIRS.add(root);
  return new FilePRStore(resolveProjectPaths(root));
}

runPRStoreContract("FilePRStore", freshFileStore);

Deno.test("FilePRStore :: cleanup — remove every test temp dir", async () => {
  for (const dir of ACTIVE_TEMP_DIRS) {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
  ACTIVE_TEMP_DIRS.clear();
});

Deno.test("FilePRStore — pre-rename crash during updateStatus preserves prior version", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-prs-crash-" });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FilePRStore(paths);
    const created = await store.create({
      title: "T",
      ticket: "ticket-0001",
      branch: "ticket-0001",
      author: "alice",
    });
    const filePath = join(paths.prs, `${created.header.id}.md`);
    const before = await Deno.readTextFile(filePath);

    __setPreRenameHook(() => {
      throw new Error("simulated crash");
    });
    try {
      await assertRejects(
        () => store.updateStatus(created.header.id, "open", "in_review"),
        Error,
      );
    } finally {
      __setPreRenameHook(undefined);
    }

    assertEquals(await Deno.readTextFile(filePath), before);
    const reread = await store.read(created.header.id);
    assertEquals(reread.header.status, "open");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
