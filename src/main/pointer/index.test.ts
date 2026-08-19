import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The channel is the whole subject here, so `ipcMain` is a stub that hands the
 * registered listener back to the test. Same shape of stub as
 * `webStream.test.ts`: the module reaches for Electron at import time, and the
 * suite has none.
 */
const handlers = new Map<string, (event: unknown, payload: unknown) => void>()

vi.mock('electron', () => ({
  ipcMain: {
    on(channel: string, handler: (event: unknown, payload: unknown) => void) {
      handlers.set(channel, handler)
    }
  }
}))

const { registerPointerTarget, isPointerActive } = await import('./index')
const { IPC } = await import('@shared/ipc')

interface SentEvent {
  type: string
  [key: string]: unknown
}

/** A stand-in for a BrowserWindow, recording what was sent into its page. */
function fakeWindow(id: number): {
  window: Parameters<typeof registerPointerTarget>[0]
  /** Input replayed into the page with `sendInputEvent`. */
  sent: SentEvent[]
  /** Messages pushed down the `pointer:restore` channel. */
  pushed: { channel: string; payload: unknown }[]
  close: () => void
  navigate: () => void
  destroy: () => void
} {
  const sent: SentEvent[] = []
  const pushed: { channel: string; payload: unknown }[] = []
  let destroyed = false
  const onClosed: (() => void)[] = []
  const onLoaded: (() => void)[] = []

  const contents = {
    id,
    isDestroyed: () => destroyed,
    sendInputEvent: (event: SentEvent) => sent.push(event),
    send: (channel: string, payload: unknown) => pushed.push({ channel, payload }),
    on(event: string, listener: () => void) {
      if (event === 'did-finish-load') onLoaded.push(listener)
    }
  }

  const window = {
    webContents: contents,
    on(event: string, listener: () => void) {
      if (event === 'closed') onClosed.push(listener)
    }
  }

  return {
    window: window as unknown as Parameters<typeof registerPointerTarget>[0],
    sent,
    pushed,
    close: () => onClosed.forEach((listener) => listener()),
    navigate: () => onLoaded.forEach((listener) => listener()),
    destroy: () => {
      destroyed = true
    }
  }
}

