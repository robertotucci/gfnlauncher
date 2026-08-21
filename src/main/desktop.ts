/**
 * Which desktop session this is, read once from the environment.
 *
 * ── What this is for, and what it is emphatically not for ───────────────────
 *
 * The launcher was written and measured on KDE Plasma, and almost all of it is
 * desktop-agnostic by construction — XDG autostart, `systemctl` through logind,
 * `org.freedesktop.portal.RemoteDesktop` for the cursor, `powerSaveBlocker`
 * with Chromium picking whichever inhibit interface the session offers. None of
 * that wants to know what desktop it is on, and asking would make it worse.
 *
 * So the rule for this module is narrow and worth stating out loud:
 * **detect the desktop to say the right sentence and read the right setting,
 * never to change behaviour.** `window.ts`, `input.ts` and `displaySleep.ts`
 * are all ordered cheapest-and-most-portable-first and all fail open; a branch
 * on `DESKTOP.id` in any of them is how you fix one desktop and break another,
 * silently, on hardware nobody here owns. There are exactly three consumers of
 * the **id**, and the last two are the same exception:
 *
 * - `announceStartup()` in `index.ts`, which writes the log's second line —
 *   the one the README asks a reporter to quote.
 * - `pointer/systemKeyboard.ts`, which has one implementation per desktop of
 *   "show the on-screen keyboard" because there is no cross-desktop protocol
 *   for it, and which reads the keyboard *layout* from a different place on
 *   each.
 * - `gfn/present.ts`, which asks the compositor to make *somebody else's*
 *   window fullscreen, and there is no cross-desktop protocol for that either.
 *
 * The exception those two share is worth stating, because it is the only thing
 * that keeps the rule above meaningful: **branch on the id where the question
 * genuinely has a different answer per desktop, never to work around a
 * difference a portable call would have handled.** Both of them put the
 * desktop-specific attempt *before* the portable one rather than instead of it,
 * and both fail open onto something that needs no desktop's help.
 *
 * `session` is a different axis and a narrower rule applies to it: it may be
 * branched on, because it is not a desktop's taste but a capability the
 * protocol either has or does not. `window.ts` already writes "X11 only"
 * against `setAlwaysOnTop`, which is `_NET_WM_STATE_ABOVE` there and has no
 * Wayland equivalent, and `notify.ts` chooses between a placed notification
 * window and a fullscreen one on the same question — can a client put its own
 * window where it wants it. Both fail towards the Wayland answer, which is the
 * one that is merely wasteful on the other protocol rather than wrong.
 *
 * ── Why the environment and not a D-Bus probe ───────────────────────────────
 *
 * `XDG_CURRENT_DESKTOP` is set by the session before anything in it starts, and
 * **it is forwarded into the Flatpak sandbox** — measured in ours, which
 * reports `KDE` from inside bwrap. A probe would cost a round trip on a path
 * answered from inside a 60 Hz tick's continuation, and would answer the wrong
 * question anyway: what matters is which session's conventions to follow, not
 * which processes happen to be running.
 *
 * Pure, and it takes the environment as an argument for the same reason
 * `hostEnvironment` does — the suite has no `vi.stubEnv` anywhere and should
 * not grow one.
 */

/** The desktops with a convention this launcher has to know about. */
export type DesktopId =
  | 'kde'
  | 'gnome'
  | 'xfce'
  | 'cinnamon'
  | 'mate'
  | 'lxqt'
  | 'budgie'
  | 'pantheon'
  | 'deepin'
  | 'sway'
  | 'hyprland'
  | 'unknown'

export type SessionType = 'wayland' | 'x11' | 'unknown'

export interface DesktopSession {
  readonly id: DesktopId
  readonly session: SessionType
  /** The raw `XDG_CURRENT_DESKTOP` entries, uppercased, for the log line. */
  readonly names: readonly string[]
}

/**
 * `XDG_CURRENT_DESKTOP` names, in the order they must be tested.
 *
 * **The order is the whole of the correctness here, and it is not
 * alphabetical.** That variable is a colon-separated *list*, and two desktops
 * put `GNOME` in it on purpose: Budgie ships `Budgie:GNOME` so that
 * GNOME-targeting applications behave, and Ubuntu ships `ubuntu:GNOME`, which
 * really is GNOME. Matching GNOME first would call every Budgie session GNOME
 * and offer it a GNOME sentence about a keyboard it does not have. So the
 * derivatives come before the thing they derive from, and `ubuntu` is not in
 * this table at all — it falls through to `GNOME`, which is the right answer.
 *
 * `X-CINNAMON` is Cinnamon's own spelling; `CINNAMON` is what a few
 * distributions set instead.
 */
