import { join } from 'node:path'
import { BrowserWindow, screen, type Rectangle } from 'electron'
import { IPC } from '@shared/ipc'
import {
  NOTICE_MAX,
  NOTICE_MS,
  type Announcement,
  type Notice,
  noticeContent,
  stepNotices
} from '@shared/notify'
import { scaleValue } from '@shared/theme'
import { DESKTOP } from './desktop'
import { screenOwnership, watchScreenOwnership } from './screen'
import { getSettings } from './settings'
import { applyUiScale } from './uiScale'

/**
 * The notice queue, and the window that draws it when the launcher cannot.
 *
 * ── Two surfaces, one component ─────────────────────────────────────────────
 *
 * A notice is feedback about something main decided — so far, a pointer-mode
 * chord read off `/dev/input/js*`. The launcher's own renderer draws it
 * whenever the launcher is the thing on screen, which is the common case and
 * costs nothing: no window, no compositor, no per-desktop behaviour.
 *
 * The other case is the one the feature exists for. Pointer mode is *for* a
 * game that is streaming, a minimised launcher, and NVIDIA's sign-in page — and
 * in all three the launcher is `handedOff` or iconified and nothing it draws is
 * on screen. That needs a window of our own, over the top, and that window is
 * the only part of this that depends on the compositor.
 *
 * `screen.ts` already owns the fact that decides between them, so this reads it
 * rather than inventing a second answer.
 *
 * ── Why the launcher's own preload, and not a fourth one ────────────────────
 *
 * The overlay page is ours, carries the same `default-src 'self'` CSP as
 * `index.html`, and therefore sits at the same trust level as the launcher
 * page. Reusing `preload/index.cjs` means both surfaces subscribe through the
 * identical bridge method and render the identical component — and it avoids a
 * fourth preload, which CONTRIBUTING.md names as the standing risk here: a
 * sandboxed preload's `require` resolves almost nothing, so two entries sharing
 * one runtime import become a chunk that kills *every* preload at load.
 *
 * ── Everything here degrades to "no notice" ─────────────────────────────────
 *
 * Nothing waits on a notice and nothing is gated by one. A compositor that
 * refuses to raise this window costs the user a sentence they would have liked,
 * and costs the launcher nothing at all. That is the property that makes it
 * acceptable to ship one window across four compositors we cannot all test, and
 * it is the thing to preserve if this grows.
 */

/**
 * The overlay's size on X11, in CSS pixels before the interface scale.
 *
 * Derived from the card rather than guessed: `NoticeStack` is `w-[26rem]` at a
 * 20px root, so 520px, plus its `right-6`/`top-6` gutters, plus room for
 * `NOTICE_MAX` of them stacked with `gap-3`. Generous on purpose — the window
 * is transparent and click-through, so the slack is invisible, whereas a card
 * clipped by a window an inch too small is the failure this sizing exists to
 * avoid.
 */
const NOTICE_WINDOW = { width: 600, height: 140 * NOTICE_MAX + 48 } as const

/**
 * Where the overlay goes on a desktop that lets a client place its own window.
 *
 * Pure, and a function with a test for the reason every constructed argv in
 * this repository is: it decides whether an entire class of desktop shows a
 * card or a clipped corner, and nothing about that is visible from the machine
 * this was written on.
 *
 * The **work area**, not the display bounds. A top-right corner measured from
 * the output puts the card under a top panel on GNOME-on-Xorg and under a
 * right-hand one on the Xfce and MATE layouts that use one, and the compose
 * keyboard already paid for that mistake at the other edge of the screen.
 */
export function noticeBounds(workArea: Rectangle, zoom: number): Rectangle {
  const width = Math.min(Math.round(NOTICE_WINDOW.width * zoom), workArea.width)
  const height = Math.min(Math.round(NOTICE_WINDOW.height * zoom), workArea.height)

  return { x: workArea.x + workArea.width - width, y: workArea.y, width, height }
}

