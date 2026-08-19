import { describe, expect, it } from 'vitest'
import {
  JOYDEV_AXES,
  JS_AXIS_RANGE,
  JS_EVENT_AXIS,
  JS_EVENT_BUTTON,
  JS_EVENT_INIT,
  JS_EVENT_SIZE,
  PAD_SAMPLE_EMPTY,
  applyJsEvents,
  normaliseAxis,
  parseJsEvents,
  type PadSample
} from './evdev'
import { CHORD_BUTTONS, CHORD_BUTTONS_JOYDEV, chordHeld } from '@shared/pointer'

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
    const { next } = feed(PAD_SAMPLE_EMPTY, axis(JOYDEV_AXES.leftY, -JS_AXIS_RANGE))
    expect(next.axes[JOYDEV_AXES.leftY]).toBe(-1)
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
      axis(JOYDEV_AXES.leftX, 12_000, true)
    )

    expect(changed).toBe(false)
    // Adopted, not ignored: the state is right, it just did not announce itself.
    expect(chordHeld(next.buttons, CHORD_BUTTONS_JOYDEV)).toBe(true)
    expect(next.axes[JOYDEV_AXES.leftX]).toBeCloseTo(12_000 / JS_AXIS_RANGE, 4)
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
    const { next } = feed(PAD_SAMPLE_EMPTY, axis(JOYDEV_AXES.dpadY, JS_AXIS_RANGE))
    expect(next.axes).toHaveLength(JOYDEV_AXES.dpadY + 1)
    expect(next.axes[JOYDEV_AXES.dpadY]).toBe(1)
    expect(next.axes[0]).toBe(0)
  })

  it('does not mutate the state it was given', () => {
    const state = feed(PAD_SAMPLE_EMPTY, button(0, true)).next
    feed(state, button(1, true), axis(0, 500))
    expect([...state.buttons]).toEqual([0])
  })
})

describe('the joydev numbering, which is not the browser’s', () => {
  it('puts the stick clicks on 9 and 10, not 10 and 11', () => {
    // Reading the W3C pair off joydev gives L3 + Guide, and Guide is the button
    // that opens the Steam overlay. Worth an assertion of its own.
    expect(CHORD_BUTTONS_JOYDEV).toEqual([9, 10])
    expect(CHORD_BUTTONS).toEqual([10, 11])

    const held = new Set([9, 10])
    expect(chordHeld(held, CHORD_BUTTONS_JOYDEV)).toBe(true)
    expect(chordHeld(held, CHORD_BUTTONS)).toBe(false)
  })

  it('puts the triggers between the sticks, which the browser does not', () => {
    // The browser reports 0/1 left and 2/3 right. On joydev, axis 2 is the left
    // trigger — reading the right stick from it means a cursor that drifts
    // whenever a trigger rests off centre.
    expect(JOYDEV_AXES.leftTrigger).toBe(2)
    expect(JOYDEV_AXES.rightX).toBe(3)
    expect(JOYDEV_AXES.rightY).toBe(4)
  })

  it('puts the d-pad on axes rather than on buttons', () => {
    expect(JOYDEV_AXES.dpadX).toBe(6)
    expect(JOYDEV_AXES.dpadY).toBe(7)
  })
})
