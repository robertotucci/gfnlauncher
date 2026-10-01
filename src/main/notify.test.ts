import { describe, expect, it, vi } from 'vitest'

/**
 * Only the geometry is under test, but the module opens a window and so reaches
 * for Electron at import time. Same stub as `pointer/compose.test.ts`.
 */
vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {
    getPrimaryDisplay: () => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1053 }
    })
  }
}))

const { noticeBounds } = await import('./notify')

/** 1080p with a 27px Plasma panel along the bottom — this machine. */
const bottomPanel = { x: 0, y: 0, width: 1920, height: 1053 }

describe('noticeBounds', () => {
  it('lands flush in the top-right corner of the work area', () => {
    const box = noticeBounds(bottomPanel, 1)

    expect(box.x + box.width).toBe(bottomPanel.x + bottomPanel.width)
    expect(box.y).toBe(bottomPanel.y)
  })

  it('follows a work area whose origin is not 0,0', () => {
    // A top panel and a left dock, which is the Xfce and MATE default between
    // them. Measuring the corner from the *display* instead puts the card
    // underneath the panel, which is the fault this function exists to avoid.
    const inset = { x: 64, y: 32, width: 1856, height: 1048 }

    const box = noticeBounds(inset, 1)

    expect(box.y).toBe(32)
    expect(box.x + box.width).toBe(1920)
  })

  it('grows with the interface scale', () => {
    const normal = noticeBounds(bottomPanel, 1)
    const large = noticeBounds(bottomPanel, 1.75)

    expect(large.width).toBeGreaterThan(normal.width)
    expect(large.height).toBeGreaterThan(normal.height)
    // Still in the corner, which is the half a naive multiply gets wrong.
    expect(large.x + large.width).toBe(bottomPanel.width)
  })

  it('never asks for more room than the work area has', () => {
    // 175% on a 720p television is the real worst case, and a window taller
    // than the screen is one a compositor answers by clipping the last card.
    const small = { x: 0, y: 0, width: 1280, height: 700 }

    const box = noticeBounds(small, 1.75)

    expect(box.width).toBeLessThanOrEqual(small.width)
    expect(box.height).toBeLessThanOrEqual(small.height)
    expect(box.x).toBeGreaterThanOrEqual(small.x)
  })
})

const { osdMessage } = await import('./notify')

describe('osdMessage', () => {
  it('puts the title first and the hint after it, on one line', () => {
    expect(osdMessage({ title: 'Pointer on', hint: 'Hold L3 + R3 to put it away', icon: 'pointer' }))
      .toEqual({ icon: 'input-mouse', text: 'Pointer on · Hold L3 + R3 to put it away' })
  })

  it('is the title alone when there is no hint', () => {
    expect(osdMessage({ title: 'Controller connected', hint: null, icon: 'gamepad' }).text).toBe(
      'Controller connected'
    )
  })

  it('names every glyph with a freedesktop icon rather than a blank', () => {
    const icons = [
      'pointer',
      'pointer-off',
      'gamepad',
      'keyboard',
      'mouse',
      'headphones',
      'speaker',
      'display',
      'computer',
      'phone',
      'device'
    ] as const

    for (const icon of icons) {
      expect(osdMessage({ title: 'x', hint: null, icon }).icon).toMatch(/^[a-z-]+$/)
    }
  })
})
