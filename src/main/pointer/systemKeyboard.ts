import { sessionBus, systemBus, type MessageBus } from '@homebridge/dbus-native'
import { DESKTOP, type DesktopId } from '../desktop'
import { hostExecFile } from '../host'

/**
 * The compositor's on-screen keyboard, and the session's keyboard layout.
 *
 * Two questions, one per desktop, and they are here together because they are
 * the same question asked of the same authority: what does this session say
 * about typing?
 *
 * ── Why this is not our own keyboard ────────────────────────────────────────
 *
 * `src/preload/pointer.ts` draws a keyboard inside the two windows we own, and
 * that is where it stops. Drawing one over somebody else's window needs a
 * floating surface, and an Electron window created the only way that could work
 * — `focusable: false`, `alwaysOnTop`, `showInactive()` — was measured on KDE
 * Wayland and **took the focus anyway**. The focus is exactly what decides
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
 * ── One branch per desktop, and only one of them can say yes ────────────────
 *
 * **There is no cross-desktop protocol for "show the on-screen keyboard."** So
 * this is written as one question — `toggleSystemKeyboard` either did it or
 * says why it could not — with an implementation per desktop behind it:
 *
 * - **KDE** answers on `org.kde.kwin.VirtualKeyboard`, which costs
 *   `--talk-name=org.kde.KWin`. It is the only desktop that can be asked, and
 *   even it usually declines — see `WILL_NOT_SHOW`.
 * - **GNOME** has an on-screen keyboard and no way to ask for it. It is raised
 *   by the shell for touch input and there is no D-Bus member, no portal and no
 *   environment variable that means "now". `org.gnome.desktop.a11y.applications
 *   screen-keyboard-enabled` is not that either: it is the user's accessibility
 *   preference, it still only fires on touch focus, and turning somebody's
 *   accessibility settings on from behind a game grid is worse than composing.
 * - **Everything else** — Xfce, MATE, LXQt, Cinnamon, sway, Hyprland — has
 *   nothing at all.
 *
 * So the honest answer everywhere but KDE is `unavailable` with a reason, which
 * `pointer/desktop.ts` already handles by opening our own composed keyboard.
 * That path needs no desktop's help and is the one that actually types into a
 * streamed game. What changed when this stopped being KDE-only is not the
 * behaviour: it is that a GNOME user is no longer told to install
 * `plasma-keyboard`.
 *
 * It also cannot promise the keystrokes arrive, on the one desktop that can say
 * yes. KWin hands what is typed to the focused client through the Wayland
 * `text-input` protocol, and a client that does not implement it gets nothing.
 * A native Qt or GTK application is reliable, a remote game inside the GeForce
 * NOW client is not, and both of those are the compositor's business rather
 * than ours. What this module guarantees is that the keyboard is asked for and
 * that a refusal is reported.
 */

const KWIN = 'org.kde.KWin'
const OBJECT = '/VirtualKeyboard'
const VIRTUAL_KEYBOARD = 'org.kde.kwin.VirtualKeyboard'
const PROPERTIES = 'org.freedesktop.DBus.Properties'

/** The other thing KWin knows that this launcher wants: the xkb layout. */
const LAYOUTS_OBJECT = '/Layouts'
const LAYOUTS_IFACE = 'org.kde.KeyboardLayouts'

/** systemd-localed, the one keyboard authority that is on every distribution. */
const LOCALED = 'org.freedesktop.locale1'
const LOCALED_OBJECT = '/org/freedesktop/locale1'

/**
 * Short, because this is answered from inside a 60 Hz tick's continuation and
 * the service is either there or it is not. The portal's fifteen seconds are
 * for a dialog somebody is reading; nothing here waits on a person.
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
 * What a desktop that cannot be asked is told, in its own terms.
 *
 * These are not error messages and they must not read as ones. Composing is the
 * ordinary path on all of these desktops and it works; the launcher is
 * explaining which keyboard the user is about to see, not apologising for a
 * failure. Each names the desktop, because "not available" without a subject is
 * the kind of line that sends somebody looking for a setting to change.
 *
 * Named per desktop rather than one generic sentence for one reason: the
 * previous version of this file said `plasma-keyboard` to everybody, and the
 * whole cost of that bug was a GNOME user looking for a KDE package.
 */
