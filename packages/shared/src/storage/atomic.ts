/**
 * Atomic per-file writes for every file-backed storage adapter.
 *
 * The strategy is the classic write-to-sibling-temp-file-then-rename pattern:
 * on POSIX, `rename()` is atomic when source and destination are on the same
 * filesystem, so a reader always observes either the pre-write or post-write
 * contents — never a partial write. To stay on one filesystem by
 * construction, the temp file is created in the *target's* directory
 * (prefix: `.keni-tmp-`).
 *
 * On any write failure before the final `rename`, the temp file is cleaned up
 * on a best-effort basis (`finally` block with an `errorCallback: noop`
 * remove). A residual `.keni-tmp-*` file is harmless but untidy; the cleanup
 * pass is not load-bearing for correctness.
 *
 * Durability note: we do not `fsync` by default. Prototype / MVP scope does
 * not require power-loss durability; the common failure mode (SIGTERM from a
 * user-interrupted session per `spec.md` §7.5) is already handled by
 * `rename()` atomicity. Callers that need fsync can opt in with
 * `opts.fsync: true`.
 *
 * @module
 */

import { dirname } from "@std/path";

/** Options for {@link writeFileAtomic}. */
export interface WriteFileAtomicOptions {
  /** Permission mode to apply to the target file. Defaults to the OS default. */
  mode?: number;
  /** Call `fsync` on the temp file before renaming. Defaults to `false`. */
  fsync?: boolean;
}

/**
 * Test-only hook invoked between the temp-file write and the rename. Tests
 * set this to simulate a crash mid-write and verify the previous file version
 * is preserved. Reset to `undefined` at the end of every test that uses it.
 *
 * @internal
 */
let preRenameHook: (() => void | Promise<void>) | undefined = undefined;

/**
 * Install a pre-rename hook. Pass `undefined` to clear. Intended exclusively
 * for the atomic-write test suite; production callers MUST NOT use this.
 *
 * @internal
 */
export function __setPreRenameHook(
  hook: (() => void | Promise<void>) | undefined,
): void {
  preRenameHook = hook;
}

/**
 * Atomically write `contents` to `targetPath`. Creates the parent directory if
 * needed (via a separate `Deno.mkdir(..., { recursive: true })`); creates a
 * temp file in the same directory, writes contents, optionally `fsync`s,
 * invokes the test-only pre-rename hook (if set), then renames the temp file
 * onto the target. On any failure, removes the temp file on a best-effort
 * basis.
 *
 * @throws Whatever `Deno.makeTempFile`, `Deno.writeTextFile`, `Deno.rename`,
 *   or the test hook throws.
 */
export async function writeFileAtomic(
  targetPath: string,
  contents: string | Uint8Array,
  opts: WriteFileAtomicOptions = {},
): Promise<void> {
  const dir = dirname(targetPath);
  await Deno.mkdir(dir, { recursive: true });

  const tempPath = await Deno.makeTempFile({
    dir,
    prefix: ".keni-tmp-",
  });

  try {
    if (typeof contents === "string") {
      await Deno.writeTextFile(tempPath, contents);
    } else {
      await Deno.writeFile(tempPath, contents);
    }

    if (opts.mode !== undefined) {
      await Deno.chmod(tempPath, opts.mode);
    }

    if (opts.fsync) {
      using file = await Deno.open(tempPath, { read: true, write: true });
      await file.syncData();
    }

    if (preRenameHook) {
      await preRenameHook();
    }

    await Deno.rename(tempPath, targetPath);
  } catch (err) {
    try {
      await Deno.remove(tempPath);
    } catch {
      // best-effort cleanup; residual temp files are harmless
    }
    throw err;
  }
}
