import type {
  BluetoothDevice,
  BluetoothKind,
  BluetoothPairingRequest,
  BluetoothSnapshot
} from '@shared/types'
import { OWN_APP_ID } from '../host'

/**
 * Everything about BlueZ that can be decided without a bus.
 *
 * The launcher mirrors BlueZ's object tree in memory — `GetManagedObjects` once,
 * then the three signals that amend it — and renders the mirror. That split is
 * what makes this file the whole of the interesting logic and `bluez.ts` a
 * transport: the fold, the two derivations the UI needs, and the error
 * vocabulary are all pure, and the suite asserts them with no radio, no daemon
 * and no D-Bus socket.
 *
 * **The error vocabulary is locale-proof by construction**, which is worth
 * saying out loud in a codebase that has been bitten twice by the opposite.
 * `classifyHostFailure` cannot match on the portal's message because the portal
 * generates it in the host session's language, and `scanFlatpakProgress` reads
 * only the digits before a `%` for the same reason. D-Bus error *names* are
 * ASCII identifiers on the wire — `org.bluez.Error.AuthenticationFailed` reads
 * the same on an Italian host — so `describeBluezError` matches the name and
 * never the text beside it.
 */

export const ADAPTER_IFACE = 'org.bluez.Adapter1'
export const DEVICE_IFACE = 'org.bluez.Device1'
export const BATTERY_IFACE = 'org.bluez.Battery1'

/** Interface name → property name → value, for one D-Bus object. */
export type BluezInterfaces = Record<string, Record<string, unknown>>

/** Object path → interfaces. The launcher's mirror of BlueZ's tree. */
export type BluezTree = ReadonlyMap<string, BluezInterfaces>

// ── Reading what dbus-native hands over ─────────────────────────────────────

/**
 * Unwraps one variant.
 *
 * dbus-native is faithful to the wire and therefore unpleasant to read: a `v`
 * arrives as `[[signatureTree], [value]]`. Only the value is ever wanted.
 * `readPortalResults` in `pointer/portal.ts` does the same job one level up;
 * this is the general form, because BlueZ nests dictionaries two deep.
 */
export function readVariant(raw: unknown): unknown {
  if (!Array.isArray(raw) || raw.length < 2) return undefined
  const values = raw[1]
  return Array.isArray(values) ? values[0] : values
}

/** An `a{sv}` — a dictionary of variants. */
export function readDict(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [key, variant] = entry as [unknown, unknown]
    if (typeof key !== 'string') continue
    out[key] = readVariant(variant)
  }
  return out
}

/** An `a{sa{sv}}` — the interfaces of one object. */
export function readInterfaces(raw: unknown): BluezInterfaces {
  const out: BluezInterfaces = {}
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [name, properties] = entry as [unknown, unknown]
    if (typeof name !== 'string') continue
    out[name] = readDict(properties)
  }
  return out
}

/** An `a{oa{sa{sv}}}` — the reply to `GetManagedObjects`. */
export function readManagedObjects(raw: unknown): BluezTree {
  const tree = new Map<string, BluezInterfaces>()
  if (!Array.isArray(raw)) return tree
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [path, interfaces] = entry as [unknown, unknown]
    if (typeof path !== 'string') continue
    tree.set(path, readInterfaces(interfaces))
  }
  return tree
}

// ── Amending the mirror ─────────────────────────────────────────────────────

/**
 * `InterfacesAdded`, and also how a device first appears during a scan.
 *
 * Merged rather than replaced: BlueZ announces `org.bluez.Battery1` on an
 * object that already carries `org.bluez.Device1`, and taking the second
 * announcement as the whole object would drop the device it belongs to.
 */
export function withInterfaces(
  tree: BluezTree,
  path: string,
  interfaces: BluezInterfaces
): BluezTree {
  const next = new Map(tree)
  next.set(path, { ...(tree.get(path) ?? {}), ...interfaces })
  return next
}

/**
 * `InterfacesRemoved`.
 *
 * An object that has lost every interface is gone; one that has lost only
 * `org.bluez.Battery1` is a device whose battery stopped reporting. BlueZ uses
 * both, so this cannot simply delete the path.
 */
export function withoutInterfaces(
  tree: BluezTree,
  path: string,
  names: readonly string[]
): BluezTree {
  const existing = tree.get(path)
  if (!existing) return tree

  const remaining = { ...existing }
  for (const name of names) delete remaining[name]

  const next = new Map(tree)
  if (Object.keys(remaining).length === 0) next.delete(path)
  else next.set(path, remaining)
  return next
}

