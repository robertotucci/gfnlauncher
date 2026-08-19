/**
 * Pointer mode: the pad standing in for a mouse and a keyboard.
 *
 * ── What this exists for ────────────────────────────────────────────────────
 *
 * Four places in this product cannot be reached with a pad, and `ipc.ts` says
 * so out loud about the first: NVIDIA's login page, the hosted web player, the
 * desktop behind a minimised launcher, and — the one that strands a session —
 * a Steam EULA or updater *inside* a stream. All four want the same answer, so
 * they get one: hold L3 and R3, and the stick becomes a cursor.
 *
 * ── Why the logic is here rather than where it is used ──────────────────────
 *
 * Three processes need the same arithmetic and none of them can be tested where
 * they live: the launcher's renderer, the bridgeless preload that drives the
 * third-party windows, and main's own evdev reader. So the fold is pure and it
 * sits in `@shared`, which every one of the three can import — the same bargain
 * `stepPad` and `stepHandback` make, and for the same reason: the suite has no
 * DOM, no pad and no compositor.
 *
 * Everything here takes its clock as an argument. Nothing reads `Date.now()`.
 */

/**
 * Which way something is being pushed.
 *
 * Deliberately re-declared rather than imported from
 * `src/renderer/src/gamepad/intents.ts`: that module is the renderer's focus
 * model and the preload cannot see it. TypeScript is structural, so the two are
 * interchangeable at every call site, and the alternative — dragging the focus
 * model into `@shared` so a cursor could borrow four strings — would couple two
 * things that have no business knowing about each other.
 */
export type Direction = 'up' | 'down' | 'left' | 'right'

// ── The chord ───────────────────────────────────────────────────────────────

/**
 * L3 and R3 in the W3C standard layout.
 *
 * Chosen because they are the only pair that is *free*: `BUTTON_ACTIONS` in
 * `intents.ts` maps 0–5 and 9, so a chord built from any of those would have to
 * suppress the actions it is made of, and the suppression would live inside
 * `stepPad` — the one fold in this repository that must stay simple enough to
 * reason about at a glance. Nothing here touches it.
 *
 * It is also what Steam Deck and Big Picture use, so it is already in the
 * fingers of the person this launcher is for.
 */
export const CHORD_BUTTONS: readonly number[] = [10, 11]

/**
 * The same pair as joydev numbers them, which is **not** the same pair.
 *
 * `/dev/input/js*` predates the W3C mapping and counts differently: Back is 6,
 * Start is 7, Guide is 8, and the stick clicks land on 9 and 10. Reading the
 * W3C indices off joydev would give L3 + Guide, which on most pads is the
 * button that opens the Steam overlay.
 */
export const CHORD_BUTTONS_JOYDEV: readonly number[] = [9, 10]

/**
 * How long both have to be down before the mode flips.
 *
 * Not an instant toggle, and the reason is the streaming case. The GeForce NOW
 * client reads the pad for itself and forwards it to the remote machine — we
 * cannot stop it and deliberately do not try (see ARCHITECTURE.md; `EVIOCGRAB`
 * was considered and rejected). So during a game every press means two things
 * at once, and a bare click of both sticks is something plenty of games do on
 * purpose. A deliberate hold is the difference between a feature and a cursor
 * that appears in the middle of a firefight.
 */
export const CHORD_HOLD_MS = 600

/**
 * The shoulder pair, which raises and lowers the on-screen keyboard.
 *
 * **The same two numbers on both interfaces**, unlike the stick clicks: LB and
 * RB are 4 and 5 in the W3C mapping and 4 and 5 on joydev. One constant, and
 * the coincidence is asserted in the suite so a future reader does not "fix" it
 * into a second table.
 *
 * A pair rather than a single button because inside pointer mode the face
 * buttons are already a mouse — A and B are the two clicks — and the shoulders
 * are the only thing left that is symmetrical enough to be remembered next to
 * L3 + R3.
 */
export const KEYBOARD_CHORD_BUTTONS: readonly number[] = [4, 5]

/**
 * Pressed, not held.
 *
 * L3 + R3 needs a deliberate hold because during a game it means something to
 * the game as well. This one only exists *inside* pointer mode, where nothing
 * else is listening to the shoulders at all, so making the user wait would be
 * caution with nothing to be cautious about.
 */
