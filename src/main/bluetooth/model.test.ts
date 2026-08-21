import { describe, expect, it } from 'vitest'
import {
  ADAPTER_IFACE,
  BATTERY_IFACE,
  DEVICE_IFACE,
  buildSnapshot,
  connectedDevices,
  connectionChanges,
  describeBluezError,
  deviceKind,
  findAdapter,
  readDict,
  readInterfaces,
  readManagedObjects,
  withInterfaces,
  withoutInterfaces,
  withProperties,
  type BluetoothState,
  type BluezTree,
  type ConnectedDevice
} from './model'

/**
 * The wire shapes here are dbus-native's, not BlueZ's: a variant arrives as
 * `[[signatureTree], [value]]`, and everything else is an array of key/value
 * pairs. Building them with these three helpers rather than by hand is what
 * keeps the fixtures below readable — and it is also the only way to be sure
 * the parser is being tested against the shape it will actually meet.
 */
const variant = (signature: string, value: unknown): unknown => [[signature], [value]]
const dict = (entries: Record<string, unknown>): unknown =>
  Object.entries(entries).map(([key, value]) => [key, value])
const object = (interfaces: Record<string, Record<string, unknown>>): unknown =>
  Object.entries(interfaces).map(([name, properties]) => [name, dict(properties)])

const ADAPTER = '/org/bluez/hci0'

const adapterProperties = {
  Address: variant('s', '20:C1:9B:D3:0A:58'),
  Alias: variant('s', 'cachyos-x8664'),
  Powered: variant('b', true),
  Discovering: variant('b', true)
}

/** A DualSense: paired, connected, and one of the few pads that reports a battery. */
const PAD = `${ADAPTER}/dev_A0_AB_51_11_22_33`
const padProperties = {
  Address: variant('s', 'A0:AB:51:11:22:33'),
  Alias: variant('s', 'DualSense Wireless Controller'),
  Name: variant('s', 'Wireless Controller'),
  Icon: variant('s', 'input-gaming'),
  Class: variant('u', 0x002508),
  Paired: variant('b', true),
  Connected: variant('b', true)
}

/** A headset, paired but switched off: no RSSI, no battery. */
const HEADSET = `${ADAPTER}/dev_38_18_4C_44_55_66`
const headsetProperties = {
  Address: variant('s', '38:18:4C:44:55:66'),
  Alias: variant('s', 'WH-1000XM4'),
  Icon: variant('s', 'audio-headphones'),
  Paired: variant('b', true),
  Connected: variant('b', false)
}

const managedObjects = (
  entries: Record<string, Record<string, Record<string, unknown>>>
): unknown => Object.entries(entries).map(([path, interfaces]) => [path, object(interfaces)])

const FULL_TREE = managedObjects({
  '/org/bluez': { 'org.bluez.AgentManager1': {} },
  [ADAPTER]: { [ADAPTER_IFACE]: adapterProperties },
  [PAD]: { [DEVICE_IFACE]: padProperties, [BATTERY_IFACE]: { Percentage: variant('y', 82) } },
  [HEADSET]: { [DEVICE_IFACE]: headsetProperties }
})

const IDLE: BluetoothState = {
  scanning: false,
  request: null,
  busy: new Set<string>(),
  error: null
}

function tree(): BluezTree {
  return readManagedObjects(FULL_TREE)
}

describe('readManagedObjects', () => {
  it('unwraps three levels of dbus-native nesting into plain values', () => {
    const parsed = tree()
    expect(parsed.get(ADAPTER)?.[ADAPTER_IFACE]?.['Powered']).toBe(true)
    expect(parsed.get(PAD)?.[DEVICE_IFACE]?.['Alias']).toBe('DualSense Wireless Controller')
    expect(parsed.get(PAD)?.[BATTERY_IFACE]?.['Percentage']).toBe(82)
  })

  it('answers an empty tree rather than throwing on anything unexpected', () => {
    for (const raw of [null, undefined, 'nonsense', 42, [['/only-a-path']]]) {
      expect(() => readManagedObjects(raw)).not.toThrow()
    }
    expect(readManagedObjects(null).size).toBe(0)
  })

  it('drops a variant it cannot read instead of storing the wrapper', () => {
    expect(readDict([['Broken', 'not-a-variant']])['Broken']).toBeUndefined()
    expect(readInterfaces('nonsense')).toEqual({})
  })
})

