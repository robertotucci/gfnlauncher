import { join } from 'node:path'
import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { isPointerCommand, type PointerCommand, type PointerRestore } from '@shared/pointer'
import {
  DEFAULT_ACCENT,
  DEFAULT_KEYBOARD_SCALE,
  accentValue,
  keyboardScaleValue
} from '@shared/theme'
import type { Settings } from '@shared/types'
import { armDesktopPointer, type DesktopPointer } from './desktop'

/**
 * Pointer mode inside the windows we own.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * Two windows in this launcher render somebody else's page: the sign-in window
 * (`gfn/webAuth.ts`) and the web player (`gfn/webStream.ts`). Neither has a
 * focus model of ours, so neither can be driven with a pad — and `ipc.ts` says
 * as much about the first, which is the one that stops an account being linked
 * at all. `src/preload/pointer.ts` gives them a cursor and a keyboard; this
 * module is the half that turns what the pad meant into input the page will
 * believe.
 *
 * ── Why the replay happens here and not in the preload ──────────────────────
 *
 * The preload could dispatch its own events into the page's DOM. They would
 * arrive with `isTrusted: false`, and a login form is the last place to find
 * out which of NVIDIA's handlers checks. `webContents.sendInputEvent` goes in
 * through Chromium's real input pipeline, so what the page receives is
 * indistinguishable from a mouse — and it is available only from main.
 *
 * ── The boundary ────────────────────────────────────────────────────────────
 *
 * Everything arriving on `pointer:event` is validated (`isPointerCommand`) and
 * matched against the set of webContents that were deliberately registered
 * here. Context isolation already means the hosted page cannot reach
 * `ipcRenderer` — this is the second lock on the same door, because the thing
 * on the other side of it is the ability to synthesise trusted input into a
 * page where somebody is typing a password.
 */

/**
 * Where the pointer preload is, as the packaged app lays it out.
 *
 * Named here rather than at each call site so a window cannot be given the
 * preload without being registered, or registered without the preload. One is
 * a dead cursor and the other is a sender main will refuse; both look like
 * "the pad does nothing", which is the one symptom nobody on a sofa can
 * diagnose.
 */
export const POINTER_PRELOAD = join(import.meta.dirname, '../preload/pointer.cjs')

/**
 * The windows that may drive a pointer.
 *
 * Keyed by `WebContents.id` rather than by the object, so a destroyed sender
 * can never match a live entry by identity.
 */
const targets = new Map<number, { readonly contents: WebContents; readonly label: string }>()

/** Which of them currently has the mode on. At most one, and usually none. */
let active: number | null = null

let listening = false

/**
 * Wires the channel. Idempotent, so it can be called from window creation
 * rather than from a start-up sequence that has to remember to do it.
 */
function listen(): void {
  if (listening) return
  listening = true

  ipcMain.on(IPC.pointerEvent, (event, payload: unknown) => {
    const target = targets.get(event.sender.id)
    if (!target) {
      // Not a window we put a pointer preload on. There is no legitimate way to
      // reach this, so it is worth a line rather than a silent drop.
      console.warn(`Pointer command from an unregistered window (id ${event.sender.id}); ignored.`)
      return
    }

    if (!isPointerCommand(payload)) {
      console.warn(`Malformed pointer command from ${target.label}; ignored.`)
      return
    }

    apply(target.contents, target.label, payload)
  })
}

