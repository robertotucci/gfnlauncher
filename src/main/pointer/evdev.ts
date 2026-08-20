import { createReadStream, readFileSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import type { ReadStream } from 'node:fs'
import type { ComposeActionName, PointerActionName } from '@shared/pointer'

/**
 * Reading the pad from main, without a Gamepad API and without an ioctl.
 *
 * ── Why main has to read it at all ──────────────────────────────────────────
 *
 * Pointer mode outside our own windows is delivered by the desktop portal, and
 * the two places it is wanted most are the two where no renderer can see the
 * pad:
 *
 *  - **A game is streaming.** The launcher is `handedOff`, so its intents are
 *    suspended — correctly, and that gate is not up for negotiation.
 *  - **"Back to desktop".** The launcher is minimised, so Chromium throttles or
 *    stops its `requestAnimationFrame` altogether.
 *
 * Either way the window cannot be the source. So main reads the device.
 *
 * ── Why joydev and not evdev ────────────────────────────────────────────────
 *
 * `/dev/input/event*` would need `EVIOCGABS` to learn each axis range before a
 * raw value means anything, and an ioctl means an FFI dependency. `/dev/input/
 * js*` is the older interface and the kernel has already done that work: every
 * axis arrives **pre-scaled to ±32767**, whatever the hardware reports. Eight
 * bytes per event, a plain `read`, no native code.
 *
 * ── Why this cannot touch the UI ────────────────────────────────────────────
 *
 * **This module has exactly one consumer, `./index.ts`, and must never gain
 * another.** It is a pad reader that keeps working while a game is on screen,
 * which is precisely the situation the launcher spent a release learning not to
 * act in. There is no path from here to the renderer's intent stream and none
 * to `gfn:launch`; the only thing downstream of it is the pointer controller,
 * whose outputs are a mode toggle and the portal's `Notify*` calls. If a second
 * consumer ever appears, that invariant is gone and the bug that commit 96b4e08
 * closed is open again through a new door.
 *
 * ── Reading it costs the running game nothing ───────────────────────────────
 *
 * joydev is a broadcast interface: every open file description gets its own
 * ring buffer in the kernel, filled at event generation. Reading alongside the
 * GeForce NOW client adds one 8-byte copy per event and touches nothing on its
 * path — no grab, no exclusive access, no shared lock. (`EVIOCGRAB` would end
 * the double meaning a shared pad has during a game. It is deliberately not
 * used: it needs an ioctl, and it would leave the game with no controller at
 * all if the exit path ever broke. See ARCHITECTURE.md.)
 */

/** `struct js_event`: `__u32 time; __s16 value; __u8 type; __u8 number;` */
export const JS_EVENT_SIZE = 8

export const JS_EVENT_BUTTON = 0x01
export const JS_EVENT_AXIS = 0x02

/**
 * The bit that says "this is not something the user just did".
 *
 * joydev replays the whole current state as synthetic events the moment the
 * device is opened, each tagged with this. They have to be **adopted** as a
 * baseline and never acted on — the same rule `PAD_START` applies in the
 * renderer, and for a sharper reason here: the launcher opens this device while
 * a game may already be running, and a button the player is holding would
 * otherwise arrive as a fresh press the instant we start listening.
 */
export const JS_EVENT_INIT = 0x80

/** What the kernel scales every axis to, whatever the hardware reports. */
export const JS_AXIS_RANGE = 32767

export interface JsEvent {
  readonly kind: 'button' | 'axis'
  readonly number: number
  /** Raw: 0/1 for a button, ±32767 for an axis. */
  readonly value: number
  /** Part of the state dump joydev sends at open. Adopt, do not act. */
  readonly initial: boolean
}

/**
 * Splits a read into whole events and whatever was left over.
 *
 * A character device does not promise to hand over whole records: an 8-byte
 * struct can and does arrive across two reads. Returning the remainder rather
 * than dropping it is the difference between a pad that works and one that
 * loses an event every few hundred, which reads as flaky hardware.
 */
export function parseJsEvents(buffer: Buffer): {
  readonly events: JsEvent[]
  readonly rest: Buffer
} {
  const events: JsEvent[] = []
  let offset = 0

  while (buffer.length - offset >= JS_EVENT_SIZE) {
    // Bytes 0–3 are the timestamp, which nothing here needs: this module is
    // sampled against the reader's own clock, and a device clock that jumps
    // would be one more thing to defend against.
    const value = buffer.readInt16LE(offset + 4)
    const type = buffer.readUInt8(offset + 6)
    const number = buffer.readUInt8(offset + 7)
    offset += JS_EVENT_SIZE

    const initial = (type & JS_EVENT_INIT) !== 0
    const kind = type & ~JS_EVENT_INIT

    if (kind === JS_EVENT_BUTTON) events.push({ kind: 'button', number, value, initial })
    else if (kind === JS_EVENT_AXIS) events.push({ kind: 'axis', number, value, initial })
    // Anything else is a type this interface does not define. Skipped rather
    // than treated as a button, which is what guessing would amount to.
  }

  return { events, rest: buffer.subarray(offset) }
}

export interface PadSample {
  /** Every button currently down, by joydev number. */
  readonly buttons: ReadonlySet<number>
  /** Axes normalised to −1…1, indexed by joydev number. */
  readonly axes: readonly number[]
}

/** Scales a raw axis into −1…1, clamped: some pads overshoot their own range. */
export function normaliseAxis(value: number): number {
  return Math.max(-1, Math.min(1, value / JS_AXIS_RANGE))
}

/**
 * Folds events into a rolling state.
 *
 * Pure, and the reason it takes the previous state rather than mutating one is
 * the initial dump: adoption is not "ignore these", it is "apply them without
 * telling anyone", and that distinction only exists if applying is a separate
 * step from reporting. `changed` is what the caller reports on.
 */
export function applyJsEvents(
  state: PadSample,
  events: readonly JsEvent[]
): { readonly next: PadSample; readonly changed: boolean } {
  if (events.length === 0) return { next: state, changed: false }

  const buttons = new Set(state.buttons)
  const axes = [...state.axes]
  let changed = false

  for (const event of events) {
    if (event.kind === 'button') {
      if (event.value === 0) buttons.delete(event.number)
      else buttons.add(event.number)
    } else {
      while (axes.length <= event.number) axes.push(0)
      axes[event.number] = normaliseAxis(event.value)
    }
    // The whole point: an initial event moves the state and reports nothing.
    if (!event.initial) changed = true
  }

  return { next: { buttons, axes }, changed }
}

export const PAD_SAMPLE_EMPTY: PadSample = { buttons: new Set(), axes: [] }

// ── Which number is which button ────────────────────────────────────────────

/**
 * The kernel's own codes, from `linux/input-event-codes.h`.
 *
 * These are what a device *declares*, and they are the stable half: BTN_THUMBL
 * is 0x13d on every pad, every driver and every transport. The joydev **index**
 * it then arrives on is not stable at all, which is what the rest of this
 * section is about.
 */
export const EV_KEY = {
  a: 0x130,
  b: 0x131,
  x: 0x133,
  y: 0x134,
  lb: 0x136,
  rb: 0x137,
  select: 0x13a,
  start: 0x13b,
  mode: 0x13c,
  l3: 0x13d,
  r3: 0x13e
} as const

export const EV_ABS = {
  x: 0x00,
  y: 0x01,
  z: 0x02,
  rx: 0x03,
  ry: 0x04,
  rz: 0x05,
  hat0x: 0x10,
  hat0y: 0x11
} as const

/** joydev's two ranges, in the order it walks them. From `joydev.c`. */
const BTN_MISC = 0x100
const BTN_JOYSTICK = 0x120
const KEY_MAX = 0x2ff
const ABS_CNT = 0x40

/**
 * What one pad calls each joydev index.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * The stick clicks used to be written down as joydev 9 and 10. That is right
 * for an Xbox pad on `xpad`, the USB driver, and wrong for the same pad over
 * **Bluetooth**, where it goes through `hid-microsoft` and declares the whole
 * BTN_A…BTN_THUMBR range — including the four codes `xpad` leaves out (BTN_C,
 * BTN_Z, BTN_TL2, BTN_TR2). joydev numbers the buttons a device declares in
 * ascending code order, so those four shift everything after them: L3 and R3
 * land on **13 and 14**, and 9 and 10 become two buttons that pad can never
 * press. The chord could not fire at all, in the exact configuration a launcher
 * used from a sofa is most likely to be in. A DualSense shifts differently
 * again — 11 and 12 — because it declares its triggers as buttons as well.
 *
 * So the numbering is asked for rather than assumed, per device and at open.
 *
 * ── Where the answer comes from ─────────────────────────────────────────────
 *
 * `JSIOCGBTNMAP` would give it directly and needs an ioctl, which is the one
 * thing this whole module is arranged to avoid. It is not needed: each node's
 * `device/capabilities/` directory under `/sys/class/input` publishes the same
 * capability bitmaps joydev itself builds the map from, and its algorithm is
 * eight lines long, so it is reproduced exactly rather than guessed at.
 */
export interface PadLayout {
  /** The evdev key code at each joydev button index. */
  readonly buttons: readonly number[]
  /** The evdev abs code at each joydev axis index. */
  readonly axes: readonly number[]
}

/**
 * `unsigned long`, which is what the kernel prints these bitmaps in.
 *
 * A 32-bit process reading them on a 64-bit kernel gets `in_compat_syscall()`,
 * and the kernel splits each long into two 32-bit halves for it — so the width
 * follows *our* build rather than the machine's.
 */
export const CAPABILITY_WORD_BITS = process.arch === 'ia32' || process.arch === 'arm' ? 32 : 64

const HEX_WORD = /^[0-9a-f]+$/i

/**
 * Reads one of the capability bitmaps a device publishes under sysfs.
 *
 * The format is a run of hex words, **most significant first**, and it has two
 * traps in it. Leading empty words are skipped entirely, so the word count
 * varies by device and cannot be used to locate anything; and the words that
 * are printed are not zero-padded, so `0` and `8000000000` are both one word.
 * Only the *last* word is at a known position — it is always word 0 — which is
 * why this indexes from the end.
 */
export function parseCapabilityBitmap(
  text: string,
  wordBits: number = CAPABILITY_WORD_BITS
): Set<number> {
  const bits = new Set<number>()
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0)

  for (let index = 0; index < words.length; index += 1) {
    const word = words[words.length - 1 - index]
    // A bitmap we cannot read is worse than none: it would produce a plausible
    // layout with everything shifted. Refuse the whole thing instead.
    if (!word || !HEX_WORD.test(word)) return new Set()

    // BigInt rather than Number: a single word carries 64 bits and the top one
    // of them is well past what a double can hold exactly.
    const value = BigInt(`0x${word}`)
    for (let bit = 0; bit < wordBits; bit += 1) {
      if ((value >> BigInt(bit)) & 1n) bits.add(index * wordBits + bit)
    }
  }

  return bits
}

