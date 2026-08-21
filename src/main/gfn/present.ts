import { join } from 'node:path'
import { app } from 'electron'
import { sessionBus } from '@homebridge/dbus-native'
import { writeFileAtomic } from '../atomicFile'
import { withBus } from '../dbus'
import { DESKTOP, type DesktopId } from '../desktop'
import { classifyHostFailure, hostExecFile } from '../host'
import { GFN_WM_CLASS } from './flatpak'

/**
 * Making the GeForce NOW window fullscreen and undecorated.
 *
 * ── The problem, and what it is not ─────────────────────────────────────────
 *
 * The client only takes the whole screen once a stream is running. Everything
 * before that — its mall, the pre-launch dialog, the loading screen — is an
 * ordinary decorated window restored at whatever size it was last left:
 * measured on a 3840×2160 display as `2559×1355 @ 1082,342` with
 * `_NET_FRAME_EXTENTS = 0, 0, 48, 0`, i.e. a 48-pixel title bar, over a launcher
 * that is deliberately still fullscreen behind it. On a machine driven from a
 * sofa that gap is the one moment the desktop shows through.
 *
 * ── Why this is not done by asking the client ───────────────────────────────
 *
 * **The client ignores `nv-*` switches on its command line.** That was the first
 * design and it is a dead end; `docs/gfn-api.md` records the measurements so
 * nobody repeats them. The short version: the binary's own switch table holds
 * `nv-windows-borders` (default true), `nv-window-persistence` (default true)
 * and `nv-sdl-fullscreen-exclusive` (default false), each read by a helper that
 * compares the value against the literal string `"true"` — and none of them has
 * any effect when passed to the process. Verified from the other end too:
 * `--nv-min-window-size=1600,1000` on argv leaves `WM_NORMAL_HINTS` reporting
 * the `640 by 360` that `Resources/GeForceNOW.json` ships. Only `--url-route`
 * gets through. The switches reach the process — they are visible in
 * `/proc/<pid>/cmdline` — and are simply not consulted.
 *
 * So the request has to go to the thing that actually owns the window frame,
 * which is the compositor.
 *
 * ── Two backends, cheapest and most specific first ──────────────────────────
 *
 * | | KDE | everywhere else |
 * | --- | --- | --- |
 * | How | a KWin script over `org.kde.KWin` | `xdotool` on the host |
 * | Costs | a permission the launcher already has | a host tool that may be absent |
 * | Timing | `windowAdded`, so it fires as the window appears | a bounded sweep |
 *
 * **KWin first, on KDE, because it needs nothing new and it has no race.** The
 * script is loaded *before* the client is spawned and connects to
 * `workspace.windowAdded`, so the window is fullscreened at the moment KWin
 * takes it over rather than some number of seconds later — measured: the window
 * comes up at `0,0`, `3840×2160`, `_NET_FRAME_EXTENTS = 0, 0, 0, 0`, with no
 * decorated phase in between. `--talk-name=org.kde.KWin` is already in the
 * manifest for `pointer/systemKeyboard.ts`.
 *
 * **`xdotool` second, because the request itself is portable and the tool is
 * not.** `_NET_WM_STATE_FULLSCREEN` is EWMH and every reasonable window manager
 * honours it, including KWin for an XWayland client — which is what the KDE path
 * proves. What is not portable is having `xdotool` installed, so this backend
 * reports its own absence rather than pretending.
 *
 * It goes through `host.ts` for the reason every other command here does, and
 * one extra: on a Wayland session the launcher's Flatpak has
 * `--socket=fallback-x11`, which grants **no** X11 socket, so an X11 client
 * inside the sandbox could not connect at all. `flatpak-spawn --host` runs
 * `xdotool` in the host session, where `DISPLAY` points at the XWayland server
 * the GeForce NOW client is already a client of.
 *
 * ── Why the sweep, and why `--onlyvisible` ──────────────────────────────────
 *
 * The window does not exist when the launch returns. `flatpak run` resolves in
 * milliseconds and the client's window was measured arriving about a second
 * later, so the `xdotool` backend has to look more than once.
 *
 * `--onlyvisible` is what makes "did it work?" answerable. The client owns four
 * X11 windows of class `GeForceNOW` and three of them are unmapped helpers —
 * one is SDL's `SDLGraphicsContext` — which exist from the first second. Without
 * the flag the search matches those and exits 0 long before there is anything to
 * fullscreen, so the sweep would stop on its own false success. With it, the
 * search matches exactly one window, the real one, and exits 1 until that
 * window is mapped. Measured both ways.
 *
 * ── **Never resize the window before its page has loaded** ──────────────────
 *
 * This is the part that is not obvious and cost a released regression, so it is
 * the part to read before changing anything here.
 *
 * Fullscreening the window *the moment it appears* corrupts the client's web
 * layout for the rest of the session. The Vulkan surface follows correctly —
 * the client logs `VkDrawable: 3840x2160  SDLWindow: 3840x2160` — but the CEF
 * viewport ends up at the window size multiplied by the resize ratio a second
 * time. Measured on a 3840×2160 display against a client whose saved geometry
 * was 2559×1355:
 *
 *   viewport = 3840 × (3840/2559) by 2160 × (2160/1355) = 5762 × 3442
 *
 * Two visible consequences, both reported before the cause was found. A dialog
 * the page centres lands at 0.75 × 0.80 of the screen instead of the middle,
 * because only the top-left 3840×2160 of that 5762×3442 layout is on screen.
 * And the game streams inside black bars: the video is fitted to the *layout's*
 * aspect, 5762/3442 = 1.674, so a 16:9 stream on a 16:9 screen is pillarboxed
 * to 2160 × 1.674 = 3615 px wide. Measured, with the sums closing exactly:
 *
 *   | applied at | black bands (l/r/t/b) | picture | aspect |
 *   | --- | --- | --- | --- |
 *   | window appears | 114 / 111 / 0 / 0 | 3615×2160 | 1.6736 |
 *   | first caption  | 0 / 0 / 0 / 0     | 3840×2160 | 1.7778 |
 *   | not at all     | 0 / 0 / 0 / 0     | 3840×2160 | 1.7778 |
 *
 * The third row is the control, and it is what names the culprit: the client
 * resizing *itself* to the same 3840×2160 when a stream starts lays out
 * perfectly. It is only a resize arriving from outside, before the client is
 * ready, that it mishandles. `noBorder` is not involved — `fullScreen` alone
 * reproduces it identically.
 *
 * **So both backends wait for the window's title.** It starts empty and the
 * page sets it once it has a document, which is precisely the thing that has to
 * exist for a resize to be laid out against. KWin has the event —
 * `captionChanged`, measured 226 ms after the window is added — and X11 has the
 * property behind it. A fixed delay was deliberately not used: an event moves
 * with the machine it is running on, and a constant tuned on this one is a
 * regression waiting for a slower one.
 */

