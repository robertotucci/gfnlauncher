import { describe, expect, it } from 'vitest'
import { nextKeyboardAction, readVariant } from './systemKeyboard'

describe('nextKeyboardAction', () => {
  it('raises the keyboard when there is one and it is down', () => {
    expect(nextKeyboardAction({ available: true, visible: false })).toBe('show')
  })

  it('puts it away again, because LB + RB is a toggle everywhere else', () => {
    // A keyboard that cannot be dismissed with the pad would sit over the game
    // for the rest of the session, and out here there is no other way to close
    // it — that is the whole reason our own cursor cannot reach it.
    expect(nextKeyboardAction({ available: true, visible: true })).toBe('hide')
  })

  it('does nothing at all when KDE has no keyboard installed', () => {
    // The default on a fresh Plasma. Reported rather than attempted: a
    // `forceActivate` against an absent input method succeeds and shows
    // nothing, which is the one outcome nobody can diagnose from a sofa.
    expect(nextKeyboardAction({ available: false, visible: false })).toBe('unavailable')
    expect(nextKeyboardAction({ available: false, visible: true })).toBe('unavailable')
  })
})

describe('readVariant', () => {
  it('unwraps the shape dbus-native hands a variant over in', () => {
    expect(readVariant([[{ type: 'b', child: [] }], [true]])).toBe(true)
    expect(readVariant(['b', [false]])).toBe(false)
  })

  it('takes a bare value when there is no array around it', () => {
    expect(readVariant(['b', 1])).toBe(1)
  })

  it('is undefined rather than false for anything it cannot read', () => {
    // The distinction this module is built on: `available: false` is a sentence
    // the launcher says to the user, naming a package to install. A property it
    // failed to read must never become that sentence.
    expect(readVariant(undefined)).toBeUndefined()
    expect(readVariant(null)).toBeUndefined()
    expect(readVariant([])).toBeUndefined()
    expect(readVariant(['b'])).toBeUndefined()
    expect(readVariant('true')).toBeUndefined()
  })
})
