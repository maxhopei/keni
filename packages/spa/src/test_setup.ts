// Import this file FIRST in every `*_test.tsx` file in the SPA package so the
// `@happy-dom/global-registrator` installs `window`, `document`, and the rest
// of the DOM globals onto Deno's `globalThis` before `@testing-library/react`
// (or any component import) reaches for them.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}
