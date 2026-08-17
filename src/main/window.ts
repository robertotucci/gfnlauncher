import { once } from 'node:events'
import type { BrowserWindow } from 'electron'
import { getSettings } from './settings'

/**
 * The two things the launcher ever does to its own window: get out of the way,
 * and come back.
 *
 * They live here rather than in `ipc.ts` because coming back has four callers
 * now — `ready-to-show`, `second-instance`, the web-stream window closing, and
 * the session watch reporting that the GeForce NOW client is gone — and three
 * of them used to carry their own copy of the sequence. Two copies of a rule
 * diverge and only one of them gets fixed; four would be worse.
 *
 * `holdFullscreen` is the third thing, and it exists because the first two do
 * not cover the way back the *window manager* offers: a click in the taskbar.
 */

/**
 * How long to wait for an un-iconify to actually land.
 *
 * `restore()` is a request, not a state change, and everything after it in
 * `restoreLauncher` is dropped by the window manager while the surface is still
 * minimised — `setFullScreen` in particular. The old callers only got away with
 * following it immediately because an `await getSettings()` happened to sit in
 * between; this makes the wait deliberate. The timeout is what stops it hanging
 * on a compositor that honours the request without emitting the event.
 */
const RESTORE_SETTLE_MS = 400

/**
 * Gets the launcher off the screen without closing it.
 *
 * **Fullscreen first, then minimise.** On Linux `minimize()` is a request to the
 * window manager, and a good many of them — plus Wayland compositors, where
 * `set_minimized` is explicitly a hint — ignore an iconify request aimed at a
 * fullscreen surface. Dropping fullscreen makes it an ordinary window first, so
 * the request is one the compositor will honour. The failure it avoids is
 * silent: the launcher simply stays on top of whatever it was stepping aside
 * for.
 *
 * Two callers, and no third: "Back to desktop" (`app:minimize`), whose whole
 * purpose is to iconify, and `gfn:open`, which hands the screen to the real
 * client on purpose. **Launching a game deliberately does not come through
 * here** — see the `gfn:launch` handler.
 *
 * `hide()` was considered instead of `minimize()`, because a hidden window's
 * `show()` is an unambiguous surface map and therefore more reliable under
 * Wayland than un-minimising. It is rejected: a hidden window is in no taskbar
 * and no alt-tab, and `second-instance` keys on `isMinimized()`. The failure
 * policy everywhere here is "degrade to the status quo ante", and `hide()`
 * degrades to something worse than it — a launcher with no way back at all, on
 * a machine with no keyboard.
 */
export function stepAside(window: BrowserWindow | null): void {
  // `mainWindow` is never cleared, so this can be handed a destroyed window;
  // calling into one throws.
  if (!window || window.isDestroyed()) return
  console.info('Stepping aside: dropping fullscreen, then minimising.')
  if (window.isFullScreen()) window.setFullScreen(false)
  window.minimize()
}

/**
 * Puts the window back to the size the user asked for.
 *
 * Only ever *enters* fullscreen, never leaves it: `Settings.fullscreen` means
 * "come up fullscreen", and someone who has hit F11 on a keyboard has said
 * something more recent than a setting. Idempotent, so every caller below can
 * fire it without checking whether another already has.
 */
async function applyFullscreen(window: BrowserWindow | null): Promise<void> {
  if (!window || window.isDestroyed()) return
  if (window.isFullScreen()) return
  if (!(await getSettings()).fullscreen) return
  // The await above can outlive the window on a quit racing a restore.
  if (window.isDestroyed()) return
  window.setFullScreen(true)
}

/**
 * Sets fullscreen from the Settings toggle, in both directions.
 *
 * Applied the moment the row is confirmed rather than at the next start, for
 * the same reason `applyUiScale` is: the cursor is sitting on the control, and
 * a size control nobody can see the effect of is a control nobody can judge.
 *
 * It is also the *only* way back to fullscreen that a gamepad can reach. There
 * is no F11 on a sofa, so without this a launcher that ended up windowed for
 * any reason would stay windowed for good.
 */
export function setFullscreen(window: BrowserWindow | null, fullscreen: boolean): void {
  if (!window || window.isDestroyed()) return
  if (window.isFullScreen() === fullscreen) return
  window.setFullScreen(fullscreen)
}

/**
 * Re-asserts fullscreen every time the window comes back into view.
 *
 * `stepAside` **drops fullscreen before minimising**, because an iconify request
 * aimed at a fullscreen surface is one many window managers ignore. That leaves
 * a windowed launcher behind, and `restoreLauncher` puts fullscreen back — but
 * only on the three ways back that go through this process. The fourth does
 * not: clicking the launcher in the taskbar is entirely between the user and
 * the compositor, so the window simply reappeared at 1600x900, and with no
 * keyboard in the room there was then no way to make it fullscreen again. The
 * launcher was a desktop app from that moment on.
 *
 * Both events, because the two packaged forms do not agree on which one arrives:
 * un-iconifying emits `restore`, and a surface Chromium re-presents under
 * Wayland emits `show`. Firing both is free — `applyFullscreen` is idempotent.
 *
 * Attached once, in `createWindow`, and never removed: the window outlives
 * every caller here.
 */
