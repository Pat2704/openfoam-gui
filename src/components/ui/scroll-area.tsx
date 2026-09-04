"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A scrolling region — using the browser's own scrolling, not a simulated one.
 *
 * WHY THIS IS NOT RADIX ANY MORE
 * ------------------------------
 * This was `@radix-ui/react-scroll-area`, and it is what made scrolling feel
 * like it lagged behind the wheel in every panel. Two things were happening at
 * once, and the second is the one that hurt:
 *
 * 1. Radix hides the native scrollbar and draws its own thumb, positioning it
 *    from JavaScript on every scroll event. The browser scrolls the content on
 *    the compositor; the thumb is moved a frame later on the main thread. Under
 *    any load the two visibly disagree — which is exactly "the scrollbar does
 *    not follow the scroll".
 *
 * 2. Radix sets `overflow: scroll` on its viewport UNCONDITIONALLY. Measured in
 *    this app: the command list's viewport was 1448px tall around 1448px of
 *    content — it had nothing to scroll, because the panel had no bounded height
 *    and had simply grown. But it was still a scroll container, so a wheel event
 *    over it was routed there first, found nothing to move, and only then
 *    chained to the page. That hand-off is the stutter, and it happened over
 *    most of the window.
 *
 * Native `overflow-y: auto` fixes both. `auto` means an element with nothing to
 * scroll is NOT a scroll container at all, so there is no dead box in the way of
 * the wheel; and the scrollbar is the browser's, drawn by the compositor, so it
 * cannot fall behind the content by construction.
 *
 * Nothing is lost visually: the app already styles native scrollbars in
 * globals.css, and that styling now applies here too rather than being
 * suppressed. The component keeps the same name and the same props, so every
 * call site is unchanged.
 *
 * `overscroll-behavior: contain` is the one thing worth keeping from the old
 * behaviour: reaching the end of a file tree should not start scrolling the page
 * behind it.
 */
function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="scroll-area"
      className={cn("relative overflow-y-auto overscroll-contain", className)}
      {...props}
    >
      {children}
    </div>
  )
}

/**
 * Kept so the module's exports do not change shape.
 *
 * Radix needed an explicit scrollbar element; the browser does not. Rendering
 * nothing is correct — a caller that includes one still compiles, and still
 * gets a scrollbar, because the scroll container above draws its own.
 */
function ScrollBar(_props: React.ComponentProps<"div">) {
  return null
}

export { ScrollArea, ScrollBar }
