import { describe, expect, it } from 'vitest'
import {
  NOTICE_EXIT_MS,
  NOTICE_MAX,
  NOTICE_MS,
  type Announcement,
  type DeviceKind,
  type Notice,
  noticeContent,
  stepNotices
} from './notify'

function notice(id: number, patch: Partial<Notice> = {}): Notice {
  return {
    id,
    group: 'pointer',
    title: `Notice ${id}`,
    hint: null,
    icon: 'pointer',
    leaving: false,
    dueAt: NOTICE_MS,
    ...patch
  }
}

function show(live: readonly Notice[], incoming: Notice, now = 0): Notice[] {
  return stepNotices(live, { kind: 'show', notice: incoming }, now).next
}

describe('stepNotices', () => {
  it('replaces within a group instead of stacking', () => {
    // Pointer on then pointer off inside three seconds is the everyday case,
    // and both cards want the same coordinates.
    const after = show([notice(1)], notice(2))

    expect(after.map((entry) => entry.id)).toEqual([2])
  })

  it('does not leave the replaced notice playing an exit under the new one', () => {
    // The bug the rule above exists for: `leaving` here would draw a card
    // sliding out from underneath one sliding in.
    const after = show([notice(1)], notice(2))

    expect(after.some((entry) => entry.leaving)).toBe(false)
  })

  it('keeps notices from different groups side by side', () => {
    const after = show([notice(1, { group: 'pointer' })], notice(2, { group: 'update' }))

    expect(after.map((entry) => entry.id)).toEqual([1, 2])
  })

  it('drops the oldest past the cap, never the one just caused', () => {
    const live = Array.from({ length: NOTICE_MAX }, (_unused, index) =>
      notice(index + 1, { group: `group-${index}` })
    )

    const after = show(live, notice(99, { group: 'newest' }))

    expect(after).toHaveLength(NOTICE_MAX)
    expect(after.at(-1)?.id).toBe(99)
    expect(after.map((entry) => entry.id)).not.toContain(1)
  })

  it('holds a notice until its time is up, then lets it leave', () => {
    const live = [notice(1, { dueAt: NOTICE_MS })]

    expect(stepNotices(live, { kind: 'tick' }, NOTICE_MS - 1).next[0]?.leaving).toBe(false)

    const leaving = stepNotices(live, { kind: 'tick' }, NOTICE_MS).next[0]
    expect(leaving?.leaving).toBe(true)
    // The exit animation has to have somewhere to play: main is what unmounts
    // the card, so it owes the stylesheet this window.
    expect(leaving?.dueAt).toBe(NOTICE_MS + NOTICE_EXIT_MS)
  })

  it('removes a leaving notice only once the exit has had its time', () => {
    const live = [notice(1, { leaving: true, dueAt: NOTICE_EXIT_MS })]

    expect(stepNotices(live, { kind: 'tick' }, NOTICE_EXIT_MS - 1).next).toHaveLength(1)
    expect(stepNotices(live, { kind: 'tick' }, NOTICE_EXIT_MS).next).toHaveLength(0)
  })

  it('reports the earliest deadline, so one timer serves the whole queue', () => {
    const live = [
      notice(1, { group: 'a', dueAt: 900 }),
      notice(2, { group: 'b', dueAt: 200 }),
      notice(3, { group: 'c', dueAt: 500 })
    ]

    expect(stepNotices(live, { kind: 'tick' }, 0).dueAt).toBe(200)
  })

  it('answers null on an empty queue, so main disarms rather than spins', () => {
    expect(stepNotices([], { kind: 'tick' }, 0).dueAt).toBeNull()
    expect(stepNotices([notice(1, { leaving: true, dueAt: 0 })], { kind: 'tick' }, 10).dueAt).toBeNull()
  })
})

describe('noticeContent — pointer mode', () => {
  const kinds: readonly Announcement[] = [{ kind: 'pointer-on' }, { kind: 'pointer-off' }]

  it.each(kinds)('gives $kind a title and a hint naming the chord', (what) => {
    const content = noticeContent(what)

    expect(content.title.length).toBeGreaterThan(0)
    // The chord is the one thing about pointer mode nobody discovers by
    // accident, and it is the same one both ways.
    expect(content.hint).toContain('L3 + R3')
  })

  it('puts both pointer kinds in one group so they replace each other', () => {
    expect(noticeContent({ kind: 'pointer-on' }).group).toBe(
      noticeContent({ kind: 'pointer-off' }).group
    )
  })

  it('draws a different icon for each, since there is no name on the card', () => {
    expect(noticeContent({ kind: 'pointer-on' }).icon).not.toBe(
      noticeContent({ kind: 'pointer-off' }).icon
    )
  })
})

describe('noticeContent — devices', () => {
  const connected = (name: string, device: DeviceKind): Announcement => ({
    kind: 'device-connected',
    name,
    device
  })

  it('names the kind in the title and the device in the hint', () => {
    const content = noticeContent(connected('WH-1000XM4', 'headphones'))

    expect(content.title).toBe('Headphones connected')
    expect(content.hint).toBe('WH-1000XM4')
  })

  it('calls a gamepad a controller, which is the word the rest of the UI uses', () => {
    expect(noticeContent(connected('Xbox Wireless Controller', 'gamepad')).title).toBe(
      'Controller connected'
    )
  })

  it('still says something useful about hardware BlueZ would not name', () => {
    // Most Low Energy devices carry no icon on first sight, and "Device
    // connected" beside the name is still the whole of what happened.
    const content = noticeContent(connected('Some Gadget', 'unknown'))

    expect(content.title).toBe('Device connected')
    expect(content.hint).toBe('Some Gadget')
  })

  it('gives every kind a noun and an icon', () => {
    // The table is a Record, so a widened union fails to compile rather than
    // rendering a card with no glyph — this pins that the values are real.
    const kinds: readonly DeviceKind[] = [
      'gamepad',
      'keyboard',
      'mouse',
      'headset',
      'headphones',
      'speaker',
      'display',
      'computer',
      'phone',
      'unknown'
    ]

    for (const kind of kinds) {
      const content = noticeContent(connected('Thing', kind))
      expect(content.title.endsWith(' connected')).toBe(true)
      expect(content.title.length).toBeGreaterThan(' connected'.length)
      expect(content.icon.length).toBeGreaterThan(0)
    }
  })

  it('groups a device by name, so its two watchers produce one card', () => {
    // A Bluetooth controller is seen twice — BlueZ says the link came up, and a
    // joystick node appears a moment later. One device arriving is one card.
    expect(noticeContent(connected('8BitDo Ultimate', 'gamepad')).group).toBe(
      noticeContent(connected('8bitdo ultimate', 'unknown')).group
    )
  })

  it('lets a disconnect replace that device rather than stack under it', () => {
    const on = noticeContent(connected('Pixel Buds', 'headphones'))
    const off = noticeContent({
      kind: 'device-disconnected',
      name: 'Pixel Buds',
      device: 'headphones'
    })

    expect(off.group).toBe(on.group)
    expect(off.title).toBe('Headphones disconnected')
  })

  it('keeps two different devices apart', () => {
    expect(noticeContent(connected('Pixel Buds', 'headphones')).group).not.toBe(
      noticeContent(connected('WH-1000XM4', 'headphones')).group
    )
  })

  it('never shares a group with a pointer notice', () => {
    // Both are live at once the moment somebody raises the cursor with a pad
    // they have just switched on, and one must not swallow the other.
    expect(noticeContent(connected('Anything', 'gamepad')).group).not.toBe(
      noticeContent({ kind: 'pointer-on' }).group
    )
  })
})
