/**
 * Error contract for the MCP layer.
 *
 * This module exposes the **single** mapping function from a thrown value
 * (HTTP-shaped or otherwise) to the MCP SDK's `isError: true` tool-result
 * shape (design.md Decision 8). Every tool handler funnels its
 * `try`/`catch` through {@link mapHttpErrorToToolResult}, so the format of
 * an MCP-surfaced failure is governed by exactly one place.
 *
 * The `code` field on {@link McpHttpError} is typed as `string` rather than
 * the closed `ErrorCode` enum from `@keni/shared/wire/errors.ts` — the
 * orchestration server might (one day) surface a code the MCP layer has
 * not been recompiled against, and the wrapper must not throw on that
 * branch. The {@link ERROR_CODES} re-export from `@keni/shared` is what
 * tests pin against; the runtime is forgiving.
 *
 * @module
 */

/**
 * Thrown by the MCP HTTP client on a non-2xx response or on a network-level
 * `fetch` rejection (in which case `httpStatus === 0`).
 *
 * The four public fields are the source-of-truth for {@link
 * mapHttpErrorToToolResult}'s rendering.
 */
export class McpHttpError extends Error {
  override readonly name = "McpHttpError";
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly httpStatus: number;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> | undefined,
    httpStatus: number,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

/**
 * Shape of an MCP tool result with `isError: true`. The `content` array is
 * declared mutable (not `readonly`) so the value satisfies the SDK's
 * `CallToolResult` shape, which expects `Array<TextContent | ...>`.
 */
export interface McpToolErrorResult {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

/** Shape of a successful MCP tool result (no `isError` key). */
export interface McpToolSuccessResult {
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Map a thrown value to the MCP `isError: true` shape. The behaviour:
 *
 * - `McpHttpError` → text `[<code>] <message> (HTTP <status>)` followed by
 *   `\nDetails: <indented JSON>` when `details !== undefined`.
 * - Any other thrown value → text `[internal_error] Unexpected error in
 *   MCP tool handler: <message>`. The original message is preserved
 *   verbatim (no redaction at this layer; the orchestration server has
 *   already redacted at its boundary).
 *
 * The result is **returned**, not thrown, per the MCP SDK's tool-handler
 * contract (the spec scenario "the result is **not** thrown — it is
 * returned per the MCP SDK's tool-handler contract").
 */
export function mapHttpErrorToToolResult(err: unknown): McpToolErrorResult {
  if (err instanceof McpHttpError) {
    const head = `[${err.code}] ${err.message} (HTTP ${err.httpStatus})`;
    const text = err.details === undefined
      ? head
      : `${head}\nDetails: ${JSON.stringify(err.details, null, 2)}`;
    return { content: [{ type: "text", text }], isError: true };
  }

  const message = err instanceof Error ? err.message : typeof err === "string" ? err : (() => {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  })();
  return {
    content: [{
      type: "text",
      text: `[internal_error] Unexpected error in MCP tool handler: ${message}`,
    }],
    isError: true,
  };
}

/**
 * Wrap a successful tool result. The text is the input value pretty-printed
 * as JSON (two-space indent). No `isError` key — the SDK's success path is
 * "absent `isError` field".
 */
export function wrapToolSuccess<T>(value: T): McpToolSuccessResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}
