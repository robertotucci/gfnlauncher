import { powerMonitor } from 'electron'
import type { BluetoothPairingRequest, BluetoothResult, BluetoothSnapshot } from '@shared/types'
import type { BluetoothAction } from '@shared/bluetooth'
import { createPairingAgent, type PairingAgent } from './agent'
import { errorName, errorText, openBluez, PAIR_TIMEOUT_MS, type BluezBus } from './bluez'
import { notify } from '../notify'
import { unblockBluetooth } from './rfkill'
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
 *
 * ── Why the launcher switches the radio on ──────────────────────────────────
 *
 * The pad in that room is a Bluetooth pad. A radio that is off when the
 * launcher comes up — Plasma restoring the switch as it was left, rfkill
 * restored by `systemd-rfkill`, an adapter that came back from a suspend
 * powered down — is therefore a launcher with no input at all, and the Devices
 * screen's own switch is out of reach for the same reason. So for a short
 * window after each of the moments that happens (startup, resume, the adapter
 * reappearing) the launcher *wants* the radio on, and pursues it: lifting a soft
 * rfkill block if there is one, then `Powered = true`. See `wantRadio`.
 *
 * The window is the restraint. Outside it, a radio switched off from the
 * desktop stays off; inside it, something switching it off again — the desktop
 * restoring its saved state a moment after us, which is a race at login — is
 * answered once more. Switching it off from the Devices screen ends the wish
 * for the rest of the run.
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

/**
 * How long the launcher goes on wanting the radio on after a moment that can
 * leave it off. Long enough to outlast the desktop restoring its own saved
 * state at login, short enough that it is not a standing fight with the
 * desktop's switch.
 */
const RADIO_WISH_MS = 30_000

/**
 * How often a startup that could not reach BlueZ tries again, and for how long.
 * bluetoothd and the session both start at boot and nothing orders them, so
 * "not running yet" at the first second is the ordinary race rather than a
 * machine without a daemon.
 */
const STARTUP_RETRY_MS = RETRY_COOLDOWN_MS
const STARTUP_RETRY_FOR_MS = 60_000

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

/** Until when the radio is wanted on. 0 is "not wanted". See `wantRadio`. */
let radioWantedUntil = 0
/** Set by switching the radio off from the Devices screen; ends every wish. */
let radioOffByUser = false
let radioInFlight = false
/** One unblock per wish: a write that did not lift the block will not on retry. */
let rfkillTried = false

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
  emptyMirror(reason)
}

/**
 * The half of `forget` that a bluetoothd restart needs too, with the bus and
 * the agent left alone: the connection is fine, only the daemon behind it went.
 */
