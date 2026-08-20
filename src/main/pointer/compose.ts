import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, screen, type Display, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import {
  COMPOSE_CURSOR_START,
  COMPOSE_DISPLAY,
  buildComposeLayout,
  clampComposeCursor,
  composeButtonAt,
  composeButtons,
  composeLayoutFor,
  composeRows,
  composeShortcuts,
  isComposeFunctionKey,
  moveComposeSelection,
  type ComposeCursor,
  type ComposeLayer,
  type ComposeLayout,
  type ComposeView
} from '@shared/keyboardLayout'
import { accentValue, keyboardScaleValue } from '@shared/theme'
import type { PadFamily } from '@shared/padFamily'
import { KEY_GRID_DEADZONE, type Direction } from '@shared/pointer'
import type { PadAxes } from './evdev'

/**
 * Typing into somebody else's window: compose here, send after getting out of
 * the way.
 *
 * ── Why this exists, when there are already two keyboards ───────────────────
 *
 * The preload draws one inside the two windows we own, and it cannot follow the
 * cursor onto the desktop or into a game — anything we draw there takes the
 * focus, and the focus is what decides where a keystroke lands, so that
 * keyboard would type into itself. `systemKeyboard.ts` asks KWin for the one
 * the *compositor* draws, which has no such problem, and on the machine this
 * was written for KWin declines: `willShowOnActive` answers **false** on a
 * session with no touchscreen, whatever `forceActivate` is told, because KDE
 * raises its keyboard for touch and not for a pointer. That is a policy in
 * someone else's compositor and no amount of asking changes it.
 *
 * So this takes the one route that does not need a window we are not allowed to
 * have: **stop trying to type and draw at the same time.** Compose the whole
 * string in a window of ours, which may take the focus because nothing is being
 * typed yet; then close it, let the focus fall back to whatever had it, and only
 * then send the characters through the portal. The keystrokes are real key
 * events at the compositor, so they reach a remote game through the GeForce NOW
 * client the same way the pad already does.
 *
 * ── Who draws it, and who decides ───────────────────────────────────────────
 *
 * `simple-keyboard` draws it, from `src/renderer/compose.html` — a second
 * renderer entry, so the library is bundled into the application and nothing
 * has to be installed on the machine. The layout is the **session's own**:
 * `@shared/keyboardLayout.ts` holds one definition per xkb name and the
 * compositor is asked which one is in use, because what gets typed here is an
 * email address and a password and both of those are muscle memory attached to
 * the keyboard already on the desk.
 *
 * Everything else is here. Main reads the pad from joydev, so main is the only
 * thing that can know where the selection is: it owns the text, the layer and
 * the cursor, and pushes all three to the window on every keystroke. The window
 * sends back exactly one kind of message — a key that was **clicked**, because
 * the launcher has a cursor on screen when this opens and a keyboard you can
 * see but not click reads as broken — and that arrives validated, against the
 * layout and against the sender.
 */

/** Longer than any password and short enough that a stuck pad cannot fill it. */
export const MAX_COMPOSE_LENGTH = 256

export interface ComposeState {
  readonly text: string
  readonly layer: ComposeLayer
  readonly at: ComposeCursor
  /** The layout being walked, so the fold needs nothing from outside itself. */
  readonly layout: ComposeLayout
}

/** A starting state on a given layout. US when nobody says otherwise. */
export function composeStart(layout = buildComposeLayout(composeLayoutFor(null))): ComposeState {
  return { text: '', layer: 'default', at: COMPOSE_CURSOR_START, layout }
}

/**
 * What pressing a key means.
 *
 * SEND sends *and* asks for a Return afterwards, because the field this is
 * being typed into almost always has a button next to it, and reaching that
 * button with the cursor is the thing the user was already struggling to do.
 *
 * Anything that is not a `{brace}` key types itself, which is the whole reason
 * the layout is written in `simple-keyboard`'s own format: the shifted layer
 * *is* the shifted characters, so there is no second table mapping one to the
 * other and no way for the two to disagree.
 */
