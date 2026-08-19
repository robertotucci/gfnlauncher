import { createReadStream, readdirSync, watch, type FSWatcher } from 'node:fs'
import type { ReadStream } from 'node:fs'

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

/**
 * Which joydev axis is which.
 *
 * **Not the W3C layout.** The browser reports four stick axes and puts the
 * d-pad on buttons 12–15; joydev exposes the raw kernel axes, so the triggers
 * sit between the sticks and the d-pad is a pair of axes. This is the ordering
 * `xpad` and `hid-playstation` both produce — ABS_X, ABS_Y, ABS_Z, ABS_RX,
 * ABS_RY, ABS_RZ, ABS_HAT0X, ABS_HAT0Y — which covers every Xbox-protocol pad,
 * every DualShock/DualSense on the in-tree driver, and 8BitDo in XInput mode.
 */
export const JOYDEV_AXES = {
  leftX: 0,
  leftY: 1,
  /** ABS_Z — the left trigger, not the right stick. Getting this wrong once
   * meant the cursor drifted whenever a trigger was resting off centre. */
  leftTrigger: 2,
  rightX: 3,
  rightY: 4,
  rightTrigger: 5,
  dpadX: 6,
  dpadY: 7
} as const

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

// ── The shell ───────────────────────────────────────────────────────────────

const INPUT_DIR = '/dev/input'
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

export interface PadReader {
  /** The current state, folded across every open device. */
  sample(): PadSample
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
export function openPadReader(onChange: () => void, dir = INPUT_DIR): PadReader {
  let state = PAD_SAMPLE_EMPTY
  const open = new Map<string, ReadStream>()
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

    open.set(name, stream)

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

      const applied = applyJsEvents(state, parsed.events)
      state = applied.next
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
    sample: () => state,
    close: () => {
      closed = true
      watcher?.close()
      for (const stream of open.values()) stream.destroy()
      open.clear()
    }
  }
}
