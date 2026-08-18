/**
 * When pad input is allowed to reach the UI.
 *
 * The launcher used to have no answer to this, because it believed it did not
 * need one: *the Gamepad API only reports to a focused window, so a blurred
 * launcher is a dead launcher.* That sentence is in this repository about ten
 * times and on Linux it is false. Chromium stops sampling pads when the **page**
 * stops being visible, and a fullscreen window that another fullscreen window
 * happens to be covering is still visible — so with a game streaming in front of
 * it, the launcher went on receiving live pad data and acting on it. The cursor
 * moved, actions fired, and because the ☰ button is Play, a pause menu could
 * reach `gfn:launch`, whose first act is to kill the client that is streaming.
 *
 * So the launcher enforces the rule itself, and the rule has to be written down
 * somewhere pure, because the two facts it needs live on opposite sides of the
 * bridge: the renderer knows whether it has focus, and only main knows whether
 * the screen has been handed to something else.
 *
 * **It fails open, deliberately.** Every unknown resolves to "accept". A stray
 * press behind another window is the bug this module exists to fix; a pad that
 * has gone dead on a television with no keyboard in the room is worse than the
 * bug, and it is unrecoverable. `SCREEN_OURS` is therefore the renderer's
 * starting assumption, so a signal that never arrives — a renderer reloaded
 * after `render-process-gone`, a main process that failed to push — costs
 * correctness and never costs control.
 */

/** What main knows about who has the screen. Pushed over `app:screen`. */
export interface ScreenOwnership {
  /**
   * The launcher is iconified.
   *
   * "Back to desktop" and `gfn:open` both `stepAside`, and a minimised launcher
   * being driven by a pad is the same defect through a different door — the user
   * is looking at their desktop while the cursor walks the grid behind it.
   */
  readonly minimised: boolean
  /**
   * The screen has been handed to something else, and it is not coming back on
   * its own: the GeForce NOW client, our own web-stream window, or the sign-in
   * window.
   *
   * Main owns this because it is the only side that knows. The renderer cannot
   * tell "GeForce NOW is streaming on top of me" from "a notification stole the
   * focus for a second", and those two want opposite answers.
   */
  readonly handedOff: boolean
}

/** Nothing is in front of us as far as anyone has said. See "fails open". */
export const SCREEN_OURS: ScreenOwnership = { minimised: false, handedOff: false }

export interface InputGate extends ScreenOwnership {
  /** The renderer's own reading, from `focus`/`blur` on `window`. */
  readonly focused: boolean
}

/**
 * The whole policy, and the reason it is three lines rather than one.
 *
 * `focused` alone would be the obvious gate and it is the one that would strand
 * the launcher. On Wayland a raise is a request the compositor may decline —
 * `restoreLauncher` logs `focused=false` after its own `focus()` call, and this
 * machine's log has examples — so after a game the launcher can be the only
 * thing on screen and still not hold focus. Gating on focus alone would make
 * that a launcher nobody can drive, which is the worst outcome this product has.
 *
 * Hence the middle row: **unfocused is only disqualifying when we know somebody
 * else has the screen.** Left in front with nothing else running, the launcher
 * answers the pad whether or not the compositor ever got round to focusing it.
 *
 *   focused | minimised | handedOff | input
 *   ------- | --------- | --------- | -----
 *   yes     | —         | —         | accepted
 *   no      | yes       | —         | ignored   ← Back to desktop, `gfn:open`
 *   no      | no        | yes       | ignored   ← the bug
 *   no      | no        | no        | accepted  ← the compositor declined focus
 */
export function shouldAcceptInput({ focused, minimised, handedOff }: InputGate): boolean {
  if (focused) return true
  if (minimised) return false
  return !handedOff
}
