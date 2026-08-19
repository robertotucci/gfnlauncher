/**
 * The Bluetooth vocabulary both sides of the bridge need.
 *
 * Small on purpose. Everything that knows what BlueZ is lives in
 * `src/main/bluetooth/`; what is here is the union the channel validates
 * against, the shape of a device address, and the one derived number the
 * renderer draws. All three are pure, so the suite can assert them without a
 * radio, a bus or a DOM.
 */

/**
 * What the launcher can ask BlueZ to do to one device.
 *
 * A closed union rather than four channels, for the reason `PowerAction` is
 * one: whatever arrives becomes a method call on somebody else's D-Bus object,
 * and a single guard at the boundary is easier to keep right than four.
 */
export const BLUETOOTH_ACTIONS = ['pair', 'connect', 'disconnect', 'forget'] as const

export type BluetoothAction = (typeof BLUETOOTH_ACTIONS)[number]

export function isBluetoothAction(value: unknown): value is BluetoothAction {
  return typeof value === 'string' && (BLUETOOTH_ACTIONS as readonly string[]).includes(value)
}

/**
 * `AA:BB:CC:DD:EE:FF`, uppercase, which is the form BlueZ publishes.
 *
 * The address is the launcher's key for a device — focus ids and every action
 * payload carry it — so it crosses the bridge, and the renderer is where this
 * codebase stops being ours. Validating the shape is only half of it: the main
 * side also refuses an address it has not itself discovered, so nothing here
 * can name a D-Bus object the launcher has never seen. See `resolveDevice` in
 * `src/main/bluetooth/index.ts`.
 */
const ADDRESS_PATTERN = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/

export function isBluetoothAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value)
}

/**
 * Signal strength as a number of ticks, 0–4.
 *
 * The Devices screen orders what it found by proximity and draws this beside
 * each row, which is the whole answer to "which of these three devices called
 * *Wireless Controller* is the one in my hand". Bands are the conventional
 * ones for BR/EDR inquiry results: about −55 dBm is the same room, −90 is the
 * edge of hearing.
 *
 * **Zero means no reading, not a weak one.** A device the adapter can see has
 * at least one tick, so an empty meter always says "this is a device we know
 * about but are not currently hearing" — which is exactly what a paired device
 * that is switched off looks like.
 */
export function signalBars(rssi: number | null): 0 | 1 | 2 | 3 | 4 {
  if (rssi === null || !Number.isFinite(rssi)) return 0
  if (rssi >= -55) return 4
  if (rssi >= -67) return 3
  if (rssi >= -78) return 2
  return 1
}
