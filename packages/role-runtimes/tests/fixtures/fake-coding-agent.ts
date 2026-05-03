/**
 * Test fixture — a tiny "coding agent" used by the role-runtime's
 * subprocess invoker tests and the end-to-end integration test.
 *
 * The fixture's behaviour is parameterised entirely via env vars so the
 * same script can model a happy-path completion, an idle cycle, an
 * abort-during-sleep, and a stderr-emitting cycle:
 *
 *   KENI_FAKE_AGENT_LINES         — N stdout lines (default 0)
 *   KENI_FAKE_AGENT_SUMMARY       — final stdout line (default "placeholder summary")
 *   KENI_FAKE_AGENT_EXIT_CODE     — exit code (default 0)
 *   KENI_FAKE_AGENT_SLEEP_MS      — pre-output sleep, interruptible (default 0)
 *   KENI_FAKE_AGENT_STDERR_LINES  — N stderr lines (default 0)
 *   KENI_FAKE_AGENT_REQUIRE_PROMPT — 1 to require non-empty stdin (default 0)
 *   KENI_FAKE_AGENT_DRAIN_STDIN   — 1 to drain and discard stdin (default 0)
 *
 * SIGTERM is handled — the fixture exits with code 143 within ~10 ms so
 * `terminate(child, { graceMs: ... })` resolves with `terminatedBy:
 * "sigterm"`.
 *
 * @module
 */

const lines = Number.parseInt(Deno.env.get("KENI_FAKE_AGENT_LINES") ?? "0", 10);
const summary = Deno.env.get("KENI_FAKE_AGENT_SUMMARY") ?? "placeholder summary";
const exitCode = Number.parseInt(Deno.env.get("KENI_FAKE_AGENT_EXIT_CODE") ?? "0", 10);
const sleepMs = Number.parseInt(Deno.env.get("KENI_FAKE_AGENT_SLEEP_MS") ?? "0", 10);
const stderrLines = Number.parseInt(Deno.env.get("KENI_FAKE_AGENT_STDERR_LINES") ?? "0", 10);
const requirePrompt = Deno.env.get("KENI_FAKE_AGENT_REQUIRE_PROMPT") === "1";
const drainStdin = Deno.env.get("KENI_FAKE_AGENT_DRAIN_STDIN") === "1" || requirePrompt;

let aborted = false;
Deno.addSignalListener("SIGTERM", () => {
  aborted = true;
  Deno.exit(143);
});

if (drainStdin) {
  let received = 0;
  const reader = Deno.stdin.readable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.length;
  }
  reader.releaseLock();
  if (requirePrompt && received === 0) {
    await Deno.stderr.write(new TextEncoder().encode("FIXTURE: empty prompt\n"));
    Deno.exit(2);
  }
}

if (sleepMs > 0) {
  await new Promise<void>((resolveFn) => {
    const handle = setTimeout(resolveFn, sleepMs);
    Deno.addSignalListener("SIGTERM", () => {
      clearTimeout(handle);
      resolveFn();
    });
  });
}

const enc = new TextEncoder();
for (let i = 0; i < stderrLines; i++) {
  if (aborted) Deno.exit(143);
  await Deno.stderr.write(enc.encode(`stderr line ${i}\n`));
}
for (let i = 0; i < lines; i++) {
  if (aborted) Deno.exit(143);
  await Deno.stdout.write(enc.encode(`line ${i}\n`));
}
await Deno.stdout.write(enc.encode(`${summary}\n`));
Deno.exit(exitCode);
