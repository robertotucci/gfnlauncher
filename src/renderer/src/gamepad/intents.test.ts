import { describe, expect, it } from 'vitest'
import type { StandardReading } from '@shared/padLayout'
import { ACTION_KEYS, KEY_BINDINGS, STICK_DEADZONE, readDirection } from './intents'

describe('ACTION_KEYS', () => {
  it('names a key the keyboard actually maps to that action', () => {
    for (const [action, key] of Object.entries(ACTION_KEYS)) {
      expect(KEY_BINDINGS[key]).toEqual({ kind: 'action', action })
    }
  })

  it('covers every action a legend can show', () => {
    // Anything drawn with `glyphFor` silently disappears when it has no key and
    // no pad is connected. That now includes the shoulder buttons, which the
    // genre strip draws at its own ends rather than in the footer.
    for (const action of [
      'confirm',
      'back',
      'search',
      'menu',
      'start',
      'pageLeft',
      'pageRight'
    ] as const) {
      expect(ACTION_KEYS[action]).toBeTruthy()
    }
  })

  it('keeps the paging keys out of anything the search overlay types', () => {
    // The overlay's own keydown handler swallows /[a-z0-9 ]/ and Backspace. A
    // key that both pages the genre strip and types a letter would do both.
    for (const key of ['[', ']']) {
      expect(/[a-z0-9 ]/i.test(key)).toBe(false)
    }
  })
})

describe('readDirection', () => {
  /** A pad at rest, with whichever buttons and axes the test cares about. */
  const pad = (held: readonly number[] = [], axes: readonly number[] = []): StandardReading => ({
    buttons: Array.from({ length: 17 }, (_, index) => held.includes(index)),
    axes: [axes[0] ?? 0, axes[1] ?? 0, axes[2] ?? 0, axes[3] ?? 0]
  })

  it('is null for a pad nobody is touching', () => {
    expect(readDirection(pad())).toBeNull()
  })

  it('reads the four d-pad buttons', () => {
    expect(readDirection(pad([12]))).toBe('up')
    expect(readDirection(pad([13]))).toBe('down')
    expect(readDirection(pad([14]))).toBe('left')
    expect(readDirection(pad([15]))).toBe('right')
  })

  it('lets the d-pad win over a stick that is also being pushed', () => {
    // Both at once is a thumb resting on the stick while the other hand uses
    // the d-pad, and answering with the stick would ignore the deliberate half.
    expect(readDirection(pad([12], [0, 1]))).toBe('up')
  })

  it('reads the left stick, and only past the deadzone', () => {
    // Sticks drift. Below this a pad lying on a sofa walks the grid on its own.
    expect(readDirection(pad([], [0, -STICK_DEADZONE]))).toBe('up')
    expect(readDirection(pad([], [0, -STICK_DEADZONE + 0.01]))).toBeNull()
    expect(readDirection(pad([], [STICK_DEADZONE, 0]))).toBe('right')
  })

  it('resolves a diagonal to one axis rather than to both', () => {
    // The focus model moves one step at a time; a diagonal that returned two
    // directions would jump a row and a column at once.
    expect(readDirection(pad([], [0.9, 0.8]))).toBe('right')
    expect(readDirection(pad([], [0.8, -0.9]))).toBe('up')
  })

  it('ignores the right stick entirely', () => {
    // It scrolls a cursor in pointer mode and must not also walk the grid
    // underneath one.
    expect(readDirection(pad([], [0, 0, 1, 1]))).toBeNull()
  })
})
