import { describe, expect, it } from 'vitest'
import {
  CHORD_BUTTONS,
  CHORD_BUTTONS_JOYDEV,
  CHORD_HOLD_MS,
  CHORD_START,
  MAX_SAMPLE_GAP_MS,
  POINTER_ACTIONS,
  POINTER_ACTIONS_JOYDEV,
  POINTER_DEADZONE,
  POINTER_MAX_SPEED,
  POINTER_MIN_SPEED,
  centreOf,
  chordHeld,
  heldActions,
  isPointerCommand,
  pointerSpeed,
  scrollDelta,
  stepChord,
  stepPointer,
  stepPointerButtons,
  type ChordState
} from './pointer'

/** 60 fps, which is what both the preload's rAF and joydev deliver in practice. */
const FRAME_MS = 16

/** Feeds "both down" for a stretch and reports every sample that toggled. */
function hold(
  from: ChordState,
  { held, start, until, step = FRAME_MS }: {
    held: boolean
    start: number
    until: number
    step?: number
  }
): { state: ChordState; toggles: number[] } {
  let state = from
  const toggles: number[] = []
  for (let now = start; now <= until; now += step) {
    const result = stepChord(state, held, now)
    state = result.next
    if (result.toggle) toggles.push(now)
  }
  return { state, toggles }
}

/** Past the adoption rule, so a test can start from a chord that may fire. */
function armed(at = 1_000): ChordState {
  return stepChord(CHORD_START, false, at).next
}

describe('stepChord', () => {
  it('toggles once the pair has been held for CHORD_HOLD_MS', () => {
    const { toggles } = hold(armed(), { held: true, start: 1_016, until: 3_000 })

    expect(toggles).toHaveLength(1)
    expect(toggles[0]).toBeGreaterThanOrEqual(1_016 + CHORD_HOLD_MS)
    expect(toggles[0]).toBeLessThan(1_016 + CHORD_HOLD_MS + FRAME_MS)
  })

  it('never toggles for a hold shorter than the threshold', () => {
    const { toggles } = hold(armed(), { held: true, start: 1_016, until: 1_016 + CHORD_HOLD_MS - 1 })
    expect(toggles).toEqual([])
  })

  it('toggles again only after the pair has been let go', () => {
    const first = hold(armed(), { held: true, start: 1_016, until: 4_000 })
    expect(first.toggles).toHaveLength(1)

    const released = stepChord(first.state, false, 4_016).next
    const second = hold(released, { held: true, start: 4_032, until: 6_000 })
    expect(second.toggles).toHaveLength(1)
  })

  it('ignores a pair that was already down when it started — the adoption rule', () => {
    // No release has ever been seen, so nothing may fire however long it is held.
    const { toggles } = hold(CHORD_START, { held: true, start: 1_000, until: 9_000 })
    expect(toggles).toEqual([])
  })

  it('arms as soon as the pair is released, and then behaves normally', () => {
    const stuck = hold(CHORD_START, { held: true, start: 1_000, until: 3_000 })
    const released = stepChord(stuck.state, false, 3_016).next
    const { toggles } = hold(released, { held: true, start: 3_032, until: 5_000 })

    expect(toggles).toHaveLength(1)
  })

  it('restarts the hold after a stall rather than crediting the missing time', () => {
    // Down at 1_016, then nothing until well past the threshold: the loop was
    // throttled and we did not watch, so we cannot claim to have timed it.
    let state = stepChord(armed(), true, 1_016).next
    const woke = stepChord(state, true, 1_016 + MAX_SAMPLE_GAP_MS + 1)
    expect(woke.toggle).toBe(false)

    state = woke.next
    const { toggles } = hold(state, {
      held: true,
      start: 1_016 + MAX_SAMPLE_GAP_MS + 1 + FRAME_MS,
      until: 4_000
    })
    expect(toggles).toHaveLength(1)
  })

  it('clears a hold in progress when the pair is released early', () => {
    const partial = hold(armed(), { held: true, start: 1_016, until: 1_016 + 300 })
    expect(partial.toggles).toEqual([])

    const released = stepChord(partial.state, false, 1_400).next
    expect(released.since).toBeNull()

    // The clock starts again from here, not from 1_016.
    const { toggles } = hold(released, { held: true, start: 1_416, until: 1_416 + CHORD_HOLD_MS - 1 })
    expect(toggles).toEqual([])
  })
})

