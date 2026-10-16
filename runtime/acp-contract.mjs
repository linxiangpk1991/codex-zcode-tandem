// acp-contract.mjs — pinned upstream contract facts, one owner.
//
// The exact zcode-acp-server version lock and the session-mode vocabulary it
// accepts are contract facts, not tunables: identity checks, setup diagnosis
// and request validation all import them from here so they cannot drift.
// Verified against the installed dist (read-only), not guessed from docs:
//   - session modes: plan/build/edit/guarded/yolo/auto (guarded is new in
//     backend 3.15.1; "auto" stays wire-valid but is not advertised);
//   - upstream 0.72.0 retries session/create WITHOUT the mode key when a
//     pre-3.15 backend rejects "guarded" (strict zod enum), silently leaving
//     the backend default active — so an effective-mode divergence must fail
//     the invocation, never pass as cosmetic.

/** The only zcode-acp-server version this tree is validated against. */
export const PINNED_ACP_VERSION = '0.72.0';

/** Session modes the isolated ACP config may pin (upstream SESSION_MODES). */
export const ISOLATED_SESSION_MODES = Object.freeze(['plan', 'build', 'edit', 'guarded', 'yolo', 'auto']);

/**
 * Modes whose upstream permission behavior auto-allows ordinary tools, so
 * permission callbacks mostly do not fire and the workspace checks for those
 * tools degrade to post-hoc observation. Explicit request opt-in only; the
 * default mode is and stays `build`. The workspace policy itself is never
 * disabled by a mode.
 */
export const AUTO_ALLOW_MODES = Object.freeze(['guarded', 'yolo', 'auto']);

export function isAutoAllowMode(mode) {
  return AUTO_ALLOW_MODES.includes(mode);
}

/** Error text for an effective-mode readback that differs from the request. */
export function modeMismatchError(requested, effective) {
  const base = `mode selection mismatch: requested ${requested ?? 'none'}, effective ${effective ?? 'none'}`;
  if (requested === 'guarded') {
    return `${base}. Upstream ${PINNED_ACP_VERSION} silently retries session/create without the mode when a backend rejects "guarded" (pre-3.15 strict enum), leaving the backend default active; refusing to continue under an unrequested mode`;
  }
  return base;
}
