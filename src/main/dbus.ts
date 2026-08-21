import type { MessageBus } from '@homebridge/dbus-native'

/**
 * One question on a session or system bus, and the bus always closed after it.
 *
 * Extracted from `pointer/systemKeyboard.ts`, which had it first and is still
 * the reason it looks like this, when `gfn/present.ts` became the second caller.
 * Both ask a handful of members of one service and then have no further use for
 * the connection, and both are reached from a path where the thing easiest to
 * get wrong is the same: **a connection left open holds the launcher's event
 * loop**, so a bus opened from a pad press could be the reason the application
 * does not quit that evening.
 */

/**
 * Short, because these are answered from inside a tick's continuation and the
 * service is either there or it is not. The portal's fifteen seconds are for a
 * dialog somebody is reading; nothing here waits on a person.
 */
export const REPLY_TIMEOUT_MS = 4_000

export type Invoke = (
  destination: string,
  path: string,
  iface: string,
  member: string,
  signature?: string,
  body?: unknown[]
) => Promise<unknown[]>

/**
 * Opens a bus, runs `ask` on it, and always closes it.
 *
 * Answers null on anything at all — a bus that would not open, a service that is
 * not there, a reply that never came. Every caller here is a fallback chain or a
 * best effort, and each step of one is allowed to have nothing to say; a throw
 * out of a `setTimeout` continuation would be an unhandled rejection instead.
 *
 * Which means `null` is reserved: an `ask` that wants to distinguish "the bus
 * said no" from "the answer is nothing" has to return a value of its own for the
 * second, because this function keeps the first.
 */
export async function withBus<T>(
  open: () => MessageBus,
  ask: (invoke: Invoke) => Promise<T>
): Promise<T | null> {
  let bus: MessageBus

  try {
    bus = open()
  } catch {
    return null
  }

  const invoke: Invoke = (destination, path, iface, member, signature, body) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${member} did not answer`)), REPLY_TIMEOUT_MS)
      // Unref'd: a launcher must never be held open by a question it asked.
      timer.unref?.()

      bus.invoke(
        { destination, path, interface: iface, member, signature, body },
        (error, ...result) => {
          clearTimeout(timer)
          if (error) reject(error instanceof Error ? error : new Error(String(error)))
          else resolve(result)
        }
      )
    })

  try {
    return await ask(invoke)
  } catch {
    return null
  } finally {
    try {
      bus.connection.end()
    } catch {
      // Already gone is the state we wanted it in.
    }
  }
}
