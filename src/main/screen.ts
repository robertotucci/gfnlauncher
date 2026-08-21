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
/** Told about the same transitions, in main. See `watchScreenOwnership`. */
const watchers: (() => void)[] = []

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

  // After the renderer, and never allowed to stop it being told: a throw in a
  // watcher must not turn "a game started" into a launcher that never heard.
  for (const watcher of watchers) {
    try {
      watcher()
    } catch (error) {
      console.warn('A screen-ownership watcher threw:', error)
    }
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
 * The same fact the renderer is pushed, for a caller inside main.
 *
 * One consumer: `notify.ts`, which has to decide whether a notice can be drawn
 * in the launcher's own window or needs the overlay that draws over whatever is
 * in front. It reads the fact and never sets it — the setters stay paired at
 * their call sites in `ipc.ts`, which is what keeps the latch from sticking.
 *
 * Note that `focused` is deliberately absent here as it is from
 * `ScreenOwnership` itself: an unfocused launcher with nothing in front of it
 * is still the thing on screen, and drawing its notices in an overlay would be
 * conjuring a window over a window somebody is looking at.
 */
export function screenOwnership(): ScreenOwnership {
  return current()
}

/**
 * The same transitions, for a caller inside main.
 *
 * One consumer, and it is not an optimisation. `notify.ts` picks a surface per
 * notice from the value above, and a notice is on screen for three and a half
 * seconds — long enough for a game to start underneath it. Without this the
 * card would stay painted on a window that has just gone behind a stream and
 * come back into view whole when the game ends, because nothing else would ask
 * again until its own timer next fired.
 *
 * Registration only; there is no way to stop watching, because the one watcher
 * is armed for the life of the process alongside the window it draws into.
 */
export function watchScreenOwnership(listener: () => void): void {
  watchers.push(listener)
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