function emptyMirror(reason: string | null): void {
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
      const added = readInterfaces(interfaces)
      tree = withInterfaces(tree, path, added)
      announce()
      // An adapter appearing is one of the moments a radio comes up off — a
      // controller re-registered after a suspend, a dongle plugged in,
      // bluetoothd restarting.
      if (added[ADAPTER_IFACE]) wantRadio('the adapter appeared')
      else pursueRadio()
    },
    onInterfacesRemoved: (path, names) => {
      tree = withoutInterfaces(tree, path, names)
      announce()
    },
    onPropertiesChanged: (path, iface, changed, invalidated) => {
      const before = iface === ADAPTER_IFACE ? radioState() : null
      tree = withProperties(tree, path, iface, readDict(changed), invalidated)
      announce()
      if (before !== null) noteRadio(before)
      pursueRadio()
    },
    onOwnerChanged: (present) => {
      if (!present) {
        console.warn('Bluetooth: BlueZ stopped; forgetting what it had reported.')
        emptyMirror('BlueZ stopped running. It is usually restarted on its own within seconds.')
        return
      }
      console.info('Bluetooth: BlueZ is running again; reading its tree afresh.')
      void reload()
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

// ── The radio ───────────────────────────────────────────────────────────────

/** `Powered` and `PowerState` off the first adapter, for a log line and a test. */
function radioState(): { powered: boolean; state: string | null } {
  const properties = findAdapter(tree)?.properties
  const state = properties?.['PowerState']
  return {
    powered: properties?.['Powered'] === true,
    state: typeof state === 'string' ? state : null
  }
}

/**
 * Says when the radio went off and the launcher did not ask for it.
 *
 * The diagnostic this bug never had: "it was off when I sat down" is a picture,
 * and the line this writes is what says whether it went off at login, at
 * resume, or an hour into the evening.
 */
function noteRadio(before: { powered: boolean; state: string | null }): void {
  const after = radioState()
  if (before.powered === after.powered && before.state === after.state) return
  console.info(
    `Bluetooth: adapter is now ${after.powered ? 'on' : 'off'}` +
      (after.state ? ` (${after.state})` : '')
  )
}

/**
 * Starts wanting the radio on for `RADIO_WISH_MS`. See the header.
 *
 * Idempotent and cheap, because it is called from every moment that might
 * need it rather than from one place that knows: the work is in
 * `pursueRadio`, which does nothing at all once the radio is on.
 */
function wantRadio(why: string): void {
  if (radioOffByUser) return
  if (Date.now() >= radioWantedUntil) {
    rfkillTried = false
    console.info(`Bluetooth: making sure the radio is on (${why}).`)
  }
  radioWantedUntil = Date.now() + RADIO_WISH_MS
  pursueRadio()
}

/**
 * One step towards a powered radio, from whatever state it is in now.
 *
 * Called after every signal while a wish is live, which is how the steps chain
 * without a timer: lifting rfkill moves `PowerState` from `off-blocked`, that
 * change arrives as a signal, and the next call sets `Powered`. The `-enabling`
 * and `-disabling` states are transitions somebody else started, and are left
 * to finish before anything is asked.
 */
function pursueRadio(): void {
  if (radioOffByUser || Date.now() >= radioWantedUntil) return
  if (!bus || radioInFlight) return

  const adapter = findAdapter(tree)
  // No adapter yet: the wish waits for `InterfacesAdded`.
  if (!adapter) return

  const { powered, state } = radioState()
  if (powered) return
  if (state === 'off-enabling' || state === 'on-disabling') return

  const connection = bus
  radioInFlight = true
  void powerOn(connection, adapter.path, state === 'off-blocked')
    .catch((cause: unknown) => {
      console.warn(`Bluetooth: could not switch the radio on — ${describe(cause)}`)
      // Not retried within this wish: the answer is not going to change in the
      // next signal, and asking on each one would be a loop.
      radioWantedUntil = 0
    })
    .finally(() => {
      radioInFlight = false
    })
}

/**
 * Lifts a soft block if BlueZ says there is one, then powers the adapter.
 *
 * `Blocked` from the `Set` is handled as well as `off-blocked` from the read,
 * because a BlueZ older than `PowerState` (5.64) only says it the first way.
 */
async function powerOn(connection: BluezBus, path: string, blocked: boolean): Promise<void> {
  if (blocked) {
    await liftRfkill()
    // The state change it causes is a signal, and that signal is the next step.
    return
  }

  try {
    await connection.setProperty(path, ADAPTER_IFACE, 'Powered', 'b', true)
  } catch (cause) {
    if (errorName(cause) !== 'org.bluez.Error.Blocked') throw cause
    await liftRfkill()
    await setPoweredAfterUnblock(connection, path)
  }
  console.info('Bluetooth: switched the radio on.')
}

/**
 * `Powered = true` right after an unblock, on a BlueZ that cannot say when the
 * unblock has landed. bluetoothd hears about it through its own rfkill read, a
 * moment after our write returns, and until then it still answers `Blocked`.
 */
async function setPoweredAfterUnblock(connection: BluezBus, path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await connection.setProperty(path, ADAPTER_IFACE, 'Powered', 'b', true)
      return
    } catch (cause) {
      if (errorName(cause) !== 'org.bluez.Error.Blocked' || attempt >= 5) throw cause
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
}

async function liftRfkill(): Promise<void> {
  if (rfkillTried) {
    throw Object.assign(new Error('Blocked through rfkill'), { name: 'org.bluez.Error.Blocked' })
  }
  rfkillTried = true
  try {
    await unblockBluetooth()
  } catch (cause) {
    console.warn(`Bluetooth: could not lift the rfkill block — ${String(cause)}`)
    throw Object.assign(new Error('Blocked through rfkill'), { name: 'org.bluez.Error.Blocked' })
  }
  console.info('Bluetooth: lifted the rfkill soft block.')
}

/**
 * Reads the whole tree again after bluetoothd came back.
 *
 * Seeded rather than announced, for the reason the first read is: devices the
 * new daemon already holds have not just arrived. Signals that land while this
 * is in flight are applied to the old tree and then superseded by the reply,
 * which is at least as new as they are — the connection delivers in order.
 */
async function reload(): Promise<void> {
  const connection = bus
  if (!connection) return
  try {
    const fresh = readManagedObjects(await connection.getManagedObjects())
    if (bus !== connection) return
    tree = fresh
    connected = connectedDevices(tree)
    error = null
  } catch (cause) {
    console.warn(`Bluetooth: could not read BlueZ's tree after its restart — ${describe(cause)}`)
    return
  }
  wantRadio('BlueZ restarted')
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
 * Opens the connection at startup so the launcher can see a device arrive, and
 * makes sure the radio is on.
 *
 * Fire and forget, and a failure here is the ordinary case rather than a fault:
 * plenty of machines have no radio and some have no daemon. `ensure()` already
 * logs why and sets the cooldown. The one retry on a timer is the boot race —
 * bluetoothd and an autostarted launcher come up in no particular order — and
 * it gives up after a minute; past that the next attempt is whenever somebody
 * opens the Devices screen, exactly as before.
 *
 * Resume is the other moment a radio comes back off, so it is watched here too.
 */
export function armBluetoothWatch(): void {
  const startedAt = Date.now()
  const attempt = (): void => {
    void ensure().then((connection) => {
      if (connection) {
        wantRadio('the launcher started')
        return
      }
      if (Date.now() - startedAt >= STARTUP_RETRY_FOR_MS) return
      setTimeout(attempt, STARTUP_RETRY_MS).unref()
    })
  }
  attempt()

  powerMonitor.on('resume', () => {
    void ensure().then((connection) => {
      if (connection) wantRadio('the machine resumed')
    })
  })
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

  // Somebody choosing, from this screen, is the end of the launcher choosing
  // for them — in both directions, so an "on" here does not leave a wish behind
  // that would answer the desktop's switch for the next thirty seconds.
  radioOffByUser = !on
  radioWantedUntil = 0

  // Switching the radio off with a scan running leaves BlueZ holding our
  // discovery reference against an adapter that cannot answer it.
  if (!on && scanning) await stopDiscovery(connection, path)

  try {
    if (on) {
      rfkillTried = false
      const blocked = radioState().state === 'off-blocked'
      // The unblock is one step and `Powered` is the next, taken when the
      // signal for the first arrives — which needs a wish to be live for it.
      if (blocked) radioWantedUntil = Date.now() + RADIO_WISH_MS
      await powerOn(connection, path, blocked)
    } else {
      await connection.setProperty(path, ADAPTER_IFACE, 'Powered', 'b', false)
    }
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
