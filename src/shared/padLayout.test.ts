import { describe, expect, it } from 'vitest'
import {
  DUALSENSE,
  FLIGHT_STICK,
  SWITCH_PRO,
  XBOX_BLUETOOTH,
  XPAD_USB,
  padIdOf,
  profileOf
} from './padFixtures'
import {
  EV_ABS,
  EV_KEY,
  STANDARD_BUTTON_CODES,
  XPAD_LAYOUT,
  isGamepad,
  joydevLayout,
  mapFits,
  matchPadProfile,
  parseCapabilityBitmap,
  parsePadId,
  rightStick,
  standardMap,
  standardReading,
  transportOf,
  type PadProfile
} from './padLayout'

/**
 * The numbering, and the translation out of it.
 *
 * Two claims are under test here and they are the same claim seen from two
 * sides. The kernel numbers a pad's buttons by what that pad *declares*, so
 * there is no table — and Chromium, which reads the very same interface,
 * therefore hands the renderer those same indices whenever it has no standard
 * mapping of its own for the device. Everything below either reproduces the
 * kernel's ordering or converts it into the one fixed layout the rest of the
 * launcher is written against.
 */

const layoutOf = (fixture: { keys: readonly number[]; abs: readonly number[] }) =>
  joydevLayout(fixture.keys, fixture.abs)

/** W3C standard indices, named so the assertions read as sentences. */
const W3C = {
  south: 0,
  east: 1,
  west: 2,
  north: 3,
  lb: 4,
  rb: 5,
  select: 8,
  start: 9,
  l3: 10,
  r3: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
  guide: 16
} as const

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

describe('rightStick', () => {
  it('takes ABS_RX/ABS_RY when the pad declares both', () => {
    expect(rightStick(layoutOf(XPAD_USB))).toEqual({ x: 3, y: 4 })
  })

  it('falls back to ABS_Z/ABS_RZ for a pad that has no ABS_RX at all', () => {
    // The Bluetooth Xbox pad: its axes 4 and 5 are ABS_GAS and ABS_BRAKE, the
    // triggers, so reading the pair the other way round scrolls on a squeeze.
    expect(rightStick(layoutOf(XBOX_BLUETOOTH))).toEqual({ x: 2, y: 3 })
  })

  it('answers null for a device with neither pair', () => {
    expect(rightStick(joydevLayout([], [EV_ABS.x, EV_ABS.y]))).toBeNull()
  })
})

describe('transportOf', () => {
  it('names the two buses a controller in a living room arrives on', () => {
    expect(transportOf(0x03)).toBe('usb')
    expect(transportOf(0x05)).toBe('bluetooth')
  })

  it('does not guess at the rest, including a bustype it could not read', () => {
    expect(transportOf(0x06)).toBe('other')
    expect(transportOf(Number.NaN)).toBe('other')
  })
})

describe('parsePadId', () => {
  it('reads the id Chromium builds for a pad it has a standard mapping for', () => {
    expect(parsePadId(padIdOf(XPAD_USB, true))).toEqual({
      name: 'Microsoft X-Box 360 pad',
      vendor: '045e',
      product: '028e',
      standard: true
    })
  })

  it('notices the absence of the phrase, which is the whole reason to parse it', () => {
    expect(parsePadId(padIdOf(DUALSENSE)).standard).toBe(false)
  })

  it('lowercases the ids, because sysfs prints them lowercase and the id may not', () => {
    const identity = parsePadId('Pad (Vendor: 045E Product: 02EA)')
    expect(identity.vendor).toBe('045e')
    expect(identity.product).toBe('02ea')
  })

  it('keeps the whole string as the name when there is no suffix to strip', () => {
    // Some Bluetooth stacks produce a pad with no vendor id at all, and the
    // name is then the only thing left to match on.
    expect(parsePadId('8BitDo Ultimate Controller')).toEqual({
      name: '8BitDo Ultimate Controller',
      vendor: null,
      product: null,
      standard: false
    })
  })

  it('survives an empty id rather than throwing on the one pad nobody can name', () => {
    expect(parsePadId('')).toEqual({ name: '', vendor: null, product: null, standard: false })
  })
})

