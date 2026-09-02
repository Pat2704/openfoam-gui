'use client';

/**
 * The host for sonner's toasts.
 *
 * It has to be a CLIENT component, and that is the whole reason this file
 * exists. A dozen components across the app call sonner's `toast()`, which
 * writes to a module-level store; if `<Toaster />` is imported straight into
 * the root layout — a server component — it is instantiated through a separate
 * module graph and ends up watching a DIFFERENT store than the one those calls
 * write to. The host renders, stays empty, and every message in the app is
 * silently dropped. That is what was happening: the panel reported "Claude Code
 * is not installed on this machine" when sign-in failed, and the user saw
 * nothing happen at all.
 *
 * Importing it from here puts the Toaster in the same client bundle as the
 * `toast()` callers, which is the whole fix.
 */

import { Toaster } from 'sonner';
// Sonner does NOT inject its own stylesheet, and nothing else imported it. A
// toast without it is not merely unstyled: the enter animation never runs, so
// the element is mounted at `opacity: 0`, translated 73 px down, and removed a
// few seconds later — present in the DOM, measurable, and invisible. That is
// the second half of why pressing "Sign in" looked like it did nothing.
import 'sonner/dist/styles.css';

export function SonnerToaster() {
  return (
    <Toaster
      position="bottom-right"
      richColors
      closeButton
      // Above the floating FOAMy and Claude panels, which start at 100.
      style={{ zIndex: 2000 }}
    />
  );
}
