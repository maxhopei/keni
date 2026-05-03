/**
 * Prototype-only UI feature flags.
 *
 * Flipping a flag here is a code change — there is no env-var, query-string,
 * or localStorage override. The single seam exists so future SPA steps
 * (chat panel in step 23, etc.) can flip a single boolean rather than
 * scatter feature flags across the codebase.
 */
export const prototypeFlags = Object.freeze({
  /**
   * Right-region chat slot. Hidden in the prototype; step 23 flips this to
   * `true` when the chat panel component lands.
   */
  chatPanelEnabled: false,
});
