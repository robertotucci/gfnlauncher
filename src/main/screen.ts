import type { BrowserWindow } from 'electron'
import { SCREEN_OURS, type ScreenOwnership } from '@shared/input'
import { IPC } from '@shared/ipc'

/**
 * Who has the screen, told to the renderer so it knows whether to answer the pad.
 *
 * The renderer has to gate input on something, because Chromium does not do it
 * for us — see `@shared/input` for the invariant that turned out to be false and
 * the bug it produced. But it cannot decide alone: from inside the window,
 * "GeForce NOW is streaming fullscreen on top of me" and "a notification took
 * the focus for a moment" are the same event, and they want opposite answers.
 *
 * Main is the side that knows, because main is the side that started the thing
 * in front. So this module owns the one fact the renderer is missing and pushes
 * it across whenever it changes.
 *
 * **`handedOff` is a latch, and latches are the risk here.** Stuck on, it would
 * be a launcher that ignores the pad — the worst failure this product has, and
 * on a television an unrecoverable one. Three things keep that from happening,
 * and none of them should be removed:
 *
 * - `shouldAcceptInput` accepts *anything* while the window has focus, so the
 *   latch can never gag a launcher the user is actually looking at and using.
 * - Every setter is paired at its call site in `ipc.ts`, and `armHandback`'s
 *   `onEnded` releases it however the session watch ends — including the ways
 *   that are not "the client went away".
 * - The renderer starts from `SCREEN_OURS`, so a push that never arrives costs
 *   correctness rather than control.
 */

let target: BrowserWindow | null = null
let handedOff = false
/** The last value pushed, so only changes are sent and only changes are logged. */
let sent: ScreenOwnership | null = null

function current(): ScreenOwnership {
  if (!target || target.isDestroyed()) return SCREEN_OURS
  return { minimised: target.isMinimized(), handedOff }
}

function push(reason: string): void {
  const next = current()
  if (sent && sent.minimised === next.minimised && sent.handedOff === next.handedOff) return
  sent = next

  // One line per transition, not per event: the window emits `show` and
  // `restore` together on some compositors, and this is a file somebody has to
  // be able to skim. The pair of it and the renderer's own "Pad input
  // suspended/resumed" is what makes a report about stray input readable.
  console.info(
    `Screen ownership: minimised=${next.minimised} handedOff=${next.handedOff} (${reason})`
  )

  if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
    target.webContents.send(IPC.appScreen, next)
  }
}

/**
 * Whether something else is in front and is not going away on its own: the
 * GeForce NOW client, our own web-stream window, or the sign-in window.
 *
 * Idempotent, so a path that releases twice — a failed launch whose watch was
 * never armed, then a disarm on the next one — costs nothing.
 */
export function setHandedOff(next: boolean, reason: string): void {
  if (handedOff === next) return
  handedOff = next
  push(reason)
}

/**
 * Attached once, from `createWindow`, beside `holdFullscreen` and for the same
 * kind of reason: these are things the launcher has to notice about its own
 * window whether or not they came from this process. A click on the taskbar
 * never reaches main as a request, only as an event.
 */
export function attachScreenReporting(window: BrowserWindow): void {
  target = window

  // `hide`/`show` as well as `minimize`/`restore`, because the two packaged
  // forms do not agree on which arrives — the same asymmetry `holdFullscreen`
  // documents. Either way the answer comes from `isMinimized()`, read fresh.
  window.on('minimize', () => push('window minimised'))
  window.on('restore', () => push('window restored'))
  window.on('hide', () => push('window hidden'))
  window.on('show', () => push('window shown'))

  // Re-sent on every load rather than only the first. A renderer reloaded after
  // `render-process-gone` — which can happen in the middle of a game — comes
  // back with no idea that anything is in front of it, and would then drive the
  // UI behind the stream exactly as before the fix.
  window.webContents.on('did-finish-load', () => {
    sent = null
    push('renderer loaded')
  })
}
