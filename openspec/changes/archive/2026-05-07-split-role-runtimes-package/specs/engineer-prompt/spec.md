## MODIFIED Requirements

### Requirement: The engineer prompt is a TypeScript string constant exported from `packages/runtime-engineer/src/prompts/engineer.ts`

The package SHALL export, from `packages/runtime-engineer/src/prompts/engineer.ts`, two constants: `export const ENGINEER_PROMPT_NAME = "engineer" as const` and `export const ENGINEER_PROMPT_BODY: string`. Both SHALL be re-exported from `packages/runtime-engineer/src/main.ts` so downstream consumers and `/opsx:verify` test fixtures can import them via `import { ENGINEER_PROMPT_BODY, ENGINEER_PROMPT_NAME } from "@keni/runtime-engineer"`. The body SHALL be a single literal (no template interpolation, no concatenation from environment variables, no runtime assembly) so the value at module load time is identical across every server invocation. The body SHALL be at least 500 characters and at most 8 KB (a soft ceiling that keeps the prompt comfortably under typical coding-agent context budgets and rejects accidental empty or unbounded growth).

The legacy import specifier `@keni/role-runtimes` (and the legacy source path `packages/role-runtimes/src/engineer/prompts/engineer.ts`) SHALL no longer resolve these symbols; every consumer SHALL update to `@keni/runtime-engineer`.

#### Scenario: Both constants are importable from `@keni/runtime-engineer`

- **WHEN** a consumer writes `import { ENGINEER_PROMPT_NAME, ENGINEER_PROMPT_BODY } from "@keni/runtime-engineer"`
- **THEN** both names resolve without error
- **AND** `ENGINEER_PROMPT_NAME` is the string literal `"engineer"`
- **AND** `ENGINEER_PROMPT_BODY` is a non-empty string

#### Scenario: The body is a single string literal, not a template

- **WHEN** the source file `packages/runtime-engineer/src/prompts/engineer.ts` is inspected
- **THEN** `ENGINEER_PROMPT_BODY` is declared as a `const` initialised with a string literal (template literal allowed *only* if it contains no `${...}` interpolations)
- **AND** no `Deno.env.get(...)` call appears in the file
- **AND** no `Deno.readTextFile` or `Deno.readFile` call appears in the file
- **AND** no `import.meta.resolve` call appears in the file

#### Scenario: The body length is within the documented bounds

- **WHEN** `ENGINEER_PROMPT_BODY.length` is read at module load time
- **THEN** the value is greater than or equal to 500
- **AND** the value is less than or equal to 8192 (8 KB)

#### Scenario: The legacy `@keni/role-runtimes` specifier no longer resolves the prompt constants

- **WHEN** the workspace is searched for `import { ENGINEER_PROMPT_BODY` or `import { ENGINEER_PROMPT_NAME` followed by `from "@keni/role-runtimes"`
- **THEN** zero occurrences are found in any production source file or test file
- **AND** every existing consumer has been updated to import from `@keni/runtime-engineer`
