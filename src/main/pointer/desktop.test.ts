import { describe, expect, it, vi } from 'vitest'
import { stepOskNav } from '@shared/osk'

// Only the pure half is under test, but the loop imports the composed keyboard,
// which reaches for Electron at import time. Same stub as `compose.test.ts`.
vi.mock('electron', () => ({
  ipcMain: { on: () => {} },
  app: { getLocale: () => 'en_US' },
  BrowserWindow: class {},
  screen: {}
}))

const { adoptVolume, volumeDirection } = await import('./desktop')
const { PAD_READING_EMPTY } = await import('./evdev')

function dpad(dpadY: number, leftY = 0): typeof PAD_READING_EMPTY {
  return { ...PAD_READING_EMPTY, axes: { ...PAD_READING_EMPTY.axes, dpadY, leftY } }
}

describe('volumeDirection', () => {
  it('reads the D-pad up as up and down as down', () => {
    expect(volumeDirection(dpad(-1))).toBe('up')
    expect(volumeDirection(dpad(1))).toBe('down')
    expect(volumeDirection(dpad(0))).toBeNull()
  })

  it('ignores the stick, which is moving the cursor', () => {
    expect(volumeDirection(dpad(0, -1))).toBeNull()
  })
})

describe('adoptVolume', () => {
  it('does not step for a D-pad already held as the mode opens', () => {
    const held = adoptVolume(dpad(-1))

    expect(stepOskNav(held, 'up', 10_000).move).toBe(false)
  })

  it('steps on the next fresh press once it is let go', () => {
    const released = stepOskNav(adoptVolume(dpad(-1)), null, 0).next

    expect(stepOskNav(released, 'up', 1).move).toBe(true)
  })
})