export type ComposeOutcome =
  | { readonly kind: 'editing'; readonly next: ComposeState }
  | { readonly kind: 'send'; readonly text: string; readonly enter: boolean }
  | { readonly kind: 'cancel' }

export function pressComposeButton(state: ComposeState, button: string): ComposeOutcome {
  switch (button) {
    case '{shift}': {
      // Both layers of a layout are built with the same tail rows and the same
      // faithful rows above them, so this is a no-op in practice — and it is
      // here because "in practice" is a property of the layouts that ship, and
      // the next one added must not be able to leave the cursor off the grid.
      const layer = state.layer === 'default' ? 'shift' : 'default'
      return {
        kind: 'editing',
        next: { ...state, layer, at: clampComposeCursor(composeRows(state.layout, layer), state.at) }
      }
    }
    case '{close}':
      return { kind: 'cancel' }
    case '{enter}':
      return { kind: 'send', text: state.text, enter: true }
    case '{bksp}':
      return { kind: 'editing', next: { ...state, text: state.text.slice(0, -1) } }
    case '{space}':
      return append(state, ' ')
    default:
      // A function key this does not know is a layout that grew a button nobody
      // taught this function about. Typing "{tab}" into a password field is a
      // worse answer than doing nothing. `isComposeFunctionKey` and not
      // `startsWith('{')`, because `{` and `}` are themselves keys here.
      if (isComposeFunctionKey(button)) return { kind: 'editing', next: state }
      return append(state, button)
  }
}

function append(state: ComposeState, text: string): ComposeOutcome {
  if (state.text.length + text.length > MAX_COMPOSE_LENGTH) {
    return { kind: 'editing', next: state }
  }
  return { kind: 'editing', next: { ...state, text: state.text + text } }
}

/**
 * Which way the pad is being pushed, d-pad first.
 *
 * The d-pad is discrete and is what a person reaches for on a grid; the stick
 * is the fallback, gated far higher than the cursor's deadzone because picking
 * a key is a discrete choice and a twitch must not skip two of them.
 */
export function composeDirection(axes: PadAxes): Direction | null {
  if (axes.dpadY < 0) return 'up'
  if (axes.dpadY > 0) return 'down'
  if (axes.dpadX < 0) return 'left'
  if (axes.dpadX > 0) return 'right'

  const gate = KEY_GRID_DEADZONE
  if (Math.abs(axes.leftX) > Math.abs(axes.leftY)) {
    if (axes.leftX <= -gate) return 'left'
    if (axes.leftX >= gate) return 'right'
  } else {
    if (axes.leftY <= -gate) return 'up'
    if (axes.leftY >= gate) return 'down'
  }
  return null
}

// ── The window ──────────────────────────────────────────────────────────────

/**
 * How many pixels at the bottom of our own window the keyboard must clear.
 *
 * **Not "the height of the panel".** A Wayland client is neither told where it
 * was put nor able to ask, and the two ways this goes wrong are indistinguishable
 * from in here: the compositor can leave our bottom edge *under* a panel, or —
 * given a window taller than the work area — leave it *past* the screen edge.
 * Both are the same count of unusable pixels at the bottom of our viewport, and
 * both are `height − workArea.height`, which needs no position at all.
 *
 * That is why this takes the height the window actually got rather than the one
 * that was asked for. The three cases on a 1080p screen with a 27 px panel:
 * a 1080-high window placed at 0,0 gives 27, the same window pushed to y=27
 * gives 27, and a 1053-high window that was honoured gives 0. One formula.
 *
 * Never negative: on an output whose work area is taller than the window we were
 * sized for, the honest answer is zero, and the alternative would push the
 * keyboard *down* off the screen to fix a problem that does not exist.
 */
