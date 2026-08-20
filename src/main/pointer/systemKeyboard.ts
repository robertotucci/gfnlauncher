import { sessionBus } from '@homebridge/dbus-native'

/**
 * The compositor's on-screen keyboard, for typing where ours cannot go.
 *
 * ── Why this is not our own keyboard ────────────────────────────────────────
 *
 * `src/preload/pointer.ts` draws a keyboard inside the two windows we own, and
 * that is where it stops. Drawing one over somebody else's window needs a
 * floating surface, and an Electron window created the only way that could work
 * — `focusable: false`, `alwaysOnTop`, `showInactive()` — was measured on this
 * compositor and **took the focus anyway**. The focus is exactly what decides
 * where `NotifyKeyboardKeysym` lands, so a keyboard drawn that way types into
 * itself. That measurement has not changed and this module does not challenge
 * it: it asks the compositor to show *its* keyboard instead, which is a
 * layer-shell surface and therefore the one kind of window that is allowed to
 * float over a fullscreen game without taking the focus from it.
 *
 * The pad still drives it, because the pad already has a cursor out there: the
 * portal's pointer clicks the compositor's keys. Nothing new crosses a boundary
 * and nothing new is drawn by us.
 *
 * ── What it costs, and what it cannot promise ───────────────────────────────
 *
 * One Flatpak permission — `--talk-name=org.kde.KWin` — and it is KDE-only.
 * There is no cross-desktop protocol for "show the on-screen keyboard": GNOME
 * has its own D-Bus name for the same idea and wlroots compositors have none at
 * all, so this is written as one implementation behind one question —
 * `toggleSystemKeyboard` either did it or says why it could not — and a second
 * desktop would be a second branch here rather than a change anywhere else.
 *
 * It also cannot promise the keystrokes arrive. KWin hands what is typed to the
 * focused client through the Wayland `text-input` protocol, and a client that
 * does not implement it gets nothing; KWin synthesises key events for some of
 * those cases and not for others. A native Qt or GTK application is reliable, a
 * remote game inside the GeForce NOW client is not, and both of those are the
 * compositor's business rather than ours. What this module guarantees is that
 * the keyboard is asked for and that a refusal is reported.
 */

const KWIN = 'org.kde.KWin'
const OBJECT = '/VirtualKeyboard'
const VIRTUAL_KEYBOARD = 'org.kde.kwin.VirtualKeyboard'
const PROPERTIES = 'org.freedesktop.DBus.Properties'

/** The other thing KWin knows that this launcher wants: the xkb layout. */
const LAYOUTS_OBJECT = '/Layouts'
const LAYOUTS_IFACE = 'org.kde.KeyboardLayouts'

/**
 * Short, because this is answered from inside a 60 Hz tick's continuation and
 * KWin is either there or it is not. The portal's fifteen seconds are for a
 * dialog somebody is reading; nothing here waits on a person.
 */
const REPLY_TIMEOUT_MS = 4_000

/** What the compositor says about its keyboard, reduced to what decides this. */
export interface SystemKeyboardState {
  /** An input method is installed *and* selected. False is the common case. */
  readonly available: boolean
  /** It is on screen right now. */
  readonly visible: boolean
}

export type SystemKeyboardAction = 'show' | 'hide' | 'unavailable'

/**
 * The decision, which is the whole of the logic and is therefore pure.
 *
 * A toggle rather than a raise, because LB + RB is a toggle everywhere else in
 * pointer mode and a keyboard you cannot put away is worse than one you cannot
 * summon — it would sit over the game for the rest of the session.
 */
export function nextKeyboardAction(state: SystemKeyboardState): SystemKeyboardAction {
  if (!state.available) return 'unavailable'
  return state.visible ? 'hide' : 'show'
}

