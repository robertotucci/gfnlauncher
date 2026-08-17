import { describe, expect, it } from 'vitest'
import { PAD_ACTIVITY_PING_MS, WAKE_AFTER_INPUT_MS, shouldStayAwake } from './wakeLock'

describe('shouldStayAwake', () => {
  it('holds the display while a focused launcher is being driven', () => {
    expect(shouldStayAwake({ lastActivityAt: 1_000, now: 2_000, focused: true })).toBe(true)
  })

  it('lets go once the input stops', () => {
    const lastActivityAt = 1_000
    expect(
      shouldStayAwake({
        lastActivityAt,
        now: lastActivityAt + WAKE_AFTER_INPUT_MS - 1,
        focused: true
      })
    ).toBe(true)
    // At the boundary the claim has expired: the television is meant to go off
    // when the room is empty, and this is the only thing that lets it.
    expect(
      shouldStayAwake({ lastActivityAt, now: lastActivityAt + WAKE_AFTER_INPUT_MS, focused: true })
    ).toBe(false)
  })

  it('lets go the moment the window is blurred, however recent the input', () => {
    // The launcher steps aside for the GeForce NOW client mid-press. Holding the
    // inhibit from behind another application's fullscreen window is not ours to
    // do.
    expect(shouldStayAwake({ lastActivityAt: 1_000, now: 1_001, focused: false })).toBe(false)
  })

  it('claims nothing before the first input of the session', () => {
    // An autostarted launcher on a television nobody is watching.
    expect(shouldStayAwake({ lastActivityAt: null, now: 9_999_999, focused: true })).toBe(false)
  })
})

describe('the two intervals', () => {
  it('reports input far more often than the inhibit expires', () => {
    // The guarantee, not the coverage. Raise the ping interval past the timeout
    // and a pad that never stopped moving would still lose the display between
    // two reports — a screen that blanks mid-press, intermittently, which is
    // the hardest kind of bug to be told about from a sofa.
    expect(PAD_ACTIVITY_PING_MS * 2).toBeLessThan(WAKE_AFTER_INPUT_MS)
  })
})
