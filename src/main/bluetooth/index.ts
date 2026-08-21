import type { BluetoothPairingRequest, BluetoothResult, BluetoothSnapshot } from '@shared/types'
import type { BluetoothAction } from '@shared/bluetooth'
import { createPairingAgent, type PairingAgent } from './agent'
import { errorName, errorText, openBluez, PAIR_TIMEOUT_MS, type BluezBus } from './bluez'
import { notify } from '../notify'
import {
  ADAPTER_IFACE,
  DEVICE_IFACE,
  buildSnapshot,
  connectedDevices,
  connectionChanges,
  describeBluezError,
  findAdapter,
  readDict,
  readInterfaces,
  readManagedObjects,
  withInterfaces,
  withoutInterfaces,
  withProperties,
  type BluezTree,
  type ConnectedDevice
} from './model'

/**
 * Pairing and connecting the hardware in the room.
 *
 * The only module `ipc.ts` imports, and the only one holding state. What it
 * holds is a **mirror** of BlueZ's object tree: read once with
 * `GetManagedObjects`, then amended by the three signals BlueZ emits. Every
 * question the renderer asks is answered from the mirror, which is what lets
 * the Devices screen poll once a second without putting anything on the bus —
 * the same arrangement `status/index.ts` has with its cached board.
 *
 * ── What is armed when, and why that changed ────────────────────────────────
 *
 * It used to be nothing: the connection opened on the first request from the
 * Devices screen and `disarmBluetooth()` closed it. That stopped being possible
 * when something outside the screen came to need the answer — the launcher now
 * says out loud when a headset connects or a controller drops, and a watch that
 * only runs while somebody is looking at the Devices screen is a watch for the
 * one moment nobody needs it. `armBluetoothWatch()` opens the connection once
 * at startup for exactly that.
 *
 * Three things keep the change small. The **agent is still registered only
 * around a pairing** and unregistered in a `finally`, so the launcher does not
 * become the desktop's default answer to incoming pairings — that argument is
 * in `agent.ts` and is untouched. A machine with no bluetoothd fails **once**,
 * logs it and is left alone, because the retry is still driven by requests.
 * And nothing about the mirror, the snapshot or any of the actions moved: the
 * screen still reads the same tree, it is simply already warm when it opens.
 */

/** How long a scan runs before stopping itself. */
const SCAN_TIMEOUT_MS = 60_000

/**
 * How long to wait before trying the bus again after a failure.
 *
 * The screen polls, so without this a machine with no bluetoothd would open a
 * system-bus connection every second for as long as somebody left the screen
 * up. The failure does not change in that time and neither does the answer.
 */
const RETRY_COOLDOWN_MS = 5_000

const EMPTY_TREE: BluezTree = new Map()

let bus: BluezBus | null = null
let agent: PairingAgent | null = null
let opening: Promise<BluezBus> | null = null
let failedAt = 0

let tree: BluezTree = EMPTY_TREE
/** The links that were up at the last signal, so a transition can be told. */
let connected: ReadonlyMap<string, ConnectedDevice> = new Map()
let scanning = false
let scanTimer: NodeJS.Timeout | null = null
let request: BluetoothPairingRequest | null = null
let answerRequest: ((accepted: boolean) => void) | null = null
let pairing = false
let error: string | null = null
const busy = new Set<string>()

function snapshot(): BluetoothSnapshot {
  return buildSnapshot(tree, { scanning, request, busy, error })
}

/**
 * What to call a device in a log line and in a confirmation.
 *
 * The same order `readDevice` uses in the model, and duplicated here rather
 * than shared with it because the two answer different questions: that one is
 * building a row, this one is naming a thing in a sentence for a person who is
 * about to be asked whether to trust it.
 */
function displayName(properties: Record<string, unknown> | undefined): string {
  const alias = properties?.['Alias']
  if (typeof alias === 'string' && alias.length > 0) return alias
  const name = properties?.['Name']
  if (typeof name === 'string' && name.length > 0) return name
  return 'Unnamed device'
}

function ok(): BluetoothResult {
  return { ok: true, error: null, snapshot: snapshot() }
}

function failed(message: string): BluetoothResult {
  return { ok: false, error: message, snapshot: snapshot() }
}

/** Whatever BlueZ rejected with, as a sentence. See `describeBluezError`. */
function describe(cause: unknown): string {
  return describeBluezError(errorName(cause), errorText(cause))
}

// ── The connection ──────────────────────────────────────────────────────────

