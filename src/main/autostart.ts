import { mkdir, writeFile, rm, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Autostart via the XDG spec (~/.config/autostart), rather than Electron's
 * setLoginItemSettings — on Linux that API is a thin and inconsistent wrapper,
 * and a plain .desktop file is inspectable and fixable by hand if it misbehaves.
 */

const ENTRY_NAME = 'gfn-launcher.desktop'

function autostartDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'autostart')
}

function entryPath(): string {
  return join(autostartDir(), ENTRY_NAME)
}

/**
 * Command the autostart entry should run. Inside an AppImage the mounted exe
 * path is temporary, so APPIMAGE (the path of the image itself) is the only
 * stable target.
 */
function execCommand(): string {
  const appImage = process.env.APPIMAGE
  if (appImage) return appImage
  return app.getPath('exe')
}

export async function isAutostartEnabled(): Promise<boolean> {
  try {
    await access(entryPath())
    return true
  } catch {
    return false
  }
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (!enabled) {
    await rm(entryPath(), { force: true })
    return
  }

  const contents = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=GFN Launcher',
    'Comment=Gamepad-driven couch launcher for NVIDIA GeForce NOW',
    `Exec=${execCommand()}`,
    // A theme name, not a path: the deb installs resources/icon.png into
    // hicolor as `gfn-launcher`, and an absolute path would be wrong for the
    // AppImage for the same reason Exec cannot use one — the mount is temporary.
    // Unintegrated, it degrades to the desktop's generic icon.
    'Icon=gfn-launcher',
    'Terminal=false',
    'Categories=Game;Network;',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')

  await mkdir(autostartDir(), { recursive: true })
  await writeFile(entryPath(), contents, 'utf8')
}
