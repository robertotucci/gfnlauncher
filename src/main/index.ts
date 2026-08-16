import { join } from 'node:path'
import { app, shell, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icons/512x512.png?asset'
import { registerIpcHandlers } from './ipc'
import { getSettings } from './settings'
import { applyUiScale } from './uiScale'

let mainWindow: BrowserWindow | null = null

// A second instance would steal focus and, with it, gamepad input from the
// first. Autostart plus a manual launch makes that a realistic scenario.
if (!app.requestSingleInstanceLock()) {
  app.quit()
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

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  // Re-applied on every load, not just the first: a reload resets the zoom
  // factor, and in dev every HMR full-reload would otherwise drop the user
  // back to 100% with nothing in the UI to explain it.
  mainWindow.webContents.on('did-finish-load', () => {
    void getSettings().then((current) => applyUiScale(mainWindow, current.uiScale))
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

// Re-launching is also how you come back from "Back to desktop": the pad cannot
// raise a blurred window, so a second launch is the gesture, and the settings
// are re-read because a window restored from the taskbar comes back at 1600x900
// otherwise — the launcher would be a desktop app from then on.
app.on('second-instance', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if ((await getSettings()).fullscreen) mainWindow.setFullScreen(true)
  mainWindow.focus()
})

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('io.github.robertotucci.GfnLauncher')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers(() => mainWindow)
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