/**
 * Everything that has to be forgotten when the bus goes.
 *
 * Called on a lost connection and on disarm, and it must clear the *derived*
 * state as well as the tree: a `scanning` left true would leave the screen
 * offering to stop a scan that no longer exists, and a pending confirmation
 * left unanswered is a promise nothing will ever resolve.
 */
function forget(reason: string | null): void {
  bus = null
  agent = null
  tree = EMPTY_TREE
  // Cleared rather than diffed against the empty tree: the bus going is not
  // every device in the room switching off, and a row of "disconnected" cards
  // for a connection *we* lost would be the launcher blaming the hardware.
  connected = new Map()
  scanning = false
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = null
  answerRequest?.(false)
  answerRequest = null
  request = null
  pairing = false
  busy.clear()
  error = reason
}

async function open(): Promise<BluezBus> {
  const connection = await openBluez({
    onInterfacesAdded: (path, interfaces) => {
      tree = withInterfaces(tree, path, readInterfaces(interfaces))
      announce()
    },
    onInterfacesRemoved: (path, names) => {
      tree = withoutInterfaces(tree, path, names)
      announce()
    },
    onPropertiesChanged: (path, iface, changed, invalidated) => {
      tree = withProperties(tree, path, iface, readDict(changed), invalidated)
      announce()
    },
    onLost: (reason) => {
      console.warn(`Bluetooth: the system bus connection was lost (${reason}).`)
      forget('The connection to BlueZ was lost. Leave this screen and come back to try again.')
    }
  })

  tree = readManagedObjects(await connection.getManagedObjects())
  error = null
  // Seeded, not announced. A headset that was already on when the launcher
  // started has not just connected, and a card for each of them at every boot
  // is the fastest way to teach somebody to ignore the corner of the screen.
  connected = connectedDevices(tree)

  const adapter = findAdapter(tree)
  const state = snapshot()
  console.info(
    `Bluetooth: ${
      adapter
        ? `adapter ${state.adapterName ?? 'unnamed'} (${state.powered ? 'on' : 'off'}), ` +
          `${state.paired.length} paired`
        : 'no adapter on this machine'
    }`
  )

  return connection
}

/**
 * The connection, opening it if this is the first ask.
 *
 * Shared between concurrent first callers the way `getSettings` shares its
 * load: the screen's poll and the press that opened the screen arrive within a
 * frame of each other, and two connections would mean two sets of match rules
 * and two copies of every signal.
 */
async function ensure(): Promise<BluezBus | null> {
  if (bus) return bus
  if (Date.now() - failedAt < RETRY_COOLDOWN_MS) return null

  opening ??= open().finally(() => {
    opening = null
  })

  try {
    bus = await opening
    agent = createPairingAgent(bus, {
      describe: (devicePath) => {
        const device = tree.get(devicePath)?.[DEVICE_IFACE]
        const address = device?.['Address']
        if (typeof address !== 'string') return null
        return { address, name: displayName(device) }
      },
      confirm: (pending) =>
        new Promise<boolean>((resolve) => {
          request = pending
          answerRequest = resolve
        }),
      display: (pending) => {
        request = pending
        answerRequest = null
      },
      clear: () => {
        answerRequest?.(false)
        answerRequest = null
        request = null
      }
    })
    return bus
  } catch (cause) {
    failedAt = Date.now()
    forget(describe(cause))
    console.warn(`Bluetooth: could not reach BlueZ — ${error ?? 'no reason given'}`)
    return null
  }
}

/**
 * A link coming up or going down, said out loud.
 *
 * Runs after every signal, which is why `connectedDevices` is the cheap read
 * rather than `buildSnapshot`: during a scan these arrive several a second as
 * RSSI moves, and all but a handful of them change nothing here.
 *
 * **Controllers are deliberately skipped.** `inputWatch.ts` announces those,
 * and it sees them over every transport rather than only over Bluetooth — so
 * leaving them in would mean one pad producing two cards a second apart, told
 * apart by nothing the user can see. The grouping in `noticeContent` would
 * usually collapse the pair anyway, since both watchers read the same name out
 * of the same hardware; this is the half that does not depend on that holding.
 */
function announce(): void {
  const now = connectedDevices(tree)
  const change = connectionChanges(connected, now)
  connected = now

  for (const device of change.connected) {
    if (device.kind === 'gamepad') continue
    console.info(`Bluetooth: ${device.kind} connected`)
    notify({ kind: 'device-connected', name: device.name, device: device.kind })
  }

  for (const device of change.disconnected) {
    if (device.kind === 'gamepad') continue
    console.info(`Bluetooth: ${device.kind} disconnected`)
    notify({ kind: 'device-disconnected', name: device.name, device: device.kind })
  }
}

