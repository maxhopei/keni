import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { __setPreRenameHook, writeFileAtomic } from "../atomic.ts";
import { InvalidArtifactError } from "../errors.ts";
import { resolveProjectPaths } from "../paths.ts";
import { runTicketStoreContract } from "./contract_test.ts";
import { FileTicketStore } from "./file.ts";

const ACTIVE_TEMP_DIRS = new Set<string>();

async function freshFileStore(): Promise<FileTicketStore> {
  const root = await Deno.makeTempDir({ prefix: "keni-tickets-test-" });
  ACTIVE_TEMP_DIRS.add(root);
  const paths = resolveProjectPaths(root);
  return new FileTicketStore(paths);
}

runTicketStoreContract("FileTicketStore", freshFileStore);

Deno.test("FileTicketStore :: cleanup — remove every test temp dir", async () => {
  for (const dir of ACTIVE_TEMP_DIRS) {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
  ACTIVE_TEMP_DIRS.clear();
});

Deno.test("FileTicketStore — pre-rename crash during transitionStatus preserves prior version", async () => {
  const root = await Deno.makeTempDir({
    prefix: "keni-tickets-crash-",
  });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FileTicketStore(paths);
    const created = await store.create({ title: "T", priority: 100 });
    const filePath = join(paths.tickets, `${created.header.id}.md`);
    const before = await Deno.readTextFile(filePath);

    __setPreRenameHook(() => {
      throw new Error("simulated mid-write crash");
    });
    try {
      await assertRejects(
        () => store.transitionStatus(created.header.id, "open", "in_progress"),
        Error,
        "simulated mid-write crash",
      );
    } finally {
      __setPreRenameHook(undefined);
    }

    const after = await Deno.readTextFile(filePath);
    assertEquals(after, before, "ticket file must be byte-identical");

    const reread = await store.read(created.header.id);
    assertEquals(reread.header.status, "open");

    const residue: string[] = [];
    for await (const entry of Deno.readDir(paths.tickets)) {
      if (entry.name.startsWith(".keni-tmp-")) residue.push(entry.name);
    }
    assertEquals(residue, [], "no temp residue must remain");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileTicketStore — read on a corrupt YAML header throws InvalidArtifactError carrying the path", async () => {
  const root = await Deno.makeTempDir({
    prefix: "keni-tickets-corrupt-",
  });
  try {
    const paths = resolveProjectPaths(root);
    const corruptPath = join(paths.tickets, "ticket-0001.md");
    const corrupt = [
      "---",
      'title: "unclosed string',
      "id: ticket-0001",
      "---",
      "",
      "body",
    ].join("\n");
    await writeFileAtomic(corruptPath, corrupt);
    const store = new FileTicketStore(paths);
    const err = await assertRejects(
      () => store.read("ticket-0001"),
      InvalidArtifactError,
    );
    assertEquals(err.path, corruptPath);
    assert(
      err.reason === "malformed_yaml" ||
        err.reason === "unterminated_front_matter",
      `expected malformed_yaml or unterminated_front_matter, got '${err.reason}'`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileTicketStore — read of a directory at the ticket path throws InvalidArtifactError", async () => {
  const root = await Deno.makeTempDir({
    prefix: "keni-tickets-isdir-",
  });
  try {
    const paths = resolveProjectPaths(root);
    await Deno.mkdir(paths.tickets, { recursive: true });
    await Deno.mkdir(join(paths.tickets, "ticket-0001.md"));
    const store = new FileTicketStore(paths);
    const err = await assertRejects(
      () => store.read("ticket-0001"),
      InvalidArtifactError,
    );
    assertEquals(err.reason, "is_directory");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileTicketStore — id mismatch between filename and YAML header throws InvalidArtifactError", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-tickets-mismatch-" });
  try {
    const paths = resolveProjectPaths(root);
    await Deno.mkdir(paths.tickets, { recursive: true });
    const yaml = [
      "---",
      "id: ticket-9999",
      'title: "wrong"',
      "status: open",
      "assignee: null",
      "priority: 100",
      "change_request: null",
      "created_at: 2026-04-30T00:00:00.000Z",
      "updated_at: 2026-04-30T00:00:00.000Z",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFileAtomic(join(paths.tickets, "ticket-0001.md"), yaml);
    const store = new FileTicketStore(paths);
    const err = await assertRejects(
      () => store.read("ticket-0001"),
      InvalidArtifactError,
    );
    assertEquals(err.reason, "id_mismatch");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileTicketStore — file format matches the documented spec.md §5.1 layout", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-tickets-format-" });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FileTicketStore(paths);
    const created = await store.create({
      title: "Add login page",
      body: "Implementation plan.",
      priority: 100,
    });
    const text = await Deno.readTextFile(
      join(paths.tickets, `${created.header.id}.md`),
    );
    assert(text.startsWith("---\n"), "front-matter delimiter at start");
    const closingDelim = text.indexOf("\n---\n");
    assert(
      closingDelim > 0,
      "closing front-matter delimiter must exist",
    );
    const yamlBlock = text.slice(4, closingDelim);
    for (
      const required of [
        "id: ticket-0001",
        "title: Add login page",
        "status: open",
        "assignee: null",
        "priority: 100",
        "change_request: null",
        "created_at:",
        "updated_at:",
      ]
    ) {
      assert(
        yamlBlock.includes(required),
        `expected YAML to include '${required}', got:\n${yamlBlock}`,
      );
    }
    assert(
      text.includes("Implementation plan."),
      "body must follow front-matter",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileTicketStore — list ignores non-ticket files in the directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-tickets-list-" });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FileTicketStore(paths);
    await store.create({ title: "A", priority: 100 });
    await Deno.writeTextFile(join(paths.tickets, "README.md"), "ignored");
    await Deno.writeTextFile(
      join(paths.tickets, "ticket-bad.md"),
      "not an id",
    );
    await Deno.writeTextFile(
      join(paths.tickets, "ticket-0042.txt"),
      "wrong ext",
    );
    const summaries = await store.list();
    assertEquals(summaries.length, 1);
    assertEquals(summaries[0]?.id, "ticket-0001");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileTicketStore — list returns empty array when the tickets directory does not exist yet", async () => {
  const root = await Deno.makeTempDir({ prefix: "keni-tickets-missing-" });
  try {
    const paths = resolveProjectPaths(root);
    const store = new FileTicketStore(paths);
    const summaries = await store.list();
    assertEquals(summaries, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