export function composeSafeBottom(windowHeight: number, workAreaHeight: number): number {
  return Math.max(0, Math.round(windowHeight - workAreaHeight))
}

/**
 * Which output's measurements to use.
 *
 * Advisory rather than authoritative: on Wayland the compositor decides where
 * this window goes and we are not consulted, so the only thing riding on this is
 * the work area `composeSafeBottom` is measured against. Primary, because the
 * alternatives all need a cursor position, and `getCursorScreenPoint` answers
 * for surfaces we own and 0,0 for everything else — which is precisely the case
 * this opens in. One named function so there is one place to change it, and the
 * geometry line in the log is what would show it needs changing.
 */
function composeDisplay(): Display {
  return screen.getPrimaryDisplay()
}

/**
 * How long to wait between closing and typing.
 *
 * The compositor gives the focus back when our window goes, and it does not
 * promise to have done so by the time `destroy()` returns. Everything typed
 * before that lands in nothing at all — the failure would read as "it typed
 * nothing", which is indistinguishable from the bug this replaces. A quarter of
 * a second is imperceptible next to composing a password with a gamepad.
 */
export const FOCUS_HANDBACK_MS = 250

/** The same timings the grid repeats at, for the same reason `osk.ts` gives. */
const REPEAT_DELAY_MS = 420
const REPEAT_INTERVAL_MS = 90

/**
 * The two appearance choices this window reads, as the ids they are stored as.
 *
 * Ids and not values all the way to the point of use: the fallback for an id
 * this build has never heard of lives in `@shared/theme` and must live in one
 * place, which is the argument `accentPreset` already records.
 *
 * Passed in from the settings snapshot the desktop backend already holds rather
 * than read here, for the reason `layoutId` gives one field down and one of its
 * own: `openComposer` returning synchronously is what keeps the caller's
 * "already open?" guard and its assignment in the same turn.
 */
export interface ComposeLook {
  readonly accentColor: string
  readonly keyboardScale: string
  /**
   * Which pad's letters go on the four keycaps that carry one.
   *
   * Here with the accent and the size because it is the same kind of fact: the
   * appearance main knows and the window cannot ask for. It is resolved from
   * the joystick nodes rather than from a `Gamepad.id`, since nothing on this
   * path has a browser to ask.
   */
  readonly family: PadFamily
}

export interface ComposerDeps {
  /**
   * Called once, after the window has gone and the focus has had time to fall
   * back. Null means the user cancelled.
   */
  readonly onFinished: (result: { readonly text: string; readonly enter: boolean } | null) => void
  /**
   * The xkb layout the session is using, if anything knows. Passed in rather
   * than read here, because reading it is a D-Bus round trip and a window that
   * has to open must not wait on one; when it is absent the locale is used.
   */
  readonly layoutId?: string | null
  /** The user's accent and keyboard size. Defaults when nobody says otherwise. */
  readonly look?: ComposeLook | null
}

export interface Composer {
  /** One sample of the pad. Everything it does is decided here. */
  step(direction: Direction | null, now: number): void
  press(): void
  backspace(): void
  /**
   * The two keys X and Y reach without walking to them.
   *
   * Both go through `pressComposeButton` with the button name the keycap
   * carries, so a shortcut and the key it names can never mean two things —
   * which is the whole claim the badge printed on that keycap makes.
   */
  space(): void
  send(): void
  cancel(): void
  /** Tears the window down without sending anything. Safe at any time. */
  dispose(): void
}

/**
 * The click channel, wired once.
 *
 * Idempotent and never torn down, like `pointer/index.ts`'s: a listener that is
 * added per window is a listener that is removed per window, and getting that
 * wrong either leaks or unsubscribes the live one.
 */
let listening = false
/** The window whose clicks are accepted. At most one, and usually none. */
let clickTarget: WebContents | null = null
let onClick: ((button: string) => void) | null = null
/** What that window is allowed to send: the button names it is drawing. */
let allowedButtons: Set<string> | null = null

