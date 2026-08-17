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

  it('keeps the cursor in the panel it is walking, however far the next row is', () => {
    // The real geometry of the Settings screen, to the pixel: the first row, the
    // nav rail's Status button beside it, and the row that is actually next.
    // Weighting the sideways gap made Status win — pressing Down on the first
    // setting left the panel for something level with it.
    const firstRow = rect(178, 240, 944, 85)
    const railBeside = rect(10, 324, 99, 91)
    const nextRow = rect(178, 603, 944, 85)

    expect(scoreCandidate(firstRow, nextRow, 'down')!).toBeLessThan(
      scoreCandidate(firstRow, railBeside, 'down')!
    )
  })

  it('does not reward a candidate for barely qualifying', () => {
    // `EPSILON` lets a candidate whose top edge is a hair above the cursor's
    // bottom count as below it. Its distance is then negative, which used to
    // score better than being genuinely adjacent.
    const level = scoreCandidate(origin, rect(0, 97), 'down')!
    const adjacent = scoreCandidate(origin, rect(0, 100), 'down')!
    expect(level).toBe(adjacent)
  })

  it('still reaches off-axis targets when nothing is in front of the cursor', () => {
    // The cost is a tie-break, not a filter: at the top of the Settings list
    // there is nothing above but the nav rail, and Up has to get there.
    expect(scoreCandidate(rect(178, 240, 944, 85), rect(10, 30, 99, 91), 'up')).not.toBeNull()
  })
})
