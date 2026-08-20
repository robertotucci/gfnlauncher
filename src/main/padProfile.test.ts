import { beforeEach, describe, expect, it, vi } from 'vitest'
import { XPAD_LAYOUT, joydevLayout } from '@shared/padLayout'
import { DUALSENSE, XPAD_USB, type PadFixture } from '@shared/padFixtures'

/**
 * Reading a pad's own description out of `/sys`.
 *
 * The suite has no `/sys` and the machine running it has no pad, so the tree is
 * mocked — the same bargain `details.test.ts` makes. What is worth pinning is
 * not the file reading but the **shape of the answer when a file is not there**:
 * every one of these attributes can be missing, on a sandbox with the device
 * permission revoked, on a node that went away between the readdir and the
 * read, and on a virtual device that never had ids. None of them may throw, and
 * a layout that could not be read has to be *labelled* rather than silently
 * replaced, because the label is what the log line and the Devices screen say.
 */

/** The fake tree, keyed by absolute path. Anything absent throws, as fs does. */
let tree = new Map<string, string>()
let dirs = new Map<string, string[]>()

vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    const value = tree.get(path)
    if (value === undefined) throw new Error(`ENOENT: ${path}`)
    return value
  },
  readdirSync: (path: string) => {
    const value = dirs.get(path)
    if (value === undefined) throw new Error(`ENOENT: ${path}`)
    return value
  }
}))

const { listPadProfiles, padProfileFor } = await import('./padProfile')

const ROOT = '/sys/class/input'

/** Writes one node into the fake tree, the way udev lays it out. */
function node(name: string, fixture: PadFixture, bustype = '0003'): void {
  const device = `${ROOT}/${name}/device`
  tree.set(`${device}/name`, `${fixture.name}\n`)
  tree.set(`${device}/id/vendor`, `${fixture.vendor}\n`)
  tree.set(`${device}/id/product`, `${fixture.product}\n`)
  tree.set(`${device}/id/bustype`, `${bustype}\n`)
  tree.set(`${device}/capabilities/key`, bitmap(fixture.keys))
  tree.set(`${device}/capabilities/abs`, bitmap(fixture.abs))
  dirs.set(ROOT, [...(dirs.get(ROOT) ?? []), name])
}

/** The set of codes, printed the way the kernel prints a capability bitmap. */
function bitmap(codes: readonly number[]): string {
  const words: bigint[] = []
  for (const code of codes) {
    const index = Math.floor(code / 64)
    while (words.length <= index) words.push(0n)
    words[index] = (words[index] ?? 0n) | (1n << BigInt(code % 64))
  }
  return words
    .map((word) => word.toString(16))
    .reverse()
    .join(' ')
}

beforeEach(() => {
  tree = new Map()
  dirs = new Map()
})

describe('padProfileFor', () => {
  it('reads the identity and the layout of one node', () => {
    node('js0', XPAD_USB)
    const profile = padProfileFor('js0')

    expect(profile).toEqual({
      node: 'js0',
      name: 'Microsoft X-Box 360 pad',
      vendor: '045e',
      product: '028e',
      transport: 'usb',
      resolved: 'kernel',
      buttons: joydevLayout(XPAD_USB.keys, XPAD_USB.abs).buttons,
      axes: joydevLayout(XPAD_USB.keys, XPAD_USB.abs).axes
    })
  })

  it('names the transport, which is the difference between two rows on a screen', () => {
    node('js0', DUALSENSE, '0005')
    expect(padProfileFor('js0').transport).toBe('bluetooth')
  })

  it('says so when the capabilities could not be read, rather than looking sure', () => {
    // A sandbox with the device permission revoked, or a node that went away.
    // `assumed` is the state worth a line in the log and a mark on the Devices
    // screen: it is the one where a button can be wrong.
    node('js0', XPAD_USB)
    tree.delete(`${ROOT}/js0/device/capabilities/key`)
    const profile = padProfileFor('js0')

    expect(profile.resolved).toBe('assumed')
    expect(profile.buttons).toEqual(XPAD_LAYOUT.buttons)
    expect(profile.name).toBe('Microsoft X-Box 360 pad')
  })

  it('survives a node with no attributes at all', () => {
    const profile = padProfileFor('js9')

    expect(profile.name).toBe('unnamed')
    expect(profile.vendor).toBe('')
    expect(profile.product).toBe('')
    expect(profile.transport).toBe('other')
    expect(profile.resolved).toBe('assumed')
  })

  it('lowercases the ids so they compare against a Gamepad id without a fold', () => {
    node('js0', XPAD_USB)
    tree.set(`${ROOT}/js0/device/id/vendor`, '045E\n')
    expect(padProfileFor('js0').vendor).toBe('045e')
  })
})

describe('listPadProfiles', () => {
  it('describes every joystick node and nothing else', () => {
    node('js0', XPAD_USB)
    node('js1', DUALSENSE, '0005')
    dirs.set(ROOT, [...(dirs.get(ROOT) ?? []), 'event4', 'mouse0', 'input12'])

    expect(listPadProfiles().map((profile) => profile.node)).toEqual(['js0', 'js1'])
  })

  it('is empty rather than an error when there is no /sys to read', () => {
    // The state at every boot before a pad is switched on, and the state inside
    // a sandbox that has had its permissions taken away. Both have to be
    // survivable rather than reportable.
    expect(listPadProfiles()).toEqual([])
  })
})
