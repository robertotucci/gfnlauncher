/**
 * When the launcher holds the display awake, and for how long.
 *
 * A gamepad is not an input device as far as a compositor's idle timer is
 * concerned: evdev joysticks are not routed to the seat, so the sticks can be
 * moving and the screen still blanks on schedule. Every other application gets
 * this for free by being driven with a mouse.
 *
 * Both halves of the arrangement live here because they have to agree. The
 * renderer reports pad input at most once every `PAD_ACTIVITY_PING_MS`; the main
 * process keeps the display awake for `WAKE_AFTER_INPUT_MS` after the last
 * report. The first has to be comfortably shorter than the second, or the
 * inhibit would lapse between two reports from a pad that never stopped moving.
 */

/**
 * The renderer's throttle. Holding a direction emits an intent every 90 ms, so
 * this is what keeps a navigating pad from becoming an IPC message per frame.
 */
export const PAD_ACTIVITY_PING_MS = 20_000

/**
 * How long the display is held awake after the last reported input.
 *
 * Tied to input rather than to a pad being plugged in, which would be the
 * simpler rule and the wrong one: a launcher that inhibits blanking merely
 * because a controller is connected leaves a bright, static grid on a television
 * all night, and that is worse than the problem it set out to fix.
 */
export const WAKE_AFTER_INPUT_MS = 5 * 60_000

/**
 * Pure, so the policy can be asserted without a display to keep awake.
 *
 * `lastActivityAt` is null until the first input of the session — a launcher
 * nobody has touched since it started has no claim on the screen.
 */
export function shouldStayAwake({
  lastActivityAt,
  now,
  focused
}: {
  /** When input was last reported, on the same clock as `now`. */
  lastActivityAt: number | null
  focused: boolean
  now: number
}): boolean {
  // A blurred launcher receives no pad input in the first place — the Gamepad
  // API only reports to a focused window — so this is mostly about letting go
  // promptly when the GeForce NOW client takes the screen. Whatever is in front
  // now is responsible for its own screen.
  if (!focused) return false
  if (lastActivityAt === null) return false
  return now - lastActivityAt < WAKE_AFTER_INPUT_MS
}
