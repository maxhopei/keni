/**
 * Tests for `args.ts` — the `keni start` argv parser.
 *
 * Covers the eight scenarios in the `cli-start` capability spec's
 * "Argv parsing" requirement.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { resolve } from "@std/path";
import { UsageError } from "../../../src/init/errors.ts";
import { parseStartArgs } from "../../../src/start/args.ts";

Deno.test("parseStartArgs: no args defaults to cwd, no flags set", () => {
  const parsed = parseStartArgs([]);
  assertEquals(parsed.projectDir, resolve(Deno.cwd()));
  assertEquals(parsed.portPin, undefined);
  assertEquals(parsed.portRange, undefined);
  assertEquals(parsed.spaDevUrl, undefined);
  assertEquals(parsed.spaBundle, undefined);
  assertEquals(parsed.positionalAndFlagBoth, false);
});

Deno.test("parseStartArgs: positional [path] resolves to absolute", () => {
  const parsed = parseStartArgs(["/some/abs/path"]);
  assertEquals(parsed.projectDir, "/some/abs/path");
  assertEquals(parsed.positionalAndFlagBoth, false);
});

Deno.test("parseStartArgs: --project flag is honoured when no positional is given", () => {
  const parsed = parseStartArgs(["--project", "/some/proj"]);
  assertEquals(parsed.projectDir, "/some/proj");
  assertEquals(parsed.positionalAndFlagBoth, false);
});

Deno.test("parseStartArgs: positional wins over --project when both are supplied", () => {
  const parsed = parseStartArgs(["/positional", "--project", "/flag"]);
  assertEquals(parsed.projectDir, "/positional");
  assertEquals(parsed.positionalAndFlagBoth, true);
});

Deno.test("parseStartArgs: unknown flag throws UsageError", () => {
  assertThrows(() => parseStartArgs(["--no-such-flag"]), UsageError);
});

Deno.test("parseStartArgs: --port 8080 collapses portRange to a single-port pin", () => {
  const parsed = parseStartArgs(["--port", "8080"]);
  assertEquals(parsed.portPin, 8080);
  assertEquals(parsed.portRange, undefined);
});

Deno.test("parseStartArgs: --port-range 9000-9005 sets the explicit range", () => {
  const parsed = parseStartArgs(["--port-range", "9000-9005"]);
  assertEquals(parsed.portRange, { start: 9000, end: 9005 });
  assertEquals(parsed.portPin, undefined);
});

Deno.test("parseStartArgs: --port-range 7777 (malformed) throws UsageError", () => {
  assertThrows(() => parseStartArgs(["--port-range", "7777"]), UsageError);
});

Deno.test("parseStartArgs: --port abc throws UsageError", () => {
  assertThrows(() => parseStartArgs(["--port", "abc"]), UsageError);
});

Deno.test("parseStartArgs: --port-range with start > end throws UsageError", () => {
  assertThrows(() => parseStartArgs(["--port-range", "9000-8000"]), UsageError);
});

Deno.test("parseStartArgs: --port and --port-range together throw UsageError", () => {
  assertThrows(
    () => parseStartArgs(["--port", "8080", "--port-range", "9000-9005"]),
    UsageError,
  );
});

Deno.test("parseStartArgs: --spa-dev-url and --spa-bundle together throw UsageError", () => {
  assertThrows(
    () => parseStartArgs(["--spa-dev-url", "http://x", "--spa-bundle", "/dist"]),
    UsageError,
  );
});

Deno.test("parseStartArgs: --shutdown-grace-ms accepts integers", () => {
  const parsed = parseStartArgs(["--shutdown-grace-ms", "5000"]);
  assertEquals(parsed.shutdownGraceMs, 5000);
});

Deno.test("parseStartArgs: --shutdown-grace-ms negative throws UsageError", () => {
  assertThrows(() => parseStartArgs(["--shutdown-grace-ms", "-1"]), UsageError);
});

Deno.test("parseStartArgs: --key=value form is accepted", () => {
  const parsed = parseStartArgs(["--port=4242"]);
  assertEquals(parsed.portPin, 4242);
});

Deno.test("parseStartArgs: too many positionals throw UsageError", () => {
  assertThrows(() => parseStartArgs(["/a", "/b"]), UsageError);
});

Deno.test("parseStartArgs: --host respects the supplied value", () => {
  const parsed = parseStartArgs(["--host", "0.0.0.0"]);
  assertEquals(parsed.host, "0.0.0.0");
});

Deno.test("parseStartArgs: --spa-dev-url is captured", () => {
  const parsed = parseStartArgs(["--spa-dev-url", "http://localhost:5173"]);
  assertEquals(parsed.spaDevUrl, "http://localhost:5173");
});

Deno.test("parseStartArgs: --spa-bundle is captured", () => {
  const parsed = parseStartArgs(["--spa-bundle", "/some/dist"]);
  assertEquals(parsed.spaBundle, "/some/dist");
});

Deno.test("parseStartArgs: a flag without its required value throws UsageError", () => {
  assertThrows(() => parseStartArgs(["--port"]), UsageError);
});

Deno.test("parseStartArgs: relative positional resolves to absolute", () => {
  const parsed = parseStartArgs(["./relative-dir"]);
  assert(parsed.projectDir.endsWith("/relative-dir"));
});
