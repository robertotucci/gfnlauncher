import { describe, expect, it } from 'vitest'
import { DONATION_URL } from '@shared/donate'
import { qrPath } from './qr'

describe('qrPath', () => {
  it('returns a grid that is a real QR version', () => {
    // Every version is 21 modules plus four per step. A count that is not on
    // that ladder means the encoder returned something we are misreading.
    const { count } = qrPath(DONATION_URL)
    expect(count).toBeGreaterThanOrEqual(21)
    expect((count - 17) % 4).toBe(0)
  })

  it('draws every dark module inside the grid', () => {
    // The callers build their viewBox as `-2 -2 count+4 count+4`: two modules
    // of quiet zone on each side, which is what a scanner locks on to. A module
    // outside 0..count-1 would be drawn into that margin and break the lock.
    const { d, count } = qrPath(DONATION_URL)
    const coordinates = [...d.matchAll(/M(\d+) (\d+)h/g)]

    expect(coordinates.length).toBeGreaterThan(0)
    for (const [, column, row] of coordinates) {
      expect(Number(column)).toBeLessThan(count)
      expect(Number(row)).toBeLessThan(count)
    }
  })

  it('encodes the same URL the same way every time', () => {
    // The component memoises on the URL alone. If the encoder were to pick a
    // different mask per call the code would flicker on every re-render.
    expect(qrPath(DONATION_URL)).toEqual(qrPath(DONATION_URL))
  })

  it('grows the grid rather than truncating a longer URL', () => {
    const short = qrPath('https://a.example')
    const long = qrPath(`https://a.example/${'x'.repeat(200)}`)
    expect(long.count).toBeGreaterThan(short.count)
  })
})
