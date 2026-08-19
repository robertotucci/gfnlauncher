import {
  systemBus,
  type DBusMessage,
  type InterfaceDescriptor,
  type MessageBus
} from '@homebridge/dbus-native'

/**
 * The connection to BlueZ, and nothing that decides anything.
 *
 * `org.bluez` on the **system** bus, which is the second D-Bus client in this
 * process — `pointer/portal.ts` is the first, on the session bus. The same
 * bargain applies to both: pure D-Bus, no native module, and therefore nothing
 * for `npmRebuild: false` and `externalizeDepsPlugin` to argue with.
 *
 * Why not `bluetoothctl` through `host.ts`, which would need no new permission:
 * because it is a *client of this API* that prints for humans. Going through it
 * would mean parsing text to learn what a structured reply already says, and
 * this codebase treats that as a last resort — `flatpakProgress.ts` is the one
 * place it was unavoidable and it documents itself as such. It would also cost
 * the signals: a discovery list that fills itself is the difference between a
 * screen and a form.
 *
 * Inside the Flatpak this reaches xdg-dbus-proxy rather than the bus, through
 * the socket flatpak bind-mounts at the ordinary path. `--system-talk-name=org.bluez`
 * is what opens it, and it has to be `talk` rather than `see`: bluetoothd calls
 * **back into the sandbox** on the pairing agent, and only `talk` permits that
 * direction. Without it every call answers `AccessDenied`, which
 * `describeBluezError` turns into the `flatpak override` that fixes it.
 */

export const BLUEZ = 'org.bluez'
const ROOT = '/'
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager'
const PROPERTIES = 'org.freedesktop.DBus.Properties'

/**
 * How long an ordinary call may take.
 *
 * Generous by the standards of this bus — most answer in single-digit
 * milliseconds — because the alternative is a screen with a spinner that never
 * stops, and the timeout exists to end that rather than to be tight.
 */
const CALL_TIMEOUT_MS = 20_000

/**
 * How long `Device1.Pair` and `Device1.Connect` may take.
 *
 * These are not slow calls, they are calls with a person and a radio in the
 * middle: BlueZ holds the reply open while the user finds the button on the
 * headset, while the two devices exchange keys, and while a confirmation waits
 * to be answered. Ninety seconds is longer than any of that and short enough
 * that a device which walked out of range ends in a sentence rather than a
 * spinner.
 */
export const PAIR_TIMEOUT_MS = 90_000

/** A rejection from dbus-native, which is a plain object rather than an Error. */
interface DBusRejection {
  name?: string
  message?: string
}

export interface BluezBus {
  /** Calls a method on an `org.bluez` object. Rejects with the D-Bus error. */
  invoke(
    path: string,
    iface: string,
    member: string,
    signature?: string,
    body?: unknown[],
    timeoutMs?: number
  ): Promise<unknown[]>
  /** `org.freedesktop.DBus.Properties.Set`, with the variant already wrapped. */
  setProperty(
    path: string,
    iface: string,
    name: string,
    signature: string,
    value: unknown
  ): Promise<void>
  /** The whole tree, in one call. */
  getManagedObjects(): Promise<unknown>
  /** Publishes an object on this connection — the pairing agent, and only it. */
  exportInterface(object: object, path: string, iface: InterfaceDescriptor): void
  close(): void
}

export interface BluezSignals {
  onInterfacesAdded(path: string, interfaces: unknown): void
  onInterfacesRemoved(path: string, names: readonly string[]): void
  onPropertiesChanged(
    path: string,
    iface: string,
    changed: unknown,
    invalidated: readonly string[]
  ): void
  /**
   * The connection died under us.
   *
   * Not recoverable in place: every pending call is lost and the mirror is
   * stale from that moment. The owner drops the bus and opens a new one on the
   * next request, which is the same posture `session.ts` takes to a capture
   * that expired.
   */
  onLost(reason: string): void
}

/**
 * Opens the connection and subscribes before anything is read.
 *
 * The order matters for the same reason it does in `portal.ts`: the match rules
 * go on first, then `GetManagedObjects` is read by the caller, so a device that
 * appears between the two arrives as a signal against a tree that already
 * exists rather than being missed in the gap.
 */