describe('findAdapter', () => {
  it('picks hci0 rather than whichever path the daemon happened to list first', () => {
    const two = readManagedObjects(
      managedObjects({
        '/org/bluez/hci1': { [ADAPTER_IFACE]: { Alias: variant('s', 'second') } },
        [ADAPTER]: { [ADAPTER_IFACE]: adapterProperties }
      })
    )
    expect(findAdapter(two)?.path).toBe(ADAPTER)
  })

  it('is null on a machine with no radio', () => {
    expect(findAdapter(new Map())).toBeNull()
  })
})

describe('buildSnapshot', () => {
  it('splits the tree into what is mine and what is in the room', () => {
    const snapshot = buildSnapshot(tree(), IDLE)
    expect(snapshot.available).toBe(true)
    expect(snapshot.powered).toBe(true)
    expect(snapshot.adapterName).toBe('cachyos-x8664')
    expect(snapshot.paired.map((device) => device.name)).toEqual([
      'DualSense Wireless Controller',
      'WH-1000XM4'
    ])
    expect(snapshot.nearby).toEqual([])
  })

  it('reports the launcher’s own scan, never the adapter’s global flag', () => {
    // `Discovering` is true in the fixture because the desktop's own panel is
    // scanning. Reading it here would have the screen claim to be searching.
    expect(buildSnapshot(tree(), IDLE).scanning).toBe(false)
    expect(buildSnapshot(tree(), { ...IDLE, scanning: true }).scanning).toBe(true)
  })

  it('names a device by alias, then name, then a placeholder', () => {
    const unnamed = withInterfaces(tree(), `${ADAPTER}/dev_11_11_11_11_11_11`, {
      [DEVICE_IFACE]: { Address: '11:11:11:11:11:11' }
    })
    expect(buildSnapshot(unnamed, IDLE).nearby[0]?.name).toBe('Unnamed device')
  })

  it('carries exactly the fields the renderer needs and no BlueZ property bag', () => {
    // The same guarantee `zone.test.ts` makes about `parseZoneAssignment`:
    // widening this to "whatever was in there" would push a device's UUID list,
    // its manufacturer data and its service records across the bridge.
    const device = buildSnapshot(tree(), IDLE).paired[0]
    expect(Object.keys(device ?? {}).sort()).toEqual([
      'address',
      'battery',
      'busy',
      'connected',
      'kind',
      'name',
      'paired',
      'rssi'
    ])
  })

  it('orders what is nearby by signal, so the pad in your hand is on top', () => {
    let parsed = withInterfaces(tree(), `${ADAPTER}/dev_AA_00_00_00_00_01`, {
      [DEVICE_IFACE]: { Address: 'AA:00:00:00:00:01', Alias: 'Far', RSSI: -88 }
    })
    parsed = withInterfaces(parsed, `${ADAPTER}/dev_AA_00_00_00_00_02`, {
      [DEVICE_IFACE]: { Address: 'AA:00:00:00:00:02', Alias: 'Near', RSSI: -41 }
    })
    parsed = withInterfaces(parsed, `${ADAPTER}/dev_AA_00_00_00_00_03`, {
      [DEVICE_IFACE]: { Address: 'AA:00:00:00:00:03', Alias: 'Unheard' }
    })

    expect(buildSnapshot(parsed, IDLE).nearby.map((device) => device.name)).toEqual([
      'Near',
      'Far',
      'Unheard'
    ])
  })

  it('puts connected devices first among the paired ones', () => {
    const parsed = withProperties(tree(), PAD, DEVICE_IFACE, { Connected: false })
    // With nothing connected the order is by name, which puts the pad first
    // anyway — so flip the headset instead to prove the rule is doing the work.
    const headsetOn = withProperties(parsed, HEADSET, DEVICE_IFACE, { Connected: true })
    expect(buildSnapshot(headsetOn, IDLE).paired.map((device) => device.name)).toEqual([
      'WH-1000XM4',
      'DualSense Wireless Controller'
    ])
  })

  it('keeps a second adapter’s devices out of the first adapter’s lists', () => {
    const parsed = withInterfaces(tree(), '/org/bluez/hci1/dev_BB_00_00_00_00_01', {
      [DEVICE_IFACE]: { Address: 'BB:00:00:00:00:01', Alias: 'Somebody else’s' }
    })
    const snapshot = buildSnapshot(parsed, IDLE)
    expect(snapshot.nearby).toEqual([])
    expect(snapshot.paired).toHaveLength(2)
  })

  it('marks the device an action is running against', () => {
    const snapshot = buildSnapshot(tree(), { ...IDLE, busy: new Set(['A0:AB:51:11:22:33']) })
    expect(snapshot.paired[0]?.busy).toBe(true)
    expect(snapshot.paired[1]?.busy).toBe(false)
  })

  it('says there is no adapter rather than rendering an empty screen', () => {
    const snapshot = buildSnapshot(new Map(), IDLE)
    expect(snapshot.available).toBe(false)
    expect(snapshot.error).toContain('no Bluetooth adapter')
  })

  it('prefers a real failure over the "no adapter" default', () => {
    const snapshot = buildSnapshot(new Map(), { ...IDLE, error: 'BlueZ is not running' })
    expect(snapshot.error).toBe('BlueZ is not running')
  })
})

