import { describe, expect, it } from 'vitest'
import {
  DUALSENSE,
  FLIGHT_STICK,
  SWITCH_PRO,
  XBOX_BLUETOOTH,
  XPAD_USB,
  padIdOf,
  profileOf
} from '@shared/padFixtures'
import { standardReading, translatePad } from '@shared/padLayout'
import { padInfo, samePadInfo } from './translate'

/**
 * What the poll loop decides about each pad, lifted out of the poll loop.
 *
 * The loop itself cannot be tested — the suite has no DOM and no controller —
 * so every judgement in it lives here instead. The one that matters most is the
 * *fallback*: three of the five branches below hand back a null map, which is
 * the identity, which is exactly how this launcher read every pad before any of
 * this existed. Nothing here may make a pad worse than it is today.
 */

const xpad = profileOf(XPAD_USB, 'js0')
const bluetooth = profileOf(XBOX_BLUETOOTH, 'js1', 'bluetooth')
const dualsense = profileOf(DUALSENSE, 'js2', 'bluetooth')
const stick = profileOf(FLIGHT_STICK, 'js3')

describe('translatePad', () => {
  it('leaves a pad Chromium mapped exactly as it found it', () => {
    // The overwhelming majority. Second-guessing the browser's own table is how
    // you break the controller that already works, so this branch derives
    // nothing and says nothing.
    const result = translatePad(padIdOf(XPAD_USB, true), true, 11, 8, [xpad])

    expect(result.map).toBeNull()
    expect(result.numbering).toBe('standard')
    expect(result.note).toBeNull()
  })

  it('still learns how a mapped pad is attached, because a screen asks', () => {
    expect(translatePad(padIdOf(DUALSENSE, true), true, 17, 6, [dualsense]).transport).toBe(
      'bluetooth'
    )
  })

  it('translates an unmapped pad through the node it matches', () => {
    const result = translatePad(padIdOf(XBOX_BLUETOOTH), false, 15, 8, [xpad, bluetooth])

    expect(result.numbering).toBe('kernel')
    expect(result.transport).toBe('bluetooth')
    expect(result.map?.buttons[10]).toBe(13)
    expect(result.note).toContain('js1')
  })

  it('says which way the d-pad arrives, since that is half of what it fixed', () => {
    expect(translatePad(padIdOf(XPAD_USB), false, 11, 8, [xpad]).note).toContain('d-pad on the hat')
    expect(translatePad(padIdOf(DUALSENSE), false, 17, 6, [dualsense]).note).toContain(
      'd-pad on its own buttons'
    )
  })

  it('assumes the standard layout for a pad that matches no node', () => {
    // A sandbox with no `/sys`, or a device the browser sees and the kernel
    // does not list as a joystick. The pad behaves as it does today, and the
    // log says the launcher had to guess rather than leaving somebody to work
    // that out from a d-pad that does nothing.
    const result = translatePad(padIdOf(SWITCH_PRO), false, 17, 4, [xpad])

    expect(result.map).toBeNull()
    expect(result.numbering).toBe('assumed')
    expect(result.note).toContain('matches no joystick node')
  })

  it('will not shuffle a pad through a layout it had to guess at', () => {
    // A node whose capability bitmaps could not be read gets `XPAD_LAYOUT` from
    // main, because the evdev reader has nothing else to work with. Here there
    // is something else and it is better: leaving the pad standard is what the
    // launcher did before any of this, and translating through a layout nobody
    // read is a way to stop a pad that half worked.
    const guessed = { ...profileOf(XPAD_USB, 'js0'), resolved: 'assumed' as const }
    const result = translatePad(padIdOf(XPAD_USB), false, 11, 8, [guessed])

    expect(result.map).toBeNull()
    expect(result.numbering).toBe('assumed')
    expect(result.note).toContain("js0's own numbering could not be read")
  })

  it('assumes it again when the counts disagree, which is the premise check', () => {
    // The whole translation rests on Chromium reporting the kernel's own
    // indices. It does today and that is not ours to guarantee, so a Chromium
    // that changed would land here — one log line, and today's behaviour.
    const result = translatePad(padIdOf(XPAD_USB), false, 17, 4, [xpad])

    expect(result.map).toBeNull()
    expect(result.numbering).toBe('assumed')
    expect(result.note).toContain('where js0 declares 11 and 8')
  })

  it('reads nothing at all off a device that is not a controller', () => {
    // A flight stick's trigger is joydev index 0 — the index this launcher
    // reads as confirm — and its throttle rests at full deflection. Folded in
    // untranslated, it pressed A in the grid and scrolled a page on its own.
    const result = translatePad(padIdOf(FLIGHT_STICK), false, 6, 4, [stick])

    expect(result.numbering).toBe('ignored')
    expect(result.map?.buttons.every((index) => index === -1)).toBe(true)
    expect(
      standardReading({ buttons: [true, true, true], axes: [1, 1, 1, 1] }, result.map).buttons.some(
        Boolean
      )
    ).toBe(false)
  })

  it('survives an id with nothing in it, and does not throw on the way', () => {
    const result = translatePad('', false, 0, 0, [])
    expect(result.map).toBeNull()
    expect(result.note).toContain('"unnamed"')
  })
})

describe('padInfo', () => {
  it('describes a pad the way the Devices screen draws it', () => {
    const id = padIdOf(DUALSENSE)
    expect(padInfo(id, translatePad(id, false, 17, 6, [dualsense]))).toEqual({
      id,
      name: 'Sony Interactive Entertainment Wireless Controller',
      family: 'playstation',
      transport: 'bluetooth',
      numbering: 'kernel'
    })
  })

  it('gives a nameless pad something a person can read', () => {
    expect(padInfo('', translatePad('', true, 0, 0, [])).name).toBe('Controller')
  })
})

describe('samePadInfo', () => {
  const id = padIdOf(XPAD_USB)
  const one = padInfo(id, translatePad(id, true, 11, 8, [xpad]))

  it('is true for the same room, so a pad at rest never re-renders anything', () => {
    // This runs sixty times a second. Comparing the fields rather than the
    // array is the whole of what keeps it free.
    expect(samePadInfo([one], [padInfo(id, translatePad(id, true, 11, 8, [xpad]))])).toBe(true)
  })

  it('notices a pad arriving, leaving, or being read differently', () => {
    expect(samePadInfo([one], [])).toBe(false)
    expect(samePadInfo([one], [{ ...one, numbering: 'kernel' }])).toBe(false)
    expect(samePadInfo([one], [{ ...one, transport: 'bluetooth' }])).toBe(false)
  })
})