/** The name the script is loaded under, and the handle it is unloaded by. */
const KWIN_PLUGIN = 'gfnLauncherClientFullscreen'

const KWIN = 'org.kde.KWin'
const SCRIPTING_OBJECT = '/Scripting'
const SCRIPTING_IFACE = 'org.kde.kwin.Scripting'
const SCRIPT_IFACE = 'org.kde.kwin.Script'

/**
 * How often the `xdotool` backend looks for the window, and for how long.
 *
 * The deadline is generous on purpose. It bounds a sweep that is only ever
 * running between a launch and the client's first window, and the cost of it
 * being too short is the thing this module exists to prevent, whereas the cost
 * of it being too long is a handful of `xdotool` invocations against a client
 * that failed to start.
 */
const SWEEP_INTERVAL_MS = 700
const SWEEP_DEADLINE_MS = 45_000

/**
 * Which backends to try, in order, on a given desktop.
 *
 * Pure, and exported, because the alternative to asserting the order here is
 * asserting it on one machine per desktop. It is also the whole of the
 * desktop-specific decision in this module — everything below it is one backend
 * or the other doing its own job.
 *
 * KDE gets both rather than only KWin: a session with `--talk-name=org.kde.KWin`
 * revoked in Flatseal is still a session where `xdotool` would work, and
 * degrading to the portable backend is better than reporting a permission
 * problem the user did not know they had.
 */
export type FullscreenBackend = 'kwin' | 'xdotool'

export function fullscreenBackends(desktop: DesktopId): readonly FullscreenBackend[] {
  return desktop === 'kde' ? ['kwin', 'xdotool'] : ['xdotool']
}