export const KEYBOARD_CHORD_HOLD_MS = 0

/**
 * Beyond this, the previous sample is history rather than context.
 *
 * The twin of `MAX_FRAME_GAP_MS` in `pad.ts`, and it exists for the same
 * reason: `requestAnimationFrame` can be throttled for a window nobody is
 * looking at, and a hold measured against a reading from an unknown time ago is
 * not a hold. Without it, a stall of a second while the pair happened to be
 * down would fire the toggle the instant the loop woke up.
 */
export const MAX_SAMPLE_GAP_MS = 250

export interface ChordState {
  /** When the pair was first seen down, or null when it is not. */
  readonly since: number | null
  /** Already toggled for this hold. Cleared only by letting go. */
  readonly fired: boolean
  /**
   * Whether the pair has been seen *released* since this state began.
   *
   * The adoption rule, and it is `stepPad`'s: a launcher that comes up with
   * both sticks already clicked must not toggle, and neither must one whose
   * reader was armed while somebody happened to be holding them.
   */
  readonly armed: boolean
  /** When the last sample was, on the same clock. */
  readonly at: number
}

export interface ChordStep {
  readonly next: ChordState
  /** True on exactly one sample per hold. */
  readonly toggle: boolean
}

export const CHORD_START: ChordState = {
  since: null,
  fired: false,
  armed: false,
  at: Number.NEGATIVE_INFINITY
}

/** Whether every button of a chord is down, given the set that is. */
export function chordHeld(pressed: Iterable<number>, chord = CHORD_BUTTONS): boolean {
  const down = pressed instanceof Set ? pressed : new Set(pressed)
  return chord.every((index) => down.has(index))
}

/**
 * One sample of "are both stick clicks down" folded into a toggle.
 *
 * Total, and pure. The toggle fires once and then waits for the release, so
 * holding the pair does not flip the mode sixty times a second — which is not a
 * hypothetical: the first thing anybody does with a new chord is hold it to see
 * what happens.
 */
export function stepChord(
  state: ChordState,
  held: boolean,
  now: number,
  holdMs: number = CHORD_HOLD_MS
): ChordStep {
  // Let go. This is also the only thing that arms the chord, so a pair that was
  // already down when this state was created stays inert until it is released.
  if (!held) {
    return { next: { since: null, fired: false, armed: true, at: now }, toggle: false }
  }

  if (!state.armed) return { next: { ...state, at: now }, toggle: false }

  // A gap means we did not watch the hold, so we cannot claim to have timed it.
  // Restart the clock rather than credit the user with the time we missed.
  const stalled = now - state.at > MAX_SAMPLE_GAP_MS
  const since = stalled || state.since === null ? now : state.since
  const fired = stalled ? false : state.fired

  if (fired || now - since < holdMs) {
    return { next: { since, fired, armed: true, at: now }, toggle: false }
  }

  return { next: { since, fired: true, armed: true, at: now }, toggle: true }
}

// ── The cursor ──────────────────────────────────────────────────────────────

/**
 * Far tighter than `STICK_DEADZONE`, and the difference is the point.
 *
 * The UI's deadzone is 0.55 because a grid only has to answer "which way", and
 * a pad at rest must never walk it. A cursor has to answer "how far", and 0.55
 * would throw away the whole first half of the stick's travel — the half that
 * does the fine positioning on a login field.
 */
export const POINTER_DEADZONE = 0.16

/** Slowest deliberate crawl, in CSS pixels per second, just past the deadzone. */
export const POINTER_MIN_SPEED = 55

/** Flat out. Crosses a 4K width in about a second and a half. */
export const POINTER_MAX_SPEED = 2_100

/**
 * The response curve.
 *
 * Above one, so the low end of the travel stays slow and most of the speed
 * arrives in the last third: a linear stick is impossible to place a cursor
 * with, because the same wrist movement that reaches a button also overshoots
 * it. Squared-and-a-half is the shape that lets one stick do both jobs.
 */
export const POINTER_ACCELERATION = 2.5

/** Caps the jump after a stall, for the reason `MAX_SAMPLE_GAP_MS` exists. */
export const MAX_STEP_MS = 100

export interface PointerBounds {
  readonly width: number
  readonly height: number
}

