import { assertEquals, assertThrows } from "@std/assert";
import { resolveBundledPrompt } from "../../../src/common/promptResolver.ts";
import { RoleRuntimeError } from "../../../src/common/types.ts";

Deno.test("resolveBundledPrompt — empty body throws RoleRuntimeError(empty_prompt_body)", () => {
  const err = assertThrows(
    () => resolveBundledPrompt({ name: "engineer", body: "" }),
    RoleRuntimeError,
  );
  assertEquals(err.code, "empty_prompt_body");
  if (!err.message.includes("engineer")) {
    throw new Error(`expected message to name the prompt; got: ${err.message}`);
  }
});

Deno.test("resolveBundledPrompt — name mismatch throws RoleRuntimeError(prompt_name_mismatch)", () => {
  const err = assertThrows(
    () => resolveBundledPrompt({ name: "po-chat", body: "hi" }, "engineer"),
    RoleRuntimeError,
  );
  assertEquals(err.code, "prompt_name_mismatch");
  if (!err.message.includes("engineer") || !err.message.includes("po-chat")) {
    throw new Error(`expected message to name both names; got: ${err.message}`);
  }
});

Deno.test("resolveBundledPrompt — valid prompt is returned verbatim", () => {
  const prompt = { name: "engineer", body: "ENGINEER PROMPT BODY" };
  const resolved = resolveBundledPrompt(prompt, "engineer");
  assertEquals(resolved, prompt);
});

Deno.test("resolveBundledPrompt — expectedName is genuinely optional", () => {
  const prompt = { name: "anything", body: "non-empty" };
  const resolved = resolveBundledPrompt(prompt);
  assertEquals(resolved, prompt);
});