describe('matchPadProfile', () => {
  const dualsense = profileOf(DUALSENSE, 'js0', 'bluetooth')
  const xpad = profileOf(XPAD_USB, 'js1')

  it('finds the node by vendor and product', () => {
    expect(matchPadProfile(parsePadId(padIdOf(DUALSENSE)), [xpad, dualsense])).toBe(dualsense)
  })

  it('falls back to the name for an id that carries no vendor', () => {
    expect(matchPadProfile(parsePadId(XPAD_USB.name), [xpad, dualsense])).toBe(xpad)
  })

  it('answers null when nothing matches, rather than picking the only pad there is', () => {
    // A wrong node is worse than none: it translates one pad's presses through
    // another pad's numbering, which is the exact fault this module ends.
    expect(matchPadProfile(parsePadId(padIdOf(SWITCH_PRO)), [xpad])).toBeNull()
  })

  it('resolves two identical pads, because the answer cannot differ between them', () => {
    const second = profileOf(DUALSENSE, 'js2', 'bluetooth')
    expect(matchPadProfile(parsePadId(padIdOf(DUALSENSE)), [dualsense, second])).toBe(dualsense)
  })

  it('refuses two different pads that answer to one id', () => {
    // Same ids, different declarations — a clone, or one pad in two modes. The
    // launcher cannot tell which node the browser is describing, so it says so.
    const impostor: PadProfile = { ...profileOf(XPAD_USB, 'js2'), vendor: '054c', product: '0ce6' }
    expect(matchPadProfile(parsePadId(padIdOf(DUALSENSE)), [dualsense, impostor])).toBeNull()
  })

  it('answers null for no profiles at all, which is a sandbox with no /sys', () => {
    expect(matchPadProfile(parsePadId(padIdOf(XPAD_USB)), [])).toBeNull()
  })
})

describe('standardMap', () => {
  it('locates every W3C button on an Xbox pad over USB', () => {
    const map = standardMap(profileOf(XPAD_USB))

    expect(map.buttons[W3C.south]).toBe(0)
    expect(map.buttons[W3C.start]).toBe(7)
    expect(map.buttons[W3C.l3]).toBe(9)
    expect(map.buttons[W3C.r3]).toBe(10)
    // The one that mattered most: raw index 9 is a stick click, and the
    // launcher's index 9 is Play. Untranslated, ☰ was L3.
    expect(map.buttons[W3C.start]).not.toBe(W3C.start)
    expect(map.axes).toEqual([0, 1, 3, 4])
    expect(map.hat).toEqual({ x: 6, y: 7 })
  })

  it('follows the same pad over Bluetooth to its other numbering', () => {
    const map = standardMap(profileOf(XBOX_BLUETOOTH, 'js0', 'bluetooth'))

    expect(map.buttons[W3C.l3]).toBe(13)
    expect(map.buttons[W3C.r3]).toBe(14)
    expect(map.buttons[W3C.lb]).toBe(6)
    // Right stick off ABS_Z/ABS_RZ, which are axes 2 and 3 on this one.
    expect(map.axes).toEqual([0, 1, 2, 3])
  })

  it('finds a DualSense d-pad on its four buttons and reports no hat', () => {
    const map = standardMap(profileOf(DUALSENSE, 'js0', 'bluetooth'))

    expect(map.hat).toBeNull()
    expect(map.buttons[W3C.up]).toBe(13)
    expect(map.buttons[W3C.right]).toBe(16)
    expect(map.buttons[W3C.guide]).toBe(10)
  })

  it('leaves a flight stick with nothing at all, buttons and axes alike', () => {
    // The regression this closes: `BTN_TRIGGER` is joydev index 0, the same
    // index a pad gives to A, so an untranslated HOTAS pressed confirm in the
    // launcher every time somebody pulled it — and its throttle, which rests at
    // full deflection on ABS_Z, was read as a right stick pushed to the floor.
    const map = standardMap(profileOf(FLIGHT_STICK))

    expect(map.buttons.every((index) => index === -1)).toBe(true)
    expect(map.axes).toEqual([-1, -1, -1, -1])
    expect(map.hat).toBeNull()
  })

  it('decides that by BTN_SOUTH, which is what makes a device a gamepad', () => {
    expect(isGamepad(profileOf(SWITCH_PRO))).toBe(true)
    expect(isGamepad(profileOf(FLIGHT_STICK))).toBe(false)
  })

  it('reports −1 rather than 0 for a button the pad does not have', () => {
    // Zero is a valid index, so a missing button that answered 0 would read as
    // the face button being held down for the life of the session.
    const map = standardMap(profileOf(XPAD_USB))
    expect(map.buttons[6]).toBe(-1)
    expect(map.buttons[W3C.up]).toBe(-1)
  })

  it('has one entry per W3C position, so no consumer has to bounds-check it', () => {
    expect(standardMap(profileOf(XPAD_USB)).buttons).toHaveLength(STANDARD_BUTTON_CODES.length)
  })
})