describe('the three signals', () => {
  it('merges an added interface instead of replacing the object', () => {
    // BlueZ announces Battery1 on a path that already carries Device1. Taking
    // the announcement as the whole object would drop the device.
    const parsed = withInterfaces(tree(), HEADSET, { [BATTERY_IFACE]: { Percentage: 40 } })
    const headset = buildSnapshot(parsed, IDLE).paired.find((d) => d.name === 'WH-1000XM4')
    expect(headset?.battery).toBe(40)
    expect(headset?.paired).toBe(true)
  })

  it('removes one interface without removing the device it belongs to', () => {
    const parsed = withoutInterfaces(tree(), PAD, [BATTERY_IFACE])
    const pad = buildSnapshot(parsed, IDLE).paired[0]
    expect(pad?.name).toBe('DualSense Wireless Controller')
    expect(pad?.battery).toBeNull()
  })

  it('removes the device when its last interface goes', () => {
    const parsed = withoutInterfaces(tree(), HEADSET, [DEVICE_IFACE])
    expect(buildSnapshot(parsed, IDLE).paired).toHaveLength(1)
  })

  it('applies invalidated properties, not only changed ones', () => {
    // BlueZ invalidates RSSI when it stops hearing a device rather than
    // setting it to a floor. Applying only `changed` leaves a four-tick signal
    // on something that has left the room.
    let parsed = withInterfaces(tree(), `${ADAPTER}/dev_CC_00_00_00_00_01`, {
      [DEVICE_IFACE]: { Address: 'CC:00:00:00:00:01', Alias: 'Walker', RSSI: -44 }
    })
    expect(buildSnapshot(parsed, IDLE).nearby[0]?.rssi).toBe(-44)

    parsed = withProperties(parsed, `${ADAPTER}/dev_CC_00_00_00_00_01`, DEVICE_IFACE, {}, ['RSSI'])
    expect(buildSnapshot(parsed, IDLE).nearby[0]?.rssi).toBeNull()
  })

  it('ignores a change for an object it has never seen', () => {
    const parsed = tree()
    expect(withProperties(parsed, '/org/bluez/hci0/service0012', DEVICE_IFACE, { X: 1 })).toBe(
      parsed
    )
  })
})

describe('deviceKind', () => {
  it('trusts the icon BlueZ published', () => {
    expect(deviceKind('input-gaming', undefined)).toBe('gamepad')
    expect(deviceKind('audio-headset', undefined)).toBe('headset')
    expect(deviceKind('audio-headphones', undefined)).toBe('headphones')
    expect(deviceKind('input-keyboard', undefined)).toBe('keyboard')
    expect(deviceKind('phone', undefined)).toBe('phone')
  })

  it('falls back to the class of device, which is all a new LE sighting has', () => {
    // Peripheral major, gamepad minor — the class a pad advertises before
    // BlueZ has worked out an icon for it.
    expect(deviceKind(undefined, 0x002508)).toBe('gamepad')
    // Peripheral major with the keyboard bit set.
    expect(deviceKind(undefined, 0x000540)).toBe('keyboard')
    // Peripheral major with the pointing bit set.
    expect(deviceKind(undefined, 0x000580)).toBe('mouse')
    // Audio/Video major, headset minor / loudspeaker minor.
    expect(deviceKind(undefined, 0x000404)).toBe('headset')
    expect(deviceKind(undefined, 0x000414)).toBe('speaker')
    expect(deviceKind(undefined, 0x000418)).toBe('headphones')
    expect(deviceKind(undefined, 0x000104)).toBe('computer')
    expect(deviceKind(undefined, 0x00020c)).toBe('phone')
  })

  it('prefers a keyboard glyph for a keyboard-and-pointer combo', () => {
    expect(deviceKind(undefined, 0x0005c0)).toBe('keyboard')
  })

  it('answers unknown rather than guessing', () => {
    expect(deviceKind(undefined, undefined)).toBe('unknown')
    expect(deviceKind('printer', undefined)).toBe('unknown')
    expect(deviceKind(null, 'not a number')).toBe('unknown')
    // Imaging major: real, and not something this launcher has a glyph for.
    expect(deviceKind(undefined, 0x000600)).toBe('unknown')
  })
})