function apply(contents: WebContents, label: string, command: PointerCommand): void {
  if (contents.isDestroyed()) return

  switch (command.kind) {
    case 'mode':
      // Only the window that owns the mode may end it, so a stale "off" from a
      // document that has already been navigated away from cannot take the
      // cursor out from under the one that replaced it.
      if (command.active) {
        active = contents.id
        /**
         * One cursor at a time, decided here because here is the side that can
         * be sure.
         *
         * `armDesktopPointer` asks `ownWindowActive()` before it opens and that
         * question races this message: both backends read the same chord off
         * the same pad, milliseconds apart, and the desktop one then spends
         * another few hundred opening a portal session. Whichever answered
         * first won, so a chord held with the sign-in window in front could
         * raise *two* cursors — the page's own and a compositor one over the
         * top of it. A window of ours being in front is the whole reason the
         * desktop backend defers, so when one says it has the pointer, the
         * other stops, whatever order they got there in.
         */
        desktop?.stop('a window of ours took the pointer')
      } else if (active === contents.id) active = null
      // One line per transition, never per frame: this file is read a week
      // later by somebody working out why a cursor did or did not appear.
      console.info(`Pointer mode ${command.active ? 'on' : 'off'} in ${label}`)
      return

    case 'move':
      contents.sendInputEvent({ type: 'mouseMove', x: round(command.x), y: round(command.y) })
      return

    case 'button':
      contents.sendInputEvent({
        type: command.down ? 'mouseDown' : 'mouseUp',
        x: round(command.x),
        y: round(command.y),
        button: command.button,
        // Always one. A double click would need the timing of two, and nothing
        // on a login page needs one.
        clickCount: 1
      })
      return

    case 'wheel':
      contents.sendInputEvent({
        type: 'mouseWheel',
        x: round(command.x),
        y: round(command.y),
        deltaX: 0,
        // Chromium's wheel delta runs the opposite way to the browser's
        // `deltaY`: a negative wheel scrolls the content down. `scrollDelta`
        // speaks the browser's convention because that is the one anybody
        // reading it will assume, so the flip happens here, once.
        deltaY: -round(command.deltaY),
        canScroll: true
      })
      return

    case 'text':
      // `char` rather than keyDown/keyUp: this is a character, not a key, and
      // for anything above the ASCII letters there is no keycode that produces
      // it without also getting the modifier state right.
      contents.sendInputEvent({ type: 'char', keyCode: command.text })
      return

    case 'key':
      contents.sendInputEvent({ type: 'keyDown', keyCode: command.key })
      contents.sendInputEvent({ type: 'keyUp', keyCode: command.key })
      return
  }
}

/** `sendInputEvent` wants integers; a fractional cursor lands nowhere useful. */
function round(value: number): number {
  return Math.round(value)
}

/**
 * Lets a window be driven by the pad, and stops when it goes away.
 *
 * Called at window creation, beside the `preload` that makes it possible —
 * the two belong together, and a window with one and not the other is either a
 * dead pointer or an unregistered sender.
 */
export function registerPointerTarget(window: BrowserWindow, label: string): void {
  listen()

  const contents = window.webContents
  targets.set(contents.id, { contents, label })

  /**
   * A document is not a session.
   *
   * Signing in walks through the mall, NVIDIA's login and the password step,
   * and every navigation re-executes the preload with nothing in it. Left
   * alone, the cursor would die at each hop and the user would hold the chord
   * three times to get through one form. So the mode is remembered here, where
   * it survives the document, and replayed into each new one.
   */
  contents.on('did-finish-load', () => {
    if (contents.isDestroyed()) return
    contents.send(IPC.pointerRestore, restoreFor(contents.id))
  })

  window.on('closed', () => {
    targets.delete(contents.id)
    if (active === contents.id) {
      active = null
      // The mode dies with the window it was in. Worth saying so: from the
      // sofa, a cursor that vanished because the window closed and a cursor
      // that vanished because something broke look identical.
      console.info(`Pointer mode ended with ${label}`)
    }
  })
}

/** Whether any window we own currently has a pad-driven cursor up. */
export function isPointerActive(): boolean {
  return active !== null
}

// ── The second backend ──────────────────────────────────────────────────────