/**
 * Unwraps a single `v`, which dbus-native hands over as `[[signature], [value]]`.
 *
 * The same shape `readPortalResults` in `portal.ts` digs values out of, one
 * variant at a time rather than a dictionary of them. Anything that is not that
 * shape is `undefined` rather than a guess: a property we could not read must
 * not read as `false`, because `available: false` is a sentence this module
 * says out loud to the user.
 */
export function readVariant(raw: unknown): unknown {
  if (!Array.isArray(raw) || raw.length < 2) return undefined
  const values = raw[1]
  return Array.isArray(values) ? values[0] : values
}

/** What one press of LB + RB out on the desktop actually did. */
export type SystemKeyboardResult =
  | { readonly kind: 'shown' }
  | { readonly kind: 'hidden' }
  /** Nothing happened, and this says what to do about it in one sentence. */
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * No virtual keyboard is installed or selected, which is the default on KDE.
 *
 * Named packages rather than "install an input method": the person reading this
 * is holding a gamepad, and the difference between those two sentences is
 * whether they can act on it. Plasma 6.7 replaced Maliit with `plasma-keyboard`
 * and both names are given because a distribution may still be on either.
 *
 * The third sentence is the one that costs an evening if it is missing. KWin
 * takes its input-method server as a **start-up option** — `kwin_wayland
 * --inputmethod` — so selecting one writes `[Wayland] InputMethod` into
 * `kwinrc` and changes nothing at all in the session doing the selecting. Not
 * even `org.kde.KWin.reconfigure`: `available` stays false, `forceActivate`
 * returns without an error, and no keyboard appears. Verified on Plasma 6.7.
 */
const NOT_INSTALLED =
  'KDE has no on-screen keyboard installed or selected. Install `plasma-keyboard` ' +
  '(Maliit, on Plasma 6.6 and older: `maliit-keyboard`), pick it under System ' +
  'Settings → Keyboard → Virtual Keyboard, then log out and back in — KWin starts ' +
  'the keyboard with the session and does not pick one up mid-session.'

/**
 * KDE has one, and will not put it on screen.
 *
 * Measured on Plasma 6.7 with `plasma-keyboard` installed, selected and running:
 * `available` true, `forceActivate` accepted, `active` true, `visible` false,
 * and `willShowOnActive` false throughout — including with a Qt window focused
 * and `activeClientSupportsTextInput` true. KDE raises its keyboard for touch
 * input, and there is no gamepad in that policy and no environment variable to
 * override it in this build. It is not a fault and there is nothing to fix on
 * this side, which is why the launcher stops asking and composes instead.
 */
const WILL_NOT_SHOW =
  'KDE has an on-screen keyboard but will not raise it for a gamepad — it shows ' +
  'that keyboard for touch input only.'

/**
 * Shows or hides it, and never throws.
 *
 * Every failure becomes a `reason` instead, because the caller is a pad press
 * on a television: there is nowhere to put an exception and a rejected promise
 * from inside a tick is an unhandled rejection.
 */
