import { describe, expect, it } from 'vitest'
import { scoreCandidate } from './SpatialFocus'

/** Minimal DOMRect stand-in — scoreCandidate only reads the edges. */
function rect(left: number, top: number, width = 100, height = 100): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

describe('scoreCandidate', () => {
  const origin = rect(0, 0)

  it('rejects candidates that are not in the direction of travel', () => {
    expect(scoreCandidate(origin, rect(-200, 0), 'right')).toBeNull()
    expect(scoreCandidate(origin, rect(0, -200), 'down')).toBeNull()
  })

  it('accepts a candidate directly in the direction of travel', () => {
    expect(scoreCandidate(origin, rect(120, 0), 'right')).not.toBeNull()
  })

  it('prefers the nearer of two aligned candidates', () => {
    const near = scoreCandidate(origin, rect(120, 0), 'right')!
    const far = scoreCandidate(origin, rect(400, 0), 'right')!
    expect(near).toBeLessThan(far)
  })

  it('holds the column when moving down through a grid', () => {
    // A tile straight below beats a nearer one that sits a column across.
    const sameColumn = scoreCandidate(origin, rect(0, 120), 'down')!
    const nextColumn = scoreCandidate(origin, rect(110, 110), 'down')!
    expect(sameColumn).toBeLessThan(nextColumn)
  })

  it('treats near-alignment as aligned', () => {
    // Sub-pixel layout differences must not make a row look staggered.
    expect(scoreCandidate(origin, rect(100.5, 0), 'right')).not.toBeNull()
  })

  it('reaches a small control nested inside a wide row', () => {
    // The settings screen stacks full-width rows and, between two of them, a
    // row of 28px accent swatches. Scoring the cross axis by centre distance
    // made every swatch lose to the next full-width row — in both directions —
    // so the accent picker could not be reached with a gamepad at all.
    const wideRow = rect(0, 0, 1000, 80)
    const swatch = rect(20, 200, 28, 28)
    const nextWideRow = rect(0, 400, 1000, 80)

    expect(scoreCandidate(wideRow, swatch, 'down')!).toBeLessThan(
      scoreCandidate(wideRow, nextWideRow, 'down')!
    )
    expect(scoreCandidate(nextWideRow, swatch, 'up')!).toBeLessThan(
      scoreCandidate(nextWideRow, wideRow, 'up')!
    )
  })

  it('still ranks a partly overlapping neighbour below an aligned one', () => {
    // Overlap counts as aligned, so the separation between grid columns has to
    // come from the gap between their edges rather than from their centres.
    const aligned = scoreCandidate(origin, rect(0, 200), 'down')!
    const nudged = scoreCandidate(origin, rect(140, 150), 'down')!
    expect(aligned).toBeLessThan(nudged)
  })
})