export interface PointerState {
  readonly x: number
  readonly y: number
  readonly at: number
}

/**
 * Speed for one stick magnitude, in pixels per second. Zero inside the deadzone.
 *
 * Split out from `stepPointer` because it is the part with a shape worth
 * asserting: that it is zero at rest, continuous at the deadzone edge rather
 * than jumping straight to a crawl, and monotonic all the way up.
 */
export function pointerSpeed(magnitude: number): number {
  if (magnitude <= POINTER_DEADZONE) return 0
  const travel = Math.min(1, (magnitude - POINTER_DEADZONE) / (1 - POINTER_DEADZONE))
  return POINTER_MIN_SPEED + (POINTER_MAX_SPEED - POINTER_MIN_SPEED) * travel ** POINTER_ACCELERATION
}

/**
 * Moves the cursor by one sample of stick, clamped to the surface it is on.
 *
 * `at` is carried in the state rather than measured here so the whole thing
 * stays a fold: the caller owns the clock, the test owns the timeline.
 */
export function stepPointer(
  state: PointerState,
  stick: { readonly x: number; readonly y: number },
  bounds: PointerBounds,
  now: number
): PointerState {
  const dt = Math.min(MAX_STEP_MS, Math.max(0, now - state.at)) / 1_000
  const magnitude = Math.hypot(stick.x, stick.y)
  const speed = pointerSpeed(magnitude)

  if (speed === 0 || dt === 0) {
    return { x: clamp(state.x, bounds.width), y: clamp(state.y, bounds.height), at: now }
  }

  // Normalised, so a diagonal is not √2 faster than a straight push.
  const step = (speed * dt) / magnitude
  return {
    x: clamp(state.x + stick.x * step, bounds.width),
    y: clamp(state.y + stick.y * step, bounds.height),
    at: now
  }
}

/**
 * Inclusive of the far edge minus one, so the cursor can always sit *on* a
 * surface rather than one pixel past it — a click at `width` lands nowhere.
 */
function clamp(value: number, size: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(0, value), Math.max(0, size - 1))
}

/** Where a cursor starts when the mode is switched on: the middle of the surface. */
export function centreOf(bounds: PointerBounds, now: number): PointerState {
  return { x: Math.floor(bounds.width / 2), y: Math.floor(bounds.height / 2), at: now }
}

// ── Scrolling ───────────────────────────────────────────────────────────────

/** Lines per second at full deflection, in CSS pixels. */
export const SCROLL_MAX_SPEED = 1_400

/**
 * Wheel movement for one sample of the right stick, in pixels.
 *
 * Sign convention is the browser's: a positive `deltaY` scrolls the content
 * down, which is what pushing the stick down should do. Linear rather than
 * accelerated — a page is read at a steady pace and the overshoot that ruins a
 * cursor is harmless here.
 */
export function scrollDelta(axis: number, dtMs: number): number {
  if (Math.abs(axis) <= POINTER_DEADZONE) return 0
  const travel =
    (Math.abs(axis) - POINTER_DEADZONE) / (1 - POINTER_DEADZONE)
  const dt = Math.min(MAX_STEP_MS, Math.max(0, dtMs)) / 1_000
  return Math.sign(axis) * Math.min(1, travel) * SCROLL_MAX_SPEED * dt
}

// ── Buttons ─────────────────────────────────────────────────────────────────

export type PointerActionName = 'leftClick' | 'rightClick' | 'exit'

/**
 * What each face button does while the cursor is up.
 *
 * A and B keep their shape — confirm and cancel become the two mouse buttons —
 * and ☰ is the second way out, because a mode with one exit is a mode somebody
 * will get stuck in.
 *
 * **The keyboard is not here.** It was on X, on the reasoning that X already
 * means typing on the grid, and that turned out to be the wrong instinct: with
 * a cursor on screen the face buttons read as mouse buttons, and a third one
 * that does something else entirely is a button nobody finds. It is
 * `KEYBOARD_CHORD_BUTTONS` now — a shoulder pair, symmetrical with the chord
 * that opened the mode in the first place.
 */
export const POINTER_ACTIONS: Readonly<Record<number, PointerActionName>> = {
  0: 'leftClick',
  1: 'rightClick',
  9: 'exit'
}