/** Fires one command as if a preload had sent it from `senderId`. */
function send(senderId: number, payload: unknown): void {
  handlers.get(IPC.pointerEvent)?.({ sender: { id: senderId } }, payload)
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('the pointer channel', () => {
  it('registers exactly one listener however many windows are registered', () => {
    registerPointerTarget(fakeWindow(101).window, 'first')
    registerPointerTarget(fakeWindow(102).window, 'second')
    expect(handlers.size).toBe(1)
    expect(handlers.has(IPC.pointerEvent)).toBe(true)
  })

  it('ignores a command from a window that was never registered', () => {
    const target = fakeWindow(200)
    registerPointerTarget(target.window, 'sign-in')

    send(999, { kind: 'move', x: 10, y: 10 })

    expect(target.sent).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unregistered window'))
  })

  it('ignores a malformed payload rather than passing it to sendInputEvent', () => {
    const target = fakeWindow(201)
    registerPointerTarget(target.window, 'sign-in')

    // Each of these is a shape `isPointerCommand` exists to stop: an unknown
    // command, a coordinate that is not a number, a paste, a modifier key.
    send(201, { kind: 'launch', cmsId: '100' })
    send(201, { kind: 'move', x: 'NaN', y: 0 })
    send(201, { kind: 'text', text: 'hunter2' })
    send(201, { kind: 'key', key: 'Meta' })
    send(201, null)
    send(201, 'move')

    expect(target.sent).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Malformed'))
  })

  it('sends nothing into a page that has already gone', () => {
    const target = fakeWindow(202)
    registerPointerTarget(target.window, 'sign-in')
    target.destroy()

    send(202, { kind: 'move', x: 1, y: 1 })
    expect(target.sent).toEqual([])
  })
})

describe('replaying a command as real input', () => {
  it('moves the cursor', () => {
    const target = fakeWindow(300)
    registerPointerTarget(target.window, 'sign-in')

    send(300, { kind: 'move', x: 120.4, y: 55.6 })

    expect(target.sent).toEqual([{ type: 'mouseMove', x: 120, y: 56 }])
  })

  it('presses and releases, so a drag is the gap between them', () => {
    const target = fakeWindow(301)
    registerPointerTarget(target.window, 'sign-in')

    send(301, { kind: 'button', button: 'left', down: true, x: 10, y: 20 })
    send(301, { kind: 'button', button: 'left', down: false, x: 10, y: 20 })

    expect(target.sent).toEqual([
      { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 10, y: 20, button: 'left', clickCount: 1 }
    ])
  })

  it('carries the right button through', () => {
    const target = fakeWindow(302)
    registerPointerTarget(target.window, 'sign-in')

    send(302, { kind: 'button', button: 'right', down: true, x: 0, y: 0 })
    expect(target.sent[0]).toMatchObject({ button: 'right' })
  })

  it('flips the wheel sign, because Chromium runs it the other way to the DOM', () => {
    const target = fakeWindow(303)
    registerPointerTarget(target.window, 'sign-in')

    // `scrollDelta` speaks the browser's convention: positive scrolls content
    // down. Chromium's wheel delta is the opposite, so a page scrolled the
    // wrong way is exactly the bug this asserts against.
    send(303, { kind: 'wheel', x: 5, y: 5, deltaY: 120 })

    expect(target.sent).toEqual([
      { type: 'mouseWheel', x: 5, y: 5, deltaX: 0, deltaY: -120, canScroll: true }
    ])
  })

  it('types a character as a char event, not as a keycode', () => {
    const target = fakeWindow(304)
    registerPointerTarget(target.window, 'sign-in')

    // A keycode would need the modifier state right for anything above the
    // plain letters, and a password is mostly the characters above them.
    send(304, { kind: 'text', text: '\\' })

    expect(target.sent).toEqual([{ type: 'char', keyCode: '\\' }])
  })

  it('sends a named key as a down and an up', () => {
    const target = fakeWindow(305)
    registerPointerTarget(target.window, 'sign-in')

    send(305, { kind: 'key', key: 'Backspace' })

    expect(target.sent).toEqual([
      { type: 'keyDown', keyCode: 'Backspace' },
      { type: 'keyUp', keyCode: 'Backspace' }
    ])
  })

  it('keeps two registered windows apart', () => {
    const first = fakeWindow(400)
    const second = fakeWindow(401)
    registerPointerTarget(first.window, 'sign-in')
    registerPointerTarget(second.window, 'web player')

    send(400, { kind: 'move', x: 1, y: 1 })

    expect(first.sent).toHaveLength(1)
    expect(second.sent).toEqual([])
  })
})

describe('the mode, and the way out of it', () => {
  it('reports whether a cursor is up anywhere', () => {
    const target = fakeWindow(500)
    registerPointerTarget(target.window, 'sign-in')

    send(500, { kind: 'mode', active: true })
    expect(isPointerActive()).toBe(true)

    send(500, { kind: 'mode', active: false })
    expect(isPointerActive()).toBe(false)
  })

  it('ends the mode when the window it was in closes', () => {
    const target = fakeWindow(501)
    registerPointerTarget(target.window, 'sign-in')
    send(501, { kind: 'mode', active: true })

    target.close()

    // The failure this guards: a latch left on after its window went away
    // would make the *next* window come up with a cursor nobody asked for.
    expect(isPointerActive()).toBe(false)
  })

  it('forgets a closed window, so a late message from it does nothing', () => {
    const target = fakeWindow(502)
    registerPointerTarget(target.window, 'sign-in')
    target.close()

    send(502, { kind: 'move', x: 1, y: 1 })

    expect(target.sent).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unregistered window'))
  })

  it('replays the mode into every new document, so a navigation does not kill it', () => {
    // Signing in is three or four navigations. Without this the cursor dies at
    // each hop and the chord has to be held again to finish one form.
    const target = fakeWindow(700)
    registerPointerTarget(target.window, 'sign-in')
    send(700, { kind: 'mode', active: true })

    target.navigate()

    expect(target.pushed).toEqual([{ channel: IPC.pointerRestore, payload: true }])
  })

  it('replays "off" into a document of a window that never turned it on', () => {
    const target = fakeWindow(701)
    registerPointerTarget(target.window, 'web player')

    target.navigate()

    expect(target.pushed).toEqual([{ channel: IPC.pointerRestore, payload: false }])
  })

  it('does not replay another window’s mode into this one', () => {
    const first = fakeWindow(702)
    const second = fakeWindow(703)
    registerPointerTarget(first.window, 'sign-in')
    registerPointerTarget(second.window, 'web player')

    send(702, { kind: 'mode', active: true })
    second.navigate()

    expect(second.pushed).toEqual([{ channel: IPC.pointerRestore, payload: false }])
  })

  it('ignores a stale "off" from a window that does not own the mode', () => {
    const first = fakeWindow(704)
    const second = fakeWindow(705)
    registerPointerTarget(first.window, 'sign-in')
    registerPointerTarget(second.window, 'web player')

    send(705, { kind: 'mode', active: true })
    send(704, { kind: 'mode', active: false })

    expect(isPointerActive()).toBe(true)
  })

  it('does not let one window closing cancel another window’s cursor', () => {
    const first = fakeWindow(600)
    const second = fakeWindow(601)
    registerPointerTarget(first.window, 'sign-in')
    registerPointerTarget(second.window, 'web player')

    send(601, { kind: 'mode', active: true })
    first.close()

    expect(isPointerActive()).toBe(true)
  })
})