/**
 * The KWin script, as source text.
 *
 * Pure and built from the class name rather than written out with it baked in,
 * so `present.test.ts` can assert what is about to be handed to another
 * process's script engine without a compositor to run it on.
 *
 * Four things in here are not stylistic:
 *
 * - **`resourceClass` is matched lowercased and by substring.** KWin reports
 *   this window's class as `geforcenow` where `xprop` reports `GeForceNOW`, and
 *   a future client could prefix or suffix it.
 * - **Both signal names, and both list accessors.** `windowList`/`windowAdded`
 *   are Plasma 6; `clientList`/`clientAdded` are Plasma 5. Asking for whichever
 *   exists costs one property read and covers both.
 * - **A new window is not touched until `captionChanged`.** See the note above:
 *   resizing it before its page exists corrupts the layout for the session. The
 *   caption is empty when the window is added and the page sets it as soon as it
 *   has a document, so this is the readiness signal rather than a delay, and it
 *   arrives later on a slower machine, which is the whole point. Every caption
 *   change applies, not only the first: after the first the size no longer
 *   changes, so the rest cost nothing and cover a page that titles itself twice.
 * - **A window already on the list is applied to at once**, without waiting for
 *   a caption it may never change again. `killGfn()` means this is close to
 *   unreachable, but a client that outlived it has long since laid its page out
 *   and is the one case where waiting would hang rather than help.
 */
export function buildKwinScript(wmClass: string = GFN_WM_CLASS): string {
  const match = JSON.stringify(wmClass.toLowerCase())

  return `// Generated by GFN Launcher. Loaded around a game launch and unloaded after it.
(function () {
  var MATCH = ${match};

  function apply(window) {
    window.noBorder = true;
    window.fullScreen = true;
    print("gfn-launcher: fullscreened " + window.resourceClass);
  }

  function mine(window) {
    if (!window) return false;
    return ("" + (window.resourceClass || "")).toLowerCase().indexOf(MATCH) !== -1;
  }

  function watch(window) {
    if (!mine(window)) return;
    // Never here and now: an outside resize before the page has a document
    // leaves the client laid out for a viewport it does not have.
    if (window.captionChanged && window.captionChanged.connect) {
      window.captionChanged.connect(function () { apply(window); });
    } else {
      apply(window);
    }
  }

  var list = workspace.windowList ? workspace.windowList() : workspace.clientList();
  for (var i = 0; i < list.length; i++) if (mine(list[i])) apply(list[i]);

  var added = workspace.windowAdded || workspace.clientAdded;
  if (added && added.connect) added.connect(watch);
})();
`
}

/**
 * The three `xdotool` argvs, in the order the sweep runs them.
 *
 * Pure and tested for the reason every constructed argv here is: these reach out
 * of this process and reshape somebody else's window, and the suite has to be
 * able to assert them exactly without an X server to run them against.
 *
 * **Three calls rather than one chained `search … windowstate`**, which is what
 * this was until the layout bug above was understood. The chained form fires the
 * instant the window is mapped, which is exactly too early; the title has to be
 * read in between, and `xdotool`'s own `--name` filter cannot do it. Measured:
 * `search --onlyvisible --all --class GeForceNOW --name 'GeForce NOW'` matches
 * nothing even once the title is set, because SDL writes `_NET_WM_NAME` and
 * `--name` reads the legacy `WM_NAME`. `getwindowname` prefers the modern
 * property and does see it.
 */
export function buildFindArgv(wmClass: string = GFN_WM_CLASS): string[] {
  return ['search', '--onlyvisible', '--class', wmClass]
}

/** Reads `_NET_WM_NAME`; empty until the client's page titles itself. */
export function buildWindowNameArgv(windowId: string): string[] {
  return ['getwindowname', windowId]
}

export function buildFullscreenArgv(windowId: string): string[] {
  return ['windowstate', '--add', 'FULLSCREEN', windowId]
}

/**
 * Whether a window's title says its page is up.
 *
 * Pure, and its own function because it is the whole of the readiness rule on
 * this backend — the counterpart of `captionChanged` in the KWin script — and
 * because "not empty" is a claim worth pinning: an all-whitespace title is a
 * title that has not been set.
 */
export function pageHasLoaded(windowName: string): boolean {
  return windowName.trim().length > 0
}

/**
 * One sweep at a time, module-level, the same shape as `handback.ts`'s `active`
 * and for the same reason: there is one launcher and one screen.
 */
let active: { stop: () => void } | null = null

/**
 * Which arming is allowed to leave a script loaded.
 *
 * Bumped by every arm and every disarm, captured before the load, and checked
 * after it — the `detectGfn` generation counter's argument, one interface over.
 * A load is several D-Bus round trips long and the launch that asked for it can
 * be abandoned inside that window:
 *
 *   T0  `gfn:launch` arms, and `loadScript` goes out
 *   T1  the spawn fails, so the handler disarms — there is nothing loaded yet
 *   T2  the load from T0 lands, and KWin now holds a script nobody will unload
 *
 * From T2 the compositor is fullscreening GeForce NOW windows on behalf of a
 * launch that never happened. Only the most recent arming may leave one behind,
 * which makes T2 a load followed immediately by its own undo.
 */
