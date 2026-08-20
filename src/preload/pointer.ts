import { ipcRenderer } from 'electron'
import type { IPC as IpcChannels } from '@shared/ipc'
import {
  CHORD_START,
  COMPOSE_ACTIONS,
  KEYBOARD_CHORD_BUTTONS,
  KEYBOARD_CHORD_HOLD_MS,
  KEY_GRID_DEADZONE,
  centreOf,
  chordHeld,
  heldActions,
  pointerHint,
  scrollDelta,
  stepChord,
  stepPointer,
  stepPointerButtons,
  type ChordState,
  type ComposeActionName,
  type Direction,
  type PointerActionName,
  type PointerCommand,
  type PointerRestore,
  type PointerState
} from '@shared/pointer'
import { isPadFamily, type PadFamily } from '@shared/padFamily'
import {
  standardReading,
  translatePad,
  type PadProfile,
  type PadTranslation
} from '@shared/padLayout'
import {
  OSK_NAV_START,
  OSK_ROWS,
  OSK_START,
  moveOskSelection,
  oskChar,
  oskKeyAt,
  oskLabel,
  oskShortcuts,
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
/**
 * X and Y, tracked apart from `held` and folded on *every* frame.
 *
 * Apart, because the two maps answer different questions and must not disarm
 * each other. Every frame, because that is the adoption rule: a thumb already
 * on X as the keyboard opens produces no down edge, and so no space nobody
 * asked for.
 */
let heldCompose: readonly ComposeActionName[] = []
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
/** Kept, because the accent and the size are set on it as custom properties. */
let hostNode: HTMLElement | null = null
let cursorNode: HTMLElement | null = null
let hintNode: HTMLElement | null = null
let keyboardNode: HTMLElement | null = null
let keyNodes: Map<string, HTMLElement> = new Map()

/**
 * The user's accent and keyboard size, replayed from main on `pointer:restore`.
 *
 * Held here because the layer may not exist yet when the message lands — a
 * preload runs before there is a document — so it is remembered and applied in
 * `ensureUi`, and again on every message after that.
 */
let look: { accent: string; scale: number } | null = null

/**
 * Which pad the badges and the hint name, and what the kernel says each pad is.
 *
 * Both arrive on `pointer:restore`, because this preload cannot ask: it has no
 * bridge and must never grow one. The family is decided in main so that it
 * agrees with the badges on the *other* on-screen keyboard, the one main draws
 * itself. `xbox` until told otherwise, which is the W3C layout the other two
 * are relabellings of, so nothing is unlabelled on the first frame.
 */
let family: PadFamily = 'xbox'
let padProfiles: readonly PadProfile[] = []
/** How each pad is being read, keyed by `Gamepad.id`. Cleared on a new list. */
let translations = new Map<string, PadTranslation>()

function applyLook(): void {
  if (!hostNode || !look) return
  hostNode.style.setProperty('--accent', look.accent)
  hostNode.style.setProperty('--kb-scale', String(look.scale))
}

const HOST_ID = 'gfn-launcher-pointer'

/**
 * The same language as the composed keyboard in `src/renderer/compose/`, and
 * that is the point: they are two drawings of one object, and a user who meets
 * both in one sign-in should not be able to tell they were written twice.
 *
 * Flat surfaces, one unit, and a darker colourway on the keys with a word on
 * them — the geometry does the work, not lighting. What it does *not* copy is
 * the stagger: this layout is alphabetical rather than QWERTY, for the reason
 * `@shared/osk.ts` records, so a stagger here would be decoration pretending to
 * be a keyboard's plan.
 *
 * `--accent` and `--kb-scale` are set on the host from `pointer:restore`; the
 * defaults below are what must be right on the frame before it arrives. `all:
 * initial` on `:host` leaves custom properties alone, so both inherit in.
 */
const STYLES = `
  :host {
    all: initial;
    --accent: oklch(0.985 0 0);
    --kb-scale: 1;
  }
  .layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483647;
    font-family: system-ui, sans-serif;
    color: #f0f1f3;

    /* Two units, as on the composed keyboard and for the same reason: nothing
       here is pressed with a finger, so a square cap spends height on nothing.
       --u sizes it across, --h down, and every type size follows --h because
       that is the dimension a legend has to fit inside. Smaller than the
       composed one either way: that one owns the screen, this floats over a
       page somebody is reading behind it. Seven rows, always.
       (No backticks in this comment: it lives inside a template literal.) */
    --u: min(calc(var(--kb-scale) * 4vw), calc(var(--kb-scale) * 84px), calc(86vw / 8.6));
    --h: min(calc(var(--u) * 0.56), 4.6vh);
    --gap: calc(var(--u) * 0.08);
    --vgap: calc(var(--h) * 0.16);
    --deck: #14171d;
    --cap: #1e232b;
    --cap-fn: #171b22;
    --well: #0b0d11;
    --line: rgba(250, 250, 250, 0.1);
    --legend2: #8b919c;
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
    background: var(--deck);
    border: 1px solid var(--line);
    font-size: 12px;
    letter-spacing: 0.04em;
    white-space: nowrap;
    color: var(--legend2);
  }
  .hint b { font-weight: 600; color: #f0f1f3; margin-right: 5px; }
  .keys {
    position: absolute;
    left: 50%;
    bottom: 56px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: var(--vgap);
    padding: calc(var(--u) * 0.2);
    border-radius: 12px;
    background: var(--deck);
    border: 1px solid var(--line);
  }
  .row { display: flex; gap: var(--gap); justify-content: center; }
  .key {
    position: relative;
    flex: 0 0 var(--u);
    height: var(--h);
    display: grid;
    place-items: center;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--cap);
    font-size: calc(var(--h) * 0.52);
    font-variant-numeric: tabular-nums;
  }
  /* Words rather than characters: the darker colourway of a keycap set's
     modifiers. Proportional rather than sized in units, so five keys come out
     exactly as wide as the eight above them — a bottom row wider than its own
     keyboard is the thing that stops this reading as one object. */
  .key[data-wide='1'] {
    flex: 3 0 0;
    min-width: 0;
    padding: 0 calc(var(--u) * 0.1);
    background: var(--cap-fn);
    color: var(--legend2);
    /* Floored, here and on the badge below: flattening the keys pulled every
       type size down with --h, and at the 80% setting these landed under the
       launcher's own smallest text. The size setting may shrink the keyboard;
       it may not make the words on it unreadable from three metres. */
    font-size: max(13px, calc(var(--h) * 0.32));
    font-weight: 600;
    letter-spacing: 0.1em;
  }
  /* The bar, and the only key here allowed to be obviously the widest. */
  .key[data-kind='space'] { flex: 8 0 0; }
  /* The pad button that reaches this key. Top right, as on the other keyboard. */
  .key::after {
    content: var(--sc, '');
    position: absolute;
    top: calc(var(--h) * 0.09);
    right: calc(var(--u) * 0.08);
    color: var(--legend2);
    font-size: max(11px, calc(var(--h) * 0.27));
    font-weight: 600;
    letter-spacing: 0;
    line-height: 1;
  }
  .key[data-on='1'] {
    z-index: 1;
    border-color: var(--accent);
    background: var(--accent);
    color: var(--well);
    box-shadow: 0 0 0 2px var(--deck), 0 0 0 4px var(--accent);
    transform: scale(1.04);
  }
  .key[data-on='1']::after { color: var(--well); opacity: 0.65; }
  .key[data-lit='1'] { border-color: var(--accent); color: var(--accent); }
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
  hostNode = host
  // Whatever arrived before there was a document to hang this on.
  applyLook()

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
      if (key.kind !== 'char') {
        node.dataset.wide = '1'
        node.dataset.kind = key.kind
      }
      node.textContent = oskLabel(key, false)
      rowNode.appendChild(node)
      keyNodes.set(key.id, node)
    }
    panel.appendChild(rowNode)
  }

  return panel
}

/**
 * Draws the legend, which is the only manual there is.
 *
 * `pointerHint` in `@shared/pointer` decides what it says; this puts it on the
 * screen. **Built as nodes rather than as a string of HTML**, and that changed
 * with the pad families: the button names used to be four literals in this file
 * and are now values that arrived over IPC, and interpolating one of those into
 * `innerHTML` — in a document belonging to NVIDIA rather than to us — is a hole
 * that does not need to exist. `textContent` cannot open one.
 */
let hintDrawn: string | null = null

function paintHint(): void {
  if (!hintNode) return

  // Only two things change what this says — the layer and the pad — and it is
  // asked sixty times a second, so it is rebuilt on a transition rather than on
  // a frame. The old `innerHTML` line rebuilt it every frame; that was cheap
  // enough not to matter and there is no reason to keep doing it with nodes.
  const signature = `${family}:${keyboardOpen}`
  if (signature === hintDrawn) return
  hintDrawn = signature
  hintNode.replaceChildren()

  for (const entry of pointerHint(family, keyboardOpen)) {
    const span = document.createElement('span')
    const button = document.createElement('b')
    button.textContent = entry.button
    span.appendChild(button)
    span.appendChild(document.createTextNode(entry.label))
    hintNode.appendChild(span)
  }
}

function paint(): void {
  if (!ensureUi()) return

  const visible = active ? '' : 'none'
  cursorNode!.style.display = keyboardOpen || !active ? 'none' : ''
  hintNode!.style.display = visible
  keyboardNode!.style.display = active && keyboardOpen ? '' : 'none'

  if (!active) return

  cursorNode!.style.transform = `translate3d(${Math.round(cursor.x)}px, ${Math.round(cursor.y)}px, 0)`
  paintHint()

  if (!keyboardOpen) return

  const selected = oskKeyAt(OSK_ROWS, keyboardAt)
  // Resolved here rather than in `buildKeyboard`, which runs once: the family
  // arrives on `pointer:restore` and can change under a keyboard that is
  // already on screen, and this loop touches every key anyway.
  const shortcuts = oskShortcuts(family)
  for (const row of OSK_ROWS) {
    for (const key of row) {
      const node = keyNodes.get(key.id)
      if (!node) continue
      node.textContent = oskLabel(key, shift)
      node.dataset.on = key.id === selected?.id ? '1' : '0'
      node.dataset.lit = key.kind === 'shift' && shift ? '1' : '0'
      // `content` needs a quoted string, and the quotes have to be inside the
      // property value — `content: var(--sc)` inserts it verbatim.
      const shortcut = shortcuts[key.kind]
      if (shortcut) node.style.setProperty('--sc', `"${shortcut}"`)
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

    // Everything below this line is the W3C layout, whatever the device
    // numbered its own buttons. Chromium only applies that layout to the pads
    // it has a table for, and for the rest it hands over the kernel's raw
    // indices — where the chord is at 13 and 14 rather than 10 and 11, and
    // where the d-pad is a pair of axes rather than four buttons. Translating
    // here is what lets `CHORD_BUTTONS` and the rest stay fixed tables.
    const reading = standardReading(
      { buttons: pad.buttons.map((button) => button.pressed), axes: pad.axes },
      translationFor(pad).map
    )

    for (let index = 0; index < reading.buttons.length; index += 1) {
      if (reading.buttons[index]) buttons.add(index)
    }

    // Largest deflection wins, so two pads do not cancel each other out.
    if (Math.abs(reading.axes[0] ?? 0) > Math.abs(left.x)) left.x = reading.axes[0] ?? 0
    if (Math.abs(reading.axes[1] ?? 0) > Math.abs(left.y)) left.y = reading.axes[1] ?? 0
    if (Math.abs(reading.axes[2] ?? 0) > Math.abs(right.x)) right.x = reading.axes[2] ?? 0
    if (Math.abs(reading.axes[3] ?? 0) > Math.abs(right.y)) right.y = reading.axes[3] ?? 0

    direction ??= dpadDirection(reading.buttons)
  }

  return { buttons, left, right, direction }
}

/**
 * How to read this pad, worked out once per device and remembered.
 *
 * Memoised because `translatePad` walks a list of profiles and this runs sixty
 * times a second per pad. The cache is dropped whole whenever main sends a new
 * list, which is also how a pad plugged in mid-session gets re-examined.
 */
function translationFor(pad: Gamepad): PadTranslation {
  const known = translations.get(pad.id)
  if (known) return known

  const translation = translatePad(
    pad.id,
    pad.mapping === 'standard',
    pad.buttons.length,
    pad.axes.length,
    padProfiles
  )
  translations.set(pad.id, translation)
  return translation
}

/** D-pad only. The stick drives the keyboard grid through its own deadzone. */
function dpadDirection(buttons: readonly boolean[]): Direction | null {
  if (buttons[12]) return 'up'
  if (buttons[13]) return 'down'
  if (buttons[14]) return 'left'
  if (buttons[15]) return 'right'
  return null
}

/** A stick resolved to one direction, the way `readDirection` does it. */
function stickDirection(x: number, y: number): Direction | null {
  // Higher than POINTER_DEADZONE: picking a key is a discrete choice and a
  // twitch must not skip two of them. Shared with the composed keyboard, which
  // is the only other thing in the launcher moving a selection on a grid.
  const gate = KEY_GRID_DEADZONE
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
    heldCompose = []
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

/**
 * The two keys X and Y reach without walking to them.
 *
 * Routed through `pressKeyboardKey` with the key from the layout rather than
 * sending the character directly, so a shortcut and the keycap it is printed on
 * can never mean two different things — which is the whole claim that badge
 * makes. Only while the keyboard is up: outside it these two are unmapped, and
 * with a bare cursor on screen the face buttons are a mouse.
 */
function onComposeAction(action: ComposeActionName): void {
  const kind = action === 'space' ? 'space' : 'enter'
  for (const row of OSK_ROWS) {
    for (const key of row) {
      if (key.kind === kind) {
        pressKeyboardKey(key)
        return
      }
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
      // **B is a backspace here, and it used to hide the keyboard.** The two
      // keyboards in this product could not both be true with B meaning one
      // thing on one and something else on the other, and a badge that lies is
      // worse than no badge. Backspace is also the more useful of the two by
      // far: this types into password fields, where a mistyped character is
      // invisible and the only correction was to walk the selection over to
      // DEL. Two ways out remain — LB + RB, the chord that opened it, and ☰,
      // which ends the mode outright — so the rule that a mode must not have a
      // single exit still holds.
      send({ kind: 'key', key: 'Backspace' })
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
    heldCompose = []
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

  // Folded every frame, acted on only while the keyboard is up — see
  // `heldCompose`. The keyboard may have been closed by one of the edges above,
  // so this reads `keyboardOpen` after them rather than before.
  const composeNow = heldActions(sample.buttons, COMPOSE_ACTIONS)
  const composeEdges = stepPointerButtons(heldCompose, composeNow)
  heldCompose = composeNow
  if (keyboardOpen) {
    for (const action of composeEdges.down) onComposeAction(action)
  }

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
 * Main replays the mode, and the look, into every new document.
 *
 * Signing in is three or four navigations and each one re-runs this file from
 * nothing. Without this the cursor would die at every step of the one flow it
 * exists for.
 *
 * The accent and the keyboard size ride the same message because this preload
 * cannot read settings — it exposes nothing and invokes nothing — and because
 * main re-sends it whenever they change, so a keyboard on screen while the
 * Settings row is touched follows rather than waiting for a navigation.
 *
 * Shape-checked rather than trusted. Not because main is a threat, but because
 * this payload was a bare boolean once, and a build that mixes the two would
 * otherwise leave `setMode` reading `active` off an object.
 */
ipcRenderer.on(POINTER_RESTORE, (_event, next: unknown) => {
  if (typeof next !== 'object' || next === null) return
  const restore = next as Partial<PointerRestore>
  if (typeof restore.active !== 'boolean') return

  if (typeof restore.accent === 'string' && typeof restore.scale === 'number') {
    look = { accent: restore.accent, scale: restore.scale }
    applyLook()
  }

  // Each field checked on its own and each one optional, for the reason the
  // block above this handler gives: this payload has now been widened twice,
  // and a half-updated build must lose one feature rather than the cursor.
  if (isPadFamily(restore.family)) family = restore.family
  if (Array.isArray(restore.pads)) {
    padProfiles = restore.pads
    // Dropped whole rather than merged: a pad that was switched on since the
    // last message has to be examined against the new list, and a pad that
    // left must not keep a translation nothing will ever clear.
    translations = new Map()
  }

  lastSample = performance.now()
  setMode(restore.active, 'restored after a navigation')
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