const DESKTOP_NAMES: readonly (readonly [name: string, id: DesktopId])[] = [
  ['BUDGIE', 'budgie'],
  ['PANTHEON', 'pantheon'],
  ['X-CINNAMON', 'cinnamon'],
  ['CINNAMON', 'cinnamon'],
  ['DEEPIN', 'deepin'],
  ['KDE', 'kde'],
  ['PLASMA', 'kde'],
  ['GNOME', 'gnome'],
  ['XFCE', 'xfce'],
  ['MATE', 'mate'],
  ['LXQT', 'lxqt'],
  ['HYPRLAND', 'hyprland'],
  ['SWAY', 'sway']
]

/**
 * What to ask when `XDG_CURRENT_DESKTOP` is empty, which is not rare.
 *
 * A compositor started by hand from a TTY sets none of it, and so does a
 * `.desktop` session file that predates the convention. Each of these is set by
 * exactly one thing and means exactly one desktop, so a bare presence check is
 * enough — the values are internal handles, not names, and must not be parsed.
 */
const MARKER_VARIABLES: readonly (readonly [variable: string, id: DesktopId])[] = [
  ['HYPRLAND_INSTANCE_SIGNATURE', 'hyprland'],
  ['SWAYSOCK', 'sway'],
  ['KDE_FULL_SESSION', 'kde'],
  ['GNOME_DESKTOP_SESSION_ID', 'gnome']
]

/**
 * Reads the session out of an environment.
 *
 * Never throws and never answers `undefined`: an environment that says nothing
 * is `unknown`, which every caller already has to handle, because an
 * unrecognised desktop and an unset variable are the same situation.
 */
export function detectDesktop(env: NodeJS.ProcessEnv): DesktopSession {
  const names = (env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0)

  return { id: identify(env, names), session: sessionType(env), names }
}

function identify(env: NodeJS.ProcessEnv, names: readonly string[]): DesktopId {
  // The table's order decides, not the variable's — see DESKTOP_NAMES. A
  // session listing `Budgie:GNOME` must not be read as GNOME merely because
  // GNOME's row happened to be reached while walking the value left to right.
  for (const [name, id] of DESKTOP_NAMES) {
    if (names.includes(name)) return id
  }

  for (const [variable, id] of MARKER_VARIABLES) {
    if ((env[variable] ?? '') !== '') return id
  }

  // Last, because it is the least trustworthy of the three: `DESKTOP_SESSION`
  // is whatever the display manager called the session file, so it is a *path*
  // on this machine (`/usr/share/wayland-sessions/plasma.desktop`) and a bare
  // word on others. Basename, drop the suffix, then the same table.
  const session = (env.DESKTOP_SESSION ?? '')
    .split('/')
    .pop()
    ?.replace(/\.desktop$/i, '')
    .toUpperCase()

  if (session) {
    for (const [name, id] of DESKTOP_NAMES) {
      if (session === name || session.startsWith(name)) return id
    }
  }

  return 'unknown'
}

/**
 * Wayland or X11.
 *
 * `XDG_SESSION_TYPE` is logind's answer and is right whenever it is set. The
 * two fallbacks are for a compositor started outside a login session: note that
 * `DISPLAY` is checked *after* `WAYLAND_DISPLAY` rather than instead of it,
 * because a Wayland session running XWayland sets both and is not an X11
 * session.
 */
function sessionType(env: NodeJS.ProcessEnv): SessionType {
  const declared = (env.XDG_SESSION_TYPE ?? '').trim().toLowerCase()
  if (declared === 'wayland' || declared === 'x11') return declared
  if ((env.WAYLAND_DISPLAY ?? '') !== '') return 'wayland'
  if ((env.DISPLAY ?? '') !== '') return 'x11'
  return 'unknown'
}

/**
 * This process's session, read once.
 *
 * A const rather than a call, like `IS_SANDBOXED` in `host.ts` and for the same
 * reason: none of it can change while the launcher runs — a desktop is not
 * swapped underneath a running application — and a module-level value is one
 * fewer thing for a caller inside a tick to have to think about.
 */
export const DESKTOP: DesktopSession = detectDesktop(process.env)
