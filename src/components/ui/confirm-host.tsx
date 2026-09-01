"use client"

/**
 * In-page replacement for window.confirm().
 *
 * WHY THIS EXISTS — do not go back to window.confirm() in this app.
 *
 * window.confirm() opens a NATIVE modal dialog. Under Electron that dialog
 * takes native focus away from the BrowserWindow, and when it closes Chromium
 * frequently fails to hand keyboard focus back to the page: the window still
 * looks focused, but text inputs stop accepting keystrokes. The only way out
 * is a real window focus event — which is why clicking on another app and back
 * "unfreezes" typing (that path hits the refocus handlers in electron/main.js).
 *
 * It bites right after pressing a destructive/execution button because those
 * are exactly the buttons that used to call confirm().
 *
 * This is invisible in a browser (`npm run dev`), where confirm() is just a
 * tab-modal overlay and focus returns normally. It only shows up in the
 * packaged app.
 *
 * Usage — same ergonomics as confirm(), but async:
 *
 *   if (!(await confirmDialog(`Delete "${name}"?`, {
 *     title: 'Delete case', confirmLabel: 'Delete',
 *   }))) return;
 *
 * <ConfirmHost /> is mounted once in src/app/layout.tsx.
 */

import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export type ConfirmOptions = {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Styles the confirm button as destructive. Defaults to true. */
  destructive?: boolean
}

type PendingConfirm = {
  message: string
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

// Module-level queue so confirmDialog() can be called from anywhere, including
// plain event handlers that have no access to React context.
const queue: PendingConfirm[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function ConfirmHost() {
  const [, forceRender] = React.useState(0)

  React.useEffect(() => {
    const listener = () => forceRender((n) => n + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const current = queue[0] || null

  // Radix animates the dialog out, and during that ~150ms `current` is already
  // null — the fallback title with an empty body, so the box the user just
  // answered flashes blank as it fades. Hold on to the answered entry for the
  // exit; `open` still follows `current`, so nothing stays interactive.
  const [closing, setClosing] = React.useState<PendingConfirm | null>(null)
  const shown = current ?? closing

  const settle = React.useCallback((value: boolean) => {
    const entry = queue.shift()
    setClosing(entry ?? null)
    if (entry) entry.resolve(value)
    notify()
  }, [])

  return (
    <AlertDialog
      open={current !== null}
      onOpenChange={(open) => {
        // Esc / overlay click resolve as "cancel".
        if (!open) settle(false)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.options.title ?? "Confirm"}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap">
            {shown?.message ?? ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {shown?.options.cancelLabel ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            className={
              shown?.options.destructive === false
                ? undefined
                : "bg-destructive text-white hover:bg-destructive/90"
            }
            onClick={() => settle(true)}
          >
            {shown?.options.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function confirmDialog(
  message: string,
  options: ConfirmOptions = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ message, options, resolve })
    notify()
  })
}
