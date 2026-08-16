import { describe, expect, it } from 'vitest'
import { detectPadScheme } from './scheme'

describe('detectPadScheme', () => {
  it('reads Sony pads off the vendor id Chromium appends', () => {
    expect(
      detectPadScheme(
        'Sony Interactive Entertainment DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'
      )
    ).toBe('playstation')
  })

  it('recognises a PlayStation pad by name when no vendor id is exposed', () => {
    expect(detectPadScheme('PLAYSTATION(R)3 Controller')).toBe('playstation')
    expect(detectPadScheme('DualShock 4 Wireless Controller')).toBe('playstation')
  })

  it('treats Xbox pads as the standard layout', () => {
    expect(
      detectPadScheme('Microsoft X-Box 360 pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)')
    ).toBe('xbox')
    expect(
      detectPadScheme('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')
    ).toBe('xbox')
  })

  it('falls back to Xbox for a pad it cannot place', () => {
    expect(detectPadScheme('8BitDo Ultimate Controller (Vendor: 2dc8 Product: 3106)')).toBe('xbox')
    expect(detectPadScheme('')).toBe('xbox')
  })
})