/**
 * Opens the connection at startup so the launcher can see a device arrive.
 *
 * Fire and forget, and a failure here is the ordinary case rather than a fault:
 * plenty of machines have no radio and some have no daemon. `ensure()` already
 * logs why and sets the cooldown, so nothing is retried on a timer — the next
 * attempt is whenever somebody opens the Devices screen, exactly as before.
 */
export function armBluetoothWatch(): void {
  void ensure()
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function getBluetooth(): Promise<BluetoothSnapshot> {
  await ensure()
  return snapshot()
}

/**
 * The adapter's object path, or a refusal.
 *
 * Every operation below needs it and every one of them can be reached before
 * there is one — a machine with no radio still has a Settings row that opens
 * this screen.
 */
function adapterPath(): string | null {
  return findAdapter(tree)?.path ?? null
}

/**
 * An address, as the object path BlueZ knows it by.
 *
 * **Looked up, never built.** The address has already been validated for shape
 * at the channel, and this is the second half of that rule: resolving it
 * against the mirror means the renderer can only ever name a device the
 * launcher has itself discovered, so no payload can reach a D-Bus object that
 * was not already on this screen.
 */
function resolveDevice(address: string): { path: string; name: string } | null {
  for (const [path, interfaces] of tree) {
    const device = interfaces[DEVICE_IFACE]
    if (device?.['Address'] !== address) continue
    return { path, name: displayName(device) }
  }
  return null
}

// ── Discovery ───────────────────────────────────────────────────────────────

async function stopDiscovery(connection: BluezBus, path: string): Promise<void> {
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = null
  scanning = false
  try {
    await connection.invoke(path, ADAPTER_IFACE, 'StopDiscovery')
  } catch (cause) {
    // "No discovery started" is the ordinary answer when the timeout below has
    // already stopped it, or when BlueZ dropped our reference on its own. It is
    // not worth a sentence on screen, and `scanning` is already false.
    console.info(`Bluetooth: discovery was already stopped (${describe(cause)})`)
  }
}

export async function setScan(on: boolean): Promise<BluetoothResult> {
  const connection = await ensure()
  if (!connection) return failed(error ?? 'BlueZ could not be reached.')

  const path = adapterPath()
  if (!path) return failed('This machine has no Bluetooth adapter.')

  if (!on) {
    await stopDiscovery(connection, path)
    return ok()
  }

  if (scanning) return ok()

  try {
    // Per-client, so this cannot disturb a scan the desktop's own panel
    // started. `RSSI` is not a threshold worth having for its own sake — it is
    // what makes BlueZ report signal strength at all, and the strength is what
    // orders the list.
    await connection.invoke(path, ADAPTER_IFACE, 'SetDiscoveryFilter', 'a{sv}', [
      [
        ['Transport', ['s', 'auto']],
        ['DuplicateData', ['b', false]],
        ['RSSI', ['n', -100]]
      ]
    ])
    await connection.invoke(path, ADAPTER_IFACE, 'StartDiscovery')
  } catch (cause) {
    return failed(describe(cause))
  }

  scanning = true
  // A scan left running is a radio kept busy on a machine somebody walked away
  // from. Sixty seconds is longer than any device takes to announce itself and
  // short enough that forgetting to press stop costs nothing.
  scanTimer = setTimeout(() => {
    void stopDiscovery(connection, path)
  }, SCAN_TIMEOUT_MS)
  scanTimer.unref()

  return ok()
}

// ── The adapter ─────────────────────────────────────────────────────────────

export async function setPowered(on: boolean): Promise<BluetoothResult> {
  const connection = await ensure()
  if (!connection) return failed(error ?? 'BlueZ could not be reached.')

  const path = adapterPath()
  if (!path) return failed('This machine has no Bluetooth adapter.')

  // Switching the radio off with a scan running leaves BlueZ holding our
  // discovery reference against an adapter that cannot answer it.
  if (!on && scanning) await stopDiscovery(connection, path)

  try {
    await connection.setProperty(path, ADAPTER_IFACE, 'Powered', 'b', on)
  } catch (cause) {
    return failed(describe(cause))
  }

  console.info(`Bluetooth: adapter switched ${on ? 'on' : 'off'}`)
  return ok()
}

// ── Devices ─────────────────────────────────────────────────────────────────

/**
 * Pair, connect, disconnect or forget.
 *
 * Device names reach the log and addresses deliberately do not — `redactSecrets`
 * would replace an address with `<mac>` anyway, so a line built around one says
 * nothing to the person reading the file a week later.
 */
export async function act(action: BluetoothAction, address: string): Promise<BluetoothResult> {
  const connection = await ensure()
  if (!connection) return failed(error ?? 'BlueZ could not be reached.')

  const device = resolveDevice(address)
  if (!device) return failed('BlueZ no longer knows about that device. Scan again.')

  if (action === 'pair' && pairing) {
    return failed('Another pairing is already running. Wait for it to finish.')
  }

  busy.add(address)
  try {
    switch (action) {
      case 'pair':
        return await pair(connection, device)
      case 'connect':
        await connection.invoke(
          device.path,
          DEVICE_IFACE,
          'Connect',
          undefined,
          undefined,
          PAIR_TIMEOUT_MS
        )
        console.info(`Bluetooth: connected ${device.name}`)
        return ok()
      case 'disconnect':
        await connection.invoke(device.path, DEVICE_IFACE, 'Disconnect')
        console.info(`Bluetooth: disconnected ${device.name}`)
        return ok()
      case 'forget': {
        const path = adapterPath()
        if (!path) return failed('This machine has no Bluetooth adapter.')
        await connection.invoke(path, ADAPTER_IFACE, 'RemoveDevice', 'o', [device.path])
        console.info(`Bluetooth: forgot ${device.name}`)
        return ok()
      }
    }
  } catch (cause) {
    const message = describe(cause)
    console.warn(`Bluetooth: could not ${action} ${device.name} — ${message}`)
    return failed(message)
  } finally {
    busy.delete(address)
  }
}

/**
 * The three steps a pairing actually is.
 *
 * `Pair` is the exchange. `Trusted` is what lets the device reconnect on its
 * own afterwards, which for a gamepad is the whole point — without it the pad
 * pairs, works for one evening, and is ignored at the next boot. `Connect` is
 * the convenience: BlueZ connects most HID devices during the pairing itself
 * and leaves audio alone.
 *
 * Only the first of the three can fail the operation. A pairing that completed
 * and then did not connect is **paired**, and saying otherwise would offer to
 * pair a device that already is; the row moves to "Paired · Disconnected", which
 * is both true and something A can act on.
 */
async function pair(
  connection: BluezBus,
  device: { path: string; name: string }
): Promise<BluetoothResult> {
  if (!agent) return failed('The pairing agent is not available.')

  console.info(`Bluetooth: pairing ${device.name}`)
  pairing = true
  try {
    await agent.during(() =>
      connection.invoke(device.path, DEVICE_IFACE, 'Pair', undefined, undefined, PAIR_TIMEOUT_MS)
    )
  } catch (cause) {
    // Already paired is not a failure to report — it is the state the press was
    // asking for, reached by somebody else.
    if (errorName(cause) !== 'org.bluez.Error.AlreadyExists') throw cause
  } finally {
    pairing = false
  }

  try {
    await connection.setProperty(device.path, DEVICE_IFACE, 'Trusted', 'b', true)
  } catch (cause) {
    console.warn(`Bluetooth: ${device.name} paired but could not be trusted — ${describe(cause)}`)
  }

  try {
    await connection.invoke(
      device.path,
      DEVICE_IFACE,
      'Connect',
      undefined,
      undefined,
      PAIR_TIMEOUT_MS
    )
  } catch (cause) {
    console.warn(`Bluetooth: ${device.name} paired but did not connect — ${describe(cause)}`)
  }

  console.info(`Bluetooth: paired ${device.name}`)
  return ok()
}

/**
 * Answers the confirmation BlueZ is holding a `Pair` call open for.
 *
 * Refusing when there is nothing pending rather than silently succeeding: a
 * press that lands after the request has cleared itself should not read as
 * having confirmed the next one.
 */
export async function respondToPairing(accept: boolean): Promise<BluetoothResult> {
  const answer = answerRequest
  if (!answer) return failed('There is nothing waiting to be confirmed.')

  answerRequest = null
  request = null
  answer(accept)
  return ok()
}

/**
 * Gives the radio, the match rules and the agent back.
 *
 * Called from `will-quit` beside `disarmPointerMode`, and for the same reason:
 * a discovery reference this process still holds is a radio the next
 * application finds busy, and an exported agent outliving the launcher is not
 * somebody else's bug to notice.
 */
export function disarmBluetooth(): void {
  const connection = bus
  const path = adapterPath()
  if (connection && path && scanning) {
    void stopDiscovery(connection, path).finally(() => connection.close())
  } else {
    connection?.close()
  }
  forget(null)
}