describe('describeBluezError', () => {
  it('names the permission a sandbox is missing, and the command that grants it', () => {
    const message = describeBluezError('org.freedesktop.DBus.Error.AccessDenied', 'denied')
    expect(message).toContain('--system-talk-name=org.bluez')
    expect(message).toContain('io.github.robertotucci.GfnLauncher')
  })

  it('tells a stopped daemon apart from a missing adapter', () => {
    const message = describeBluezError('org.freedesktop.DBus.Error.ServiceUnknown', 'no service')
    expect(message).toContain('systemctl start bluetooth')
    expect(message).not.toContain('adapter')
  })

  it('turns the pairing failures into something a person can act on', () => {
    expect(describeBluezError('org.bluez.Error.AuthenticationTimeout', 'x')).toContain(
      'pairing mode'
    )
    expect(describeBluezError('org.bluez.Error.AuthenticationFailed', 'x')).toContain(
      'pairing mode'
    )
    expect(describeBluezError('org.bluez.Error.AlreadyExists', 'x')).toContain('already paired')
    expect(describeBluezError('org.bluez.Error.Rejected', 'x')).toContain('refused')
  })

  it("passes BlueZ's own wording through for its catch-all", () => {
    // `Failed` carries the specific half — "Software caused connection abort",
    // "Protocol not available" — and flattening it would lose the only useful
    // thing in the reply.
    expect(describeBluezError('org.bluez.Error.Failed', 'Software caused connection abort')).toBe(
      'Software caused connection abort'
    )
    expect(describeBluezError(undefined, 'BlueZ did not answer Pair in time')).toBe(
      'BlueZ did not answer Pair in time'
    )
  })
})

describe('connectedDevices', () => {
  it('lists only the links that are up, keyed by address', () => {
    const connected = connectedDevices(tree())

    expect([...connected.keys()]).toEqual(['A0:AB:51:11:22:33'])
    expect(connected.get('A0:AB:51:11:22:33')).toEqual({
      address: 'A0:AB:51:11:22:33',
      name: 'DualSense Wireless Controller',
      kind: 'gamepad'
    })
  })

  it('prefers the alias, which is the name the user gave it', () => {
    // The pad's `Name` is the generic "Wireless Controller"; the alias is what
    // BlueZ shows everywhere else and what a card has to agree with.
    expect(connectedDevices(tree()).get('A0:AB:51:11:22:33')?.name).not.toBe('Wireless Controller')
  })

  it('skips an object with no address rather than inventing a key', () => {
    const partial = readManagedObjects(
      managedObjects({
        '/org/bluez/hci0/dev_x': { [DEVICE_IFACE]: { Connected: variant('b', true) } }
      })
    )

    expect(connectedDevices(partial).size).toBe(0)
  })
})

describe('connectionChanges', () => {
  const device = (address: string, name = 'WH-1000XM4'): ConnectedDevice => ({
    address,
    name,
    kind: 'headphones'
  })

  const set = (...devices: ConnectedDevice[]): Map<string, ConnectedDevice> =>
    new Map(devices.map((entry) => [entry.address, entry]))

  it('reports a link that has come up', () => {
    const change = connectionChanges(set(), set(device('38:18:4C:44:55:66')))

    expect(change.connected).toEqual([device('38:18:4C:44:55:66')])
    expect(change.disconnected).toEqual([])
  })

  it('reports one that has gone, with the name it had while it was there', () => {
    // BlueZ may drop the object entirely on disconnect, so the remembered entry
    // is the only thing left that can name it.
    const change = connectionChanges(set(device('38:18:4C:44:55:66')), set())

    expect(change.disconnected).toEqual([device('38:18:4C:44:55:66')])
    expect(change.connected).toEqual([])
  })

  it('says nothing when only an unrelated property moved', () => {
    // This runs after *every* signal, and during a scan those arrive several a
    // second as RSSI moves. Almost all of them have to be silent.
    const live = set(device('38:18:4C:44:55:66'))

    expect(connectionChanges(live, live)).toEqual({ connected: [], disconnected: [] })
  })

  it('treats a rename as the same device rather than a swap', () => {
    // The address is the one thing about a Bluetooth device that does not
    // change; keying on the name would announce a departure and an arrival for
    // somebody renaming their headset in the desktop's own settings.
    const change = connectionChanges(
      set(device('38:18:4C:44:55:66', 'WH-1000XM4')),
      set(device('38:18:4C:44:55:66', 'Sony headphones'))
    )

    expect(change).toEqual({ connected: [], disconnected: [] })
  })
})
