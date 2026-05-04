/**
 * Build-time version constant for `@keni/shared` (and every package that
 * re-exports this module).
 *
 * Read by the `/health` endpoint's response body. The prototype hard-codes
 * the value here; future binary packaging will replace it via a build
 * argument. Bump the literal manually when cutting a tagged release until
 * the packaging step exists.
 *
 * @module
 */

/** Build-time version literal. */
export const VERSION = "0.0.0-prototype" as const;

/** Type alias for callers that want a concrete `string` type. */
export type Version = typeof VERSION;