/**
 * joydev's own ordering, from `joydev_connect()`.
 *
 * Buttons come in two passes: everything from BTN_JOYSTICK up, ascending, and
 * *then* the BTN_MISC block below it. The order is deliberate on the kernel's
 * part — it keeps a gamepad's face buttons at index 0 on a device that also
 * declares the older joystick codes. Axes are one pass, ascending, and the
 * d-pad is in there as a pair of axes rather than four buttons on most pads.
 */
export function joydevLayout(keys: Iterable<number>, abs: Iterable<number>): PadLayout {
  const ascending = (first: number, second: number): number => first - second
  const codes = [...keys].sort(ascending)

  return {
    buttons: [
      ...codes.filter((code) => code >= BTN_JOYSTICK && code <= KEY_MAX),
      ...codes.filter((code) => code >= BTN_MISC && code < BTN_JOYSTICK)
    ],
    axes: [...abs].filter((code) => code < ABS_CNT).sort(ascending)
  }
}

/**
 * What `xpad` produces, used when the capability bitmaps cannot be read.
 *
 * A guess, and named as one — but the *best* guess: it is the layout this file
 * assumed unconditionally until the Bluetooth case proved it was not universal,
 * so falling back to it can only leave a pad no worse off than before. The
 * caller says so in the log rather than letting a cursor that does not appear
 * be the only symptom.
 */