let generation = 0

/**
 * Idempotent, and safe when nothing is armed.
 *
 * **Unloading the KWin script matters more than cancelling the sweep**, and it
 * is why this is not gated on having loaded one. A script is a resident
 * connection to `windowAdded` *inside the compositor*: it is the only thing this
 * launcher creates that can outlive the process, and one left behind would go on
 * undecorating GeForce NOW windows — including the one `gfn:open` opens, which
 * is the one path where a window with no title bar is actively unhelpful.
 *
 * So the unload is unconditional on KDE, at the cost of one D-Bus round trip per
 * game session, and `index.ts` calls this once at start-up as well: `will-quit`
 * cannot await anything, so the last unload of a session is a request the
 * process may well exit before it answers, and clearing at start is what makes
 * that survivable rather than merely unlikely.
 */
export function disarmClientFullscreen(): void {
  generation += 1

  active?.stop()
  active = null

  if (!fullscreenBackends(DESKTOP.id).includes('kwin')) return

  void withBus(sessionBus, (invoke) =>
    invoke(KWIN, SCRIPTING_OBJECT, SCRIPTING_IFACE, 'unloadScript', 's', [KWIN_PLUGIN])
  ).then((result) => {
    // Null is `withBus` saying the bus or the service did not answer — as
    // opposed to KWin answering `false`, which is the ordinary "there was
    // nothing loaded". Worth a line, because a script that outlived its launch
    // is invisible from here and diagnosable only from the log.
    if (result === null) {
      console.warn(
        `KWin did not answer the request to unload ${KWIN_PLUGIN}; it may still be loaded.`
      )
    }
  })
}

/**
 * Arms whatever this desktop can do about the client's window, and never throws.
 *
 * Called *before* the spawn, which is the whole reason the KWin path has no
 * race, and released by the session watch's `onEnded`.
 *
 * Synchronous, like `armHandback`, because nothing downstream may wait on it:
 * the launch must not be delayed by a compositor, and on the `xdotool` path
 * there is nothing to wait *for* — the answer arrives when a window does. Every
 * outcome is a log line instead, which is the honest shape for a best effort
 * nobody is watching.
 */
export function armClientFullscreen(): void {
  disarmClientFullscreen()

  const backends = fullscreenBackends(DESKTOP.id)
  const mine = (generation += 1)
  console.info(`Client fullscreen: trying ${backends.join(' then ')} on ${DESKTOP.id}.`)

  void run(backends, mine)
}

async function run(backends: readonly FullscreenBackend[], mine: number): Promise<void> {
  for (const backend of backends) {
    if (backend === 'kwin' && (await loadKwinScript())) {
      // Abandoned while the load was in flight — see `generation`. Undoing it
      // here rather than leaving it is the whole point of the counter.
      if (generation !== mine) disarmClientFullscreen()
      return
    }

    if (backend === 'xdotool') {
      if (generation !== mine) return
      sweepWithXdotool()
      return
    }
  }
}

/**
 * Writes the script somewhere KWin can read it, then loads and runs it.
 *
 * The path is inside `userData`, which is a **host** path in every packaging:
 * `~/.config/gfn-launcher` unpackaged and
 * `~/.var/app/io.github.robertotucci.GfnLauncher/config/gfn-launcher` in the
 * Flatpak. That is not incidental — `loadScript` takes a file name and KWin
 * opens it itself, from outside the sandbox, so a path only we can see would
 * load nothing and report success doing it.
 *
 * Rewritten on every launch rather than once at start-up: it costs one small
 * atomic write on a path that is already spawning a Flatpak, and it means a
 * stale file from an older version is never what the compositor runs.
 */
