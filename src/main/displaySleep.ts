import { app, powerSaveBlocker, type BrowserWindow } from 'electron'
import { shouldStayAwake } from '@shared/wakeLock'

/**
 * Keeping the television on while somebody is using the pad.
 *
 * The problem is in `@shared/wakeLock`: a joystick is not seat input, so a
 * compositor's idle timer runs straight through a browsing session and blanks
 * the screen under someone who is halfway across the grid. Nothing on the host
 * fixes this for us — `joystickwake` and friends exist precisely because it is
 * every pad-driven application's own problem.
 *
 * `powerSaveBlocker` rather than the renderer's Screen Wake Lock API: a page
 * wake lock is held for as long as the document is visible, which on a launcher
 * that is always visible means forever. The policy wanted here is the opposite
 * of forever, and it belongs on the side of the bridge that already owns
 * everything privileged.
 *
 * **The inhibit is bounded, and that is deliberate.** On Linux this reaches
 * `org.freedesktop.ScreenSaver`, so while it is held the automatic lock is held
 * off too. `docs/wake-on-gamepad.md` refuses to disable the lock screen on the
 * grounds that a program which quietly does that is not one to trust; five
 * minutes that expire on their own, only while the launcher is in front, is a
 * different proposition, and this comment is the record of the distinction.
 */

/**
 * How often the claim is re-examined. Only the *release* needs this — a fresh
 * report acts immediately — so it is coarse on purpose: the display goes off up
 * to half a minute after the five are up, and nothing is watching the clock
 * that closely.
 */
const CHECK_INTERVAL_MS = 30_000

export interface DisplayWakeLock {
  /**
   * Called when the renderer reports pad input. Already throttled on that side
   * to one report per `PAD_ACTIVITY_PING_MS`.
   */
  padActivity(): void
}

export function createDisplayWakeLock(getWindow: () => BrowserWindow | null): DisplayWakeLock {
  let lastActivityAt: number | null = null
  let blocker: number | null = null

  /**
   * `Date.now()` rather than a monotonic clock: the only event that skews it
   * enough to matter is a suspend, and a resume makes the gap enormous, which
   * releases the inhibit. That is the safe direction to be wrong in.
   */
  const apply = (): void => {
    const window = getWindow()
    const wanted = shouldStayAwake({
      lastActivityAt,
      now: Date.now(),
      // `mainWindow` is never cleared, so this can be a destroyed window, and
      // calling into one throws.
      focused: window !== null && !window.isDestroyed() && window.isFocused()
    })

    if (wanted && blocker === null) {
      blocker = powerSaveBlocker.start('prevent-display-sleep')
    } else if (!wanted && blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
    }
  }

  // `unref` so a launcher on its way out is not held open by a timer whose only
  // job is to let go of something.
  setInterval(apply, CHECK_INTERVAL_MS).unref()

  // Losing focus is the one release that must not wait for that interval. The
  // claim is `!focused` the instant GeForce NOW takes the screen, and holding
  // `prevent-display-sleep` — which on Linux also defers the session lock — for
  // up to another half a minute over somebody else's fullscreen window is
  // exactly the behaviour `docs/wake-on-gamepad.md` refuses to have.
  //
  // It matters more now than it did: the renderer stops reporting pad activity
  // while it is not answering the pad, so nothing else would come along to
  // re-evaluate this. At the `app` level rather than on a window handle, so
  // there is no initialisation order between here and `createWindow` to get
  // wrong; `apply` re-reads the window either way.
  app.on('browser-window-blur', apply)
  app.on('browser-window-focus', apply)

  return {
    padActivity(): void {
      lastActivityAt = Date.now()
      apply()
    }
  }
}
