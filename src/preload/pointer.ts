import { ipcRenderer } from 'electron'
import type { IPC as IpcChannels } from '@shared/ipc'
import {
  CHORD_START,
  KEYBOARD_CHORD_BUTTONS,
  KEYBOARD_CHORD_HOLD_MS,
  centreOf,
  chordHeld,
  heldActions,
  scrollDelta,
  stepChord,
  stepPointer,
  stepPointerButtons,
  type ChordState,
  type Direction,
  type PointerActionName,
  type PointerCommand,
  type PointerState
} from '@shared/pointer'
import {
  OSK_NAV_START,
  OSK_ROWS,
  OSK_START,
  moveOskSelection,
  oskChar,
  oskKeyAt,
  oskLabel,
  stepOskNav,
  type OskCursor,
  type OskKey,
  type OskNavState
} from '@shared/osk'

/**
 * Pointer mode inside a window that renders somebody else's page.
 *
 * ── This preload exposes nothing, and that is the whole design ──────────────
 *
 * ARCHITECTURE.md says of the sign-in window: *"This window renders a
 * third-party site. It gets no bridge, no preload and no Node."* Two thirds of
 * that still hold, and the third was never the rule — it was the shorthand. The
 * rule is that **the page gains nothing**, and it is kept by the absence of a
 * single call: there is no `contextBridge.exposeInMainWorld` in this file and
 * there must never be one. Context isolation puts everything below in a world
 * the page cannot see, address or call into. `window.launcher` stays undefined
 * on `play.geforcenow.com`, and so does `require`.
 *
 * What this buys is the thing that could not be bought any other way: the pad
 * has to be read by the window that has the focus, and when the login page is
 * up that is this one — the launcher behind it is `handedOff` and its own input
 * is suspended, correctly. So the loop lives here.
 *
 * ── What is here and what is in main ────────────────────────────────────────
 *
 * Here: reading the pad, deciding what it meant, and drawing what the user can
 * see. There: turning the decision into input Chromium believes. The split is
 * not arbitrary — `sendInputEvent` is a main-process API and produces *trusted*
 * events, while anything this file could dispatch into the page itself would
 * arrive with `isTrusted: false`. On a login form that is not a distinction to
 * gamble on.
 *
 * Every decision worth testing was lifted into `@shared/pointer` and
 * `@shared/osk`, both pure. What is left below is a loop and a DOM, neither of
 * which the suite can see.
 */

// ── Talking to main ─────────────────────────────────────────────────────────

/**
 * The two channel names, written out and checked against `IPC` by the compiler.
 *
 * `shared/ipc.ts` says to import the constants rather than write the strings,
 * and this is the one place that cannot: a **runtime** import of that module
 * from a second preload entry makes Rollup hoist it into a shared chunk, which
 * both preloads then `require` by relative path — and a sandboxed preload's
 * `require` throws `module not found` on anything that is not `electron`,
 * `events`, `timers` or `url`. The bridge dies with it, silently, at build time.
 * `oneFilePerPreload` in electron.vite.config.ts is what stops that shipping.
 *
 * The `import type` above is erased, so nothing is shared at runtime. The
 * annotations keep the coupling: `IPC` is declared `as const`, so each of these
 * is a literal type, and a typo or a renamed channel is a compile error rather
 * than a message nobody receives.
 */
const POINTER_EVENT: (typeof IpcChannels)['pointerEvent'] = 'pointer:event'
const POINTER_RESTORE: (typeof IpcChannels)['pointerRestore'] = 'pointer:restore'

function send(command: PointerCommand): void {
  ipcRenderer.send(POINTER_EVENT, command)
}

// ── State ───────────────────────────────────────────────────────────────────

let active = false
let cursor: PointerState = { x: 0, y: 0, at: 0 }
let chord = CHORD_START
/** The shoulder pair. Its own state, so one chord cannot disarm the other. */
let keyboardChord: ChordState = CHORD_START
let held: readonly PointerActionName[] = []
let lastSample = 0

let keyboardOpen = false
let keyboardAt: OskCursor = OSK_START
let keyboardNav: OskNavState = OSK_NAV_START
let shift = false

function bounds(): { width: number; height: number } {
  return {
    width: Math.max(1, window.innerWidth || 1),
    height: Math.max(1, window.innerHeight || 1)
  }
}

// ── What the user can see ───────────────────────────────────────────────────

/**
 * Everything we draw lives under one host in a **shadow root**.
 *
 * Two reasons, and both are about a page we do not control. The page's
 * stylesheet cannot reach inside a shadow root, so a site with an aggressive
 * `* { }` rule cannot make the cursor invisible; and nothing here leaks out to
 * restyle the login form under it. Attached to `documentElement` rather than
 * `body`, because a preload runs before there is a body and some pages replace
 * theirs outright.
 */