const NO_SYSTEM_KEYBOARD: Partial<Record<DesktopId, string>> = {
  gnome:
    'GNOME raises its on-screen keyboard for touch input and offers no way to ask ' +
    'for it, so the launcher draws its own.',
  cinnamon:
    'Cinnamon offers no way to ask for an on-screen keyboard, so the launcher ' +
    'draws its own.',
  budgie:
    'Budgie offers no way to ask for an on-screen keyboard, so the launcher draws ' +
    'its own.',
  xfce: 'Xfce has no on-screen keyboard to ask for, so the launcher draws its own.',
  mate: 'MATE has no on-screen keyboard to ask for, so the launcher draws its own.',
  lxqt: 'LXQt has no on-screen keyboard to ask for, so the launcher draws its own.',
  pantheon: 'Pantheon offers no way to ask for an on-screen keyboard, so the launcher draws its own.',
  deepin: 'Deepin offers no way to ask for an on-screen keyboard, so the launcher draws its own.',
  sway: 'A wlroots compositor has no on-screen keyboard to ask for, so the launcher draws its own.',
  hyprland:
    'A wlroots compositor has no on-screen keyboard to ask for, so the launcher ' +
    'draws its own.'
}

/** Said where the desktop is one nobody here has a name for. */
const NO_SYSTEM_KEYBOARD_ELSEWHERE =
  'This desktop offers no way to ask for an on-screen keyboard, so the launcher ' +
  'draws its own.'

/**
 * Whether this desktop can be asked at all, and what to say when it cannot.
 *
 * Null means "ask it" and is true of exactly one desktop. Pure and exported for
 * the same reason `nextKeyboardAction` is: it is the whole of the decision, and
 * the alternative to testing it here is testing it on six machines.
 */
export function systemKeyboardReason(desktop: DesktopId): string | null {
  if (desktop === 'kde') return null
  return NO_SYSTEM_KEYBOARD[desktop] ?? NO_SYSTEM_KEYBOARD_ELSEWHERE
}

/**
 * Shows or hides it, and never throws.
 *
 * Every failure becomes a `reason` instead, because the caller is a pad press
 * on a television: there is nowhere to put an exception and a rejected promise
 * from inside a tick is an unhandled rejection.
 *
 * Away from KDE this answers **without opening a bus at all**. That is not only
 * a saved round trip on the path between a chord and a keyboard: it is what
 * stops the KDE-shaped `ServiceUnknown` message — which names a `flatpak
 * override` for `org.kde.KWin` — from being shown to somebody whose desktop
 * simply is not KDE and for whom that command would fix nothing.
 */
