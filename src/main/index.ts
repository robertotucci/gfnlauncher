import { join } from 'node:path'
import { app, shell, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icons/512x512.png?asset'
import { armClientWatch, disarmClientWatch } from './clientWatch'
import { disarmHandback } from './gfn/handback'
import { FLATPAK_ID, IS_SANDBOXED } from './host'
import { registerIpcHandlers } from './ipc'
import { initLogging, writeLogLine } from './log'
import { reportPadAccess } from './padAccess'
import { armPointerMode, disarmPointerMode } from './pointer'
import { getSettings, updateSettings } from './settings'
import { attachScreenReporting } from './screen'
import { applyUiScale } from './uiScale'
import { holdFullscreen, logFocusChanges, restoreLauncher } from './window'

/**
 * Opened before anything else can fail.
 *
 * The failures worth having a log for include the ones that stop the window
 * from ever appearing, so this cannot wait for `app.whenReady()` — and it does
 * not need to: `app.getPath('userData')` is resolved from the application name
 * and is available from the first line of the process.
 */
const LOG_PATH = initLogging()

/**
 * How many times a dead renderer is brought back before the launcher gives up.
 *
 * There is a reload at all because the alternative on a television is a black
 * rectangle with no way to act on it — no menu bar, no keyboard, and a gamepad
 * that talks to a renderer which no longer exists. It is bounded because a
 * renderer that dies on every paint would otherwise loop forever, and a visible
 * crashed tab is at least a state somebody can photograph.
 */
const MAX_RENDERER_RELOADS = 3

let mainWindow: BrowserWindow | null = null
let rendererReloads = 0

// A second instance would steal focus and, with it, gamepad input from the
// first. Autostart plus a manual launch makes that a realistic scenario.
//
// Everything below the lock lives inside `start()` rather than at module scope,
// and that is not tidiness. `app.quit()` before `ready` schedules a quit; it
// does not stop the rest of this module from running, so the losing instance
// used to go on and register a `whenReady` handler that could still build a
// window and take the screen from the instance it was meant to defer to.
if (!app.requestSingleInstanceLock()) {
  console.info('Another instance already holds the lock; handing the screen to it and quitting.')
  app.quit()
} else {
  start()
}

function start(): void {
  announceStartup()

  // Re-launching is how you come back from "Back to desktop": the pad cannot
  // raise a blurred window, so a second launch is the gesture. `restoreLauncher`
  // owns the sequence — including re-reading fullscreen from settings, without
  // which a window restored from the taskbar comes back at 1600x900 and the
  // launcher is a desktop app from then on.
  app.on('second-instance', () => {
    console.info('Second instance asked us to come to the front.')
    void restoreLauncher(mainWindow)
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('io.github.robertotucci.GfnLauncher')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIpcHandlers(() => mainWindow)

    // Before the window, not after: the GeForce NOW client can update while the
    // first load is still going, and a change missed then is one nothing else
    // would notice. The thunk is why that works — it pushes to whichever window
    // exists by the time it has something to say.
    armClientWatch(() => mainWindow)

    // The pad reader behind the desktop cursor. Armed here for the same reason
    // as the client watch: it has to be listening before the window exists,
    // because the case it serves most is a launcher that is *not* the thing on
    // screen — minimised behind a desktop, or behind a running game.
    const settings = await getSettings()
    armPointerMode(
      () => mainWindow,
      settings,
      (pointerRestoreToken) => {
        // Fire and forget: the token only saves the user a permission dialog
        // next time, and a failed write must not take down a session that is
        // already granted and working.
        void updateSettings({ pointerRestoreToken }).catch((error: unknown) => {
          console.warn('Could not persist the desktop-pointer permission token:', error)
        })
      }
    )

    await createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  }, failedToStart)

  // Two watches hold stat watchers and timers between them — the session one,
  // for the length of a game, and the client one, for the length of the run.
  // Everything in both is already `persistent: false` or unref'd, so this is
  // belt to that braces — but it is also what stops a probe resolving into a
  // window that is being torn down.
  app.on('will-quit', () => {
    console.info('Launcher quitting.')
    disarmHandback()
    disarmClientWatch()
    // Holds open joystick devices and, while a cursor is up, a portal session
    // with a virtual pointer the compositor is keeping alive on our behalf.
    // Both have to go back explicitly; the second one especially, because a
    // stray virtual pointer outliving the launcher is not our bug to notice.
    disarmPointerMode()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  // The GPU process going is the other way this ends up as a black screen, and
  // unlike the renderer there is nothing useful to do about it — Chromium
  // restarts its own. Recording it is the point: "the picture went" and "the
  // GPU process was killed by the OOM killer" are the same symptom.
  app.on('child-process-gone', (_event, details) => {
    console.error(
      `Child process gone: type=${details.type} reason=${details.reason} ` +
        `exitCode=${details.exitCode}${details.name ? ` name=${details.name}` : ''}`
    )
  })
}

/**
 * The first lines of every session, and the ones a bug report is read against.
 *
 * Which install form, which session type and whether the sandbox is in play
 * decide the behaviour of nearly everything that can go wrong here — the update
 * path, `hostCommand`, whether `focus()` is a request or an instruction — so
 * they are written down once rather than inferred from the failure.
 */
function announceStartup(): void {
  console.info(
    `GFN Launcher ${app.getVersion()} starting — ` +
      `packaged=${app.isPackaged} sandboxed=${IS_SANDBOXED} ` +
      `flatpakId=${FLATPAK_ID ?? 'none'} appImage=${process.env.APPIMAGE ? 'yes' : 'no'}`
  )
  console.info(
    `Session: type=${process.env.XDG_SESSION_TYPE ?? 'unknown'} ` +
      `desktop=${process.env.XDG_CURRENT_DESKTOP ?? 'unknown'} ` +
      `wayland=${process.env.WAYLAND_DISPLAY ? 'yes' : 'no'} ` +
      `electron=${process.versions.electron} chrome=${process.versions.chrome} ` +
      `node=${process.versions.node}`
  )
  console.info(`Logging to ${LOG_PATH}`)

  // Beside them, and only when there is something to say: a sandbox that cannot
  // read the udev database answers no pad that was connected before it started,
  // and the symptom — a launcher that ignores the controller — looks like every
  // other way this application can fail. See `padAccess.ts`.
  reportPadAccess()
}

/**
 * The launcher could not start at all.
 *
 * There is nowhere to put this on screen — the whole point is that there is no
 * screen — so it goes to the log and to whatever stdout exists, and the process
 * ends rather than lingering as an invisible, input-less thing in the process
 * table.
 */
function failedToStart(error: unknown): void {
  console.error('The launcher could not start:', error)
  app.exit(1)
}

async function createWindow(): Promise<void> {
  const settings = await getSettings()

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    fullscreen: settings.fullscreen,
    autoHideMenuBar: true,
    // Linux only reads this off the window itself — there is no bundle to infer
    // it from, and unpackaged (i.e. `npm run dev`) there is no .desktop entry
    // either, so without it the launcher is a generic Electron diamond in the
    // switcher. Under Wayland the compositor prefers the app_id → .desktop match
    // instead, which the deb and the AppImage supply; this is the fallback that
    // covers X11 and every unpackaged run.
    icon,
    // Matches the app background so an autostarted launcher never flashes white
    // on a dark TV.
    backgroundColor: '#08090c',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  watchRenderer(mainWindow)

  // Through `restoreLauncher` rather than a bare `show()` + `focus()`: at the
  // start of a desktop session this is the launcher's one chance to take the
  // screen, and on Wayland `focus()` alone is a request the compositor is free
  // to decline. The other half of that fix is not code — it is `StartupNotify`
  // in the autostart entry, which is what makes the session hand us an
  // activation token in the first place. See `autostart.ts`.
  mainWindow.on('ready-to-show', () => {
    void restoreLauncher(mainWindow)
  })

  // Registered before anything can minimise the window. `stepAside` leaves
  // fullscreen on the way out, and the way back in is not always ours — a click
  // in the taskbar never reaches this process, and used to leave the launcher
  // windowed with no gamepad-reachable way out of it.
  holdFullscreen(mainWindow)

  // Beside it, and for the same class of reason: things the launcher has to
  // notice about its own window whether or not this process asked for them.
  // What the renderer does with it is refuse to answer the pad while somebody
  // else has the screen — see `screen.ts`.
  attachScreenReporting(mainWindow)

  // Two independent readings of the same fact. The renderer logs what its own
  // `blur` listener saw; this logs what Chromium's window activation did. When
  // a report says "the launcher acted on input it should not have", the pair is
  // what says whether the focus signal was wrong or the gate was.
  logFocusChanges(mainWindow)

  // Re-applied on every load, not just the first: a reload resets the zoom
  // factor, and in dev every HMR full-reload would otherwise drop the user
  // back to 100% with nothing in the UI to explain it.
  mainWindow.webContents.on('did-finish-load', () => {
    void getSettings()
      .then((current) => applyUiScale(mainWindow, current.uiScale))
      .catch((error: unknown) => console.warn('Interface scale could not be applied:', error))
  })

  // Nothing in this UI should ever open a browser window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

/**
 * Everything the renderer can do to fail without saying so.
 *
 * All four of these present identically from three metres — a launcher that
 * does not answer the pad — and none of them reaches `LaunchNotice` or any
 * other on-screen surface, because the thing that would draw it is the thing
 * that broke. The log is the only place they can be told apart.
 */
function watchRenderer(window: BrowserWindow): void {
  const { webContents } = window

  // The renderer's own `console`, teed into the same file as the main
  // process's. This is what carries a React error boundary's report, an
  // unhandled rejection in a click handler, and every `console.error` already
  // written in `App.tsx` — none of which had anywhere to go before.
  //
  // Off `console-message` rather than a channel on the bridge: the preload
  // surface is an explicit allow-list of methods on purpose, and a diagnostic
  // is not a good enough reason to widen it. This also catches messages from
  // before the bridge exists, which is precisely when a preload fault shows up.
  webContents.on('console-message', (details) => {
    // Chromium's own verbose chatter, which would bury the rest.
    if (details.level === 'debug') return
    const level = details.level === 'warning' ? 'warn' : details.level
    const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''
    writeLogLine(level, 'gui', `${details.message}${where}`)
  })

  webContents.on('preload-error', (_event, preloadPath, error) => {
    // `window.launcher` is undefined after this, so every screen throws on its
    // first call. Worth its own line: the symptom is "nothing works" and the
    // cause is one file.
    console.error(`Preload script failed (${preloadPath}):`, error)
  })

  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Renderer failed to load ${validatedURL}: ${errorDescription} (${errorCode})`)
  })

  webContents.on('unresponsive', () => console.warn('Renderer stopped responding.'))
  webContents.on('responsive', () => console.info('Renderer is responding again.'))

  webContents.on('render-process-gone', (_event, details) => {
    console.error(`Renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)

    // A clean exit is the window being closed, which is not a fault and must
    // not be undone by a reload.
    if (details.reason === 'clean-exit' || window.isDestroyed()) return

    if (rendererReloads >= MAX_RENDERER_RELOADS) {
      console.error(
        `Renderer has gone ${rendererReloads} times; leaving the crashed view up rather than ` +
          'looping. Restart the launcher, and attach the log.'
      )
      return
    }

    rendererReloads += 1
    console.warn(`Reloading the renderer (attempt ${rendererReloads}/${MAX_RENDERER_RELOADS}).`)
    webContents.reload()
  })
}