let root: ShadowRoot | null = null
let cursorNode: HTMLElement | null = null
let hintNode: HTMLElement | null = null
let keyboardNode: HTMLElement | null = null
let keyNodes: Map<string, HTMLElement> = new Map()

const HOST_ID = 'gfn-launcher-pointer'

const STYLES = `
  :host { all: initial; }
  .layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483647;
    font-family: system-ui, sans-serif;
    color: #fafafa;
  }
  .cursor {
    position: absolute;
    top: 0;
    left: 0;
    width: 26px;
    height: 26px;
    margin: -3px 0 0 -3px;
    transform: translate3d(0, 0, 0);
    will-change: transform;
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.9));
  }
  .hint {
    position: absolute;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    display: flex;
    gap: 14px;
    padding: 8px 16px;
    border-radius: 8px;
    background: rgba(8, 9, 12, 0.92);
    border: 1px solid rgba(250, 250, 250, 0.14);
    font-size: 12px;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .hint b { font-weight: 600; color: #7dd3fc; margin-right: 5px; }
  .keys {
    position: absolute;
    left: 50%;
    bottom: 56px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px;
    border-radius: 12px;
    background: rgba(8, 9, 12, 0.96);
    border: 1px solid rgba(250, 250, 250, 0.14);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
  }
  .row { display: flex; gap: 6px; justify-content: center; }
  .key {
    min-width: 46px;
    height: 42px;
    padding: 0 10px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    border: 1px solid rgba(250, 250, 250, 0.14);
    background: rgba(250, 250, 250, 0.06);
    font-size: 15px;
    font-variant-numeric: tabular-nums;
  }
  .key[data-wide='1'] { font-size: 11px; letter-spacing: 0.08em; }
  .key[data-on='1'] {
    border-color: #7dd3fc;
    background: #7dd3fc;
    color: #08090c;
    transform: scale(1.06);
  }
  .key[data-lit='1'] { border-color: #7dd3fc; color: #7dd3fc; }
`

/** A plain arrow. Inline SVG so it needs nothing from the page and no network. */
const CURSOR_SVG = `
  <svg viewBox="0 0 24 24" width="26" height="26" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 2 L5 20 L10 15.5 L13 22 L16.5 20.4 L13.5 14 L20 14 Z"
          fill="#fafafa" stroke="#08090c" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>
`

function ensureUi(): boolean {
  if (root) return true
  if (!document.documentElement) return false

  const host = document.createElement('div')
  host.id = HOST_ID
  // Belt and braces: even outside the shadow root the host must never take a
  // click away from the page it is floating over.
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  document.documentElement.appendChild(host)

  root = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = STYLES
  root.appendChild(style)

  const layer = document.createElement('div')
  layer.className = 'layer'
  root.appendChild(layer)

  cursorNode = document.createElement('div')
  cursorNode.className = 'cursor'
  cursorNode.innerHTML = CURSOR_SVG
  layer.appendChild(cursorNode)

  hintNode = document.createElement('div')
  hintNode.className = 'hint'
  layer.appendChild(hintNode)

  keyboardNode = buildKeyboard()
  layer.appendChild(keyboardNode)

  return true
}

function buildKeyboard(): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'keys'
  keyNodes = new Map()

  for (const row of OSK_ROWS) {
    const rowNode = document.createElement('div')
    rowNode.className = 'row'
    for (const key of row) {
      const node = document.createElement('div')
      node.className = 'key'
      if (key.kind !== 'char') node.dataset.wide = '1'
      node.textContent = oskLabel(key, false)
      rowNode.appendChild(node)
      keyNodes.set(key.id, node)
    }
    panel.appendChild(rowNode)
  }

  return panel
}

/**
 * The legend, which is the only manual there is.
 *
 * It names what the buttons do *here* rather than what they do in the launcher,
 * and it changes with the layer for the same reason the footer in `App.tsx`
 * does: a legend that says "Click" while A is typing a letter is worse than no
 * legend.
 */
function hintText(): string {
  return keyboardOpen
    ? '<span><b>A</b>Type</span><span><b>LB+RB</b>Hide keyboard</span>' +
        '<span><b>B</b>Hide keyboard</span><span><b>☰</b>Exit pointer</span>'
    : '<span><b>A</b>Click</span><span><b>B</b>Right click</span>' +
        '<span><b>LB+RB</b>Keyboard</span><span><b>☰</b>Exit pointer</span>'
}

