import { describe, expect, it } from 'vitest'
import {
  PAD_BUTTON_NAMES,
  PAD_FAMILIES,
  detectPadFamily,
  isPadFamily,
  padFamilyOf
} from './padFamily'
import { parsePadId } from './padLayout'

/**
 * Which pad the launcher thinks is in somebody's hands, and what it calls the
 * buttons on it.
 *
 * Every failure here is a label rather than a binding — the buttons keep
 * working — but the label is the only instruction manual a ten-foot interface
 * gives, so a footer that names a button the pad does not have is the same
 * thing as no footer at all.
 */

const family = (id: string) => detectPadFamily(parsePadId(id))

describe('detectPadFamily', () => {
  it('reads Sony pads off the vendor id Chromium appends', () => {
    expect(
      family(
        'Sony Interactive Entertainment DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'
      )
    ).toBe('playstation')
    expect(family('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toBe(
      'playstation'
    )
  })

  it('recognises a PlayStation pad by name when no vendor id is exposed', () => {
    expect(family('PLAYSTATION(R)3 Controller')).toBe('playstation')
    expect(family('DualShock 4 Wireless Controller')).toBe('playstation')
  })

  it('recognises the third parties that make PlayStation-shaped pads', () => {
    // Their own vendor ids, so the name is the only evidence there is.
    expect(family('Nacon Revolution Pro Controller (Vendor: 146b Product: 0d01)')).toBe(
      'playstation'
    )
    expect(family('Razer Raiju Tournament Edition (Vendor: 1532 Product: 1007)')).toBe(
      'playstation'
    )
  })

  it('reads Nintendo pads off their vendor id, which 8BitDo borrows in Switch mode', () => {
    // An 8BitDo pad set to Switch mode reports as a Pro Controller, ids and
    // all, because that is what the console has to see. The vendor id is
    // therefore right about the *labels* even when it is wrong about the maker,
    // which is exactly what this table is for.
    expect(family('Nintendo Switch Pro Controller (Vendor: 057e Product: 2009)')).toBe('nintendo')
    expect(family('Joy-Con (L) (Vendor: 057e Product: 2006)')).toBe('nintendo')
  })

  it('does not read "Pro" alone as Nintendo', () => {
    // An 8BitDo Pro 2 is an Xbox-layout pad, and calling its bottom button B
    // would be wrong in the one place the legend has to be right.
    expect(family('8BitDo Pro 2 (Vendor: 2dc8 Product: 6003)')).toBe('xbox')
  })

  it('treats Xbox pads as the standard layout', () => {
    expect(family('Microsoft X-Box 360 pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)')).toBe(
      'xbox'
    )
    expect(family('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe(
      'xbox'
    )
  })

  it('falls back to Xbox for a pad it cannot place', () => {
    expect(family('8BitDo Ultimate Controller (Vendor: 2dc8 Product: 3106)')).toBe('xbox')
    expect(family('')).toBe('xbox')
  })
})

describe('padFamilyOf', () => {
  const ids = (...values: string[]) => values.map(parsePadId)

  it('is the family when every pad in the room agrees', () => {
    expect(padFamilyOf(ids('Pad (Vendor: 054c Product: 0ce6)'))).toBe('playstation')
    expect(
      padFamilyOf(ids('A (Vendor: 057e Product: 2009)', 'B (Vendor: 057e Product: 2017)'))
    ).toBe('nintendo')
  })

  it('falls back to Xbox when two pads disagree', () => {
    // Naming one of them would print a legend that is wrong for whoever is
    // holding the other, and the badge goes to a window that cannot know a
    // second pad exists. Xbox is the layout the other two are relabellings of.
    expect(
      padFamilyOf(ids('A (Vendor: 054c Product: 0ce6)', 'B (Vendor: 057e Product: 2009)'))
    ).toBe('xbox')
  })

  it('falls back to Xbox with no pads at all', () => {
    expect(padFamilyOf([])).toBe('xbox')
  })
})

describe('isPadFamily', () => {
  it('accepts the three and refuses everything else', () => {
    // The guard on the pointer preload's channel: a family arrives over IPC and
    // is interpolated into a page the launcher does not own.
    for (const value of PAD_FAMILIES) expect(isPadFamily(value)).toBe(true)
    expect(isPadFamily('sega')).toBe(false)
    expect(isPadFamily(undefined)).toBe(false)
    expect(isPadFamily(3)).toBe(false)
  })
})

describe('PAD_BUTTON_NAMES', () => {
  it('names the bottom button after where it is printed, not after what it does', () => {
    // The whole claim of the Nintendo row: confirm is still the bottom button,
    // and on that pad the bottom button says B. Swapping the *action* instead
    // would move the click under somebody's thumb every time they changed pad.
    expect(PAD_BUTTON_NAMES.xbox.south).toBe('A')
    expect(PAD_BUTTON_NAMES.playstation.south).toBe('×')
    expect(PAD_BUTTON_NAMES.nintendo.south).toBe('B')
    expect(PAD_BUTTON_NAMES.nintendo.east).toBe('A')
  })

  it('uses only characters an offline machine can draw', () => {
    // These are drawn as text on a keycap and in a hint, with no icon set
    // available and whatever font the runtime shipped. `×` is U+00D7, which is
    // Latin-1 and therefore everywhere; U+2715 is Dingbats and renders as a
    // box on a plain font. The shapes are Geometric Shapes, which DejaVu Sans
    // covers. This assertion is what stops somebody "tidying" them into the
    // prettier codepoints.
    expect(PAD_BUTTON_NAMES.playstation.south.codePointAt(0)).toBe(0x00d7)
    expect(PAD_BUTTON_NAMES.playstation.east.codePointAt(0)).toBe(0x25cb)
    expect(PAD_BUTTON_NAMES.playstation.west.codePointAt(0)).toBe(0x25a1)
    expect(PAD_BUTTON_NAMES.playstation.north.codePointAt(0)).toBe(0x25b3)
  })

  it('gives every family every button, so no caller has to handle a gap', () => {
    for (const name of PAD_FAMILIES) {
      const names = Object.values(PAD_BUTTON_NAMES[name])
      expect(names).toHaveLength(7)
      expect(names.every((value) => value.length > 0)).toBe(true)
    }
  })

  it('keeps the four face names distinct within a family', () => {
    // Two keys badged with the same character is a keyboard nobody can read.
    for (const name of PAD_FAMILIES) {
      const { south, east, west, north } = PAD_BUTTON_NAMES[name]
      expect(new Set([south, east, west, north]).size).toBe(4)
    }
  })
})