/**
 * `PropertiesChanged`, which during a scan is most of the traffic.
 *
 * `invalidated` matters as much as `changed` and is easy to skip: BlueZ
 * invalidates `RSSI` when it stops hearing a device rather than setting it to
 * some floor value, and a mirror that only applied `changed` would show a
 * four-tick signal for something that walked out of the room.
 *
 * A `PropertiesChanged` for an object we have never seen is dropped. It is not
 * an error — BlueZ emits them for GATT objects the launcher never asked about.
 */
export function withProperties(
  tree: BluezTree,
  path: string,
  iface: string,
  changed: Record<string, unknown>,
  invalidated: readonly string[] = []
): BluezTree {
  const existing = tree.get(path)
  if (!existing) return tree

  const properties = { ...(existing[iface] ?? {}), ...changed }
  for (const name of invalidated) delete properties[name]

  const next = new Map(tree)
  next.set(path, { ...existing, [iface]: properties })
  return next
}

// ── Reading the mirror ──────────────────────────────────────────────────────

function str(properties: Record<string, unknown> | undefined, key: string): string | null {
  const value = properties?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function bool(properties: Record<string, unknown> | undefined, key: string): boolean {
  return properties?.[key] === true
}

function num(properties: Record<string, unknown> | undefined, key: string): number | null {
  const value = properties?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export interface BluezAdapter {
  path: string
  properties: Record<string, unknown>
}

/**
 * The adapter to drive, or null when the machine has none.
 *
 * Paths are sorted so a two-adapter machine picks `hci0` rather than whichever
 * one BlueZ happened to list first. Choosing rather than offering is
 * deliberate: a launcher that asked which radio to use before it could pair a
 * gamepad would be asking a question nobody on a sofa has an opinion about.
 */
export function findAdapter(tree: BluezTree): BluezAdapter | null {
  const paths = [...tree.keys()].filter((path) => tree.get(path)?.[ADAPTER_IFACE]).sort()
  const path = paths[0]
  if (path === undefined) return null
  return { path, properties: tree.get(path)?.[ADAPTER_IFACE] ?? {} }
}

/**
 * BlueZ's freedesktop icon names, onto the closed union the renderer draws.
 *
 * These are what `Device1.Icon` actually contains; BlueZ derives them from the
 * class of device and, for Low Energy, from the appearance. Anything not listed
 * is `unknown` on purpose — a wrong glyph is worse than a neutral one, and the
 * room this launcher lives in contains pads, headsets, keyboards and phones.
 */
const ICON_KINDS: Record<string, BluetoothKind> = {
  'input-gaming': 'gamepad',
  'input-keyboard': 'keyboard',
  'input-mouse': 'mouse',
  'input-tablet': 'mouse',
  'audio-headset': 'headset',
  'audio-headphones': 'headphones',
  'audio-card': 'speaker',
  'multimedia-player': 'speaker',
  'video-display': 'display',
  computer: 'computer',
  phone: 'phone',
  modem: 'phone'
}

/** Class-of-device major classes, from the Bluetooth assigned numbers. */
const MAJOR_COMPUTER = 0x01
const MAJOR_PHONE = 0x02
const MAJOR_AUDIO = 0x04
const MAJOR_PERIPHERAL = 0x05

/**
 * What kind of thing this is, from whatever BlueZ was willing to say.
 *
 * `Icon` first, because BlueZ has already done this work and knows about
 * appearance values we do not. `Class` second, for the devices that carry no
 * icon — which in practice is most Low Energy hardware on its first sighting,
 * i.e. exactly the rows in the nearby list somebody is trying to identify.
 */
export function deviceKind(icon: unknown, deviceClass: unknown): BluetoothKind {
  if (typeof icon === 'string') {
    const known = ICON_KINDS[icon]
    if (known) return known
  }

  if (typeof deviceClass !== 'number' || !Number.isFinite(deviceClass)) return 'unknown'

  switch ((deviceClass >> 8) & 0x1f) {
    case MAJOR_COMPUTER:
      return 'computer'
    case MAJOR_PHONE:
      return 'phone'
    case MAJOR_AUDIO:
      switch ((deviceClass >> 2) & 0x3f) {
        case 0x01:
        case 0x02:
          return 'headset'
        case 0x06:
        case 0x07:
          return 'headphones'
        case 0x05:
        case 0x08:
          return 'speaker'
        default:
          return 'unknown'
      }
    case MAJOR_PERIPHERAL: {
      // Bits 6–7 are the keyboard/pointing pair, and they outrank the minor
      // class below: a keyboard-and-pointer combo is a keyboard to a person.
      const pointing = (deviceClass >> 6) & 0x03
      if (pointing === 0x01 || pointing === 0x03) return 'keyboard'
      if (pointing === 0x02) return 'mouse'
      // 0x01 joystick, 0x02 gamepad. Both are a pad in this room.
      const minor = (deviceClass >> 2) & 0x0f
      return minor === 0x01 || minor === 0x02 ? 'gamepad' : 'unknown'
    }
    default:
      return 'unknown'
  }
}

function readDevice(
  interfaces: BluezInterfaces,
  busy: ReadonlySet<string>
): BluetoothDevice | null {
  const device = interfaces[DEVICE_IFACE]
  const address = str(device, 'Address')
  if (!address) return null

  return {
    address,
    // `Alias` before `Name`: it is what BlueZ shows everywhere else, and it is
    // the one the user may have renamed. A device that has broadcast no name at
    // all still needs a row somebody can press.
    name: str(device, 'Alias') ?? str(device, 'Name') ?? 'Unnamed device',
    kind: deviceKind(device?.['Icon'], device?.['Class']),
    paired: bool(device, 'Paired'),
    connected: bool(device, 'Connected'),
    rssi: num(device, 'RSSI'),
    battery: num(interfaces[BATTERY_IFACE], 'Percentage'),
    busy: busy.has(address)
  }
}

/** One device whose link is up, as much of it as a sentence needs. */
export interface ConnectedDevice {
  readonly address: string
  readonly name: string
  readonly kind: BluetoothKind
}

/**
 * Everything BlueZ currently considers connected, keyed by address.
 *
 * A separate, much cheaper read than `buildSnapshot`: this runs after **every**
 * signal, and during a scan those arrive several a second as RSSI moves. It
 * allocates one entry per connected device — usually none or one — and does no
 * sorting, no partitioning and no battery lookup.
 */
export function connectedDevices(tree: BluezTree): Map<string, ConnectedDevice> {
  const connected = new Map<string, ConnectedDevice>()

  for (const interfaces of tree.values()) {
    const device = interfaces[DEVICE_IFACE]
    if (!device || !bool(device, 'Connected')) continue

    const address = str(device, 'Address')
    if (!address) continue

    connected.set(address, {
      address,
      // The same order `readDevice` uses, and for the same reason: `Alias` is
      // what the user renamed it to and what BlueZ shows everywhere else.
      name: str(device, 'Alias') ?? str(device, 'Name') ?? 'Unnamed device',
      kind: deviceKind(device['Icon'], device['Class'])
    })
  }

  return connected
}

/**
 * Which links came up and which went down between two readings.
 *
 * Pure and exported so the transitions are assertable without a radio. Keyed on
 * the address, which is the one thing about a Bluetooth device that does not
 * change — a rename mid-session is the same device, not a departure and an
 * arrival, and `left` therefore carries the name it had when it was last seen
 * because by then BlueZ may have dropped the object entirely.
 */
export function connectionChanges(
  before: ReadonlyMap<string, ConnectedDevice>,
  after: ReadonlyMap<string, ConnectedDevice>
): { connected: ConnectedDevice[]; disconnected: ConnectedDevice[] } {
  const connected: ConnectedDevice[] = []
  const disconnected: ConnectedDevice[] = []

  for (const [address, device] of after) if (!before.has(address)) connected.push(device)
  for (const [address, device] of before) if (!after.has(address)) disconnected.push(device)

  return { connected, disconnected }
}

/** Lowercased rather than `localeCompare`d, so the order is the same everywhere. */
function byName(a: BluetoothDevice, b: BluetoothDevice): number {
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  return left < right ? -1 : left > right ? 1 : 0
}

export interface BluetoothState {
  /** The launcher's own discovery request — never `Adapter1.Discovering`. */
  scanning: boolean
  request: BluetoothPairingRequest | null
  /** Addresses with an action in flight. */
  busy: ReadonlySet<string>
  /** Why the feature is unusable at all, if it is. */
  error: string | null
}

/**
 * The mirror, as the screen needs it.
 *
 * Two lists rather than one flag per row, because they answer different
 * questions and are read in different orders: what is already mine, and what is
 * in the room. The second is sorted by signal, which is the whole idea of the
 * screen — the device in the user's hand is the loudest one, so it is at the
 * top without anybody having to be told that is why.
 *
 * Unpaired devices are listed for as long as BlueZ keeps them, not for as long
 * as they are being heard. BlueZ evicts a temporary device a little after
 * discovery stops and says so with `InterfacesRemoved`, so the list cleans
 * itself; culling on a missing `RSSI` instead would empty the list the instant
 * the scan stopped, which is the moment the user is reaching for a row.
 */
export function buildSnapshot(tree: BluezTree, state: BluetoothState): BluetoothSnapshot {
  const adapter = findAdapter(tree)

  if (!adapter) {
    return {
      available: false,
      powered: false,
      scanning: false,
      adapterName: null,
      paired: [],
      nearby: [],
      request: null,
      error: state.error ?? 'This machine has no Bluetooth adapter.'
    }
  }

  const paired: BluetoothDevice[] = []
  const nearby: BluetoothDevice[] = []

  for (const [path, interfaces] of tree) {
    // Devices hang off their own adapter's path. Filtering on it keeps a second
    // radio's devices out of a list headed by the first radio's name.
    if (!path.startsWith(`${adapter.path}/`)) continue
    const device = readDevice(interfaces, state.busy)
    if (!device) continue
    ;(device.paired ? paired : nearby).push(device)
  }

  paired.sort((a, b) => Number(b.connected) - Number(a.connected) || byName(a, b))
  nearby.sort((a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity) || byName(a, b))

  return {
    available: true,
    powered: bool(adapter.properties, 'Powered'),
    scanning: state.scanning,
    adapterName: str(adapter.properties, 'Alias') ?? str(adapter.properties, 'Name'),
    paired,
    nearby,
    request: state.request,
    error: state.error
  }
}

// ── Failures ────────────────────────────────────────────────────────────────

/**
 * A D-Bus error name, as a sentence somebody on a sofa can act on.
 *
 * Matched on the **name**, never on the message beside it — see the note at the
 * top of this file. `fallback` is what BlueZ said, used for the two cases where
 * its own wording is more specific than anything that could be written here.
 */
export function describeBluezError(name: string | undefined, fallback: string): string {
  switch (name) {
    // The two that are not BlueZ's, and the two most likely to be met.
    case 'org.freedesktop.DBus.Error.ServiceUnknown':
      return (
        'BlueZ is not running on this machine, so nothing can reach the Bluetooth hardware. ' +
        'Start it with: systemctl start bluetooth'
      )
    case 'org.freedesktop.DBus.Error.AccessDenied':
      return (
        'This launcher is not allowed to talk to BlueZ. ' +
        'Grant it the org.bluez system permission in Flatseal, or run: ' +
        `flatpak override --user --system-talk-name=org.bluez ${OWN_APP_ID}`
      )

    case 'org.bluez.Error.AlreadyExists':
      return 'That device is already paired.'
    case 'org.bluez.Error.AuthenticationCanceled':
    case 'org.bluez.Error.Canceled':
      return 'The pairing was cancelled.'
    case 'org.bluez.Error.AuthenticationFailed':
      return 'The device did not accept the pairing. Put it back into pairing mode and try again.'
    case 'org.bluez.Error.AuthenticationRejected':
    case 'org.bluez.Error.Rejected':
      return 'The device refused to pair.'
    case 'org.bluez.Error.AuthenticationTimeout':
      return 'The device stopped answering. Put it back into pairing mode and try again.'
    case 'org.bluez.Error.ConnectionAttemptFailed':
      return 'The device did not answer. Check it is switched on and in range.'
    case 'org.bluez.Error.DoesNotExist':
      return 'BlueZ no longer knows about that device. Scan again.'
    case 'org.bluez.Error.InProgress':
      return 'The adapter is busy with something else. Wait a moment and try again.'
    case 'org.bluez.Error.NotAvailable':
      return 'The device is not available.'
    case 'org.bluez.Error.NotConnected':
      return 'That device is not connected.'
    case 'org.bluez.Error.NotPermitted':
      return 'BlueZ refused that.'
    case 'org.bluez.Error.NotReady':
      return 'The Bluetooth adapter is not ready. Switching Bluetooth off and on again may fix it.'
    case 'org.bluez.Error.NotSupported':
      return 'The adapter does not support that.'
    case 'org.bluez.Error.InvalidArguments':
      return 'BlueZ refused the request.'

    // `Failed` is BlueZ's catch-all and its own text is genuinely the more
    // useful half — "Software caused connection abort", "Protocol not
    // available" — so it is passed through rather than flattened.
    default:
      return fallback
  }
}
