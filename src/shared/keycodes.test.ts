import { describe, expect, it } from 'vitest'
import { keycodeForChar, keycodeForKey, keysymForChar, keysymForKey } from './keycodes'
import { OSK_ROWS, oskChar } from './osk'
import { POINTER_KEYS } from './pointer'

/** Every character the on-screen keyboard can actually produce. */
function typeableCharacters(): string[] {
  const found = new Set<string>()
  for (const row of OSK_ROWS) {
    for (const key of row) {
      for (const shift of [false, true]) {
        const char = oskChar(key, shift)
        if (char !== null) found.add(char)
      }
    }
  }
  return [...found]
}

describe('keysymForChar', () => {
  it('is the code point, because Latin-1 keysyms are', () => {
    expect(keysymForChar('a')).toBe(0x61)
    expect(keysymForChar('A')).toBe(0x41)
    expect(keysymForChar('@')).toBe(0x40)
    expect(keysymForChar(' ')).toBe(0x20)
    expect(keysymForChar('~')).toBe(0x7e)
  })

  it('covers every character the on-screen keyboard can type', () => {
    // The two modules have to agree or a key on screen does nothing at all.
    const missing = typeableCharacters().filter((char) => keysymForChar(char) === null)
    expect(missing).toEqual([])
  })

  it('refuses anything outside printable ASCII', () => {
    // The range check is the guard: without it any string reaching this becomes
    // an arbitrary keysym handed to the compositor.
    expect(keysymForChar('è')).toBeNull()
    expect(keysymForChar('\n')).toBeNull()
    expect(keysymForChar('')).toBeNull()
    expect(keysymForChar('')).toBeNull()
    expect(keysymForChar('ab')).toBeNull()
  })
})

describe('keysymForKey', () => {
  it('uses the X11 function-key range, not a code point', () => {
    expect(keysymForKey('Backspace')).toBe(0xff08)
    expect(keysymForKey('Tab')).toBe(0xff09)
    expect(keysymForKey('Enter')).toBe(0xff0d)
    expect(keysymForKey('Escape')).toBe(0xff1b)
  })

  it('has an entry for every named key the boundary accepts', () => {
    for (const key of POINTER_KEYS) {
      expect(typeof keysymForKey(key)).toBe('number')
    }
  })
})

describe('keycodeForChar — the fallback', () => {
  it('maps a letter to its key, and its capital to the same key with shift', () => {
    expect(keycodeForChar('a')).toEqual({ keycode: 30, shift: false })
    expect(keycodeForChar('A')).toEqual({ keycode: 30, shift: true })
    expect(keycodeForChar('z')).toEqual({ keycode: 44, shift: false })
    expect(keycodeForChar('Z')).toEqual({ keycode: 44, shift: true })
  })

  it('maps the shifted symbols to the key that carries them on a US layout', () => {
    expect(keycodeForChar('1')).toEqual({ keycode: 2, shift: false })
    expect(keycodeForChar('!')).toEqual({ keycode: 2, shift: true })
    expect(keycodeForChar('@')).toEqual({ keycode: 3, shift: true })
    expect(keycodeForChar('?')).toEqual({ keycode: 53, shift: true })
    expect(keycodeForChar('|')).toEqual({ keycode: 43, shift: true })
  })

  it('maps space', () => {
    expect(keycodeForChar(' ')).toEqual({ keycode: 57, shift: false })
  })

  it('covers every character the on-screen keyboard can type', () => {
    // A hole here is a key that does nothing on a session where the keysym call
    // is unavailable — which is the session where the user has fewest options.
    const missing = typeableCharacters().filter((char) => keycodeForChar(char) === null)
    expect(missing).toEqual([])
  })

  it('never maps two characters to the same key and shift', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const char of typeableCharacters()) {
      const stroke = keycodeForChar(char)!
      const slot = `${stroke.keycode}:${stroke.shift}`
      if (seen.has(slot)) clashes.push(`${char} and ${seen.get(slot)} both on ${slot}`)
      else seen.set(slot, char)
    }
    expect(clashes).toEqual([])
  })

  it('refuses what it does not know rather than guessing a key', () => {
    expect(keycodeForChar('è')).toBeNull()
    expect(keycodeForChar('€')).toBeNull()
    expect(keycodeForChar('')).toBeNull()
  })
})

describe('keycodeForKey', () => {
  it('maps the named keys, unshifted', () => {
    expect(keycodeForKey('Backspace')).toEqual({ keycode: 14, shift: false })
    expect(keycodeForKey('Enter')).toEqual({ keycode: 28, shift: false })
    expect(keycodeForKey('Tab')).toEqual({ keycode: 15, shift: false })
    expect(keycodeForKey('Escape')).toEqual({ keycode: 1, shift: false })
  })
})
