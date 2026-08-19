import { sessionBus, type DBusMessage, type MessageBus } from '@homebridge/dbus-native'
import {
  KEY_LEFTSHIFT,
  keycodeForChar,
  keycodeForKey,
  keysymForChar,
  keysymForKey
} from '@shared/keycodes'
import type { PointerKeyName } from '@shared/pointer'

/**
 * A real cursor on the real desktop, via `org.freedesktop.portal.RemoteDesktop`.
 *
 * ── Why a portal and not /dev/uinput ────────────────────────────────────────
 *
 * uinput is the obvious answer and it is the wrong one here. Creating a virtual
 * device needs `ioctl` — `UI_SET_EVBIT`, `UI_DEV_CREATE` — which Node cannot do
 * without a native FFI dependency, and `/dev/uinput` is root-owned on most
 * distributions, so it would also need a udev rule installed as root. On a
 * machine whose whole premise is that it is driven from a sofa, "run this
 * command as root first" is not a feature.
 *
 * The portal needs none of that. It is pure D-Bus, Flatpak permits talking to
 * `org.freedesktop.portal.Desktop` with no `finish-args` at all, and because it
 * injects at the **compositor**, the input reaches whatever has the screen.
 * Which is the point: the GeForce NOW client is not ours and no Electron API
 * can put a cursor inside it, but the compositor can — the client captures the
 * pointer and forwards it, so this is what moves the mouse inside a streamed
 * Steam window to accept an EULA.
 *
 * ── What it costs ───────────────────────────────────────────────────────────
 *
 * A permission dialog, once. It is a system window, so it needs a real pointer
 * or a keyboard the first time — there is no way around that from inside the
 * sandbox, and pretending otherwise would just fail later and less clearly.
 * `persist_mode: 2` plus the `restore_token` returned by `Start` is what makes
 * every subsequent session silent, which is why the token is worth persisting.
 */

const DESTINATION = 'org.freedesktop.portal.Desktop'
const OBJECT = '/org/freedesktop/portal/desktop'
const REMOTE_DESKTOP = 'org.freedesktop.portal.RemoteDesktop'
const REQUEST_IFACE = 'org.freedesktop.portal.Request'
const SESSION_IFACE = 'org.freedesktop.portal.Session'

/** `AvailableDeviceTypes` bits. Touchscreen exists and is not wanted. */
export const DEVICE_KEYBOARD = 1
export const DEVICE_POINTER = 2

/**
 * Remember the grant until the user revokes it.
 *
 * 0 never persists and 1 lasts only while this process lives — either would put
 * the permission dialog in front of somebody every time they reached for a
 * cursor, and the dialog is the one part of this that cannot be answered with
 * the pad.
 */
const PERSIST_UNTIL_REVOKED = 2

/** `linux/input-event-codes.h`. The portal speaks evdev button numbers. */
const BTN_LEFT = 0x110
const BTN_RIGHT = 0x111

/** `NotifyPointerAxisDiscrete` axis 0 is vertical. */
const AXIS_VERTICAL = 0

const RELEASED = 0
const PRESSED = 1

/**
 * How long to wait for a `Response` signal that is not a user decision.
 *
 * `Start` is excluded: it is showing a dialog and a person is reading it. The
 * others are bookkeeping and should answer immediately, so a hang there is a
 * portal that is not going to answer at all.
 */
const REPLY_TIMEOUT_MS = 15_000

/** Long enough for somebody to find the dialog, read it and decide. */
const CONSENT_TIMEOUT_MS = 180_000

// ── Paths, which the client has to predict ──────────────────────────────────

/**
 * Our unique bus name, in the form the portal builds object paths out of.
 *
 * `:1.219` becomes `1_219`. This has to be derived rather than read back,
 * because of a race the portal documents: the `Response` signal can be emitted
 * before `CreateSession` returns its handle, so a client that waits for the
 * handle to know where to listen can miss the answer entirely. Predicting the
 * path is how the subscription gets in first.
 *
 * Throws on a name that is not a unique name. The alternative is composing an
 * object path out of `undefined` and subscribing to a signal that never comes,
 * which presents as "the cursor does nothing" — the least diagnosable failure
 * this product has.
 */