/**
 * Which shape the overlay has to be, decided by the session protocol.
 *
 * **Not by the desktop.** `desktop.ts` forbids branching on `DESKTOP.id`, and
 * that rule is kept — nothing here reads the desktop's name. What this reads is
 * a capability the protocol either has or does not, the same one
 * `restoreLauncher` writes "X11 only" against:
 *
 * - **X11** can place a window (EWMH), order it above its peers
 *   (`_NET_WM_STATE_ABOVE`), and declare it a notification
 *   (`_NET_WM_WINDOW_TYPE_NOTIFICATION`) — which every EWMH window manager
 *   reads as "above, never focused, not in the taskbar". So Xfce, MATE, LXQt,
 *   Cinnamon, Openbox and both GNOME and KDE on Xorg get a small placed window
 *   with no focus theft to accept at all, and no second fullscreen surface over
 *   a fullscreen game to break the compositor's unredirection with.
 * - **Wayland** can do none of the three. `xdg_toplevel` has no placement —
 *   `0,0` is a fiction, as the compose window measured the hard way — and
 *   `setAlwaysOnTop` is a documented no-op. `set_fullscreen` is the only
 *   request in the protocol that maps a surface onto one whole output at a
 *   known origin, so the window *is* the screen, transparent, and the
 *   stylesheet puts the card in the corner. That is the same trick that anchors
 *   the on-screen keyboard to the bottom edge, and the one layout authority
 *   that needs nobody's permission.
 *
 * `unknown` takes the Wayland route, on which mistake is survivable: a
 * fullscreen window is legal on X11 and merely wasteful, whereas a placed
 * window on Wayland lands wherever the compositor felt like. That also covers
 * an XWayland run inside a Wayland session.
 */
function placeable(): boolean {
  return DESKTOP.session === 'x11'
}

let getMainWindow: () => BrowserWindow | null = () => null
let live: Notice[] = []
let nextId = 1
let timer: NodeJS.Timeout | null = null

let overlay: BrowserWindow | null = null
let overlayReady = false
let overlayShown = false
/** The interface scale, cached because the reveal path cannot await a read. */
let zoom = 1

export function armNotices(getWindow: () => BrowserWindow | null): void {
  getMainWindow = getWindow

  // A notice outlives a launch. `setHandedOff` fires before `killGfn`, and a
  // card raised a second earlier would otherwise sit on a window that has just
  // gone behind a stream — and reappear whole when the game ends, because
  // nothing would ask again until its own deadline.
  watchScreenOwnership(paint)
}

/**
 * Say something.
 *
 * The only entry point, and deliberately an *event* rather than a sentence: the
 * copy lives in `@shared/notify` where it is unit-tested, and a caller that
 * could pass its own wording is a caller that will eventually pass wording
 * nobody proofread at three metres.
 */
export function notify(what: Announcement): void {
  const notice: Notice = {
    id: nextId++,
    ...noticeContent(what),
    leaving: false,
    dueAt: Date.now() + NOTICE_MS
  }

  apply(stepNotices(live, { kind: 'show', notice }, Date.now()))
}

export function disarmNotices(): void {
  if (timer) clearTimeout(timer)
  timer = null
  live = []

  if (overlay && !overlay.isDestroyed()) overlay.destroy()
  overlay = null
  overlayReady = false
  overlayShown = false
}

function tick(): void {
  timer = null
  apply(stepNotices(live, { kind: 'tick' }, Date.now()))
}

function apply(step: ReturnType<typeof stepNotices>): void {
  live = step.next

  if (timer) clearTimeout(timer)
  timer = null

  if (step.dueAt !== null) {
    // Floored at a frame rather than at zero: a deadline already in the past
    // would otherwise re-enter through a zero-delay timer on every tick.
    timer = setTimeout(tick, Math.max(16, step.dueAt - Date.now()))
    timer.unref?.()
  }

  paint()
}

/**
 * Puts the list in front of exactly one surface, and empties the other.
 *
 * The empty push is not tidiness. A notice that was routed to the launcher and
 * then had a game start on top of it would otherwise stay painted on a window
 * nobody can see, and come back into view whole when the game ends.
 */
function paint(): void {
  // **Nothing this module does may take down its caller**, and the callers are
  // the reason: `notify()` is reached from inside a D-Bus signal handler in
  // `bluetooth/index.ts` and from an `fs.watch` settle in `inputWatch.ts`. A
  // throw in the first would break the mirror that the Devices screen and every
  // pairing depend on, and in the second it is an unhandled exception in a
  // timer, which ends the main process. Both would be the launcher falling over
  // because it could not draw a card about a headset — the wrong way round, so
  // this is loud in the log and silent everywhere else.
  try {
    const { minimised, handedOff } = screenOwnership()
    const overlaid = minimised || handedOff

    send(getMainWindow(), overlaid ? [] : live)
    paintOverlay(overlaid ? live : [])
  } catch (error) {
    console.error('A notice could not be drawn:', error)
  }
}

function send(window: BrowserWindow | null, notices: readonly Notice[]): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(IPC.notice, notices)
}

function paintOverlay(notices: readonly Notice[]): void {
  // Never built for an empty list: the overlay exists for the handed-off case,
  // and most sessions never reach it. Nothing is created until the first notice
  // that actually needs one, and it is then kept for the rest of the run —
  // paying the window's load time once rather than on every chord.
  if (notices.length === 0 && !overlay) return

  const window = ensureOverlay()
  if (!window || window.isDestroyed()) return

  send(window, notices)
  if (!overlayReady) return

  if (notices.length === 0) {
    if (window.isVisible()) window.hide()
    return
  }

  reveal(window)
}

