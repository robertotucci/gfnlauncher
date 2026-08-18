import { describe, expect, it } from 'vitest'
import { REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, type Intent } from './intents'
import { MAX_FRAME_GAP_MS, PAD_START, stepPad, type PadFrame, type PadState } from './pad'

/** 60 fps, which is what the provider's `requestAnimationFrame` loop delivers. */
const FRAME_MS = 16

/** A frame at rest. */
function frame(at: number, partial: Partial<PadFrame> = {}): PadFrame {
  return { pressed: [], direction: null, accepted: true, now: at, ...partial }
}

/** Feeds frames in order and collects everything that came out. */
function run(
  frames: readonly PadFrame[],
  from: PadState = PAD_START
): { state: PadState; intents: Intent[] } {
  let state = from
  const intents: Intent[] = []
  for (const f of frames) {
    const step = stepPad(state, f)
    state = step.next
    intents.push(...step.intents)
  }
  return { state, intents }
}

/** Past the first-frame adoption, so a test can start from a live baseline. */
function live(at = 1_000): PadState {
  return run([frame(at)]).state
}

/** Holds one direction at 60 fps and reports when each move came out. */
function holdDirection(direction: 'up' | 'down' | 'left' | 'right', until: number): number[] {
  let state = live()
  const at: number[] = []
  for (let now = 1_000 + FRAME_MS; now <= until; now += FRAME_MS) {
    const step = stepPad(state, frame(now, { direction }))
    state = step.next
    if (step.intents.length > 0) at.push(now)
  }
  return at
}

describe('stepPad', () => {
  it('fires a button once per press, never on hold', () => {
    const { intents } = run(
      [
        frame(1_016, { pressed: ['confirm'] }),
        frame(1_032, { pressed: ['confirm'] }),
        frame(1_048, { pressed: ['confirm'] })
      ],
      live()
    )
    expect(intents).toEqual([{ kind: 'action', action: 'confirm' }])
  })

  it('fires the same button again once it has been let go', () => {
    const { intents } = run(
      [
        frame(1_016, { pressed: ['confirm'] }),
        frame(1_032),
        frame(1_048, { pressed: ['confirm'] })
      ],
      live()
    )
    expect(intents).toEqual([
      { kind: 'action', action: 'confirm' },
      { kind: 'action', action: 'confirm' }
    ])
  })

  it('counts a button held on two pads as one press', () => {
    // The provider unions across pads before it gets here, so this pins the
    // contract rather than the implementation: `pressed` is a set.
    const { intents } = run([frame(1_016, { pressed: ['back'] })], live())
    expect(intents).toEqual([{ kind: 'action', action: 'back' }])
  })

  it('moves on the first frame of a direction, then repeats on the clock', () => {
    // Real frames, not jumps: a jump would trip the gap re-baseline below, which
    // is itself the point — the two mechanisms have to stay clear of each other.
    const at = holdDirection('down', 1_800)
    const first = at[0] ?? 0

    expect(first).toBe(1_000 + FRAME_MS)
    expect(at.filter((t) => t > first && t < first + REPEAT_DELAY_MS)).toEqual([])

    const beats = at.filter((t) => t >= first + REPEAT_DELAY_MS)
    expect(beats.length).toBeGreaterThanOrEqual(3)
    for (const [index, t] of beats.entries()) {
      if (index === 0) continue
      const gap = t - (beats[index - 1] ?? 0)
      expect(gap).toBeGreaterThanOrEqual(REPEAT_INTERVAL_MS)
      expect(gap).toBeLessThan(REPEAT_INTERVAL_MS + FRAME_MS)
    }
  })

  it('moves on a direction change without waiting for the repeat clock', () => {
    const { intents } = run(
      [frame(1_016, { direction: 'left' }), frame(1_032, { direction: 'right' })],
      live()
    )
    expect(intents).toEqual([
      { kind: 'move', direction: 'left' },
      { kind: 'move', direction: 'right' }
    ])
  })

  it('adopts the very first frame rather than acting on it', () => {
    // A launcher that comes up with a button already down must not act on it.
    const { intents } = run([frame(1_000, { pressed: ['start'] })])
    expect(intents).toEqual([])
  })
})

describe('stepPad while input is suspended', () => {
  it('emits nothing at all, whatever the pad is doing', () => {
    const { intents } = run(
      [
        frame(1_016, { accepted: false, pressed: ['start', 'confirm'], direction: 'down' }),
        frame(1_032, { accepted: false, pressed: ['start', 'confirm'], direction: 'down' }),
        frame(2_000, { accepted: false, pressed: ['back'], direction: 'up' })
      ],
      live()
    )
    expect(intents).toEqual([])
  })

  it('is not sticky: one accepted frame is enough to be live again', () => {
    // The property that makes "input frozen for the rest of the session"
    // unrepresentable. There is no latch here to get stuck.
    const suspended = run([frame(1_016, { accepted: false })], live()).state
    const { intents } = run(
      [frame(1_032), frame(1_048, { pressed: ['confirm'] })],
      suspended
    )
    expect(intents).toEqual([{ kind: 'action', action: 'confirm' }])
  })
})