function paint(): void {
  if (!ensureUi()) return

  const visible = active ? '' : 'none'
  cursorNode!.style.display = keyboardOpen || !active ? 'none' : ''
  hintNode!.style.display = visible
  keyboardNode!.style.display = active && keyboardOpen ? '' : 'none'

  if (!active) return

  cursorNode!.style.transform = `translate3d(${Math.round(cursor.x)}px, ${Math.round(cursor.y)}px, 0)`
  hintNode!.innerHTML = hintText()

  if (!keyboardOpen) return

  const selected = oskKeyAt(OSK_ROWS, keyboardAt)
  for (const row of OSK_ROWS) {
    for (const key of row) {
      const node = keyNodes.get(key.id)
      if (!node) continue
      node.textContent = oskLabel(key, shift)
      node.dataset.on = key.id === selected?.id ? '1' : '0'
      node.dataset.lit = key.kind === 'shift' && shift ? '1' : '0'
    }
  }
}

// ── Reading the pad ─────────────────────────────────────────────────────────

interface Sample {
  readonly buttons: Set<number>
  readonly left: { x: number; y: number }
  readonly right: { x: number; y: number }
  readonly direction: Direction | null
}

/**
 * Folds every connected pad into one reading.
 *
 * Every pad rather than the first: a machine with a pad and a steering wheel
 * plugged in reports both, and the one the user picked up may not be index 0.
 */
function readPads(): Sample {
  const pads = navigator.getGamepads?.() ?? []
  const buttons = new Set<number>()
  const left = { x: 0, y: 0 }
  const right = { x: 0, y: 0 }
  let direction: Direction | null = null

  for (const pad of pads) {
    if (!pad) continue

    for (let index = 0; index < pad.buttons.length; index += 1) {
      if (pad.buttons[index]?.pressed) buttons.add(index)
    }

    // Largest deflection wins, so two pads do not cancel each other out.
    if (Math.abs(pad.axes[0] ?? 0) > Math.abs(left.x)) left.x = pad.axes[0] ?? 0
    if (Math.abs(pad.axes[1] ?? 0) > Math.abs(left.y)) left.y = pad.axes[1] ?? 0
    if (Math.abs(pad.axes[2] ?? 0) > Math.abs(right.x)) right.x = pad.axes[2] ?? 0
    if (Math.abs(pad.axes[3] ?? 0) > Math.abs(right.y)) right.y = pad.axes[3] ?? 0

    direction ??= dpadDirection(pad)
  }

  return { buttons, left, right, direction }
}

/** D-pad only. The stick drives the keyboard grid through its own deadzone. */
function dpadDirection(pad: Gamepad): Direction | null {
  if (pad.buttons[12]?.pressed) return 'up'
  if (pad.buttons[13]?.pressed) return 'down'
  if (pad.buttons[14]?.pressed) return 'left'
  if (pad.buttons[15]?.pressed) return 'right'
  return null
}

/** A stick resolved to one direction, the way `readDirection` does it. */
function stickDirection(x: number, y: number): Direction | null {
  // Higher than POINTER_DEADZONE: picking a key is a discrete choice and a
  // twitch must not skip two of them.
  const gate = 0.5
  if (Math.abs(x) > Math.abs(y)) {
    if (x <= -gate) return 'left'
    if (x >= gate) return 'right'
  } else {
    if (y <= -gate) return 'up'
    if (y >= gate) return 'down'
  }
  return null
}

// ── The loop ────────────────────────────────────────────────────────────────

function setMode(next: boolean, reason: string): void {
  if (active === next) return
  active = next
  keyboardOpen = false
  shift = false
  keyboardNav = OSK_NAV_START
  // Back to unarmed, which is what makes the adoption rule apply again: a
  // shoulder already down as the mode opens must not raise the keyboard with it.
  keyboardChord = CHORD_START

  if (active) {
    cursor = centreOf(bounds(), lastSample)
    keyboardAt = OSK_START
  } else {
    // Never leave a button stuck down in the page. A mode that ends mid-drag
    // and does not say so leaves a login form with a selection it cannot clear.
    for (const action of held) {
      if (action === 'leftClick' || action === 'rightClick') {
        send({
          kind: 'button',
          button: action === 'leftClick' ? 'left' : 'right',
          down: false,
          x: cursor.x,
          y: cursor.y
        })
      }
    }
    held = []
  }

  send({ kind: 'mode', active })
  console.info(`Pointer mode ${active ? 'on' : 'off'} (${reason})`)
  paint()
}

function pressKeyboardKey(key: OskKey): void {
  switch (key.kind) {
    case 'shift':
      shift = !shift
      return
    case 'close':
      keyboardOpen = false
      return
    case 'backspace':
      send({ kind: 'key', key: 'Backspace' })
      return
    case 'enter':
      send({ kind: 'key', key: 'Enter' })
      return
    default: {
      const char = oskChar(key, shift)
      if (char !== null) send({ kind: 'text', text: char })
    }
  }
}