function reveal(window: BrowserWindow): void {
  if (placeable()) {
    // Recomputed per reveal rather than at creation: a panel can be moved, a
    // display added, and the interface scale changed, all while the launcher is
    // sitting behind a game.
    window.setBounds(noticeBounds(screen.getPrimaryDisplay().workArea, zoom))
  }

  // `showInactive` rather than `show`, which is the whole of the request being
  // made here: draw over what is in front without becoming what is in front.
  // On X11 the window type already guarantees it. On Wayland it is a request
  // the compositor may decline in either direction — KWin takes the focus
  // anyway, which for a card that lives three and a half seconds is a blip
  // rather than the fault it would be for a keyboard.
  if (!window.isVisible()) window.showInactive()

  if (overlayShown) return
  overlayShown = true

  const view = window.getContentBounds()
  console.info(
    `Notice overlay opened [${DESKTOP.session}, ${placeable() ? 'placed' : 'fullscreen'}]: ` +
      `${view.width}x${view.height} at ${view.x},${view.y}, zoom ${window.webContents.getZoomFactor()}`
  )
}

function ensureOverlay(): BrowserWindow | null {
  if (overlay && !overlay.isDestroyed()) return overlay

  const area = screen.getPrimaryDisplay().workArea
  const placed = placeable()
  const bounds = placed ? noticeBounds(area, zoom) : screen.getPrimaryDisplay().bounds

  overlay = new BrowserWindow({
    ...bounds,
    frame: false,
    // The two routes differ in exactly this, and in the window type below.
    fullscreen: !placed,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    // Honoured on X11, where it is what keeps the focus off this window
    // entirely; there is no equivalent to ask for on Wayland.
    ...(placed ? { type: 'notification' as const } : {}),
    // Belt to the window type's braces, and the only thing asking on Wayland.
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // The card's own animation is the compositor's, but the *list* it draws
      // comes from a timer in main — and this window is unfocused by design and
      // frequently occluded, which is precisely what Chromium throttles.
      backgroundThrottling: false
    }
  })

  overlayReady = false
  overlayShown = false

  // Ignored on X11, where the window type already says it, and load-bearing on
  // Wayland: a transparent surface over a stream that swallowed clicks would
  // break the very cursor the first notice announces. CSS `pointer-events:none`
  // is the other half and does not reach this far — Electron receives the event
  // either way; this is what stops the compositor from delivering it.
  overlay.setIgnoreMouseEvents(true)
  overlay.setAlwaysOnTop(true, 'screen-saver')

  // Teed into the log the way the compose page's is, and for the same reason: a
  // notice that never appeared and a notice that was never sent are the same
  // photograph, and this window has no other way to say which it was.
  overlay.webContents.on('console-message', (details) => {
    if (details.level === 'debug') return
    const level = details.level === 'error' ? 'error' : details.level === 'warning' ? 'warn' : 'info'
    console[level](`Notice page: ${details.message}`)
  })

  /**
   * Ready, or late enough that waiting is worse than showing.
   *
   * The fallback is the compose window's and is not paranoia: a window that
   * never appears is exactly the failure this feature exists to replace, and
   * from a sofa the two are the same picture. A notice that arrives a second
   * late is a notice; one waiting on a signal that never came is nothing.
   */
  const ready = (why: string): void => {
    if (overlayReady) return
    overlayReady = true
    if (why !== 'ready') console.warn(`Notice overlay revealed late: ${why}.`)
    paint()
  }

  overlay.once('ready-to-show', () => ready('ready'))
  const late = setTimeout(() => ready('the paint signal never came'), 1_500)
  late.unref?.()

  overlay.webContents.on('did-finish-load', () => {
    void getSettings()
      .then((current) => {
        zoom = scaleValue(current.uiScale)
        applyUiScale(overlay, current.uiScale)
        // The box was sized from a zoom this read had not answered yet, so it
        // is resized here rather than only at the next reveal — otherwise the
        // very first notice of a session is the one drawn in a window an inch
        // too small, on the setting that needs the room most.
        if (placeable() && overlay && !overlay.isDestroyed()) {
          overlay.setBounds(noticeBounds(screen.getPrimaryDisplay().workArea, zoom))
        }
      })
      .catch((error: unknown) => {
        console.warn('Notice overlay could not read the interface scale:', error)
      })
    // Re-pushed rather than sent once: a reload in development, or a renderer
    // brought back after a crash, comes up with an empty stack.
    paint()
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void overlay.loadURL(`${devServer}/notify.html`)
  } else {
    void overlay.loadFile(join(import.meta.dirname, '../renderer/notify.html'))
  }

  return overlay
}