export function portalSenderToken(uniqueName: string | undefined): string {
  if (!uniqueName || !uniqueName.startsWith(':')) {
    throw new Error(
      `Expected a D-Bus unique name like ":1.42", got ${JSON.stringify(uniqueName)}. ` +
        'The bus assigns it when the Hello reply lands, so a call has to complete first.'
    )
  }
  return uniqueName.slice(1).replace(/\./g, '_')
}

export function portalRequestPath(uniqueName: string | undefined, token: string): string {
  return `${OBJECT}/request/${portalSenderToken(uniqueName)}/${token}`
}

export function portalSessionPath(uniqueName: string | undefined, token: string): string {
  return `${OBJECT}/session/${portalSenderToken(uniqueName)}/${token}`
}

/**
 * A token that is legal in an object path.
 *
 * The portal spec allows `[A-Za-z0-9_]` only, so anything derived from a clock
 * or a UUID has to be scrubbed. A counter is enough — tokens only have to be
 * unique within one connection, and this one has at most a handful.
 */
let tokenCounter = 0
export function nextPortalToken(prefix: string): string {
  tokenCounter += 1
  return `gfnlauncher_${prefix}_${tokenCounter}`
}

// ── Reading what comes back ─────────────────────────────────────────────────

/**
 * Unwraps the `a{sv}` dictionary a portal response carries.
 *
 * dbus-native hands variants over as `[[signatureTree], [value]]`, which is
 * faithful to the wire and unpleasant to read at every call site. Only the
 * value is wanted, and only the string and integer cases occur here.
 */
export function readPortalResults(raw: unknown): Record<string, unknown> {
  const results: Record<string, unknown> = {}
  if (!Array.isArray(raw)) return results

  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [key, variant] = entry as [unknown, unknown]
    if (typeof key !== 'string') continue
    if (!Array.isArray(variant) || variant.length < 2) continue
    const values = variant[1]
    results[key] = Array.isArray(values) ? values[0] : values
  }

  return results
}

interface PortalResponse {
  /** 0 success, 1 the user cancelled, 2 something else went wrong. */
  readonly code: number
  readonly results: Record<string, unknown>
}

// ── The session ─────────────────────────────────────────────────────────────

export interface RemotePointer {
  /** Relative motion, which is what a stick produces. */
  moveBy(dx: number, dy: number): void
  button(button: 'left' | 'right', down: boolean): void
  /** Discrete wheel steps; negative scrolls the content up. */
  scroll(steps: number): void
  typeChar(char: string): void
  pressKey(key: PointerKeyName): void
  close(): void
}

export interface RemotePointerOptions {
  /** From a previous grant, so the dialog does not come back. */
  readonly restoreToken: string | null
  /** Called with a fresh token whenever the portal issues one. Persist it. */
  readonly onRestoreToken: (token: string) => void
}