/** LB + RB, and it is a toggle in both directions. */
function toggleKeyboard(): void {
  keyboardOpen = !keyboardOpen
  if (keyboardOpen) {
    keyboardAt = OSK_START
    keyboardNav = OSK_NAV_START
  }
}

function onAction(action: PointerActionName, down: boolean): void {
  if (keyboardOpen) {
    if (!down) return
    if (action === 'leftClick') {
      const key = oskKeyAt(OSK_ROWS, keyboardAt)
      if (key) pressKeyboardKey(key)
    } else if (action === 'rightClick') {
      keyboardOpen = false
    } else if (action === 'exit') {
      setMode(false, '☰ while the keyboard was up')
    }
    return
  }

  switch (action) {
    case 'leftClick':
    case 'rightClick':
      send({
        kind: 'button',
        button: action === 'leftClick' ? 'left' : 'right',
        down,
        x: cursor.x,
        y: cursor.y
      })
      return
    case 'exit':
      if (down) setMode(false, '☰')
      return
  }
}

function tick(): void {
  try {
    poll()
  } catch (error) {
    // The same bargain `GamepadProvider` makes: this loop is the only path
    // input takes, so anything escaping it ends the cursor for the session —
    // in a window whose whole job is to let somebody sign in without a mouse.
    console.error('The pointer poll threw; continuing.', error)
  } finally {
    requestAnimationFrame(tick)
  }
}

function poll(): void {
  const now = performance.now()
  const sample = readPads()

  const chordStep = stepChord(chord, chordHeld(sample.buttons), now)
  chord = chordStep.next
  if (chordStep.toggle) setMode(!active, 'L3 + R3')

  if (!active) {
    lastSample = now
    held = []
    return
  }

  // The shoulders, and only while the mode is up: outside it LB and RB page
  // through genres on the grid, and that binding is not ours to take.
  const keyboardStep = stepChord(
    keyboardChord,
    chordHeld(sample.buttons, KEYBOARD_CHORD_BUTTONS),
    now,
    KEYBOARD_CHORD_HOLD_MS
  )
  keyboardChord = keyboardStep.next
  if (keyboardStep.toggle) toggleKeyboard()

  // Button edges first, so a click lands where the cursor was drawn rather than
  // where this frame is about to move it.
  const current = heldActions(sample.buttons)
  const { down, up } = stepPointerButtons(held, current)
  held = current
  for (const action of up) onAction(action, false)
  for (const action of down) onAction(action, true)

  if (keyboardOpen) {
    const direction = sample.direction ?? stickDirection(sample.left.x, sample.left.y)
    const nav = stepOskNav(keyboardNav, direction, now)
    keyboardNav = nav.next
    if (nav.move && direction) keyboardAt = moveOskSelection(OSK_ROWS, keyboardAt, direction)
  } else {
    const previous = cursor
    cursor = stepPointer({ ...cursor, at: lastSample }, sample.left, bounds(), now)
    if (Math.round(previous.x) !== Math.round(cursor.x) || Math.round(previous.y) !== Math.round(cursor.y)) {
      send({ kind: 'move', x: cursor.x, y: cursor.y })
    }

    const delta = scrollDelta(sample.right.y, now - lastSample)
    if (delta !== 0) send({ kind: 'wheel', x: cursor.x, y: cursor.y, deltaY: delta })
  }

  lastSample = now
  paint()
}

// ── Start ───────────────────────────────────────────────────────────────────

/**
 * Main replays the mode into every new document.
 *
 * Signing in is three or four navigations and each one re-runs this file from
 * nothing. Without this the cursor would die at every step of the one flow it
 * exists for.
 */
ipcRenderer.on(POINTER_RESTORE, (_event, next: unknown) => {
  if (typeof next !== 'boolean') return
  lastSample = performance.now()
  setMode(next, 'restored after a navigation')
})

/**
 * Deliberately unconditional, and deliberately silent until the chord.
 *
 * A pad that is not connected costs one `getGamepads()` per frame and draws
 * nothing at all, which is cheaper than working out whether to start.
 */
requestAnimationFrame(tick)

// The layer is built as soon as there is a document to hang it on. Doing it
// lazily on the first chord instead would put a DOM insertion on the frame the
// user is watching for feedback.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => paint(), { once: true })
} else {
  paint()
}

/**
 * The one thing this file must never do, restated where somebody editing it
 * will see it: **no `contextBridge.exposeInMainWorld`.** Everything above lives
 * in an isolated world precisely so the page hosting it gains nothing, and a
 * single exposed object would hand a third-party login page the ability to
 * synthesise trusted input into itself.
 */
export {}
