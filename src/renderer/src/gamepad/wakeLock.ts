import { useRef } from 'react'
import { PAD_ACTIVITY_PING_MS } from '@shared/wakeLock'
import { useIntent } from './GamepadProvider'

/**
 * Tells the main process that somebody is driving the launcher, so it can hold
 * the display awake. Mounted once, in `App`.
 *
 * Hung off intents rather than off the poll loop: an intent is what the app
 * considers an interaction, and the alternative would be an IPC message per
 * frame. It fires for keyboard intents too, which is redundant — a real keypress
 * already resets the idle timer — and not worth a branch to avoid.
 *
 * The throttle is what makes this cheap. Holding a direction emits an intent
 * every `REPEAT_INTERVAL_MS`, so crossing the grid is one message rather than
 * dozens.
 */
export function usePadWakeLock(): void {
  // Not zero: `performance.now()` starts near zero as well, and a press in the
  // first twenty seconds of a session — which is most first presses — would be
  // read as a repeat of a report that never happened.
  const lastPingAt = useRef(Number.NEGATIVE_INFINITY)

  useIntent(() => {
    const now = performance.now()
    if (now - lastPingAt.current < PAD_ACTIVITY_PING_MS) return
    lastPingAt.current = now
    window.launcher.app.padActivity()
  })
}