export async function openRemotePointer(
  options: RemotePointerOptions
): Promise<RemotePointer> {
  const bus = sessionBus()

  const invoke = (
    member: string,
    signature: string | undefined,
    body: unknown[] | undefined,
    iface = REMOTE_DESKTOP
  ): Promise<unknown[]> =>
    new Promise((resolve, reject) => {
      bus.invoke(
        { destination: DESTINATION, path: OBJECT, interface: iface, member, signature, body },
        (error, ...result) => (error ? reject(error) : resolve(result))
      )
    })

  // The unique name only exists once a reply has come back, and every path
  // below is built from it. `GetId` is the cheapest call on the bus.
  await new Promise<void>((resolve, reject) => {
    bus.invoke(
      {
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'GetId'
      },
      (error) => (error ? reject(error) : resolve())
    )
  })

  // Subscribed once, for the whole connection, before any request is made —
  // see `portalSenderToken` for the race this avoids.
  const MATCH = `type='signal',interface='${REQUEST_IFACE}',member='Response'`
  await new Promise<void>((resolve, reject) => {
    bus.addMatch(MATCH, (error) => (error ? reject(error) : resolve()))
  })

  const waiting = new Map<string, (response: PortalResponse) => void>()

  const onMessage = (message: DBusMessage): void => {
    if (message.interface !== REQUEST_IFACE || message.member !== 'Response') return
    const settle = message.path ? waiting.get(message.path) : undefined
    if (!settle) return
    const [code, results] = message.body ?? []
    settle({ code: typeof code === 'number' ? code : 2, results: readPortalResults(results) })
  }
  bus.connection.on('message', onMessage)

  /** Makes a request and resolves with the `Response` signal it produces. */
  const request = async (
    member: string,
    build: (token: string) => { signature: string; body: unknown[] },
    timeoutMs = REPLY_TIMEOUT_MS
  ): Promise<PortalResponse> => {
    const token = nextPortalToken(member.toLowerCase())
    const path = portalRequestPath(bus.name, token)

    const answered = new Promise<PortalResponse>((resolve, reject) => {
      waiting.set(path, resolve)
      setTimeout(
        () => reject(new Error(`The desktop portal did not answer ${member} in time`)),
        timeoutMs
      ).unref()
    })

    const { signature, body } = build(token)
    try {
      await invoke(member, signature, body)
      return await answered
    } finally {
      waiting.delete(path)
    }
  }

  const fail = (message: string): never => {
    bus.connection.off('message', onMessage)
    bus.connection.end()
    throw new Error(message)
  }

  // ── CreateSession ─────────────────────────────────────────────────────────

  const sessionToken = nextPortalToken('session')
  const created = await request('CreateSession', (token) => ({
    signature: 'a{sv}',
    body: [
      [
        ['handle_token', ['s', token]],
        ['session_handle_token', ['s', sessionToken]]
      ]
    ]
  }))
  if (created.code !== 0) fail('The desktop portal refused to open a remote-control session')

  const session =
    typeof created.results.session_handle === 'string'
      ? created.results.session_handle
      : portalSessionPath(bus.name, sessionToken)

  // ── SelectDevices ─────────────────────────────────────────────────────────

  const selectOptions: unknown[] = [
    ['handle_token', ['s', '']],
    ['types', ['u', DEVICE_KEYBOARD | DEVICE_POINTER]],
    ['persist_mode', ['u', PERSIST_UNTIL_REVOKED]]
  ]
  if (options.restoreToken) selectOptions.push(['restore_token', ['s', options.restoreToken]])

  const selected = await request('SelectDevices', (token) => {
    selectOptions[0] = ['handle_token', ['s', token]]
    return { signature: 'oa{sv}', body: [session, selectOptions] }
  })
  if (selected.code !== 0) fail('The desktop portal refused a keyboard and pointer')

  // ── Start, which is the one that may ask the user ─────────────────────────

  const started = await request(
    'Start',
    (token) => ({
      // No parent window: the launcher is fullscreen and the dialog is the
      // compositor's, so parenting it to us would only constrain where it can
      // appear.
      signature: 'osa{sv}',
      body: [session, '', [['handle_token', ['s', token]]]]
    }),
    CONSENT_TIMEOUT_MS
  )

  if (started.code === 1) {
    fail(
      'Remote control was declined. Pointer mode on the desktop needs that ' +
        'permission once; it is remembered afterwards.'
    )
  }
  if (started.code !== 0) fail('The desktop portal could not start a remote-control session')

  if (typeof started.results.restore_token === 'string' && started.results.restore_token) {
    options.onRestoreToken(started.results.restore_token)
  }

  const devices = typeof started.results.devices === 'number' ? started.results.devices : 0
  console.info(
    `Desktop pointer ready: pointer=${(devices & DEVICE_POINTER) !== 0} ` +
      `keyboard=${(devices & DEVICE_KEYBOARD) !== 0} ` +
      `token=${started.results.restore_token ? 'issued' : 'reused'}`
  )

  return buildPointer(bus, session, invoke, () => {
    bus.connection.off('message', onMessage)
  })
}

// ── Sending input ───────────────────────────────────────────────────────────