/** The same map for joydev's numbering. Faces agree; only ☰ moves. */
export const POINTER_ACTIONS_JOYDEV: Readonly<Record<number, PointerActionName>> = {
  0: 'leftClick',
  1: 'rightClick',
  7: 'exit'
}

/**
 * Which actions started and which ended between two samples.
 *
 * Edges rather than levels, because a click is `mouseDown` then `mouseUp` and a
 * drag is the gap between them — holding A across ten frames must not send ten
 * presses, and letting go must send exactly one release.
 */
export function stepPointerButtons(
  previous: readonly PointerActionName[],
  current: readonly PointerActionName[]
): { readonly down: PointerActionName[]; readonly up: PointerActionName[] } {
  return {
    down: current.filter((action) => !previous.includes(action)),
    up: previous.filter((action) => !current.includes(action))
  }
}

/** Reads the actions a pad is holding, given a button map. */
export function heldActions(
  pressed: Iterable<number>,
  actions: Readonly<Record<number, PointerActionName>> = POINTER_ACTIONS
): PointerActionName[] {
  const held: PointerActionName[] = []
  for (const index of pressed) {
    const action = actions[index]
    if (action && !held.includes(action)) held.push(action)
  }
  return held
}

// ── What crosses the boundary ───────────────────────────────────────────────

/**
 * One thing the pointer wants done, as it travels preload → main.
 *
 * The commands are deliberately coarse and absolute: every one that touches the
 * page carries the coordinates it happens at, so main never has to keep a
 * cursor of its own in step with the one the user can see. A dropped message
 * then costs a frame rather than desynchronising the two.
 */
export type PointerCommand =
  | { readonly kind: 'mode'; readonly active: boolean }
  | { readonly kind: 'move'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'button'
      readonly button: 'left' | 'right'
      readonly down: boolean
      readonly x: number
      readonly y: number
    }
  | { readonly kind: 'wheel'; readonly x: number; readonly y: number; readonly deltaY: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'key'; readonly key: PointerKeyName }

/**
 * The named keys the on-screen keyboard can send.
 *
 * An allow-list rather than an arbitrary string, because this crosses a process
 * boundary and lands in `sendInputEvent`. Nothing outside a text field's needs
 * belongs here — and in particular nothing that could carry a modifier.
 */
export const POINTER_KEYS = ['Backspace', 'Enter', 'Tab', 'Escape'] as const
export type PointerKeyName = (typeof POINTER_KEYS)[number]

/** A single printable character. Longer strings are somebody replaying a paste. */
const MAX_TEXT_LENGTH = 1

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validates a command arriving from a preload.
 *
 * On the main side, as CONTRIBUTING requires of everything crossing the bridge.
 * This particular boundary deserves it more than most: the windows this listens
 * for are the ones rendering somebody else's login page, and while context
 * isolation means the page cannot reach `ipcRenderer` at all, the cost of being
 * wrong about that is a page that can synthesise trusted input into itself.
 */
export function isPointerCommand(value: unknown): value is PointerCommand {
  if (typeof value !== 'object' || value === null) return false
  const command = value as { kind?: unknown }

  switch (command.kind) {
    case 'mode':
      return typeof (value as { active?: unknown }).active === 'boolean'
    case 'move': {
      const { x, y } = value as { x?: unknown; y?: unknown }
      return isCoordinate(x) && isCoordinate(y)
    }
    case 'button': {
      const { button, down, x, y } = value as {
        button?: unknown
        down?: unknown
        x?: unknown
        y?: unknown
      }
      return (
        (button === 'left' || button === 'right') &&
        typeof down === 'boolean' &&
        isCoordinate(x) &&
        isCoordinate(y)
      )
    }
    case 'wheel': {
      const { x, y, deltaY } = value as { x?: unknown; y?: unknown; deltaY?: unknown }
      return isCoordinate(x) && isCoordinate(y) && isCoordinate(deltaY)
    }
    case 'text': {
      const { text } = value as { text?: unknown }
      return typeof text === 'string' && text.length > 0 && text.length <= MAX_TEXT_LENGTH
    }
    case 'key': {
      const { key } = value as { key?: unknown }
      return POINTER_KEYS.includes(key as PointerKeyName)
    }
    default:
      return false
  }
}