export function holdFullscreen(window: BrowserWindow): void {
  const reapply = (): void => void applyFullscreen(window)
  window.on('restore', reapply)
  window.on('show', reapply)
}

/**
 * Brings the launcher back after something else had the screen.
 *
 * ── Why this is a sequence and not a `focus()` ──────────────────────────────
 *
 * On X11 `focus()` is the whole answer. Under Wayland it is a request the
 * compositor may refuse: raising and focusing needs an xdg-activation token,
 * only the client currently holding input can mint one, Electron exposes no way
 * to carry it, and KWin's focus-stealing prevention declines without it. So the
 * steps below are ordered cheapest-and-most-portable first and each is
 * annotated with where it actually does something. None of them is guaranteed;
 * between them they cover every session this launcher runs in.
 *
 * Working in their favour: when the window that had the screen disappears, the
 * compositor has to give focus to *something*, and on a television the launcher
 * is usually the only other window. The common case tends to resolve itself and
 * this sequence is what covers the rest.
 *
 * Getting it wrong is not cosmetic — the Gamepad API only reports to a focused
 * window, so a launcher that comes back unfocused is a launcher with no input.
 */
export async function restoreLauncher(window: BrowserWindow | null): Promise<void> {
  if (!window || window.isDestroyed()) return

  // Already in front. The user alt-tabbed back before whatever we were waiting
  // on went away, and re-asserting fullscreen here would overrule a choice they
  // just made by hand.
  if (window.isFocused() && !window.isMinimized()) return

  // Every step below is a *request* a compositor may decline, so the outcome is
  // recorded either side of the sequence. "The launcher did not come back after
  // a game" is the single most-reported behaviour this codebase has, and the
  // pair of lines is what says whether it asked and was refused or never asked.
  console.info(
    `Restoring the launcher: minimised=${window.isMinimized()} visible=${window.isVisible()} ` +
      `focused=${window.isFocused()}`
  )

  // 1. Un-iconify first, and wait for it. See `RESTORE_SETTLE_MS`.
  if (window.isMinimized()) {
    // Through an `AbortSignal` so the listener is dropped when the wait times
    // out rather than left on the window. Without it, a compositor that honours
    // `restore()` without emitting the event leaks one listener per attempt,
    // and the eleventh prints a MaxListenersExceededWarning that reads like a
    // bug somewhere else entirely.
    const abort = new AbortController()
    const restored = once(window, 'restore', { signal: abort.signal }).catch(() => undefined)
    window.restore()
    await Promise.race([restored, delay(RESTORE_SETTLE_MS)])
    abort.abort()
  }

  // 2. `show()` as well as `restore()`. xdg-shell has `set_minimized` and no
  //    inverse, so under Wayland Chromium comes back by re-presenting the
  //    surface — and mapping a surface is the one moment a compositor will show
  //    and focus a window without an activation token. Redundant on X11.
  if (!window.isVisible()) window.show()

  // 3. Fullscreen from settings, never from remembered state. Without it a
  //    window restored from the taskbar comes back at 1600x900 and the launcher
  //    is a desktop app from then on. `holdFullscreen` covers the restores that
  //    never reach this function; this covers the ones that do, in the right
  //    order — after the un-iconify has landed, before the raise.
  await applyFullscreen(window)

  // 4. Raise. **X11 only**, and kept because the AppImage and the .deb run on
  //    X11 sessions too: `setAlwaysOnTop` is `_NET_WM_STATE_ABOVE` there and has
  //    no Wayland equivalent — an ordinary xdg_toplevel cannot order itself
  //    above its peers — and `moveTop()` is likewise a no-op under Wayland.
  //    Transient on purpose: left on, the launcher would sit over the GeForce
  //    NOW window on the next launch, which is the bug `stepAside` exists for.
  window.setAlwaysOnTop(true)
  window.moveTop()
  window.setAlwaysOnTop(false)

  // 5. Focus last, and the step most likely to be refused. Still worth making:
  //    it is the entire answer on X11.
  window.focus()

  // Read back rather than assumed. `focused=false` here is the compositor
  // having declined, which is the whole Wayland problem written down — and it
  // is exactly the line that distinguishes it from the launcher never having
  // been asked to come back at all.
  if (!window.isDestroyed()) {
    console.info(
      `Restore requested: visible=${window.isVisible()} focused=${window.isFocused()} ` +
        `fullscreen=${window.isFullScreen()}`
    )
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
