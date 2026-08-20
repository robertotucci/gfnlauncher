import { describe, expect, it } from 'vitest'
import {
  CHORD_BUTTONS_EVDEV,
  EV_ABS,
  EV_KEY,
  JS_AXIS_RANGE,
  JS_EVENT_AXIS,
  JS_EVENT_BUTTON,
  JS_EVENT_INIT,
  JS_EVENT_SIZE,
  KEYBOARD_CHORD_BUTTONS_EVDEV,
  PAD_SAMPLE_EMPTY,
  POINTER_ACTIONS_EVDEV,
  XPAD_LAYOUT,
  applyJsEvents,
  joydevLayout,
  mergePadReadings,
  normaliseAxis,
  parseCapabilityBitmap,
  parseJsEvents,
  readPad,
  type PadLayout,
  type PadSample
} from './evdev'
import { CHORD_BUTTONS, KEYBOARD_CHORD_BUTTONS, chordHeld, heldActions } from '@shared/pointer'

/** Builds one `struct js_event` exactly as the kernel writes it. */
function jsEvent({
  time = 0,
  value,
  type,
  number
}: {
  time?: number
  value: number
  type: number
  number: number
}): Buffer {
  const buffer = Buffer.alloc(JS_EVENT_SIZE)
  buffer.writeUInt32LE(time, 0)
  buffer.writeInt16LE(value, 4)
  buffer.writeUInt8(type, 6)
  buffer.writeUInt8(number, 7)
  return buffer
}

const button = (number: number, down: boolean, initial = false): Buffer =>
  jsEvent({ value: down ? 1 : 0, type: JS_EVENT_BUTTON | (initial ? JS_EVENT_INIT : 0), number })

const axis = (number: number, value: number, initial = false): Buffer =>
  jsEvent({ value, type: JS_EVENT_AXIS | (initial ? JS_EVENT_INIT : 0), number })

/** Folds a set of buffers through the parser and the reducer, in one go. */
function feed(state: PadSample, ...buffers: Buffer[]): ReturnType<typeof applyJsEvents> {
  const { events } = parseJsEvents(Buffer.concat(buffers))
  return applyJsEvents(state, events)
}

describe('parseJsEvents', () => {
  it('reads the eight-byte struct the kernel writes', () => {
    const { events, rest } = parseJsEvents(button(3, true))

    expect(events).toEqual([{ kind: 'button', number: 3, value: 1, initial: false }])
    expect(rest).toHaveLength(0)
  })

  it('reads an axis at full deflection', () => {
    const { events } = parseJsEvents(axis(1, -JS_AXIS_RANGE))
    expect(events[0]).toEqual({ kind: 'axis', number: 1, value: -JS_AXIS_RANGE, initial: false })
  })

  it('reads several events out of one read', () => {
    const { events } = parseJsEvents(Buffer.concat([button(0, true), axis(0, 100), button(0, false)]))
    expect(events).toHaveLength(3)
  })

  it('keeps a partial event for the next read instead of dropping it', () => {
    // A character device does not promise whole records. Dropping the tail
    // loses roughly one event in a few hundred, which reads as flaky hardware.
    const whole = button(5, true)
    const first = parseJsEvents(whole.subarray(0, 5))
    expect(first.events).toEqual([])
    expect(first.rest).toHaveLength(5)

    const second = parseJsEvents(Buffer.concat([first.rest, whole.subarray(5)]))
    expect(second.events).toEqual([{ kind: 'button', number: 5, value: 1, initial: false }])
    expect(second.rest).toHaveLength(0)
  })

  it('flags the state dump joydev sends when the device is opened', () => {
    const { events } = parseJsEvents(Buffer.concat([button(0, true, true), axis(2, 0, true)]))
    expect(events.every((event) => event.initial)).toBe(true)
    // The INIT bit must not leak into the kind, or every synthetic event would
    // be an unknown type and the baseline would be empty.
    expect(events.map((event) => event.kind)).toEqual(['button', 'axis'])
  })

  it('skips an event type this interface does not define', () => {
    const { events } = parseJsEvents(jsEvent({ value: 1, type: 0x04, number: 0 }))
    expect(events).toEqual([])
  })

  it('returns nothing for an empty read', () => {
    expect(parseJsEvents(Buffer.alloc(0))).toEqual({ events: [], rest: Buffer.alloc(0) })
  })
})