function buildPointer(
  bus: MessageBus,
  session: string,
  invoke: (
    member: string,
    signature: string | undefined,
    body: unknown[] | undefined
  ) => Promise<unknown[]>,
  detach: () => void
): RemotePointer {
  let closed = false
  /**
   * Whether the keysym call worked.
   *
   * Undefined until the first keystroke tells us. Keysyms are layout
   * independent and keycodes are not — `KEY_2` shifted is `@` on a US layout
   * and `"` on an Italian one — so the fallback is genuinely worse and is only
   * taken when the portal implementation has no keysym support at all.
   */
  let keysymWorks: boolean | undefined
  let complained = false

  /**
   * Fire and forget, and never twice about the same fault.
   *
   * These are called from a pad loop. A rejected promise per frame would fill
   * the log — the file somebody is asked to attach to a bug report — with the
   * same line sixty times a second, and `log.ts` caps that file.
   */
  const fire = (member: string, signature: string, body: unknown[]): void => {
    if (closed) return
    invoke(member, signature, body).catch((error: unknown) => {
      if (complained) return
      complained = true
      console.error(`The desktop portal rejected ${member}; pointer mode may be dead:`, error)
    })
  }

  const notifyKeysym = async (keysym: number, state: number): Promise<void> => {
    await invoke('NotifyKeyboardKeysym', 'oa{sv}iu', [session, [], keysym, state])
  }

  const notifyKeycode = (keycode: number, state: number): void => {
    fire('NotifyKeyboardKeycode', 'oa{sv}iu', [session, [], keycode, state])
  }

  /** One character, by whichever route this session supports. */
  const sendChar = (char: string): void => {
    if (closed) return

    const keysym = keysymForChar(char)
    if (keysym !== null && keysymWorks !== false) {
      notifyKeysym(keysym, PRESSED)
        .then(() => notifyKeysym(keysym, RELEASED))
        .then(() => {
          keysymWorks = true
        })
        .catch(() => {
          if (keysymWorks === true) return
          // First failure: this portal has no keysym support. Say so once —
          // the consequence is real and the user should know why an accented
          // password suddenly types the wrong character.
          keysymWorks = false
          console.warn(
            'This desktop portal does not accept keysyms, so the on-screen ' +
              'keyboard falls back to US-layout keycodes. Symbols may differ ' +
              'from the labels on a non-US keyboard layout.'
          )
          sendKeycodeChar(char)
        })
      return
    }

    sendKeycodeChar(char)
  }

  const sendKeycodeChar = (char: string): void => {
    const stroke = keycodeForChar(char)
    if (!stroke) return
    // A keycode carries no case, so shift has to be held around it by hand.
    if (stroke.shift) notifyKeycode(KEY_LEFTSHIFT, PRESSED)
    notifyKeycode(stroke.keycode, PRESSED)
    notifyKeycode(stroke.keycode, RELEASED)
    if (stroke.shift) notifyKeycode(KEY_LEFTSHIFT, RELEASED)
  }

  return {
    moveBy(dx, dy) {
      if (dx === 0 && dy === 0) return
      fire('NotifyPointerMotion', 'oa{sv}dd', [session, [], dx, dy])
    },

    button(button, down) {
      fire('NotifyPointerButton', 'oa{sv}iu', [
        session,
        [],
        button === 'left' ? BTN_LEFT : BTN_RIGHT,
        down ? PRESSED : RELEASED
      ])
    },

    scroll(steps) {
      if (steps === 0) return
      fire('NotifyPointerAxisDiscrete', 'oa{sv}ui', [session, [], AXIS_VERTICAL, steps])
    },

    typeChar: sendChar,

    pressKey(key) {
      if (closed) return
      const keysym = keysymForKey(key)
      if (keysymWorks !== false) {
        notifyKeysym(keysym, PRESSED)
          .then(() => notifyKeysym(keysym, RELEASED))
          .then(() => {
            keysymWorks = true
          })
          .catch(() => {
            keysymWorks = false
            const stroke = keycodeForKey(key)
            notifyKeycode(stroke.keycode, PRESSED)
            notifyKeycode(stroke.keycode, RELEASED)
          })
        return
      }
      const stroke = keycodeForKey(key)
      notifyKeycode(stroke.keycode, PRESSED)
      notifyKeycode(stroke.keycode, RELEASED)
    },

    close() {
      if (closed) return
      closed = true

      // `Session.Close` lives on the **session's own object path**, not on the
      // portal's — the one call here that does. Sending it to
      // /org/freedesktop/portal/desktop is accepted by the bus and does
      // nothing, which is the sort of mistake that only shows up as a virtual
      // pointer the compositor never took down.
      bus.invoke(
        {
          destination: DESTINATION,
          path: session,
          interface: SESSION_IFACE,
          member: 'Close'
        },
        () => {
          // The session may already be gone, which is the normal way this ends.
        }
      )

      detach()
      bus.connection.end()
      console.info('Desktop pointer closed')
    }
  }
}