export async function openBluez(signals: BluezSignals): Promise<BluezBus> {
  const bus: MessageBus = systemBus()
  let dead: string | null = null

  const die = (reason: string): void => {
    if (dead) return
    dead = reason
    signals.onLost(reason)
  }

  // Without this a socket that goes away is an unhandled 'error' event, which
  // in Node ends the process — and this process is the launcher.
  bus.connection.on('error', (error) => die(error.message || 'the system bus connection closed'))

  const invoke = (
    path: string,
    iface: string,
    member: string,
    signature?: string,
    body?: unknown[],
    timeoutMs = CALL_TIMEOUT_MS
  ): Promise<unknown[]> =>
    new Promise((resolve, reject) => {
      if (dead) {
        reject(Object.assign(new Error(dead), { name: 'org.bluez.Error.NotReady' }))
        return
      }

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        // Deliberately not a D-Bus error name: nothing on the bus said this, we
        // did, and `describeBluezError` must not mistake it for BlueZ's word.
        reject(new Error(`BlueZ did not answer ${member} within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref()

      bus.invoke({ destination: BLUEZ, path, interface: iface, member, signature, body }, (error, ...result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(result)
      })
    })

  const onMessage = (message: DBusMessage): void => {
    const body = message.body ?? []
    if (message.interface === OBJECT_MANAGER && message.member === 'InterfacesAdded') {
      const [path, interfaces] = body
      if (typeof path === 'string') signals.onInterfacesAdded(path, interfaces)
      return
    }
    if (message.interface === OBJECT_MANAGER && message.member === 'InterfacesRemoved') {
      const [path, names] = body
      if (typeof path === 'string') {
        signals.onInterfacesRemoved(path, Array.isArray(names) ? (names as string[]) : [])
      }
      return
    }
    if (message.interface === PROPERTIES && message.member === 'PropertiesChanged') {
      const [iface, changed, invalidated] = body
      if (typeof iface === 'string' && typeof message.path === 'string') {
        signals.onPropertiesChanged(
          message.path,
          iface,
          changed,
          Array.isArray(invalidated) ? (invalidated as string[]) : []
        )
      }
    }
  }
  bus.connection.on('message', onMessage)

  const addMatch = (rule: string): Promise<void> =>
    new Promise((resolve, reject) => {
      bus.addMatch(rule, (error) => (error ? reject(error) : resolve()))
    })

  // `sender=` is resolved from the well-known name by the bus itself, so these
  // stay correct across a bluetoothd restart even though its unique name does
  // not. Scoped to org.bluez so the launcher is not woken by every property
  // change on the system bus.
  await addMatch(
    `type='signal',sender='${BLUEZ}',interface='${OBJECT_MANAGER}',path='${ROOT}'`
  )
  await addMatch(
    `type='signal',sender='${BLUEZ}',interface='${PROPERTIES}',member='PropertiesChanged'`
  )

  return {
    invoke,

    async setProperty(path, iface, name, signature, value) {
      // The variant is `[signature, value]` on the way out, which is not the
      // shape it arrives in — see `readVariant` in model.ts for the other half.
      await invoke(path, PROPERTIES, 'Set', 'ssv', [iface, name, [signature, value]])
    },

    async getManagedObjects() {
      const [objects] = await invoke(ROOT, OBJECT_MANAGER, 'GetManagedObjects')
      return objects
    },

    exportInterface(object, path, iface) {
      bus.exportInterface(object, path, iface)
    },

    close() {
      bus.connection.off('message', onMessage)
      dead ??= 'closed'
      bus.connection.end()
    }
  }
}

/** The D-Bus error name of a rejection, when it carries one. */
export function errorName(error: unknown): string | undefined {
  const name = (error as DBusRejection | null)?.name
  // An `Error` also has a `name`, and it is "Error" — which is not a D-Bus
  // error name and must not be matched against one.
  return typeof name === 'string' && name.includes('.') ? name : undefined
}

/** Whatever the failure said, for the cases where BlueZ's own text is better. */
export function errorText(error: unknown): string {
  const message = (error as DBusRejection | null)?.message
  if (typeof message === 'string' && message.trim().length > 0) return message.trim()
  return 'BlueZ refused the request.'
}
