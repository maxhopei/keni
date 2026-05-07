/**
 * PO role placeholder prompt.
 *
 * The constant is shipped only to prove the polymorphic role plug-in
 * model registers a second role end-to-end. The PO runner's `precheck`
 * always resolves `{ kind: "skip", reason: "po_not_implemented" }`,
 * so the prompt is never sent to a coding-agent CLI; this body exists
 * so the prompt resolver returns a non-empty `BundledPrompt` (per the
 * cycle's `empty_prompt_body` guard) and so an operator inspecting the
 * agent's roster sees the placeholder status from the prompt itself.
 *
 * The literal substring `STUB IMPLEMENTATION` on the first non-empty
 * line is asserted by the package's structural test.
 *
 * @module
 */

export const PO_PROMPT_NAME = "po" as const;

export const PO_PROMPT_BODY: string = `STUB IMPLEMENTATION — Product Owner role (placeholder).

This prompt body exists only to satisfy the role-runtime cycle's
\`BundledPrompt\` invariants: the prompt name SHALL match
\`expectedPromptName\` and the body SHALL be a non-empty string. The
PO runner's \`precheck(ctx)\` always resolves
\`{ kind: "skip", reason: "po_not_implemented" }\`, so this prompt is
never rendered into a coding-agent subprocess. The role exists in
\`agents\` rosters today purely so the polymorphic role plug-in model
(\`runServer\`'s \`roleWires\` registry) can be exercised end-to-end
with two roles instead of one.

When a real PO role is implemented (a future change), this constant
will be replaced with the canonical PO prompt (covering grooming,
ticket triage, scope review, and PR sign-off responsibilities). Until
then, the role lives as a no-op stub: the runner ticks, skips
precheck, and the activity log gains nothing for the PO agent.

The PO role SHALL not be relied on for production work; it ships only
to demonstrate the orchestration server has zero compile-time
knowledge of any specific role.`;
