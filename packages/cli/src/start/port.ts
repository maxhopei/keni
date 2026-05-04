/**
 * Port-range walker for `keni start`.
 *
 * Walks an inclusive `[start, end]` integer range, calling the injected
 * `startServer` for each port. On `Deno.errors.AddrInUse`, logs a
 * warn line and tries the next port. On a non-`AddrInUse` error
 * (`Deno.errors.PermissionDenied`, etc.), rethrows verbatim — those
 * are fail-fast surfaces, not "try the next port" surfaces.
 *
 * When every port in the range is busy, throws {@link PortRangeExhaustedError}.
 *
 * @module
 */

/** Sink for warn-level lines from the binder. */
export interface PortBindLogSink {
  warn(message: string): void;
}

/** Throws when every port in the supplied range is busy. */
export class PortRangeExhaustedError extends Error {
  override readonly name = "PortRangeExhaustedError";
  readonly range: { readonly start: number; readonly end: number };

  constructor(range: { start: number; end: number }) {
    super(
      range.start === range.end
        ? `Port ${range.start} is in use; --port pins disable the fallback range`
        : `No port in [${range.start}..${range.end}] could be bound (every port is in use)`,
    );
    this.range = range;
  }
}

/** Inputs for {@link bindPortInRange}. */
export interface BindPortInRangeInput<H> {
  readonly startServer: (opts: { host: string; port: number }) => Promise<H>;
  readonly host: string;
  readonly range: { readonly start: number; readonly end: number };
  readonly logSink?: PortBindLogSink;
}

/**
 * Walk `range.start..range.end` (inclusive). Returns the server handle
 * resolved by the first successful `startServer({ host, port })` call.
 *
 * @throws {PortRangeExhaustedError} when every port in the range is busy.
 */
export async function bindPortInRange<H>(input: BindPortInRangeInput<H>): Promise<H> {
  const { startServer, host, range, logSink } = input;
  if (range.start > range.end) {
    throw new PortRangeExhaustedError(range);
  }
  for (let port = range.start; port <= range.end; port++) {
    try {
      return await startServer({ host, port });
    } catch (e) {
      if (e instanceof Deno.errors.AddrInUse) {
        logSink?.warn(
          `Port ${port} on ${host} is in use; trying next port in [${range.start}..${range.end}]`,
        );
        continue;
      }
      throw e;
    }
  }
  throw new PortRangeExhaustedError(range);
}
