import { assert, assertEquals } from "@std/assert";
import {
  createSubprocessCodingAgentInvoker,
  packageName,
  resolveBundledPrompt,
  RoleRuntimeError,
  RoleRuntimeHttpError,
  startCycle,
} from "./main.ts";

Deno.test("@keni/role-runtimes exposes its package name", () => {
  assertEquals(packageName, "@keni/role-runtimes");
});

Deno.test("@keni/role-runtimes exposes startCycle as a function", () => {
  assertEquals(typeof startCycle, "function");
});

Deno.test("@keni/role-runtimes exposes createSubprocessCodingAgentInvoker as a function", () => {
  assertEquals(typeof createSubprocessCodingAgentInvoker, "function");
});

Deno.test("@keni/role-runtimes exposes resolveBundledPrompt as a function", () => {
  assertEquals(typeof resolveBundledPrompt, "function");
});

Deno.test("@keni/role-runtimes exposes RoleRuntimeError as an Error subclass", () => {
  assert(RoleRuntimeError.prototype instanceof Error);
});

Deno.test("@keni/role-runtimes exposes RoleRuntimeHttpError as an Error subclass", () => {
  assert(RoleRuntimeHttpError.prototype instanceof Error);
});
