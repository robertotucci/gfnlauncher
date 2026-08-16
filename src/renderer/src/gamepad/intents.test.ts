import { describe, expect, it } from 'vitest'
import { ACTION_KEYS, KEY_BINDINGS } from './intents'

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