describe('mapFits', () => {
  it('accepts the counts the kernel and the browser both read off one node', () => {
    expect(mapFits(profileOf(XPAD_USB), 11, 8)).toBe(true)
  })

  it('refuses a mismatch, which is what keeps the premise from being an assumption', () => {
    // If Chromium ever stops handing over raw joydev indices, this is where it
    // shows up — and the caller then leaves the pad exactly as it is today.
    expect(mapFits(profileOf(XPAD_USB), 17, 8)).toBe(false)
    expect(mapFits(profileOf(XPAD_USB), 11, 4)).toBe(false)
  })
})

describe('standardReading', () => {
  /** A raw pad with the given joydev indices held and axes at rest. */
  const raw = (held: readonly number[], axes: readonly number[] = []) => ({
    buttons: Array.from({ length: 20 }, (_, index) => held.includes(index)),
    axes: Array.from({ length: 8 }, (_, index) => axes[index] ?? 0)
  })

  it('is the identity for a null map, which is every pad Chromium already mapped', () => {
    // The fail-open path, and the one that must never derive anything: a pad
    // the browser has a table for is read exactly as it was before any of this
    // existed.
    const pad = raw([0, 9])
    const reading = standardReading(pad, null)
    expect(reading.buttons).toBe(pad.buttons)
    expect(reading.axes).toBe(pad.axes)
  })

  it('moves ☰ from where the pad puts it to where the launcher looks for it', () => {
    const map = standardMap(profileOf(XPAD_USB))
    // Raw 7 is BTN_START on this pad; raw 9 is the left stick click.
    const reading = standardReading(raw([7]), map)

    expect(reading.buttons[W3C.start]).toBe(true)
    expect(reading.buttons[W3C.l3]).toBe(false)
  })

  it('reads the chord on a Bluetooth pad, where the raw indices are 13 and 14', () => {
    const map = standardMap(profileOf(XBOX_BLUETOOTH, 'js0', 'bluetooth'))
    const reading = standardReading(raw([13, 14]), map)

    expect(reading.buttons[W3C.l3]).toBe(true)
    expect(reading.buttons[W3C.r3]).toBe(true)
  })

  it('synthesises the d-pad from the hat, which is where most pads put it', () => {
    // The standard layout has four buttons and the pad has two axes. Without
    // this the d-pad simply does not exist on any unmapped pad, and the
    // on-screen keyboard cannot be walked around.
    const map = standardMap(profileOf(XPAD_USB))
    const left = standardReading(raw([], [0, 0, 0, 0, 0, 0, -1, 0]), map)
    const down = standardReading(raw([], [0, 0, 0, 0, 0, 0, 0, 1]), map)

    expect(left.buttons[W3C.left]).toBe(true)
    expect(left.buttons[W3C.right]).toBe(false)
    expect(down.buttons[W3C.down]).toBe(true)
    expect(down.buttons[W3C.up]).toBe(false)
  })

  it('leaves the d-pad alone with the hat centred', () => {
    const map = standardMap(profileOf(XPAD_USB))
    const reading = standardReading(raw([]), map)
    expect(reading.buttons.slice(12, 16)).toEqual([false, false, false, false])
  })

  it('takes a DualSense d-pad off its buttons instead, with no hat to read', () => {
    const profile = profileOf(DUALSENSE, 'js0', 'bluetooth')
    const map = standardMap(profile)
    const reading = standardReading(raw([profile.buttons.indexOf(0x223)]), map)

    expect(reading.buttons[W3C.right]).toBe(true)
    expect(reading.buttons[W3C.left]).toBe(false)
  })

  it('puts the sticks where the launcher reads them', () => {
    const map = standardMap(profileOf(XPAD_USB))
    // Raw axis 2 is the left trigger on this pad, and it is exactly where the
    // untranslated reading looked for the right stick's x.
    const reading = standardReading(raw([], [0.1, 0.2, 0.9, 0.3, 0.4, 0, 0, 0]), map)
    expect(reading.axes).toEqual([0.1, 0.2, 0.3, 0.4])
  })

  it('reports nothing at all for a flight stick, however hard it is pushed', () => {
    const map = standardMap(profileOf(FLIGHT_STICK))
    const reading = standardReading(raw([0, 1, 2], [1, 1, 1, 1]), map)

    expect(reading.buttons.some(Boolean)).toBe(false)
    expect(reading.axes).toEqual([0, 0, 0, 0])
  })
})