function listen(): void {
  if (listening) return
  listening = true

  ipcMain.on(IPC.composePress, (event, payload: unknown) => {
    if (!clickTarget || event.sender.id !== clickTarget.id) {
      // No legitimate path reaches this: the channel exists for one window that
      // main opened and gave a preload to.
      console.warn(`A compose keypress arrived from window ${event.sender.id}; ignored.`)
      return
    }

    // An allow-list of the open layout's own button names. The payload crosses
    // a boundary and ends up as characters typed into somebody else's window.
    if (typeof payload !== 'string' || !allowedButtons?.has(payload)) {
      console.warn('A malformed compose keypress was ignored.')
      return
    }

    onClick?.(payload)
  })
}

/**
 * Opens the window and returns the handle the pointer loop drives it with.
 *
 * Deliberately not `alwaysOnTop` at the ordinary level: over a fullscreen game
 * that is not enough on every compositor, and `screen-saver` is the level a
 * thing you are meant to read on top of a game belongs at.
 */
export function openComposer(deps: ComposerDeps): Composer {
  listen()

  // The compositor's answer if there was one, the locale if not — `it-IT`
  // resolves to the same layout as `it`, which is the point of taking either.
  const layout = buildComposeLayout(composeLayoutFor(deps.layoutId ?? app.getLocale()))
  // Resolved once, here, rather than on every keystroke inside `paint` — and on
  // the same line as the layout, because these are the three decisions taken at
  // open and somebody reading the log a week later wants them together.
  const accent = accentValue(deps.look?.accentColor)
  const scale = keyboardScaleValue(deps.look?.keyboardScale)
  // Resolved once per window rather than per paint: the pad in the room does
  // not change while somebody is typing a line with it, and the badges are read
  // by the page from this object on every keystroke.
  const shortcuts = composeShortcuts(deps.look?.family ?? 'xbox')
  console.info(
    `Compose keyboard layout: ${layout.name} (${layout.id}), ` +
      `accent ${deps.look?.accentColor ?? 'default'}, size ${Math.round(scale * 100)}%`
  )

  let state = composeStart(layout)
  let heldDirection: Direction | null = null
  let repeatAt = 0
  let finished = false

  /**
   * The size of the whole output, and transparent, because **a Wayland client
   * cannot place its own window**.
   *
   * The obvious build of this — a small panel, `setPosition` along the bottom
   * edge — was written first and measured: KWin ignored it and left the
   * keyboard 791 px from the bottom, near the top left. Positioning is the
   * compositor's on Wayland and there is no protocol for asking. So the window
   * is as big as the screen and see-through, and the keyboard is put along the
   * bottom by the *stylesheet*, which is the one layout authority that does not
   * need anybody's permission.
   *
   * **`bounds` and not `workArea`, and the panel is handled separately.** This
   * used to ask for the work area on the reasoning that it would then sit above
   * a panel rather than under one, and that is a placement the compositor never
   * agreed to make: KWin clamps placement to the work area, so a window smaller
   * than the output can land anywhere inside it — including with its bottom edge
   * behind the panel, which cut the last row of keys off. Asking for the whole
   * output is the least ambiguous request there is, and `composeSafeBottom` then
   * tells the page how much of its own bottom edge is unusable, whichever way
   * the compositor got it wrong. That number is measured from the size we were
   * actually given, so it is right in both directions.
   *
   * **And it is `fullscreen` too, which is the part that actually pins it.**
   * Asking for the output's size was still not enough, and the measurement is
   * on the record: a 4K screen at KDE's 1.7 scale reports 2259x1271, the window
   * asked for 2259x1271, `getContentBounds()` answered `2259x1271 at 0,0` — and
   * the last row of keys was still off the bottom of the screen. The panel that
   * could have covered it is on the *top* edge, the work area equalled the
   * bounds, the zoom was 1, and the page's own layout came to a third of the
   * viewport. Every quantity we can read said the window was right, and it was
   * not: **`0,0` is a fiction on Wayland**, where a client is never told where
   * it was put, so a placement error is the one fault in this window that
   * cannot be measured from inside it.
   *
   * `xdg_toplevel.set_fullscreen` is the only request in the protocol that maps
   * a surface onto one whole output at a known origin, so it is the only way to
   * stop needing to measure. It costs one risk worth naming: a translucent
   * fullscreen surface is the classic candidate for compositor unredirection,
   * whose failure mode is the keyboard opening on a black screen. KWin
   * composites these correctly, and the geometry line below plus the page's own
   * report are what would show it going wrong on something that does not.
   *
   * `maximize()` was the other candidate and is not the answer: it lands on the
   * work area rather than the output, and `resizable: false` makes Electron pin
   * the minimum and maximum size together, which a compositor answers by
   * declining to maximise at all — a silent no-op. `resizable` is therefore
   * `true` now, and costs nothing: the window is frameless, there is no pointer
   * path to a resize handle, and the page is fluid at any size it is given.
   */
  const display = composeDisplay()
  /** What we ask for: the whole output. */
  const bounds = display.bounds
  /** What is left after the panels: what the keyboard has to stay inside. */
  const area = display.workArea

  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    // Honoured on X11, ignored on Wayland, and free either way.
    x: bounds.x,
    y: bounds.y,
    frame: false,
    fullscreen: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, '../preload/compose.cjs')
    }
  })

  clickTarget = window.webContents
  allowedButtons = composeButtons(layout)
  onClick = (button) => apply(pressComposeButton(state, button))

  /**
   * The page's own console, teed into the log the way the launcher's is.
   *
   * It was not, and that cost a diagnosis: with the window reporting a size and
   * an origin that were both correct, the only remaining witness to where the
   * keyboard actually landed was the page — and it had no way to say. A throw
   * in `compose/main.ts` was equally invisible, on the one screen in this
   * product whose failure looks exactly like the bug it was built to replace.
   */
  window.webContents.on('console-message', (details) => {
    if (details.level === 'debug') return
    const level = details.level === 'warning' ? 'warn' : details.level
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](
      `Compose page: ${details.message}`
    )
  })

  window.setAlwaysOnTop(true, 'screen-saver')

  // electron-vite sets this only while its dev server is running, so it is the
  // whole of the dev/packaged question here — and one import fewer in a module
  // the suite has to be able to load.
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void window.loadURL(`${devServer}/compose.html`)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/compose.html'))
  }

  /**
   * Everything the anchoring depends on, in one line.
   *
   * Which output, what was asked for, what was given, what the page was told,
   * and the zoom factor — because a compose window that inherited the
   * launcher's zoom would make the page's CSS pixels and this DIP measurement
   * disagree, and that is invisible any other way. This is the line that says
   * whether a compositor is placing the window the way it was asked to, which
   * is the whole of the anchoring question and cannot be answered from inside.
   */
  let lastGeometry = ''
  const geometry = (): string => {
    const view = window.getContentBounds()
    return (
      `${view.width}x${view.height} at ${view.x},${view.y} ` +
      `[asked ${bounds.width}x${bounds.height}, work area ${area.width}x${area.height}, ` +
      `safe bottom ${composeSafeBottom(view.height, area.height)}px, ` +
      `zoom ${window.webContents.getZoomFactor()}]`
    )
  }

  /**
   * Shown once, whichever of these gets there first.
   *
   * `ready-to-show` is the right signal and the fallback is not paranoia: a
   * window that never appears is *exactly* the failure this whole feature is
   * replacing, and the difference between the two is invisible from a sofa. A
   * keyboard that arrives a second late is a keyboard; one that waits for a
   * signal that never came is nothing at all.
   */
  let shown = false
  const reveal = (why: string): void => {
    if (shown || window.isDestroyed()) return
    shown = true

    window.show()
    window.focus()
    lastGeometry = geometry()
    console.info(`Keyboard opened for composing (${why}): ${lastGeometry}`)
  }

  window.once('ready-to-show', () => reveal('ready'))
  const late = setTimeout(() => reveal('the paint signal never came'), 1_500)
  late.unref?.()

  // Pushed on every load rather than once: the page builds its keyboard from
  // the first view it receives, and in development it can be reloaded.
  window.webContents.on('did-finish-load', () => paint())

  /**
   * The size is the compositor's answer, and on Wayland it can arrive *after*
   * the first paint — `configure` is not ordered against `did-finish-load`. A
   * view painted against the requested size would then carry a `safeBottom`
   * measured from a window that no longer exists at that size.
   */
  window.on('resize', () => {
    paint()
    const line = geometry()
    if (line === lastGeometry) return
    lastGeometry = line
    console.info(`Compose window resized by the compositor: ${line}`)
  })

  const paint = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return

    const view: ComposeView = {
      text: state.text,
      layer: state.layer,
      selected:
        composeButtonAt(composeRows(state.layout, state.layer), state.at.row, state.at.column) ??
        '',
      layout: state.layout.layers,
      display: COMPOSE_DISPLAY,
      shortcuts,
      accent,
      scale,
      rows: state.layout.layers[state.layer].length,
      // Recomputed per paint rather than cached: a compositor reconfigure — an
      // output change, a panel appearing — moves it, and a stale inset is a row
      // of keys behind the taskbar again.
      safeBottom: composeSafeBottom(window.getContentBounds().height, area.height)
    }
    window.webContents.send(IPC.composeView, view)
  }

  /** Closes the window, waits for the focus to go back, then reports. */
  const finish = (result: { text: string; enter: boolean } | null): void => {
    if (finished) return
    finished = true

    clearTimeout(late)
    if (clickTarget === window.webContents) {
      clickTarget = null
      onClick = null
      allowedButtons = null
    }
    if (!window.isDestroyed()) window.destroy()

    const timer = setTimeout(() => deps.onFinished(result), FOCUS_HANDBACK_MS)
    // The launcher must never be held open by a keyboard somebody walked away
    // from mid-word.
    timer.unref?.()
  }

  /** One outcome, from the pad or from a click. They mean the same thing. */
  const apply = (outcome: ComposeOutcome): void => {
    if (outcome.kind === 'cancel') {
      finish(null)
      return
    }
    if (outcome.kind === 'send') {
      finish(outcome.text.length > 0 ? { text: outcome.text, enter: outcome.enter } : null)
      return
    }

    state = outcome.next
    paint()
  }

  return {
    step(direction, now) {
      if (direction === null) {
        heldDirection = null
        return
      }

      if (direction !== heldDirection) {
        heldDirection = direction
        repeatAt = now + REPEAT_DELAY_MS
      } else if (now < repeatAt) {
        return
      } else {
        repeatAt = now + REPEAT_INTERVAL_MS
      }

      state = {
        ...state,
        at: moveComposeSelection(composeRows(state.layout, state.layer), state.at, direction)
      }
      paint()
    },

    press() {
      const button = composeButtonAt(
        composeRows(state.layout, state.layer),
        state.at.row,
        state.at.column
      )
      if (button) apply(pressComposeButton(state, button))
    },

    backspace() {
      if (state.text.length === 0) return
      state = { ...state, text: state.text.slice(0, -1) }
      paint()
    },

    space() {
      apply(pressComposeButton(state, '{space}'))
    },

    send() {
      apply(pressComposeButton(state, '{enter}'))
    },

    cancel() {
      finish(null)
    },

    dispose() {
      finished = true
      clearTimeout(late)
      if (clickTarget === window.webContents) {
        clickTarget = null
        onClick = null
        allowedButtons = null
      }
      if (!window.isDestroyed()) window.destroy()
    }
  }
}