export const XPAD_LAYOUT: PadLayout = {
  buttons: [
    EV_KEY.a,
    EV_KEY.b,
    EV_KEY.x,
    EV_KEY.y,
    EV_KEY.lb,
    EV_KEY.rb,
    EV_KEY.select,
    EV_KEY.start,
    EV_KEY.mode,
    EV_KEY.l3,
    EV_KEY.r3
  ],
  axes: [
    EV_ABS.x,
    EV_ABS.y,
    // ABS_Z is the left trigger here, not the right stick. Getting this wrong
    // once meant a cursor that drifted whenever a trigger rested off centre.
    EV_ABS.z,
    EV_ABS.rx,
    EV_ABS.ry,
    EV_ABS.rz,
    EV_ABS.hat0x,
    EV_ABS.hat0y
  ]
}

// ── What the pad is doing, in terms nothing downstream has to decode ────────

export interface PadAxes {
  readonly leftX: number
  readonly leftY: number
  readonly rightX: number
  readonly rightY: number
  /** −1, 0 or 1. The d-pad, however this pad happens to report it. */
  readonly dpadX: number
  readonly dpadY: number
}

/**
 * One reading, folded across every pad and stated in evdev codes.
 *
 * Codes rather than indices, because indices are per device: two pads of
 * different makes both report a button 9 and they are not the same button, so
 * a set of indices from more than one device cannot be folded into anything
 * meaningful. This is the only shape that leaves this module.
 */
