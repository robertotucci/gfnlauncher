import {
  REPEAT_DELAY_MS,
  REPEAT_INTERVAL_MS,
  type Direction,
  type GamepadAction,
  type Intent
} from './intents'

/**
 * One frame of pad state folded into intents.
 *
 * Pure and total, in the same spirit as `stepHandback` in
 * `src/main/gfn/handback.ts`: the shell reads the hardware and delivers the
 * result, this decides what any of it means. Which matters here more than
 * usual, because the suite has no DOM — `GamepadProvider` cannot be tested at
 * all, and everything about this fold that is easy to get wrong would otherwise
 * be verifiable only by quitting a game and watching what happens.
 *
 * ── Why edge detection needs a state machine and not a `Set` ────────────────
 *
 * Suppressing input while something else has the screen (see
 * `@shared/input`) is only half a fix. The other half is the boundary: the
 * button that quit the game is still physically down when the launcher comes
 * back, and a naive edge detector reads "not pressed last frame, pressed now"
 * and fires it. `CrashScreen`'s `useAnyInput` already solves exactly this with a
 * baseline, and this is that idea generalised — the first frame after a
 * suspension is *adopted*, not compared.
 *
 * The same trick covers a failure the focus signal cannot: `requestAnimationFrame`
 * can be throttled or stopped for a window that is blurred or occluded, and
 * Chromium's exact behaviour there is precisely what this whole bug proved
 * cannot be assumed. So a frame that arrives more than `MAX_FRAME_GAP_MS` after
 * the last one is also adopted rather than compared — an "edge" measured against
 * a reading from an unknown time ago is not an edge.
 */

/**
 * Beyond this, the previous frame is history rather than context.
 *
 * Comfortably above a dropped frame or a GC pause (~33 ms at 30 fps) and
 * comfortably below both Chromium's background rAF throttle (~1 s) and
 * `REPEAT_DELAY_MS`, so it can never swallow a repeat that was due.
 */
export const MAX_FRAME_GAP_MS = 250

export interface PadFrame {
  /** Every action held this frame, across every connected pad, deduplicated. */
  readonly pressed: readonly GamepadAction[]
  readonly direction: Direction | null
  /** `shouldAcceptInput` — whether the launcher may act on any of this. */
  readonly accepted: boolean
  /** `performance.now()`. The clock belongs to the caller so this stays pure. */
  readonly now: number
}

export interface PadState {
  /** The edge baseline: what was held on the frame before. */
  readonly held: readonly GamepadAction[]
  readonly direction: Direction | null
  /**
   * When the next repeat is due, or `null` for "held, but disowned".
   *
   * `null` is what stops a burst at the boundary. A direction adopted on resume
   * sits in `direction`, so the next frame takes the *repeat* branch, finds no
   * clock, and emits nothing — for as long as it is held. Re-arming the clock
   * instead would still fire an unrequested move `REPEAT_DELAY_MS` after the
   * game ended. Recentring the stick clears it; pushing again is a genuine
   * change of direction and behaves normally.
   */
  readonly repeatAt: number | null
  /** When that frame was, on the same clock. */
  readonly at: number
  readonly accepted: boolean
}

export interface PadStep {
  readonly next: PadState
  /** In order. Nothing is delivered here; the provider emits them. */
  readonly intents: readonly Intent[]
}

/**
 * Deliberately `accepted: false`, so the very first frame of a session is
 * adopted too: a launcher that comes up with a button already held must not act
 * on it.
 */
export const PAD_START: PadState = {
  held: [],
  direction: null,
  repeatAt: null,
  at: Number.NEGATIVE_INFINITY,
  accepted: false
}

/** Take the frame as the new baseline and emit nothing. */
function adopt(frame: PadFrame): PadStep {
  return {
    next: {
      held: frame.pressed,
      direction: frame.direction,
      repeatAt: null,
      at: frame.now,
      accepted: frame.accepted
    },
    intents: []
  }
}

export function stepPad(state: PadState, frame: PadFrame): PadStep {
  // Suspended. The state still tracks the hardware — that is what makes the
  // resume free rather than something to remember to do — but nothing is
  // emitted, and the repeat clock is disowned rather than left ticking.
  if (!frame.accepted) return adopt(frame)

  // Resuming, or waking from a stall. Either way there is nothing to compare
  // against, so this frame becomes the baseline.
  if (!state.accepted || frame.now - state.at > MAX_FRAME_GAP_MS) return adopt(frame)

  const intents: Intent[] = []

  // Buttons fire once per press, never on hold.
  for (const action of frame.pressed) {
    if (!state.held.includes(action)) intents.push({ kind: 'action', action })
  }

  let repeatAt = state.repeatAt
  if (frame.direction === null) {
    repeatAt = null
  } else if (frame.direction !== state.direction) {
    repeatAt = frame.now + REPEAT_DELAY_MS
    intents.push({ kind: 'move', direction: frame.direction })
  } else if (repeatAt !== null && frame.now >= repeatAt) {
    repeatAt = frame.now + REPEAT_INTERVAL_MS
    intents.push({ kind: 'move', direction: frame.direction })
  }

  return {
    next: {
      held: frame.pressed,
      direction: frame.direction,
      repeatAt,
      at: frame.now,
      accepted: true
    },
    intents
  }
}
