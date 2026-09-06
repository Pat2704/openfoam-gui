/**
 * Who is in front, among the floating panels.
 *
 * FOAMy, Claude and Codex are independent components that all float over the
 * app, and neither can know when the other was last used. With a fixed
 * `z-[100]` on everything, the winner was DOM order: opening FOAMy left the
 * Claude launcher sitting on top of its window, and the panel you had just
 * opened could end up behind the one you had not touched in an hour.
 *
 * So the stacking order lives here instead, as one counter shared by both:
 *
 *   - the launcher group sits below every window;
 *   - a window asks for the next value when it opens and whenever it is
 *     clicked, which puts the most recently used one in front — of the other
 *     window and of the launcher group.
 *
 * The counter only ever grows, which is fine: it is per page load, and a
 * session would need billions of clicks to reach anything a browser minds.
 */

/** The launcher group. Every window is above this. */
export const LAUNCHER_Z = 100;

let top = LAUNCHER_Z;

/** The next depth for a window that should be in front of everything else. */
export function bringToFront(): number {
  top += 1;
  return top;
}

/** True when this window is already the frontmost one — used to skip a re-render. */
export function isFront(z: number): boolean {
  return z === top;
}