export async function toggleSystemKeyboard(): Promise<SystemKeyboardResult> {
  let bus: ReturnType<typeof sessionBus>

  try {
    bus = sessionBus()
  } catch (error) {
    return { kind: 'unavailable', reason: `no session bus (${describe(error)})` }
  }

  const invoke = (
    member: string,
    iface: string,
    signature?: string,
    body?: unknown[]
  ): Promise<unknown[]> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${member} did not answer within ${REPLY_TIMEOUT_MS} ms`)),
        REPLY_TIMEOUT_MS
      )
      // Unref'd: a launcher must never be held open by a keyboard it asked for.
      timer.unref?.()

      bus.invoke(
        { destination: KWIN, path: OBJECT, interface: iface, member, signature, body },
        (error, ...result) => {
          clearTimeout(timer)
          if (error) reject(error instanceof Error ? error : new Error(String(error)))
          else resolve(result)
        }
      )
    })

  const property = async (name: string): Promise<unknown> =>
    readVariant((await invoke('Get', PROPERTIES, 'ss', [VIRTUAL_KEYBOARD, name]))[0])

  try {
    const available = await property('available')
    // Anything but a definite `true` is treated as "no keyboard": the property
    // is missing on a compositor that is not KWin, and an unreadable one must
    // not be reported to the user as a keyboard that failed to appear.
    if (available !== true) {
      return { kind: 'unavailable', reason: NOT_INSTALLED }
    }

    const action = nextKeyboardAction({
      available: true,
      visible: (await property('visible')) === true
    })

    if (action === 'hide') {
      await invoke('Set', PROPERTIES, 'ssv', [VIRTUAL_KEYBOARD, 'active', ['b', false]])
      return { kind: 'hidden' }
    }

    // **Asked, before being told.** `forceActivate` succeeds whether or not
    // anything appears, so calling it and reporting success is how the launcher
    // came to log `On-screen keyboard shown` at a user looking at a screen with
    // no keyboard on it. `willShowOnActive` is KWin answering the only question
    // worth asking, and on a session with no touchscreen it answers false —
    // KDE raises its keyboard for touch input, and a gamepad is not touch.
    if ((await invoke('willShowOnActive', VIRTUAL_KEYBOARD))[0] !== true) {
      return { kind: 'unavailable', reason: WILL_NOT_SHOW }
    }

    // `forceActivate` rather than setting `active`, and the difference is the
    // whole point out here: setting the property shows the keyboard only for a
    // client that has asked for text input, and the clients this exists for —
    // a game, an installer, somebody else's launcher — have asked for nothing.
    await invoke('forceActivate', VIRTUAL_KEYBOARD)
    return { kind: 'shown' }
  } catch (error) {
    return { kind: 'unavailable', reason: describe(error) }
  } finally {
    try {
      bus.connection.end()
    } catch {
      // A connection that is already gone is the state we wanted it in.
    }
  }
}

/**
 * Which keyboard layout the session is configured with, as xkb names it.
 *
 * `org.kde.KeyboardLayouts` answers `it` on an Italian session, and that is the
 * signal the compose keyboard follows — the locale is a *language*, and the two
 * disagree often enough to matter: plenty of people run an English desktop on
 * an Italian keyboard, and it is the keyboard their fingers know.
 *
 * Null when there is nothing to ask, which is every desktop that is not KDE.
 * The caller falls back to the locale and then to US, because a keyboard has to
 * draw something.
 */
export async function readSystemLayout(): Promise<string | null> {
  let bus: ReturnType<typeof sessionBus>

  try {
    bus = sessionBus()
  } catch {
    return null
  }

  const invoke = (member: string): Promise<unknown[]> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${member} did not answer`)), REPLY_TIMEOUT_MS)
      timer.unref?.()

      bus.invoke(
        { destination: KWIN, path: LAYOUTS_OBJECT, interface: LAYOUTS_IFACE, member },
        (error, ...result) => {
          clearTimeout(timer)
          if (error) reject(error instanceof Error ? error : new Error(String(error)))
          else resolve(result)
        }
      )
    })

  try {
    const [index] = await invoke('getLayout')
    const [list] = await invoke('getLayoutsList')
    if (typeof index !== 'number' || !Array.isArray(list)) return null

    // Each entry is (short, display, long). The short name is the xkb one.
    const entry = list[index]
    const short = Array.isArray(entry) ? entry[0] : null
    return typeof short === 'string' && short.length > 0 ? short : null
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

/**
 * Turns a D-Bus failure into a line worth reading.
 *
 * `ServiceUnknown` is the one worth naming: it is what both "this is not KDE"
 * and "the Flatpak permission was revoked" look like, and they are the two
 * likeliest reasons this ever fails.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('ServiceUnknown')
    ? 'KWin did not answer. Either this is not a KDE session, or the launcher has ' +
        'lost `--talk-name=org.kde.KWin` (restore it with `flatpak override --user ' +
        '--talk-name=org.kde.KWin io.github.robertotucci.GfnLauncher`).'
    : message
}