export interface PadReading {
  /** Every button down anywhere, as an evdev key code. */
  readonly buttons: ReadonlySet<number>
  readonly axes: PadAxes
}

export const PAD_READING_EMPTY: PadReading = {
  buttons: new Set(),
  axes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0, dpadX: 0, dpadY: 0 }
}

/**
 * The d-pad codes for a pad that reports it as four buttons.
 *
 * Most report it as a pair of hat *axes* and this is unused; a DualSense on
 * `hid-playstation` reports it as BTN_DPAD_UP…RIGHT, which arrive as four more
 * joydev buttons after the gamepad block. Both have to fold to the same pair of
 * numbers or the on-screen keyboard is undrivable on half the pads in the room.
 */
const EV_DPAD = { up: 0x220, down: 0x221, left: 0x222, right: 0x223 } as const

/** The two axes a stick is on, or null when the device does not have both. */
function stickPair(layout: PadLayout, x: number, y: number): { x: number; y: number } | null {
  const first = layout.axes.indexOf(x)
  const second = layout.axes.indexOf(y)
  return first === -1 || second === -1 ? null : { x: first, y: second }
}

/**
 * Translates one device's raw sample through its layout.
 *
 * The right stick is the only judgement call in here, and it is the same one
 * SDL makes: **ABS_RX/ABS_RY when the device has both**, which is where `xpad`
 * and `hid-playstation` put it, and ABS_Z/ABS_RZ otherwise, which is where an
 * Xbox pad over Bluetooth puts it — that pad spends ABS_RX and ABS_RY on
 * nothing and its triggers on ABS_GAS and ABS_BRAKE. Reading the pair the wrong
 * way round means a page that scrolls when a trigger is squeezed.
 *
 * The d-pad is resolved to the same pair of numbers whichever way the pad sends
 * it — hat axes on an Xbox pad, four buttons on a DualSense — because the thing
 * downstream of it is a keyboard grid, and a keyboard nobody can move around is
 * not a keyboard. The triggers are deliberately left out: nothing reads them,
 * and an unread field is one more thing to keep true.
 */
export function readPad(layout: PadLayout, state: PadSample): PadReading {
  const buttons = new Set<number>()
  for (const index of state.buttons) {
    const code = layout.buttons[index]
    if (code !== undefined) buttons.add(code)
  }

  const left = stickPair(layout, EV_ABS.x, EV_ABS.y)
  const right = stickPair(layout, EV_ABS.rx, EV_ABS.ry) ?? stickPair(layout, EV_ABS.z, EV_ABS.rz)
  const hat = stickPair(layout, EV_ABS.hat0x, EV_ABS.hat0y)
  const value = (index: number | undefined): number =>
    index === undefined ? 0 : (state.axes[index] ?? 0)

  /** Buttons win over an absent hat, and a hat at rest reads as the buttons do. */
  const dpad = (axis: number | undefined, low: number, high: number): number => {
    const held = (buttons.has(high) ? 1 : 0) - (buttons.has(low) ? 1 : 0)
    if (held !== 0) return held
    return Math.sign(value(axis))
  }

  return {
    buttons,
    axes: {
      leftX: value(left?.x),
      leftY: value(left?.y),
      rightX: value(right?.x),
      rightY: value(right?.y),
      dpadX: dpad(hat?.x, EV_DPAD.left, EV_DPAD.right),
      dpadY: dpad(hat?.y, EV_DPAD.up, EV_DPAD.down)
    }
  }
}

/**
 * Folds several pads into one reading.
 *
 * Buttons union and the largest deflection wins on each axis, which is the same
 * rule `readPads` uses in the preload: a machine with a pad and a flight stick
 * plugged in reports both, the one somebody picked up may not be the first, and
 * two pads at rest must not cancel out the one being pushed.
 */
