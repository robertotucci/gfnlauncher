import { describe, expect, it } from 'vitest'
import {
  ACCENT_PRESETS,
  DEFAULT_KEYBOARD_SCALE,
  DEFAULT_UI_SCALE,
  KEYBOARD_SCALE_PRESETS,
  UI_SCALE_PRESETS,
  accentValue,
  isAccentId,
  isKeyboardScaleId,
  isScaleId,
  keyboardScaleValue,
  scaleValue
} from './theme'

describe('isAccentId', () => {
  it('accepts every preset the settings screen draws', () => {
    for (const preset of ACCENT_PRESETS) expect(isAccentId(preset.id)).toBe(true)
  })

  it('rejects anything that is not one of them', () => {
    // This is the guard that stops a hand-edited settings.json from putting
    // arbitrary CSS into --brand.
    expect(isAccentId('oklch(0.5 0.3 20)')).toBe(false)
    expect(isAccentId('')).toBe(false)
    expect(isAccentId(null)).toBe(false)
    expect(isAccentId(3)).toBe(false)
  })
})

describe('accentValue', () => {
  it('falls back to white for an id this build has never heard of', () => {
    expect(accentValue('chartreuse')).toBe(accentValue('white'))
    expect(accentValue(null)).toBe(accentValue('white'))
  })
})

describe('isScaleId', () => {
  it('accepts every step the picker offers', () => {
    for (const preset of UI_SCALE_PRESETS) expect(isScaleId(preset.id)).toBe(true)
  })

  it('rejects a percentage that is not a step', () => {
    // The value becomes an argument to setZoomFactor, where an arbitrary number
    // is a window nobody can navigate back out of.
    expect(isScaleId('200')).toBe(false)
    expect(isScaleId('1.25')).toBe(false)
    expect(isScaleId('')).toBe(false)
    expect(isScaleId(1.25)).toBe(false)
    expect(isScaleId(null)).toBe(false)
  })
})

describe('scaleValue', () => {
  it('resolves each step to its zoom factor', () => {
    expect(scaleValue('75')).toBe(0.75)
    expect(scaleValue('100')).toBe(1)
    expect(scaleValue('175')).toBe(1.75)
  })

  it('falls back to unscaled for anything unknown', () => {
    expect(scaleValue('200')).toBe(1)
    expect(scaleValue(null)).toBe(1)
    expect(scaleValue(undefined)).toBe(1)
  })

  it('has a default that is one of the steps, and is 100%', () => {
    expect(isScaleId(DEFAULT_UI_SCALE)).toBe(true)
    expect(scaleValue(DEFAULT_UI_SCALE)).toBe(1)
  })
})

describe('ACCENT_PRESETS lightness', () => {
  it('keeps every preset light enough to carry dark text', () => {
    // Not a matter of taste. `--primary-foreground` is a single dark value in
    // the launcher, and both on-screen keyboards now fill the *selected* key
    // with the accent and write a near-black on top of it. A preset below this
    // makes the one key the pad is standing on the one key nobody can read.
    //
    // The format is asserted as well as the number: a preset written as a hex
    // would make the regex miss, and a skipped check reads exactly like a
    // passing one.
    for (const preset of ACCENT_PRESETS) {
      const match = /^oklch\((0\.\d+) /.exec(preset.value)
      expect(match, `${preset.id} is not an oklch() colour`).not.toBeNull()
      expect(Number(match?.[1]), preset.id).toBeGreaterThanOrEqual(0.8)
    }
  })
})

describe('isKeyboardScaleId', () => {
  it('accepts every step the picker offers', () => {
    for (const preset of KEYBOARD_SCALE_PRESETS) expect(isKeyboardScaleId(preset.id)).toBe(true)
  })

  it('rejects a size that is not a step', () => {
    expect(isKeyboardScaleId('200')).toBe(false)
    expect(isKeyboardScaleId('1.15')).toBe(false)
    expect(isKeyboardScaleId('')).toBe(false)
    expect(isKeyboardScaleId(1.15)).toBe(false)
    expect(isKeyboardScaleId(null)).toBe(false)
  })

  it('is not interchangeable with isScaleId', () => {
    // The two lists share only "100", and this is what makes that a rule rather
    // than a coincidence. `sanitise()` needs one guard per field, and pasting
    // the interface one onto `keyboardScale` would reject every step the
    // keyboard row can produce — pinning the user at 100% for ever, saving
    // nothing and reporting nothing. That failure is invisible; this is not.
    expect(isKeyboardScaleId('175')).toBe(false)
    expect(isScaleId('80')).toBe(false)
    expect(isKeyboardScaleId('100')).toBe(true)
    expect(isScaleId('100')).toBe(true)
  })
})

describe('keyboardScaleValue', () => {
  it('resolves each step to its multiplier', () => {
    expect(keyboardScaleValue('80')).toBe(0.8)
    expect(keyboardScaleValue('100')).toBe(1)
    expect(keyboardScaleValue('130')).toBe(1.3)
  })

  it('falls back to unscaled for anything unknown', () => {
    expect(keyboardScaleValue('200')).toBe(1)
    expect(keyboardScaleValue(null)).toBe(1)
    expect(keyboardScaleValue(undefined)).toBe(1)
  })

  it('has a default that is one of the steps, and is 100%', () => {
    expect(isKeyboardScaleId(DEFAULT_KEYBOARD_SCALE)).toBe(true)
    expect(keyboardScaleValue(DEFAULT_KEYBOARD_SCALE)).toBe(1)
  })

  it('stays inside a range a keyboard can be drawn at', () => {
    // It ends up as a multiplier on the one unit the whole panel is built from,
    // in a window there is no other way out of than the keyboard itself.
    for (const preset of KEYBOARD_SCALE_PRESETS) {
      expect(preset.value, preset.id).toBeGreaterThanOrEqual(0.5)
      expect(preset.value, preset.id).toBeLessThanOrEqual(2)
    }
  })
})