describe('stepPad across the suspend boundary', () => {
  it('does not fire a button that was still held when input came back', () => {
    // The headline case: you quit the game with A, the launcher comes back, and
    // A is still down. That is not a press.
    const { intents } = run(
      [
        frame(1_016, { accepted: false, pressed: ['confirm'] }),
        frame(1_032, { accepted: false, pressed: ['confirm'] }),
        frame(1_048, { pressed: ['confirm'] }),
        frame(1_064, { pressed: ['confirm'] }),
        frame(1_080, { pressed: ['confirm'] })
      ],
      live()
    )
    expect(intents).toEqual([])
  })

  it('fires it once it has been let go and pressed again', () => {
    const { intents } = run(
      [
        frame(1_016, { accepted: false, pressed: ['confirm'] }),
        frame(1_032, { pressed: ['confirm'] }),
        frame(1_048),
        frame(1_064, { pressed: ['confirm'] })
      ],
      live()
    )
    expect(intents).toEqual([{ kind: 'action', action: 'confirm' }])
  })

  it('does not move for a direction held across the boundary, and never repeats', () => {
    // The no-burst case, and the one most likely to be lost to a later
    // "simplification" of `repeatAt: null` back into `now + REPEAT_DELAY_MS`.
    const frames: PadFrame[] = [frame(1_016, { accepted: false, direction: 'down' })]
    for (let at = 1_032; at <= 1_032 + REPEAT_DELAY_MS + 10 * REPEAT_INTERVAL_MS; at += 16) {
      frames.push(frame(at, { direction: 'down' }))
    }
    expect(run(frames, live()).intents).toEqual([])
  })

  it('moves again once the stick has been recentred', () => {
    const { intents } = run(
      [
        frame(1_016, { accepted: false, direction: 'down' }),
        frame(1_032, { direction: 'down' }),
        frame(1_048),
        frame(1_064, { direction: 'down' })
      ],
      live()
    )
    expect(intents).toEqual([{ kind: 'move', direction: 'down' }])
  })
})

describe('stepPad across a gap between frames', () => {
  it('re-baselines after a stall, even though nothing said input was suspended', () => {
    // `requestAnimationFrame` can be throttled or stopped for a blurred or
    // occluded window, and this whole bug is a lesson in not assuming what
    // Chromium does there. An edge measured against a reading from an unknown
    // time ago is not an edge — so this is the half of the fix that does not
    // depend on the focus signal arriving at all.
    const { intents } = run(
      [
        frame(1_016 + MAX_FRAME_GAP_MS + 1, { pressed: ['start'] }),
        frame(1_032 + MAX_FRAME_GAP_MS + 1, { pressed: ['start'] })
      ],
      live(1_016)
    )
    expect(intents).toEqual([])
  })

  it('treats an ordinary dropped frame as an ordinary frame', () => {
    // The other direction, so the threshold cannot be tightened into swallowing
    // presses on a machine that stutters.
    const { intents } = run([frame(1_116, { pressed: ['start'] })], live(1_016))
    expect(intents).toEqual([{ kind: 'action', action: 'start' }])
  })

  it('keeps the gap clear of both thresholds it sits between', () => {
    // The guarantee rather than the coverage. Raise it past the repeat delay and
    // a held direction skips a beat on every hiccup; drop it near one frame and
    // every stutter eats a press.
    expect(MAX_FRAME_GAP_MS).toBeGreaterThan(100)
    expect(MAX_FRAME_GAP_MS).toBeLessThan(REPEAT_DELAY_MS)
  })
})

describe('stepPad, as a reducer', () => {
  it('is total: every frame is legal in every state', () => {
    const states: PadState[] = [
      PAD_START,
      live(),
      run([frame(1_016, { accepted: false, pressed: ['confirm'], direction: 'up' })], live()).state
    ]
    const frames: PadFrame[] = [
      frame(2_000),
      frame(2_000, { pressed: ['confirm', 'back', 'start'], direction: 'left' }),
      frame(2_000, { accepted: false, direction: 'right' }),
      frame(Number.MAX_SAFE_INTEGER, { pressed: ['menu'] })
    ]

    for (const state of states) {
      for (const f of frames) {
        expect(() => stepPad(state, f)).not.toThrow()
      }
    }
  })

  it('does not mutate the state it is given', () => {
    const state = Object.freeze(live())
    expect(() => stepPad(state, frame(1_016, { pressed: ['confirm'] }))).not.toThrow()
  })
})