export function mergePadReadings(readings: Iterable<PadReading>): PadReading {
  const buttons = new Set<number>()
  const axes = { leftX: 0, leftY: 0, rightX: 0, rightY: 0, dpadX: 0, dpadY: 0 }

  for (const reading of readings) {
    for (const code of reading.buttons) buttons.add(code)
    for (const name of ['leftX', 'leftY', 'rightX', 'rightY', 'dpadX', 'dpadY'] as const) {
      if (Math.abs(reading.axes[name]) > Math.abs(axes[name])) axes[name] = reading.axes[name]
    }
  }

  return { buttons, axes }
}

// ── What the pad means, on this side of the boundary ────────────────────────

/**
 * The chord, and the buttons under the cursor, as the kernel names them.
 *
 * The twins of `CHORD_BUTTONS`, `KEYBOARD_CHORD_BUTTONS` and `POINTER_ACTIONS`
 * in `@shared/pointer`, which are the same decisions in the **W3C** numbering
 * the browser reports. Two tables rather than one because there is no number
 * both interfaces agree on for a given button — the W3C layout is a fixed
 * table, and joydev's is whatever the device declared. They are kept here, next
 * to the reader, because an evdev code is a kernel detail and no other process
 * has any business holding one.
 */
export const CHORD_BUTTONS_EVDEV: readonly number[] = [EV_KEY.l3, EV_KEY.r3]

/** LB + RB, which asks for the on-screen keyboard. */
export const KEYBOARD_CHORD_BUTTONS_EVDEV: readonly number[] = [EV_KEY.lb, EV_KEY.rb]

/** A clicks, B right-clicks, ☰ is the second way out. */
export const POINTER_ACTIONS_EVDEV: Readonly<Record<number, PointerActionName>> = {
  [EV_KEY.a]: 'leftClick',
  [EV_KEY.b]: 'rightClick',
  [EV_KEY.start]: 'exit'
}

/**
 * X and Y, which reach SPACE and SEND without walking to them.
 *
 * The twin of `COMPOSE_ACTIONS`, and read **only** while the on-screen keyboard
 * is in front. Outside it these two codes are unmapped and must stay that way:
 * with a bare cursor up the face buttons are a mouse.
 *
 * `EV_KEY.x` is `BTN_WEST` and `EV_KEY.y` is `BTN_NORTH` — codes, not indices,
 * for the reason the block above gives. The pad that broke L3 + R3 numbers
 * these differently again.
 */
export const COMPOSE_ACTIONS_EVDEV: Readonly<Record<number, ComposeActionName>> = {
  [EV_KEY.x]: 'space',
  [EV_KEY.y]: 'send'
}

// ── The shell ───────────────────────────────────────────────────────────────

const INPUT_DIR = '/dev/input'
const SYSFS_INPUT = '/sys/class/input'
const JS_NODE = /^js\d+$/

/** The joystick devices present right now. Empty is the normal case at boot. */
export function listJoystickNodes(dir = INPUT_DIR): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => JS_NODE.test(name))
      .sort()
  } catch {
    // No /dev/input at all, or no permission. Both mean "no pad here", which
    // is a state this has to survive rather than report.
    return []
  }
}

/**
 * Asks the kernel what this device's buttons and axes actually are.
 *
 * Null when the bitmaps are missing or unreadable — a sandbox without `/sys`,
 * a node that went away between the readdir and here — and the caller falls
 * back to `XPAD_LAYOUT` out loud. Both files are read before either is trusted,
 * because half a layout is a shifted one.
 */
export function readPadLayout(node: string, root = SYSFS_INPUT): PadLayout | null {
  try {
    const capabilities = `${root}/${node}/device/capabilities`
    const keys = parseCapabilityBitmap(readFileSync(`${capabilities}/key`, 'utf8'))
    const abs = parseCapabilityBitmap(readFileSync(`${capabilities}/abs`, 'utf8'))
    const layout = joydevLayout(keys, abs)
    // A device with no buttons or no axes is not one this can drive a cursor
    // with, and an empty layout is also what a bitmap we failed to parse looks
    // like. Either way it is not an answer.
    return layout.buttons.length === 0 || layout.axes.length === 0 ? null : layout
  } catch {
    return null
  }
}

/** The model name, for the one line the log gets per pad. Never a secret. */
function readPadName(node: string, root = SYSFS_INPUT): string {
  try {
    return readFileSync(`${root}/${node}/device/name`, 'utf8').trim() || 'unnamed'
  } catch {
    return 'unnamed'
  }
}

export interface PadReader {
  /** The current reading, folded across every open device. */
  sample(): PadReading
  /** How many devices are open right now. Zero is the normal case at boot. */
  connected(): number
  close(): void
}

