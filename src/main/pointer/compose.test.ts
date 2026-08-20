import { describe, expect, it, vi } from 'vitest'

// Only the pure half is under test, but the module opens a window and so
// reaches for Electron at import time. Same stub as `index.test.ts`.
vi.mock('electron', () => ({
  ipcMain: { on: () => {} },
  app: { getLocale: () => 'en_US' },
  BrowserWindow: class {},
  // `getPrimaryDisplay` is the one this module calls. It used to name
  // `getDisplayMatching`, which it has never called — a stub for a function
  // that does not exist reads as documentation of a call that does.
  screen: {
    getPrimaryDisplay: () => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1053 }
    })
  }
}))

const {
  composeStart,
  composeSafeBottom,
  MAX_COMPOSE_LENGTH,
  composeDirection,
  pressComposeButton
} = await import('./compose')
const { buildComposeLayout, composeLayoutFor } = await import('@shared/keyboardLayout')

/** A state on the Italian layout, which is the one with a generated row. */
const start = composeStart(buildComposeLayout(composeLayoutFor('it')))

const axes = (
  partial: Partial<{
    leftX: number
    leftY: number
    rightX: number
    rightY: number
    dpadX: number
    dpadY: number
  }> = {}
): {
  leftX: number
  leftY: number
  rightX: number
  rightY: number
  dpadX: number
  dpadY: number
} => ({ leftX: 0, leftY: 0, rightX: 0, rightY: 0, dpadX: 0, dpadY: 0, ...partial })

describe('pressComposeButton', () => {
  it('types the button, which is the character it is named after', () => {
    // The layout is written in simple-keyboard's own format and the shifted
    // layer *is* the shifted characters, so this needs no table and there is no
    // second copy of the layout to disagree with.
    expect(pressComposeButton(start, 'a')).toEqual({
      kind: 'editing',
      next: { ...start, text: 'a' }
    })
    expect(pressComposeButton({ ...start, layer: 'shift' }, '%')).toMatchObject({
      next: { text: '%' }
    })
  })

  it('switches layer on shift, and back again', () => {
    const up = pressComposeButton(start, '{shift}')
    expect(up).toMatchObject({ next: { layer: 'shift' } })
    expect(pressComposeButton({ ...start, layer: 'shift' }, '{shift}')).toMatchObject({
      next: { layer: 'default' }
    })
  })

  it('keeps the selection where it is across a layer change', () => {
    // Both layers are the same shape, so shift must not move the cursor — it is
    // the same key with a different face on it.
    const at = { row: 3, column: 5 }
    expect(pressComposeButton({ ...start, at }, '{shift}')).toMatchObject({
      next: { at }
    })
  })

  it('types a space from the function row', () => {
    expect(pressComposeButton(start, '{space}')).toMatchObject({ next: { text: ' ' } })
  })

  it('deletes the last character and stops at empty', () => {
    expect(pressComposeButton({ ...start, text: 'ab' }, '{bksp}')).toMatchObject({
      next: { text: 'a' }
    })
    expect(pressComposeButton(start, '{bksp}')).toMatchObject({ next: { text: '' } })
  })

  it('sends on SEND, and asks for a Return with it', () => {
    // The field being typed into almost always has a button next to it, and
    // reaching that button with the cursor is the thing that was hard in the
    // first place.
    expect(pressComposeButton({ ...start, text: 'hunter2' }, '{enter}')).toEqual({
      kind: 'send',
      text: 'hunter2',
      enter: true
    })
  })

  it('cancels on CANCEL', () => {
    expect(pressComposeButton(start, '{close}')).toEqual({ kind: 'cancel' })
  })

  it('ignores a brace key it does not know rather than typing it', () => {
    // A layout that grows a `{tab}` must not put the four characters "{tab}"
    // into somebody's password field.
    expect(pressComposeButton(start, '{tab}')).toEqual({
      kind: 'editing',
      next: start
    })
  })

  it('stops accepting characters at the cap', () => {
    // A pad with a stuck button is a real thing, and this text is sent as
    // keystrokes into somebody else's window.
    const full = { ...start, text: 'x'.repeat(MAX_COMPOSE_LENGTH) }
    expect(pressComposeButton(full, 'a')).toEqual({ kind: 'editing', next: full })
    expect(pressComposeButton(full, '{space}')).toEqual({ kind: 'editing', next: full })
  })
})

describe('composeDirection', () => {
  it('reads the d-pad first, because that is what a person reaches for', () => {
    expect(composeDirection(axes({ dpadY: -1 }))).toBe('up')
    expect(composeDirection(axes({ dpadY: 1 }))).toBe('down')
    expect(composeDirection(axes({ dpadX: -1 }))).toBe('left')
    expect(composeDirection(axes({ dpadX: 1 }))).toBe('right')
  })

  it('lets the d-pad win over a stick that is also being pushed', () => {
    expect(composeDirection(axes({ dpadX: 1, leftY: 1 }))).toBe('right')
  })

  it('falls back to the stick, gated well past the cursor deadzone', () => {
    // Picking a key is a discrete choice: a twitch must not skip two of them,
    // which is why this gate is 0.5 and POINTER_DEADZONE is 0.16.
    expect(composeDirection(axes({ leftY: 0.3 }))).toBeNull()
    expect(composeDirection(axes({ leftY: 0.9 }))).toBe('down')
    expect(composeDirection(axes({ leftX: -0.9 }))).toBe('left')
  })

  it('resolves a diagonal to the larger axis rather than to both', () => {
    expect(composeDirection(axes({ leftX: 0.9, leftY: 0.6 }))).toBe('right')
    expect(composeDirection(axes({ leftX: 0.6, leftY: -0.9 }))).toBe('up')
  })

  it('is nothing at all at rest', () => {
    expect(composeDirection(axes())).toBeNull()
  })
})

describe('composeSafeBottom', () => {
  /*
   * The three ways a Wayland compositor can answer, and they are
   * indistinguishable from inside the window — which is the point of measuring
   * the window rather than looking for a panel. All three screens here are
   * 1080p with a 27 px panel, so the work area is 1053 high.
   */
  const workArea = 1053

  it('clears a panel sitting over the bottom of a full-height window', () => {
    expect(composeSafeBottom(1080, workArea)).toBe(27)
  })

  it('gives the same answer when the window was pushed past the screen edge', () => {
    // KWin clamps placement to the work area, so a window taller than it can be
    // put at y=27 with its last 27 px off the screen. Same unusable pixels,
    // same number, and no position was needed to work it out.
    expect(composeSafeBottom(1080, workArea)).toBe(27)
  })

  it('is zero when the window is exactly the work area', () => {
    // The request was honoured, so the bottom edge already is the top of the
    // panel and lifting the keyboard would leave a gap for no reason.
    expect(composeSafeBottom(1053, workArea)).toBe(0)
  })

  it('never goes negative', () => {
    // A second output with a taller work area than the window we were sized
    // for. Signed arithmetic here would push the keyboard *down*, off the
    // screen, to correct a problem that does not exist.
    expect(composeSafeBottom(900, workArea)).toBe(0)
  })

  it('rounds, because a fractional inset is a subpixel row of panel', () => {
    expect(composeSafeBottom(1080.4, 1052.6)).toBe(28)
  })
})
