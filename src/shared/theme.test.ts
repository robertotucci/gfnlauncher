import { describe, expect, it } from 'vitest'
import {
  ACCENT_PRESETS,
  DEFAULT_UI_SCALE,
  UI_SCALE_PRESETS,
  accentValue,
  isAccentId,
  isScaleId,
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
