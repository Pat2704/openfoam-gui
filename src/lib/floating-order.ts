/**
 * Who is in front, among the floating panels.
 *
 * FOAMy and Claude are two independent components that both float over the
 * app, and neither can know when the other was last used. With a fixed
 * `z-[100]` on everything, the winner was DOM order: opening FOAMy left the
 * Claude launcher sitting on top of its window, and the panel you had just
 * opened could end up behind the one you had not touched in an hour.
 *
 * So the stacking order lives here instead, as one counter shared by both:
 *
 *   - the two launchers sit at the SAME depth, always, so neither button can
 *     hide the other;
 *   - a window asks for the next value when it opens and whenever it is
 *     clicked, which puts the most recently used one in front — of the other
 *     window and of both launchers.
 *
 * The counter only ever grows, which is fine: it is per page load, and a
 * session would need billions of clicks to reach anything a browser minds.
 */

/** Both launchers. Every window is above this. */
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