async function loadKwinScript(): Promise<boolean> {
  const path = join(app.getPath('userData'), 'kwin-client-fullscreen.js')

  try {
    await writeFileAtomic(path, buildKwinScript())
  } catch (error) {
    console.warn(
      `Client fullscreen: could not write the KWin script to ${path}: ${describe(error)}. ` +
        'Falling back to xdotool.'
    )
    return false
  }

  const loaded = await withBus(sessionBus, async (invoke) => {
    // Unconditionally, and its answer ignored: `loadScript` refuses a plugin
    // name that is already registered, and a script left behind by a launcher
    // that was killed mid-session is exactly the state where this matters.
    await invoke(KWIN, SCRIPTING_OBJECT, SCRIPTING_IFACE, 'unloadScript', 's', [KWIN_PLUGIN])

    const [id] = await invoke(KWIN, SCRIPTING_OBJECT, SCRIPTING_IFACE, 'loadScript', 'ss', [
      path,
      KWIN_PLUGIN
    ])
    // KWin answers -1 for a script it would not take. Anything that is not a
    // non-negative number is not an object path we may then call `run` on.
    if (typeof id !== 'number' || id < 0) return false

    await invoke(KWIN, `${SCRIPTING_OBJECT}/Script${id}`, SCRIPT_IFACE, 'run')
    return true
  })

  if (loaded === true) {
    console.info('Client fullscreen: KWin script loaded; it will act as the window appears.')
    return true
  }

  console.warn(
    'Client fullscreen: KWin would not take the script — either KWin is not running, or the ' +
      'launcher has lost `--talk-name=org.kde.KWin` (restore it with `flatpak override --user ' +
      '--talk-name=org.kde.KWin io.github.robertotucci.GfnLauncher`). Falling back to xdotool.'
  )
  return false
}

/**
 * Asks `xdotool` for the window until there is one, or until the deadline.
 *
 * Every failure is a log line and none of them is fatal, because none of them
 * costs the user their game: a client that came up decorated is the behaviour
 * this launcher had before, and the alternative — a notice over a stream that is
 * about to start — is worse than the thing it is reporting.
 *
 * `quiet` on the exec, and it is load-bearing rather than tidy: exit 1 for "no
 * window matched yet" is this command's ordinary answer for the first several
 * seconds of every launch, and a warning per sweep would bury the one failure
 * that means something.
 */
function sweepWithXdotool(): void {
  const deadline = Date.now() + SWEEP_DEADLINE_MS

  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const stop = (): void => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    if (active?.stop === stop) active = null
  }

  active = { stop }

  const schedule = (): void => {
    if (stopped) return
    if (Date.now() >= deadline) {
      stop()
      console.warn(
        `Client fullscreen: no ready GeForce NOW window within ${SWEEP_DEADLINE_MS / 1000} s; ` +
          'giving up on making it fullscreen.'
      )
      return
    }
    timer = setTimeout(() => void sweep(), SWEEP_INTERVAL_MS)
    // Unref'd for the `displaySleep.ts` reason: a launcher on its way out must
    // never be held open by a timer whose only job is to ask a question.
    timer.unref()
  }

  /**
   * One pass: find the mapped window, check its page has loaded, fullscreen it.
   *
   * Three `xdotool` calls, and the middle one is the whole reason this is not a
   * single chained invocation — see the note at the top of the file. `quiet`
   * throughout: "no window yet" and "no title yet" are this sweep's ordinary
   * answers for the first second or so of every launch.
   */
  const sweep = async (): Promise<void> => {
    if (stopped) return

    try {
      const { stdout } = await hostExecFile('xdotool', buildFindArgv(), { quiet: true })
      const id = stdout.split('\n')[0]?.trim() ?? ''
      if (!id) return schedule()

      const { stdout: name } = await hostExecFile('xdotool', buildWindowNameArgv(id), {
        quiet: true
      })
      // Not ready. Resizing it now is the regression the file header describes,
      // so this returns and waits rather than doing something visible.
      if (!pageHasLoaded(name)) return schedule()

      await hostExecFile('xdotool', buildFullscreenArgv(id), { quiet: true })
      if (stopped) return
      stop()
      console.info(`Client fullscreen: xdotool put window ${id} fullscreen.`)
    } catch (error) {
      if (stopped) return

      // `missing` and `blocked` will not fix themselves in the next 700 ms, and
      // sweeping sixty more times against them would say the same thing sixty
      // times. A plain non-zero exit is the ordinary "not yet".
      const failure = classifyHostFailure(error)
      if (failure.kind === 'missing' || failure.kind === 'blocked') {
        stop()
        console.warn(
          failure.kind === 'missing'
            ? 'Client fullscreen: xdotool could not be run, so the GeForce NOW window keeps its ' +
                'title bar until the stream starts. Install xdotool to remove it. ' +
                failure.message
            : `Client fullscreen: xdotool could not be run. ${failure.message}`
        )
        return
      }

      schedule()
    }
  }

  void sweep()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
