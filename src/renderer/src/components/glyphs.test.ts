import { Circle, Menu, Plus, Triangle, X } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import type { GamepadAction } from '@/gamepad/intents'
import { glyphFor } from './glyphs'

describe('glyphFor', () => {
  it('speaks Xbox on an Xbox pad and PlayStation on a Sony one', () => {
    expect(glyphFor('confirm', 'xbox')?.label).toBe('A')
    expect(glyphFor('menu', 'xbox')?.label).toBe('Y')
    expect(glyphFor('confirm', 'playstation')?.icon).toBe(X)
    expect(glyphFor('menu', 'playstation')?.icon).toBe(Triangle)
    expect(glyphFor('back', 'playstation')?.icon).toBe(Circle)
  })

  it('keeps the Xbox faces as letters rather than icons', () => {
    // A, B, X and Y are characters printed on the pad. Drawing them from an
    // icon set would be dressing up a letter as a symbol.
    for (const action of ['confirm', 'back', 'search', 'menu'] as const) {
      expect(glyphFor(action, 'xbox')?.icon).toBeUndefined()
    }
  })

  it('draws the Start button as an icon on every pad', () => {
    expect(glyphFor('start', 'xbox')?.icon).toBe(Menu)
    expect(glyphFor('start', 'playstation')?.icon).toBe(Menu)
    expect(glyphFor('start', 'nintendo')?.icon).toBe(Plus)
  })

  it('relabels a Switch pad and does not remap it', () => {
    // The bottom button still confirms — that is what `confirm` means, on this
    // pad as on every other — and on this one it is printed B. Swapping the
    // action instead would move the press under somebody's thumb every time
    // they changed controller, and would take the mouse click in pointer mode
    // with it.
    expect(glyphFor('confirm', 'nintendo')?.label).toBe('B')
    expect(glyphFor('back', 'nintendo')?.label).toBe('A')
    expect(glyphFor('search', 'nintendo')?.label).toBe('Y')
    expect(glyphFor('menu', 'nintendo')?.label).toBe('X')
  })

  it('falls back to the keyboard binding when no pad is in hand', () => {
    expect(glyphFor('back', 'keyboard')?.label).toBe('ESC')
    expect(glyphFor('confirm', 'keyboard')?.label).toBe('ENTER')
    expect(glyphFor('start', 'keyboard')?.label).toBe('F1')
  })

  it('never gives a keyboard glyph an icon', () => {
    // Keycaps carry the key's own name; an icon there would claim the keyboard
    // has a button it does not have.
    expect(glyphFor('start', 'keyboard')?.icon).toBeUndefined()
  })

  it('drops an action the keyboard cannot reach', () => {
    // A legend row is a promise; with no key bound and no pad in hand there is
    // nothing to press, so the row is dropped rather than drawn unpressable.
    expect(glyphFor('unbound' as GamepadAction, 'keyboard')).toBeNull()
  })

  it('labels the shoulder buttons on every scheme', () => {
    // The genre strip draws these itself. They went unbound for a while, which
    // meant the strip lost its hints the moment a pad was unplugged.
    expect(glyphFor('pageLeft', 'xbox')?.label).toBe('LB')
    expect(glyphFor('pageLeft', 'playstation')?.label).toBe('L1')
    expect(glyphFor('pageLeft', 'nintendo')?.label).toBe('L')
    expect(glyphFor('pageLeft', 'keyboard')?.label).toBe('[')
    expect(glyphFor('pageRight', 'keyboard')?.label).toBe(']')
  })
})