describe('normaliseAxis', () => {
  it('scales the kernel range to −1…1', () => {
    expect(normaliseAxis(0)).toBe(0)
    expect(normaliseAxis(JS_AXIS_RANGE)).toBe(1)
    expect(normaliseAxis(-JS_AXIS_RANGE)).toBe(-1)
    expect(normaliseAxis(JS_AXIS_RANGE / 2)).toBeCloseTo(0.5, 4)
  })

  it('clamps a pad that overshoots its own range', () => {
    // −32768 is representable in the int16 the struct carries, and some pads
    // send it. Unclamped it becomes −1.00003, which is a cursor that creeps.
    expect(normaliseAxis(-32768)).toBe(-1)
    expect(normaliseAxis(40_000)).toBe(1)
  })
})

describe('applyJsEvents', () => {
  it('tracks buttons going down and coming back up', () => {
    let state = feed(PAD_SAMPLE_EMPTY, button(0, true), button(4, true)).next
    expect([...state.buttons].sort()).toEqual([0, 4])

    state = feed(state, button(0, false)).next
    expect([...state.buttons]).toEqual([4])
  })

  it('tracks axes, normalised', () => {
    const { next } = feed(PAD_SAMPLE_EMPTY, axis(1, -JS_AXIS_RANGE))
    expect(next.axes[1]).toBe(-1)
  })

  it('adopts the opening state dump without reporting a change', () => {
    // The failure this exists for: the launcher opens the device while a game
    // is running and the player is holding a button. Reported as a change, that
    // is a press nobody made — and the button in question might be half a
    // chord.
    const { next, changed } = feed(
      PAD_SAMPLE_EMPTY,
      button(9, true, true),
      button(10, true, true),
      axis(0, 12_000, true)
    )

    expect(changed).toBe(false)
    // Adopted, not ignored: the state is right, it just did not announce itself.
    expect([...next.buttons].sort((first, second) => first - second)).toEqual([9, 10])
    expect(next.axes[0]).toBeCloseTo(12_000 / JS_AXIS_RANGE, 4)
  })

  it('reports a change as soon as one real event arrives among the dump', () => {
    const { changed } = feed(PAD_SAMPLE_EMPTY, button(0, true, true), button(1, true))
    expect(changed).toBe(true)
  })

  it('reports nothing for an empty batch, and keeps the same state object', () => {
    const state = feed(PAD_SAMPLE_EMPTY, button(0, true)).next
    const result = applyJsEvents(state, [])
    expect(result.changed).toBe(false)
    expect(result.next).toBe(state)
  })

  it('grows the axis array for a pad with more axes than the last one', () => {
    const { next } = feed(PAD_SAMPLE_EMPTY, axis(7, JS_AXIS_RANGE))
    expect(next.axes).toHaveLength(8)
    expect(next.axes[7]).toBe(1)
    expect(next.axes[0]).toBe(0)
  })

  it('does not mutate the state it was given', () => {
    const state = feed(PAD_SAMPLE_EMPTY, button(0, true)).next
    feed(state, button(1, true), axis(0, 500))
    expect([...state.buttons]).toEqual([0])
  })
})


// ── The layout, which is the part that was wrong ────────────────────────────

/**
 * The three pads this has to get right, as the kernel declares them.
 *
 * Codes rather than printed bitmaps, because the ordering is what is under
 * test; `parseCapabilityBitmap` gets the real strings below.
 */
