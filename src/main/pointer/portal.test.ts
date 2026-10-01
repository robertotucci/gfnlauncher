import type { MessageBus } from '@homebridge/dbus-native'
import {
  KEY_LEFTSHIFT,
  keycodeForChar,
  keycodeForKey,
  keysymForChar,
  keysymForKey
} from '@shared/keycodes'
import { describe, expect, it, vi } from 'vitest'
import { buildPointer } from './portal'

/**
 * The portal answers each call asynchronously, and the order its replies come
 * back in is not something this side controls. The fake below answers after a
 * delay that shrinks with every call, so a later call is answered *first* —
 * the worst case, and the one that used to scramble a composed word.
 */
function fakePortal(rejectKeysyms = false) {
  const calls: string[] = []
  let delay = 50
  const invoke = vi.fn((member: string, _signature: string | undefined, body?: unknown[]) => {
    const [, , code, state] = body as [string, unknown, number, number]
    calls.push(`${member === 'NotifyKeyboardKeysym' ? 'sym' : 'code'}:${code}:${state ? 'down' : 'up'}`)
    const wait = (delay = Math.max(0, delay - 5))
    return new Promise<unknown[]>((resolve, reject) =>
      setTimeout(
        () =>
          rejectKeysyms && member === 'NotifyKeyboardKeysym'
            ? reject(new Error('No such method'))
            : resolve([]),
        wait
      )
    )
  })
  const pointer = buildPointer({} as MessageBus, '/session', invoke, () => {})
  return { calls, pointer }
}

async function settle(): Promise<void> {
  await vi.runAllTimersAsync()
}

describe('the desktop keyboard', () => {
  it('finishes each keystroke before starting the next', async () => {
    vi.useFakeTimers()
    const { calls, pointer } = fakePortal()

    for (const char of 'aAab') pointer.typeChar(char)
    pointer.pressKey('Enter')
    await settle()

    const sym = (n: number | null): string[] => [`sym:${n}:down`, `sym:${n}:up`]
    expect(calls).toEqual([
      ...sym(keysymForChar('a')),
      ...sym(keysymForChar('A')),
      ...sym(keysymForChar('a')),
      ...sym(keysymForChar('b')),
      ...sym(keysymForKey('Enter'))
    ])
    vi.useRealTimers()
  })

  it('falls back to keycodes in order, with shift held around only its own key', async () => {
    vi.useFakeTimers()
    const { calls, pointer } = fakePortal(true)

    for (const char of 'aBc') pointer.typeChar(char)
    pointer.pressKey('Enter')
    await settle()

    const code = (n: number): string[] => [`code:${n}:down`, `code:${n}:up`]
    const a = keycodeForChar('a')!.keycode
    const b = keycodeForChar('B')!.keycode
    const c = keycodeForChar('c')!.keycode
    const enter = keycodeForKey('Enter').keycode
    // Exactly one keysym is tried; it settles the question for the rest.
    expect(calls.filter((call) => call.startsWith('sym:'))).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith('code:'))).toEqual([
      ...code(a),
      `code:${KEY_LEFTSHIFT}:down`,
      ...code(b),
      `code:${KEY_LEFTSHIFT}:up`,
      ...code(c),
      ...code(enter)
    ])
    vi.useRealTimers()
  })

  it('types nothing queued once the session is closed', async () => {
    vi.useFakeTimers()
    const { calls, pointer } = fakePortal()
    pointer.typeChar('a')
    pointer.typeChar('b')
    // close() talks to the bus; only the flag matters here.
    try {
      pointer.close()
    } catch {
      // The fake bus has no connection to end.
    }
    await settle()
    expect(calls).toEqual([])
    vi.useRealTimers()
  })
})