describe('chordHeld', () => {
  it('needs every button of the chord, not any of them', () => {
    expect(chordHeld([10], CHORD_BUTTONS)).toBe(false)
    expect(chordHeld([11], CHORD_BUTTONS)).toBe(false)
    expect(chordHeld([10, 11], CHORD_BUTTONS)).toBe(true)
    expect(chordHeld([0, 3, 10, 11], CHORD_BUTTONS)).toBe(true)
  })

  it('reads a different pair on joydev, which numbers the pad differently', () => {
    // The W3C pair on joydev is L3 + Guide, which is the Steam overlay button.
    expect(chordHeld([10, 11], CHORD_BUTTONS_JOYDEV)).toBe(false)
    expect(chordHeld([9, 10], CHORD_BUTTONS_JOYDEV)).toBe(true)
  })

  it('keeps the two mappings distinct', () => {
    expect(CHORD_BUTTONS).not.toEqual(CHORD_BUTTONS_JOYDEV)
  })
})

describe('pointerSpeed', () => {
  it('is exactly zero inside the deadzone, so a resting stick never drifts', () => {
    expect(pointerSpeed(0)).toBe(0)
    expect(pointerSpeed(POINTER_DEADZONE)).toBe(0)
    expect(pointerSpeed(POINTER_DEADZONE - 0.001)).toBe(0)
  })

  it('starts at a crawl rather than jumping, just past the deadzone', () => {
    const nudge = pointerSpeed(POINTER_DEADZONE + 0.0001)
    expect(nudge).toBeGreaterThan(0)
    expect(nudge).toBeLessThan(POINTER_MIN_SPEED * 1.01)
  })

  it('reaches full speed at full deflection and never exceeds it', () => {
    expect(pointerSpeed(1)).toBeCloseTo(POINTER_MAX_SPEED, 5)
    // A stick reporting past its own range — diagonals do — must not overspeed.
    expect(pointerSpeed(1.4)).toBeCloseTo(POINTER_MAX_SPEED, 5)
  })

  it('is monotonic across the whole travel', () => {
    let previous = -1
    for (let m = 0; m <= 1; m += 0.02) {
      const speed = pointerSpeed(m)
      expect(speed).toBeGreaterThanOrEqual(previous)
      previous = speed
    }
  })

  it('spends most of its travel slow, which is what makes a stick placeable', () => {
    // Half deflection must be well under half speed, or fine positioning is lost.
    expect(pointerSpeed(0.5)).toBeLessThan(POINTER_MAX_SPEED / 4)
  })
})