const XPAD_USB = {
  keys: [
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
  abs: [EV_ABS.x, EV_ABS.y, EV_ABS.z, EV_ABS.rx, EV_ABS.ry, EV_ABS.rz, EV_ABS.hat0x, EV_ABS.hat0y]
}

/**
 * The same pad over Bluetooth, on `hid-microsoft`. Read off a real one:
 * `/sys/class/input/js0/device/capabilities/key` = `7fff000000000000 0
 * 8000000000 0 0`. It declares the four codes xpad leaves out — BTN_C, BTN_Z,
 * BTN_TL2, BTN_TR2 — and every one of them shifts the stick clicks along.
 */
const XBOX_BLUETOOTH = {
  keys: [0x130, 0x131, 0x132, 0x133, 0x134, 0x135, 0x136, 0x137, 0x138, 0x139, 0x13a, 0x13b, 0x13c, 0x13d, 0x13e],
  // ABS_GAS and ABS_BRAKE are the triggers here, and ABS_RX/ABS_RY are absent
  // entirely: the right stick is on ABS_Z and ABS_RZ.
  abs: [EV_ABS.x, EV_ABS.y, EV_ABS.z, EV_ABS.rz, 0x09, 0x0a, EV_ABS.hat0x, EV_ABS.hat0y]
}

/** A DualSense on `hid-playstation`, which puts its d-pad on four buttons. */
const DUALSENSE = {
  keys: [0x130, 0x131, 0x133, 0x134, 0x136, 0x137, 0x138, 0x139, 0x13a, 0x13b, 0x13c, 0x13d, 0x13e, 0x220, 0x221, 0x222, 0x223],
  abs: [EV_ABS.x, EV_ABS.y, EV_ABS.z, EV_ABS.rx, EV_ABS.ry, EV_ABS.rz]
}

const layoutOf = (pad: { keys: number[]; abs: number[] }): PadLayout =>
  joydevLayout(pad.keys, pad.abs)

describe('parseCapabilityBitmap', () => {
  it('reads the bitmap a real Xbox pad publishes over Bluetooth', () => {
    // Every gamepad button from BTN_A to BTN_THUMBR, plus KEY_RECORD — the
    // Share button — three words further down. That second one is the
    // assertion that matters: it can only be found if the words are indexed
    // from the end, which is the only position the format pins.
    const bits = parseCapabilityBitmap('7fff000000000000 0 8000000000 0 0')

    expect(bits.has(EV_KEY.a)).toBe(true)
    expect(bits.has(EV_KEY.l3)).toBe(true)
    expect(bits.has(EV_KEY.r3)).toBe(true)
    expect(bits.has(0x13f)).toBe(false)
    expect(bits.has(0xa7)).toBe(true)
  })

  it('reads the axes of the same pad', () => {
    expect([...parseCapabilityBitmap('30627')].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 5, 9, 10, 16, 17
    ])
  })

  it('does not assume the words are padded, because the kernel does not pad them', () => {
    // `%lx` with no width, so a word of one is "1" and a word of zero is "0".
    // Reading these left to right would put that bit at 0 rather than at 128.
    const bits = parseCapabilityBitmap('1 0 0')
    expect([...bits]).toEqual([128])
  })

  it('reads a word wider than a double can hold exactly', () => {
    expect(parseCapabilityBitmap('8000000000000000').has(63)).toBe(true)
  })

  it('splits into 32-bit words for a 32-bit build, which is how the kernel prints to one', () => {
    expect([...parseCapabilityBitmap('1 0', 32)]).toEqual([32])
  })

  it('refuses a bitmap it cannot read rather than returning a shifted one', () => {
    // Half a layout is worse than none: it looks plausible and every index is
    // wrong. The caller falls back to xpad and says so.
    expect([...parseCapabilityBitmap('not-a-bitmap')]).toEqual([])
    expect([...parseCapabilityBitmap('')]).toEqual([])
    expect([...parseCapabilityBitmap('0')]).toEqual([])
  })
})

