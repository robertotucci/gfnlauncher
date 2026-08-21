import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PadProfile } from '@shared/padLayout'

/**
 * Following the controllers on this machine.
 *
 * The suite has no `/dev/input` and the machine running it has no pad, so both
 * halves are mocked — the same bargain `padProfile.test.ts` makes one module
 * over. What is worth pinning is the *coalescing*: one controller arriving
 * creates several nodes a few milliseconds apart, and the whole reason this
 * settles before it looks is that each of them must not become a card.
 */
const listeners: (() => void)[] = []
let closed = 0

vi.mock('node:fs', () => ({
  watch: (_dir: string, listener: () => void) => {
    listeners.push(listener)
    return {
      close: () => {
        closed += 1
      },
      unref: () => {}
    }
  }
}))

let present: PadProfile[] = []

vi.mock('./padProfile', () => ({
  listPadProfiles: () => present
}))

// Type-only, so it is erased and cannot defeat the mocks hoisted above; the
// values come through the dynamic import below.
import type { InputDevice } from './inputWatch'

const { armInputWatch, disarmInputWatch, inputChanges } = await import('./inputWatch')

function profile(node: string, name: string): PadProfile {
  return {
    node,
    name,
    vendor: '045e',
    product: '0b13',
    transport: 'bluetooth',
    resolved: 'kernel',
    buttons: [],
    axes: []
  }
}

function pad(node: string, name = 'Xbox Wireless Controller'): InputDevice {
  return { node, name }
}

describe('inputChanges', () => {
  it('reports a controller that was not there before', () => {
    const change = inputChanges([], [pad('js0')])

    expect(change.arrived).toEqual([pad('js0')])
    expect(change.left).toEqual([])
  })

  it('reports one that has gone, with the name it had while it was there', () => {
    // The point of carrying the remembered entry: by the time the node is
    // missing, `/sys` has nothing left to say about it, and a card reading
    // "Controller disconnected / unnamed" is worse than no card.
    const change = inputChanges([pad('js0', 'DualSense Wireless Controller')], [])

    expect(change.left).toEqual([pad('js0', 'DualSense Wireless Controller')])
    expect(change.arrived).toEqual([])
  })

  it('says nothing when the list has not moved', () => {
    // The common case by far: `/dev/input` sees traffic for every input device
    // on the machine, and a keyboard is not a controller arriving.
    const live = [pad('js0'), pad('js1', 'Nintendo Switch Pro Controller')]

    expect(inputChanges(live, live)).toEqual({ arrived: [], left: [] })
  })

  it('tells two identical pads apart by node, not by name', () => {
    // Two of the same controller report the same string, so a name-keyed diff
    // reads "one left and one arrived" as no change at all.
    const change = inputChanges([pad('js0'), pad('js1')], [pad('js0')])

    expect(change.left).toEqual([pad('js1')])
    expect(change.arrived).toEqual([])
  })

  it('sees a swap that reuses the same node', () => {
    // joydev hands a freed minor to the next device, so one pad out and a
    // different one in inside a single settle window leaves `js0` present the
    // whole time. Keyed on the node alone this reads as nothing having
    // happened, which is why the name is part of the identity.
    const change = inputChanges([pad('js0', 'A')], [pad('js0', 'B')])

    expect(change.left).toEqual([pad('js0', 'A')])
    expect(change.arrived).toEqual([pad('js0', 'B')])
  })

  it('reports both directions at once', () => {
    // One settle covers everything that happened during it, so a pad swapped
    // for another between two looks has to produce both cards.
    const change = inputChanges([pad('js0', 'A')], [pad('js1', 'B')])

    expect(change.arrived).toEqual([pad('js1', 'B')])
    expect(change.left).toEqual([pad('js0', 'A')])
  })
})

describe('armInputWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listeners.length = 0
    closed = 0
    present = []
  })

  afterEach(() => {
    disarmInputWatch()
    vi.useRealTimers()
  })

  /** What the kernel does when a device appears, as this module can see it. */
  function fire(): void {
    for (const listener of [...listeners]) listener()
  }

  it('announces nothing for a controller that was already on', () => {
    // The seeding rule. A pad switched on before the launcher has not arrived,
    // and a card for each of them at every boot teaches somebody to ignore the
    // corner of the screen.
    present = [profile('js0', 'Xbox Wireless Controller')]
    const seen = vi.fn()

    armInputWatch(seen)
    fire()
    vi.advanceTimersByTime(2_000)

    expect(seen).not.toHaveBeenCalled()
  })

  it('reports one that arrives afterwards', () => {
    const seen = vi.fn()
    armInputWatch(seen)

    present = [profile('js0', 'Xbox Wireless Controller')]
    fire()
    vi.advanceTimersByTime(2_000)

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0]?.[0]).toEqual({ arrived: [pad('js0')], left: [] })
  })

  it('collapses the several nodes one controller creates into one look', () => {
    // This is the whole reason for the settle: `js0`, an `event*` node and the
    // sysfs tree land a few milliseconds apart, and three cards for one pad is
    // the failure it exists to prevent.
    const seen = vi.fn()
    armInputWatch(seen)

    present = [profile('js0', 'Xbox Wireless Controller')]
    fire()
    vi.advanceTimersByTime(50)
    fire()
    vi.advanceTimersByTime(50)
    fire()
    vi.advanceTimersByTime(2_000)

    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('stays silent for the traffic every other input device makes', () => {
    // A keyboard being plugged in fires the same watch and changes no joystick.
    const seen = vi.fn()
    armInputWatch(seen)

    fire()
    vi.advanceTimersByTime(2_000)

    expect(seen).not.toHaveBeenCalled()
  })

  it('reports a departure, naming what it was', () => {
    present = [profile('js0', 'DualSense Wireless Controller')]
    const seen = vi.fn()
    armInputWatch(seen)

    present = []
    fire()
    vi.advanceTimersByTime(2_000)

    expect(seen.mock.calls[0]?.[0]).toEqual({
      arrived: [],
      left: [pad('js0', 'DualSense Wireless Controller')]
    })
  })

  it('arms once, however many times it is called', () => {
    armInputWatch(vi.fn())
    armInputWatch(vi.fn())

    expect(listeners).toHaveLength(1)
  })

  it('lets go of the watch on disarm', () => {
    armInputWatch(vi.fn())
    disarmInputWatch()

    expect(closed).toBe(1)
  })
})
