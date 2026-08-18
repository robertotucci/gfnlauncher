import { describe, expect, it } from 'vitest'
import { SCREEN_OURS, shouldAcceptInput } from './input'

describe('shouldAcceptInput', () => {
  it('accepts anything while the launcher has focus', () => {
    for (const minimised of [false, true]) {
      for (const handedOff of [false, true]) {
        expect(shouldAcceptInput({ focused: true, minimised, handedOff })).toBe(true)
      }
    }
  })

  it('ignores a pad driving a minimised launcher', () => {
    // "Back to desktop" and `gfn:open`. The user is looking at something else
    // and the cursor would be walking the grid behind it.
    expect(shouldAcceptInput({ focused: false, minimised: true, handedOff: false })).toBe(false)
  })

  it('ignores a pad while the screen has been handed off', () => {
    // The reported bug: a game streaming fullscreen in front of a launcher that
    // Chromium is still feeding pad data to.
    expect(shouldAcceptInput({ focused: false, minimised: false, handedOff: true })).toBe(false)
  })

  it('still accepts input when the compositor simply declined to focus us', () => {
    // The row that stops this from being a `focused` gate. On Wayland a raise is
    // a request, and `restoreLauncher` records `focused=false` after its own
    // `focus()`. Nothing else has the screen, so the launcher is what the user
    // is looking at and the pad has to work.
    expect(shouldAcceptInput({ focused: false, minimised: false, handedOff: false })).toBe(true)
  })

  it('fails open on the state a renderer starts with', () => {
    // `SCREEN_OURS` is what the renderer assumes until main says otherwise — a
    // reload after `render-process-gone`, a push that never arrived. A dead pad
    // on a television with no keyboard is worse than a stray press, so the
    // default must be the permissive one. Do not tighten this.
    expect(shouldAcceptInput({ focused: false, ...SCREEN_OURS })).toBe(true)
  })
})