describe('joydevLayout', () => {
  it('puts the stick clicks on 9 and 10 for an Xbox pad over USB', () => {
    const { buttons, axes } = layoutOf(XPAD_USB)

    expect(buttons.indexOf(EV_KEY.l3)).toBe(9)
    expect(buttons.indexOf(EV_KEY.r3)).toBe(10)
    expect(buttons.indexOf(EV_KEY.lb)).toBe(4)
    expect(buttons.indexOf(EV_KEY.start)).toBe(7)
    // The triggers sit between the sticks, which the browser's layout does not.
    expect(axes.indexOf(EV_ABS.z)).toBe(2)
    expect(axes.indexOf(EV_ABS.rx)).toBe(3)
  })

  it('puts them on 13 and 14 for the same pad over Bluetooth', () => {
    // The bug. Four codes xpad never declares — BTN_C, BTN_Z, BTN_TL2, BTN_TR2
    // — sit in front of the stick clicks and push them along, so a chord
    // written down as 9 and 10 was two buttons this pad cannot press and
    // pointer mode could not be opened at all.
    const { buttons } = layoutOf(XBOX_BLUETOOTH)

    expect(buttons.indexOf(EV_KEY.l3)).toBe(13)
    expect(buttons.indexOf(EV_KEY.r3)).toBe(14)
    expect(buttons.indexOf(EV_KEY.lb)).toBe(6)
    expect(buttons.indexOf(EV_KEY.rb)).toBe(7)
  })

  it('puts them on 11 and 12 for a DualSense, which shifts differently again', () => {
    const { buttons } = layoutOf(DUALSENSE)

    expect(buttons.indexOf(EV_KEY.l3)).toBe(11)
    expect(buttons.indexOf(EV_KEY.r3)).toBe(12)
    // Its d-pad is four buttons rather than two axes, and they come last
    // because 0x220 is above the gamepad block rather than below it.
    expect(buttons.indexOf(0x220)).toBe(13)
  })

  it('keeps the face buttons at 0 on a device that also declares the old joystick codes', () => {
    // joydev walks BTN_JOYSTICK upward first and the BTN_MISC block second,
    // precisely so a gamepad's A stays index 0 next to a BTN_0 it inherited.
    const { buttons } = joydevLayout([0x100, EV_KEY.a, EV_KEY.b], [EV_ABS.x, EV_ABS.y])
    expect(buttons).toEqual([EV_KEY.a, EV_KEY.b, 0x100])
  })

  it('drops an axis code past the end of the joydev table', () => {
    expect(joydevLayout([], [EV_ABS.x, 0x40, 0x41]).axes).toEqual([EV_ABS.x])
  })

  it('is what the xpad fallback claims to be', () => {
    // The fallback is used when /sys cannot be read, so it has to be the layout
    // this function would have produced for that pad rather than a second
    // opinion about it.
    expect(XPAD_LAYOUT).toEqual(layoutOf(XPAD_USB))
  })
})

describe('readPad', () => {
  const reading = (pad: { keys: number[]; abs: number[] }, state: Partial<PadSample>) =>
    readPad(layoutOf(pad), {
      buttons: state.buttons ?? new Set<number>(),
      axes: state.axes ?? []
    })

  it('reports buttons as kernel codes, so two different pads can be folded together', () => {
    const usb = reading(XPAD_USB, { buttons: new Set([9, 10]) })
    const bluetooth = reading(XBOX_BLUETOOTH, { buttons: new Set([13, 14]) })

    expect([...usb.buttons].sort()).toEqual([EV_KEY.l3, EV_KEY.r3])
    // Same two buttons, different indices, one answer.
    expect([...bluetooth.buttons].sort()).toEqual([EV_KEY.l3, EV_KEY.r3])
  })

  it('drops an index the device never declared', () => {
    expect([...reading(XPAD_USB, { buttons: new Set([40]) }).buttons]).toEqual([])
  })

  it('takes the right stick from ABS_RX/ABS_RY when the pad has them', () => {
    const { axes } = reading(XPAD_USB, { axes: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0, 0] })
    expect(axes).toEqual({
      leftX: 0.1,
      leftY: 0.2,
      rightX: 0.4,
      rightY: 0.5,
      dpadX: 0,
      dpadY: 0
    })
  })

  it('takes it from ABS_Z/ABS_RZ when the pad has no ABS_RX at all', () => {
    // The Bluetooth Xbox pad. Read the other way round, its axis 4 is ABS_GAS —
    // the right *trigger* — so a page would have scrolled on a squeeze and the
    // right stick would have done nothing.
    const { axes } = reading(XBOX_BLUETOOTH, { axes: [0, 0, 0.3, 0.4, 0.9, 0, 0, 0] })
    expect(axes).toEqual({ leftX: 0, leftY: 0, rightX: 0.3, rightY: 0.4, dpadX: 0, dpadY: 0 })
  })

  it('reads the d-pad off the hat axes, which is where most pads put it', () => {
    const { axes } = reading(XBOX_BLUETOOTH, { axes: [0, 0, 0, 0, 0, 0, -1, 1] })
    expect(axes.dpadX).toBe(-1)
    expect(axes.dpadY).toBe(1)
  })

  it('reads it off the four buttons a DualSense uses instead', () => {
    // Same two numbers out, whichever way the pad sends it in — the thing
    // downstream is a keyboard grid, and one that half the pads in the room
    // cannot move around is not a keyboard.
    const layout = layoutOf(DUALSENSE)
    const up = readPad(layout, { buttons: new Set([layout.buttons.indexOf(0x220)]), axes: [] })
    const right = readPad(layout, { buttons: new Set([layout.buttons.indexOf(0x223)]), axes: [] })

    expect(up.axes.dpadY).toBe(-1)
    expect(right.axes.dpadX).toBe(1)
  })

  it('reports zero for a stick the device does not have', () => {
    const { axes } = readPad(joydevLayout([], [EV_ABS.x, EV_ABS.y]), {
      buttons: new Set(),
      axes: [1, 1]
    })
    expect(axes).toEqual({ leftX: 1, leftY: 1, rightX: 0, rightY: 0, dpadX: 0, dpadY: 0 })
  })
})

