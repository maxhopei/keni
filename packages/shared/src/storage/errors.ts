/**
 * Typed errors thrown by every storage adapter. Every class extends `Error` and
 * sets `this.name` to its class name, so narrow error logs (JSON-serialised or
 * stringified) still identify the class without `instanceof`.
 *
 * Callers that want type-safe narrowing should use `instanceof`:
 * ```ts
 * try { await store.read(id); } catch (err) {
 *   if (err instanceof StoreNotFoundError) { ... }
 * }
 * ```
 *
 * @module
 */

/**
 * Thrown when `read` / `update*` / `transitionStatus` targets an id that does
 * not exist in the store.
 */
export class StoreNotFoundError extends Error {
  override readonly name = "StoreNotFoundError";
  /** The id or path that was not found. */
  readonly id: string;
  /** Optional filesystem path, when the store is file-backed. */
  readonly path?: string;

  constructor(id: string, path?: string) {
    super(
      path ? `Artifact '${id}' not found at ${path}` : `Artifact '${id}' not found`,
    );
    this.id = id;
    if (path !== undefined) this.path = path;
  }

  toJSON(): { name: string; message: string; id: string; path?: string } {
    const out: { name: string; message: string; id: string; path?: string } = {
      name: this.name,
      message: this.message,
      id: this.id,
    };
    if (this.path !== undefined) out.path = this.path;
    return out;
  }
}

/**
 * Thrown by optimistic status transitions (`transitionStatus` on tickets,
 * `updateStatus` on PRs) when the on-disk / in-memory `from` value does not
 * match the argument passed by the caller — meaning the caller's view is
 * stale.
 */
export class StaleStateError extends Error {
  override readonly name = "StaleStateError";
  readonly id: string;
  readonly expected: string;
  readonly actual: string;

  constructor(id: string, expected: string, actual: string) {
    super(
      `Stale state on '${id}': expected '${expected}', actual '${actual}'`,
    );
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }

  toJSON(): {
    name: string;
    message: string;
    id: string;
    expected: string;
    actual: string;
  } {
    return {
      name: this.name,
      message: this.message,
      id: this.id,
      expected: this.expected,
      actual: this.actual,
    };
  }
}

/**
 * Thrown at `create()` time if the proposed id already exists. Under the
 * single-writer-per-artifact contract this is defensive; the id-generator is
 * designed to always produce fresh ids.
 */
export class DuplicateIdError extends Error {
  override readonly name = "DuplicateIdError";
  readonly id: string;

  constructor(id: string) {
    super(`Artifact id '${id}' already exists`);
    this.id = id;
  }

  toJSON(): { name: string; message: string; id: string } {
    return { name: this.name, message: this.message, id: this.id };
  }
}

/**
 * Thrown when an on-disk file fails to parse (malformed YAML front-matter,
 * invalid JSON line, schema mismatch) or when a caller supplies an invalid
 * input (activity entry exceeding the 4 KB line limit, patch including a
 * forbidden field like `status` on `updateHeader`).
 */
export class InvalidArtifactError extends Error {
  override readonly name = "InvalidArtifactError";
  /** Filesystem path of the offending artifact, when applicable. */
  readonly path?: string;
  /** Short reason code useful for UI surfacing (e.g., `"size_exceeded"`, `"status_in_patch"`, `"malformed_yaml"`). */
  readonly reason: string;

  constructor(reason: string, message: string, path?: string) {
    super(message);
    this.reason = reason;
    if (path !== undefined) this.path = path;
  }

  toJSON(): {
    name: string;
    message: string;
    reason: string;
    path?: string;
  } {
    const out: {
      name: string;
      message: string;
      reason: string;
      path?: string;
    } = {
      name: this.name,
      message: this.message,
      reason: this.reason,
    };
    if (this.path !== undefined) out.path = this.path;
    return out;
  }
}