describe('stepPointer', () => {
  const bounds = { width: 1920, height: 1080 }

  it('does not move for a stick at rest', () => {
    const start = { x: 100, y: 100, at: 1_000 }
    const next = stepPointer(start, { x: 0, y: 0 }, bounds, 1_016)
    expect(next.x).toBe(100)
    expect(next.y).toBe(100)
    expect(next.at).toBe(1_016)
  })

  it('moves in the direction of the push', () => {
    const start = { x: 500, y: 500, at: 1_000 }
    const right = stepPointer(start, { x: 1, y: 0 }, bounds, 1_016)
    expect(right.x).toBeGreaterThan(500)
    expect(right.y).toBe(500)

    const up = stepPointer(start, { x: 0, y: -1 }, bounds, 1_016)
    expect(up.y).toBeLessThan(500)
  })

  it('travels the same distance on a diagonal as on an axis', () => {
    const start = { x: 900, y: 500, at: 1_000 }
    const axis = stepPointer(start, { x: 1, y: 0 }, bounds, 1_100)
    // Same magnitude, held at 45°. An unnormalised step would move √2 further
    // here, which is the classic "diagonals are faster" bug.
    const diagonal = stepPointer(start, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, bounds, 1_100)

    const axisDistance = Math.hypot(axis.x - start.x, axis.y - start.y)
    const diagonalDistance = Math.hypot(diagonal.x - start.x, diagonal.y - start.y)
    expect(diagonalDistance).toBeCloseTo(axisDistance, 6)
  })

  it('is slower on a half-pushed diagonal than on a fully pushed axis', () => {
    const start = { x: 500, y: 300, at: 1_000 }
    const full = stepPointer(start, { x: 1, y: 0 }, bounds, 1_100)
    const half = stepPointer(start, { x: 0.35, y: 0.35 }, bounds, 1_100)

    expect(Math.hypot(half.x - start.x, half.y - start.y)).toBeLessThan(
      Math.hypot(full.x - start.x, full.y - start.y)
    )
  })

  it('clamps to the surface, and leaves room for a click on the far edge', () => {
    const start = { x: 1_900, y: 1_070, at: 1_000 }
    const next = stepPointer(start, { x: 1, y: 1 }, bounds, 2_000)
    expect(next.x).toBe(bounds.width - 1)
    expect(next.y).toBe(bounds.height - 1)
  })

  it('clamps at the near edge too', () => {
    const start = { x: 4, y: 4, at: 1_000 }
    const next = stepPointer(start, { x: -1, y: -1 }, bounds, 2_000)
    expect(next.x).toBe(0)
    expect(next.y).toBe(0)
  })

  it('caps the jump after a stall instead of teleporting', () => {
    const start = { x: 0, y: 500, at: 1_000 }
    // Ten seconds of missing samples at full speed would cross the screen many
    // times over; the cap keeps it to a tenth of a second's worth.
    const next = stepPointer(start, { x: 1, y: 0 }, bounds, 11_000)
    expect(next.x).toBeLessThanOrEqual(POINTER_MAX_SPEED * 0.1 + 1)
  })

  it('re-clamps a position that is already outside, without moving it further', () => {
    // The window shrank underneath the cursor.
    const start = { x: 5_000, y: 5_000, at: 1_000 }
    const next = stepPointer(start, { x: 0, y: 0 }, bounds, 1_016)
    expect(next.x).toBe(bounds.width - 1)
    expect(next.y).toBe(bounds.height - 1)
  })

  it('survives a non-finite position rather than propagating it', () => {
    const next = stepPointer({ x: Number.NaN, y: 0, at: 1_000 }, { x: 0, y: 0 }, bounds, 1_016)
    expect(next.x).toBe(0)
  })
})

describe('centreOf', () => {
  it('starts the cursor in the middle, where it can be found', () => {
    expect(centreOf({ width: 1920, height: 1080 }, 5)).toEqual({ x: 960, y: 540, at: 5 })
  })
})

describe('scrollDelta', () => {
  it('ignores a stick inside the deadzone', () => {
    expect(scrollDelta(0, FRAME_MS)).toBe(0)
    expect(scrollDelta(POINTER_DEADZONE, FRAME_MS)).toBe(0)
  })

  it('scrolls down for a downward push, following the browser sign convention', () => {
    expect(scrollDelta(1, FRAME_MS)).toBeGreaterThan(0)
    expect(scrollDelta(-1, FRAME_MS)).toBeLessThan(0)
  })

  it('scales with the time the sample covers', () => {
    expect(scrollDelta(1, 32)).toBeCloseTo(scrollDelta(1, 16) * 2, 5)
  })

  it('caps a stalled sample the same way the cursor does', () => {
    expect(scrollDelta(1, 10_000)).toBeCloseTo(scrollDelta(1, 100), 5)
  })
})