describe('mergePadReadings', () => {
  const flat = { leftX: 0, leftY: 0, rightX: 0, rightY: 0, dpadX: 0, dpadY: 0 }

  it('unions the buttons and takes the largest deflection on each axis', () => {
    // A pad and a flight stick both plugged in: the one somebody picked up may
    // not be the first, and two at rest must not cancel out the one in use.
    const merged = mergePadReadings([
      { buttons: new Set([EV_KEY.a]), axes: { ...flat, leftX: 0.2 } },
      { buttons: new Set([EV_KEY.b]), axes: { ...flat, leftX: -0.9, rightY: 0.5 } }
    ])

    expect([...merged.buttons].sort()).toEqual([EV_KEY.a, EV_KEY.b])
    expect(merged.axes).toEqual({
      leftX: -0.9,
      leftY: 0,
      rightX: 0,
      rightY: 0.5,
      dpadX: 0,
      dpadY: 0
    })
  })

  it('is a resting pad when there are no devices', () => {
    expect(mergePadReadings([])).toEqual({ buttons: new Set(), axes: flat })
  })
})

describe('the two mappings, and why there have to be two', () => {
  it('names the chord by kernel code out here, not by index', () => {
    // The index is per device; the code is not. This is the difference the
    // Bluetooth case turned into a feature that could not be reached.
    expect(CHORD_BUTTONS_EVDEV).toEqual([EV_KEY.l3, EV_KEY.r3])
    expect(CHORD_BUTTONS).toEqual([10, 11])
  })

  it('fires the chord for a Bluetooth pad, which the old fixed pair could not', () => {
    const held = readPad(layoutOf(XBOX_BLUETOOTH), {
      buttons: new Set([13, 14]),
      axes: []
    }).buttons

    expect(chordHeld(held, CHORD_BUTTONS_EVDEV)).toBe(true)
    // What the pad reports on 9 and 10 — BTN_TL2 and BTN_TR2, which it has no
    // way of pressing, because its triggers are axes.
    expect(chordHeld(new Set([9, 10]), CHORD_BUTTONS_EVDEV)).toBe(false)
  })

  it('keeps the shoulder pair out of the mouse buttons', () => {
    expect(KEYBOARD_CHORD_BUTTONS_EVDEV).toEqual([EV_KEY.lb, EV_KEY.rb])
    expect(KEYBOARD_CHORD_BUTTONS).toEqual([4, 5])
    for (const code of KEYBOARD_CHORD_BUTTONS_EVDEV) {
      expect(POINTER_ACTIONS_EVDEV[code]).toBeUndefined()
    }
    for (const code of CHORD_BUTTONS_EVDEV) {
      expect(POINTER_ACTIONS_EVDEV[code]).toBeUndefined()
    }
  })

  it('clicks with A and B and leaves on ☰, whatever index they arrive at', () => {
    const bluetooth = readPad(layoutOf(XBOX_BLUETOOTH), {
      buttons: new Set([0, 1, 11]),
      axes: []
    })
    expect(heldActions(bluetooth.buttons, POINTER_ACTIONS_EVDEV)).toEqual([
      'leftClick',
      'rightClick',
      'exit'
    ])
  })
})
