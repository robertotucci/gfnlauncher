import { open } from 'node:fs/promises'

/**
 * Lifting the kernel's soft block on Bluetooth — `rfkill unblock bluetooth`,
 * without the tool.
 *
 * BlueZ cannot power an adapter that rfkill holds: `Powered = true` answers
 * `org.bluez.Error.Blocked` and `PowerState` reads `off-blocked`. That block is
 * also what Plasma's own Bluetooth switch sets, and `systemd-rfkill` restores it
 * at the next boot — so a radio somebody switched off from the desktop one
 * evening is still off the next, under a launcher whose only input is a
 * Bluetooth pad. Lifting it is the same thing the desktop's switch does in the
 * other direction, as the same unprivileged user: `/dev/rfkill` is granted to
 * the seat's user by logind's `uaccess`, and `--device=all` is already what puts
 * it inside the sandbox.
 *
 * A **hard** block is a physical switch or a firmware setting and nothing here
 * touches it; the event below only ever carries `soft = 0`.
 */

const RFKILL_DEVICE = '/dev/rfkill'

/** `RFKILL_TYPE_BLUETOOTH` in `<linux/rfkill.h>`. */
const TYPE_BLUETOOTH = 2
/** `RFKILL_OP_CHANGE_ALL`: every device of `type`, which is what the tool sends. */
const OP_CHANGE_ALL = 3

/**
 * The event, as the eight bytes `struct rfkill_event` is.
 *
 * `idx` u32, then `type`, `op`, `soft`, `hard` as u8. The original eight-byte
 * size rather than the newer `rfkill_event_ext`, because every kernel accepts
 * it — the extended one added a trailing field and kept this prefix. `idx` is
 * ignored for `CHANGE_ALL`, and zero reads the same in either byte order.
 */
export function rfkillUnblockEvent(): Buffer {
  const event = Buffer.alloc(8)
  event.writeUInt32LE(0, 0)
  event.writeUInt8(TYPE_BLUETOOTH, 4)
  event.writeUInt8(OP_CHANGE_ALL, 5)
  event.writeUInt8(0, 6)
  event.writeUInt8(0, 7)
  return event
}

/**
 * Writes the unblock. Rejects with the filesystem's error — `EACCES` on a seat
 * that does not own the device, `ENOENT` in a sandbox without `--device=all` —
 * which the caller logs and turns into a sentence.
 */
export async function unblockBluetooth(): Promise<void> {
  const handle = await open(RFKILL_DEVICE, 'w')
  try {
    await handle.write(rfkillUnblockEvent())
  } finally {
    await handle.close()
  }
}