export async function toggleSystemKeyboard(): Promise<SystemKeyboardResult> {
  const cannotAsk = systemKeyboardReason(DESKTOP.id)
  if (cannotAsk) return { kind: 'unavailable', reason: cannotAsk }

  let bus: MessageBus

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

// ── The keyboard layout ─────────────────────────────────────────────────────

/**
 * Where the layout came from, so the log can say and a report can be read.
 *
 * A wrong layout used to be completely silent — the compose keyboard drew a US
 * board, the user's password went in wrong, and nothing anywhere recorded which
 * of five sources had been consulted. Naming the source is what turns that into
 * one grep.
 */
export type LayoutSource =
  | 'XKB_DEFAULT_LAYOUT'
  | 'KDE'
  | 'GNOME input sources'
  | 'localed'

export interface SystemLayout {
  /** The xkb name, e.g. `it`. */
  readonly id: string
  readonly source: LayoutSource
}

/**
 * Takes the first layout out of an xkb layout *list*.
 *
 * Both `XKB_DEFAULT_LAYOUT` and localed's `X11Layout` are comma-separated —
 * `us,it` is an ordinary two-layout setup — and the first is the one the
 * session comes up in, which is the one to draw. Variants ride on a `+`
 * (`de+nodeadkeys`, `fr+oss`) and are dropped: the compose keyboard has a table
 * per layout and no variants in it, so keeping the suffix would turn a layout
 * it *does* have into one it does not and fall back to US.
 */
export function parseXkbLayoutList(raw: string | undefined | null): string | null {
  const first = (raw ?? '').split(',')[0]?.split('+')[0]?.trim().toLowerCase()
  return first ? first : null
}

/**
 * Reads `gsettings get org.gnome.desktop.input-sources sources`.
 *
 * Two output shapes, both measured against real `gsettings`: an empty list
 * prints its type, `@a(ss) []`, and a populated one does not,
 * `[('xkb', 'it'), ('xkb', 'us')]`.
 *
 * **Only `xkb` entries count.** The same list holds input *methods* —
 * `('ibus', 'mozc-jp')`, `('ibus', 'pinyin')` — whose second field is an engine
 * name and not a layout at all, and a user typing Japanese still has an xkb row
 * for the physical keyboard under it. Taking entry zero blindly would hand
 * `mozc-jp` to `composeLayoutFor`, which would find no such layout and draw US:
 * the exact failure this whole chain exists to end, for the users least likely
 * to be able to work around it.
 */
export function parseGnomeInputSources(raw: string | undefined | null): string | null {
  for (const [, type, value] of (raw ?? '').matchAll(/\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g)) {
    if (type !== 'xkb') continue
    const layout = parseXkbLayoutList(value)
    if (layout) return layout
  }
  return null
}

/**
 * Which sources to ask, in which order, for a given desktop.
 *
 * Pure, so the order is assertable without a bus, a host or a desktop — and the
 * order is the design:
 *
 * 1. **`XKB_DEFAULT_LAYOUT` first, because it is free and it is exact.** Plasma
 *    and every wlroots compositor export it, it survives into the Flatpak
 *    sandbox (measured: `it` inside ours), and reading an environment variable
 *    costs nothing on a path between a pad chord and a keyboard.
 * 2. **The desktop's own setting**, which is the only one that follows a layout
 *    switched mid-session.
 * 3. **localed last of the three**, because it is the *system* keyboard
 *    configuration: right on Xfce, MATE, LXQt and any X11 session, and stale on
 *    a desktop where the user changed their layout in the desktop's own
 *    settings and never touched `localectl`. It is a fallback, and a fallback
 *    that is usually right beats the alternative, which is the session
 *    *language* — see `readSystemLayout`.
 *
 * GNOME's setting is asked of the GNOME family rather than of GNOME alone:
 * Cinnamon, Budgie and Pantheon all keep `org.gnome.desktop.input-sources`, and
 * asking a desktop that does not have the schema costs one failed `gsettings`
 * that is caught and moved past.
 */
export function layoutSources(desktop: DesktopId): readonly LayoutSource[] {
  const own: readonly LayoutSource[] =
    desktop === 'kde'
      ? ['KDE']
      : desktop === 'gnome' ||
          desktop === 'cinnamon' ||
          desktop === 'budgie' ||
          desktop === 'pantheon'
        ? ['GNOME input sources']
        : []

  return ['XKB_DEFAULT_LAYOUT', ...own, 'localed']
}

/**
 * Which keyboard layout the session is configured with, as xkb names it.
 *
 * **This is a *layout*, not a language, and the two disagree often enough to
 * matter.** Plenty of people run an English desktop on an Italian keyboard, and
 * it is the keyboard their fingers know — so the caller's fallback,
 * `app.getLocale()`, is genuinely the last resort rather than a peer. For one
 * release this function answered `null` on every desktop but KDE and that
 * fallback was the *only* answer a GNOME user ever got.
 *
 * Null when nothing could be read, and never a throw: the compose keyboard has
 * to open either way, and a keyboard in the wrong layout is recoverable where a
 * keyboard that did not appear is not.
 */
export async function readSystemLayout(): Promise<SystemLayout | null> {
  for (const source of layoutSources(DESKTOP.id)) {
    const id = await readLayoutFrom(source)
    if (id) return { id, source }
  }
  return null
}

async function readLayoutFrom(source: LayoutSource): Promise<string | null> {
  switch (source) {
    case 'XKB_DEFAULT_LAYOUT':
      return parseXkbLayoutList(process.env.XKB_DEFAULT_LAYOUT)
    case 'KDE':
      return readKdeLayout()
    case 'GNOME input sources':
      return readGnomeLayout()
    case 'localed':
      return readLocaledLayout()
  }
}

/**
 * KDE's, over `org.kde.KeyboardLayouts`.
 *
 * The layout list is `(short, display, long)` triples and the *index* is which
 * one is active, so both calls are needed: the index alone says nothing and the
 * list alone does not say which.
 */
async function readKdeLayout(): Promise<string | null> {
  return withBus(sessionBus, async (invoke) => {
    const [index] = await invoke(KWIN, LAYOUTS_OBJECT, LAYOUTS_IFACE, 'getLayout')
    const [list] = await invoke(KWIN, LAYOUTS_OBJECT, LAYOUTS_IFACE, 'getLayoutsList')
    if (typeof index !== 'number' || !Array.isArray(list)) return null

    // Each entry is (short, display, long). The short name is the xkb one.
    const entry = list[index]
    const short = Array.isArray(entry) ? entry[0] : null
    return typeof short === 'string' ? parseXkbLayoutList(short) : null
  })
}

/**
 * GNOME's, through `gsettings` on the host.
 *
 * Through `host.ts` rather than directly, which is what makes one call work in
 * both worlds: unsandboxed it reads this user's dconf, and sandboxed
 * `flatpak-spawn --host` reads the *host session's* dconf, which is the one
 * that holds the answer. Measured working from inside our own sandbox, where
 * reading dconf any other way would have wanted `--filesystem=xdg-run/dconf`
 * and `--talk-name=ca.desktop.dconf` — two permissions for a string we can
 * already get with the one we have.
 *
 * The portal's `org.freedesktop.portal.Settings` was the other candidate and is
 * not usable: its backends expose a fixed set of namespaces, and
 * `org.gnome.desktop.input-sources` is not among them.
 *
 * `quiet` because a missing schema is the ordinary case on three of the four
 * desktops this is tried on, and a warning per keyboard press about a desktop
 * behaving normally is how a log stops being skimmable.
 */
async function readGnomeLayout(): Promise<string | null> {
  try {
    const { stdout } = await hostExecFile(
      'gsettings',
      ['get', 'org.gnome.desktop.input-sources', 'sources'],
      { quiet: true }
    )
    return parseGnomeInputSources(stdout)
  } catch {
    return null
  }
}

/**
 * The system's, over `org.freedesktop.locale1` on the **system** bus.
 *
 * `X11Layout` is what `localectl` prints and what every distribution's
 * installer writes, which is what makes this the one source that answers on
 * Xfce, MATE, LXQt and a bare compositor alike. It is a property read, so
 * nothing here is privileged: localed's own policy needs polkit for `Set*` and
 * for nothing else.
 *
 * Inside the Flatpak this needs `--system-talk-name=org.freedesktop.locale1` —
 * verified, since without it the call answers `ServiceUnknown` from inside our
 * sandbox while working on the host. Its denial costs a keyboard *layout* and
 * never the keyboard, which is why it is the last step and why the failure is
 * swallowed rather than reported.
 */
async function readLocaledLayout(): Promise<string | null> {
  return withBus(systemBus, async (invoke) => {
    const [raw] = await invoke(LOCALED, LOCALED_OBJECT, PROPERTIES, 'Get', 'ss', [
      LOCALED,
      'X11Layout'
    ])
    const value = readVariant(raw)
    return typeof value === 'string' ? parseXkbLayoutList(value) : null
  })
}

type Invoke = (
  destination: string,
  path: string,
  iface: string,
  member: string,
  signature?: string,
  body?: unknown[]
) => Promise<unknown[]>

/**
 * Opens a bus, runs one question on it, and always closes it.
 *
 * Shared by the two layout readers because they differ only in which bus and
 * which member, and because the thing easiest to get wrong is the same in both:
 * a connection left open holds the launcher's event loop, and these are called
 * from a pad press that may be the last one of the evening.
 *
 * Answers null on anything at all — a bus that would not open, a service that
 * is not there, a reply that never came. This is a fallback chain and every
 * step of it is allowed to have nothing to say.
 */
async function withBus(
  open: () => MessageBus,
  ask: (invoke: Invoke) => Promise<string | null>
): Promise<string | null> {
  let bus: MessageBus

  try {
    bus = open()
  } catch {
    return null
  }

  const invoke: Invoke = (destination, path, iface, member, signature, body) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${member} did not answer`)), REPLY_TIMEOUT_MS)
      timer.unref?.()

      bus.invoke({ destination, path, interface: iface, member, signature, body }, (error, ...result) => {
        clearTimeout(timer)
        if (error) reject(error instanceof Error ? error : new Error(String(error)))
        else resolve(result)
      })
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

/**
 * Turns a D-Bus failure into a line worth reading.
 *
 * `ServiceUnknown` is the one worth naming, and it is now only reachable on a
 * KDE session — `toggleSystemKeyboard` answers before opening a bus anywhere
 * else — which is what makes it safe to name a KDE permission here. On KDE the
 * two things it can mean are a revoked `--talk-name` and a KWin that is not
 * answering, and the override is the actionable half.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('ServiceUnknown')
    ? 'KWin did not answer. Either KWin is not running, or the launcher has lost ' +
        '`--talk-name=org.kde.KWin` (restore it with `flatpak override --user ' +
        '--talk-name=org.kde.KWin io.github.robertotucci.GfnLauncher`).'
    : message
}