describe('stepPointerButtons', () => {
  it('reports a press once and a release once', () => {
    expect(stepPointerButtons([], ['leftClick'])).toEqual({ down: ['leftClick'], up: [] })
    expect(stepPointerButtons(['leftClick'], ['leftClick'])).toEqual({ down: [], up: [] })
    expect(stepPointerButtons(['leftClick'], [])).toEqual({ down: [], up: ['leftClick'] })
  })

  it('handles two buttons changing on the same sample', () => {
    expect(stepPointerButtons(['leftClick'], ['rightClick'])).toEqual({
      down: ['rightClick'],
      up: ['leftClick']
    })
  })
})

describe('heldActions', () => {
  it('maps the standard layout', () => {
    expect(heldActions([0])).toEqual(['leftClick'])
    expect(heldActions([1])).toEqual(['rightClick'])
    expect(heldActions([2])).toEqual(['toggleKeyboard'])
    expect(heldActions([9])).toEqual(['exit'])
  })

  it('ignores buttons with no pointer meaning, including the chord itself', () => {
    expect(heldActions([3, 4, 5, 10, 11, 12])).toEqual([])
  })

  it('deduplicates across two pads holding the same face button', () => {
    expect(heldActions([0, 0])).toEqual(['leftClick'])
  })

  it('puts ☰ somewhere else on joydev', () => {
    expect(heldActions([9], POINTER_ACTIONS_JOYDEV)).toEqual([])
    expect(heldActions([7], POINTER_ACTIONS_JOYDEV)).toEqual(['exit'])
    expect(POINTER_ACTIONS[9]).toBe('exit')
  })
})

describe('isPointerCommand', () => {
  it('accepts every shape the preload sends', () => {
    expect(isPointerCommand({ kind: 'mode', active: true })).toBe(true)
    expect(isPointerCommand({ kind: 'move', x: 10, y: 20 })).toBe(true)
    expect(isPointerCommand({ kind: 'button', button: 'left', down: true, x: 1, y: 2 })).toBe(true)
    expect(isPointerCommand({ kind: 'wheel', x: 1, y: 2, deltaY: -30 })).toBe(true)
    expect(isPointerCommand({ kind: 'text', text: 'a' })).toBe(true)
    expect(isPointerCommand({ kind: 'key', key: 'Backspace' })).toBe(true)
  })

  it('rejects anything that is not one of them', () => {
    expect(isPointerCommand(null)).toBe(false)
    expect(isPointerCommand('move')).toBe(false)
    expect(isPointerCommand({})).toBe(false)
    expect(isPointerCommand({ kind: 'launch' })).toBe(false)
  })

  it('rejects coordinates that are not finite numbers', () => {
    expect(isPointerCommand({ kind: 'move', x: '10', y: 20 })).toBe(false)
    expect(isPointerCommand({ kind: 'move', x: Number.NaN, y: 20 })).toBe(false)
    expect(isPointerCommand({ kind: 'move', x: Number.POSITIVE_INFINITY, y: 0 })).toBe(false)
    expect(isPointerCommand({ kind: 'wheel', x: 0, y: 0, deltaY: Number.NaN })).toBe(false)
  })

  it('rejects a button that is not one of the two, and a middle click', () => {
    expect(isPointerCommand({ kind: 'button', button: 'middle', down: true, x: 0, y: 0 })).toBe(
      false
    )
    expect(isPointerCommand({ kind: 'button', button: 'left', down: 'yes', x: 0, y: 0 })).toBe(false)
  })

  it('rejects a paste dressed up as a keystroke', () => {
    expect(isPointerCommand({ kind: 'text', text: '' })).toBe(false)
    expect(isPointerCommand({ kind: 'text', text: 'password' })).toBe(false)
  })

  it('rejects a key outside the allow-list', () => {
    expect(isPointerCommand({ kind: 'key', key: 'F1' })).toBe(false)
    expect(isPointerCommand({ kind: 'key', key: 'Meta' })).toBe(false)
    expect(isPointerCommand({ kind: 'key', key: 'Enter' })).toBe(true)
  })
})