/**
 * Opens every joystick device and keeps following the ones that appear later.
 *
 * Hot-plug matters more than it looks: a pad switched on after the launcher
 * started is the common case on a machine that boots to a television, and it is
 * the exact scenario `padAccess.ts` documents from the other side.
 *
 * Disposal is the caller's, from the `will-quit` handler, per the rule that
 * long-lived work must never be the reason the app cannot quit. The watcher is
 * `unref`'d; the device streams cannot be, and the comment at that line says
 * why.
 */
export function openPadReader(
  onChange: () => void,
  dir = INPUT_DIR,
  sysfs = SYSFS_INPUT
): PadReader {
  /**
   * One entry per device, and the state is **per device** rather than shared.
   *
   * It has to be: joydev indices only mean something next to the layout of the
   * device that produced them, so a second pad folding its button 9 into the
   * same set as the first pad's is two different buttons in one number.
   */
  const open = new Map<string, { stream: ReadStream; layout: PadLayout; state: PadSample }>()
  let watcher: FSWatcher | null = null
  let closed = false

  const attach = (name: string): void => {
    if (closed || open.has(name)) return

    let stream: ReadStream
    try {
      stream = createReadStream(`${dir}/${name}`)
    } catch (error) {
      console.warn(`Could not open ${name} for pointer mode:`, error)
      return
    }

    const layout = readPadLayout(name, sysfs)
    if (!layout) {
      console.warn(
        `Could not read ${sysfs}/${name}/device/capabilities; assuming the xpad ` +
          'button layout for it. If L3 + R3 does nothing with this pad, that guess is why.'
      )
    }

    const entry = { stream, layout: layout ?? XPAD_LAYOUT, state: PAD_SAMPLE_EMPTY }
    open.set(name, entry)

    // One line per pad, and it names the two numbers this module got wrong for
    // a release: with them in the log, "the chord does nothing" is one grep
    // rather than an afternoon with a kernel header.
    const l3 = entry.layout.buttons.indexOf(EV_KEY.l3)
    const r3 = entry.layout.buttons.indexOf(EV_KEY.r3)
    console.info(
      `Pad ${name} (${readPadName(name, sysfs)}): ${entry.layout.buttons.length} buttons, ` +
        `${entry.layout.axes.length} axes, ` +
        (l3 === -1 || r3 === -1
          ? 'and no stick clicks at all — L3 + R3 cannot be pressed on this one'
          : `L3 + R3 at ${l3} and ${r3}`)
    )

    // No `unref` here, and it is not an oversight: `fs.ReadStream` has none —
    // reads on a character device go through the thread pool, which offers no
    // handle to detach. What keeps this from holding the app open is `close()`,
    // called from the `will-quit` handler in index.ts. The watcher below *can*
    // be unref'd and is.
    let rest: Buffer = Buffer.alloc(0)

    stream.on('data', (chunk) => {
      const parsed = parseJsEvents(
        Buffer.concat([rest, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      )
      rest = parsed.rest

      const applied = applyJsEvents(entry.state, parsed.events)
      entry.state = applied.next
      // Only real input wakes the consumer. The state dump joydev sends on open
      // has already been folded in above and must not look like a press.
      if (applied.changed) onChange()
    })

    const drop = (): void => {
      open.delete(name)
      stream.destroy()
    }

    // A pad unplugged mid-session ends the stream with ENODEV. Ordinary, not an
    // error worth a line — the launcher is used with pads that sleep.
    stream.on('error', drop)
    stream.on('close', () => open.delete(name))
  }

  for (const name of listJoystickNodes(dir)) attach(name)

  try {
    watcher = watch(dir, (_event, filename) => {
      if (typeof filename === 'string' && JS_NODE.test(filename)) attach(filename)
    })
    watcher.unref()
  } catch (error) {
    // Without a watcher, pads present at start still work and later ones do
    // not. Worth saying so: the symptom is "it works only if the pad was
    // already on", which is the same sentence padAccess.ts exists for and
    // would otherwise send somebody to the wrong fix.
    console.warn(
      `Cannot watch ${dir} for new pads; a controller connected after start ` +
        'will not drive the desktop pointer:',
      error
    )
  }

  return {
    sample: () =>
      mergePadReadings(
        [...open.values()].map((entry) => readPad(entry.layout, entry.state))
      ),
    connected: () => open.size,
    close: () => {
      closed = true
      watcher?.close()
      for (const entry of open.values()) entry.stream.destroy()
      open.clear()
    }
  }
}