/**
 * The desktop half, wired up.
 *
 * Everything above drives a cursor **inside** a window we own, with
 * `sendInputEvent`. `./desktop.ts` drives one **outside** every window, through
 * the compositor. They are the same feature and the same chord; which one
 * answers depends only on where the user is, and this is the seam.
 *
 * Kept in this file rather than in `index.ts` so the two backends know about
 * each other in one place — specifically so the desktop one can refuse to open
 * while a sign-in window is already driving its own cursor, which is the only
 * way the two could ever fight.
 */
let desktop: DesktopPointer | null = null

/**
 * A snapshot of the four settings this module and the desktop backend read.
 *
 * A snapshot rather than an `await getSettings()` at each use, because the
 * chord is handled inside a 60 Hz tick and nothing there may be asynchronous.
 * `updatePointerSettings` keeps it in step from the settings IPC handler, which
 * is the one place a change can come from.
 *
 * Two of them are permission and session state and two are **appearance** —
 * both keyboards this mode can raise are drawn outside the launcher's renderer,
 * so the accent and the keyboard size have no other route to them. Anything
 * else the pointer needs from settings belongs here too rather than arriving by
 * a fifth path; that is what keeps one rule instead of several.
 */
let pointerSettings: Pick<
  Settings,
  'pointerDesktop' | 'pointerRestoreToken' | 'accentColor' | 'keyboardScale'
> = {
  pointerDesktop: false,
  pointerRestoreToken: null,
  accentColor: DEFAULT_ACCENT,
  keyboardScale: DEFAULT_KEYBOARD_SCALE
}

/** What both keyboards are drawn with, resolved from the ids we store. */
function pointerLook(): { accent: string; scale: number } {
  return {
    accent: accentValue(pointerSettings.accentColor),
    scale: keyboardScaleValue(pointerSettings.keyboardScale)
  }
}

function restoreFor(id: number): PointerRestore {
  return { active: active === id, ...pointerLook() }
}

export function updatePointerSettings(settings: Settings): void {
  pointerSettings = {
    pointerDesktop: settings.pointerDesktop,
    pointerRestoreToken: settings.pointerRestoreToken,
    accentColor: settings.accentColor,
    keyboardScale: settings.keyboardScale
  }

  // Pushed rather than left for the next navigation. The sign-in window can be
  // open while the accent is changed from the Settings screen behind it, and a
  // keyboard still wearing the old one would be the one part of the launcher
  // that did not follow. Costs one message per open target, on a channel that
  // fires a handful of times a session.
  for (const [id, target] of targets) {
    if (target.contents.isDestroyed()) continue
    target.contents.send(IPC.pointerRestore, restoreFor(id))
  }

  // Applied now, not at the next start. Off has to end a session that is
  // already up and close the pad devices; on has to open them without waiting
  // for a restart. A toggle whose effect arrives later is a toggle nobody can
  // judge — the same reasoning the fullscreen row is built on.
  desktop?.syncEnabled()
}

/**
 * Arms the desktop backend and starts pushing its state to the renderer.
 *
 * The thunk is the same arrangement `armClientWatch` uses: this outlives any
 * particular window, and pushes to whichever one exists when it has something
 * to say.
 */
export function armPointerMode(
  getWindow: () => BrowserWindow | null,
  settings: Settings,
  persistToken: (token: string) => void
): void {
  updatePointerSettings(settings)

  desktop = armDesktopPointer({
    enabled: () => pointerSettings.pointerDesktop,
    restoreToken: () => pointerSettings.pointerRestoreToken,
    saveRestoreToken: (token) => {
      pointerSettings = { ...pointerSettings, pointerRestoreToken: token }
      persistToken(token)
    },
    ownWindowActive: isPointerActive,
    composeLook: () => ({
      accentColor: pointerSettings.accentColor,
      keyboardScale: pointerSettings.keyboardScale
    }),
    onMode: (modeActive) => {
      const window = getWindow()
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(IPC.pointerMode, modeActive)
      }
    }
  })
}

export function disarmPointerMode(): void {
  desktop?.dispose()
  desktop = null
}
