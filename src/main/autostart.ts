import { mkdir, writeFile, rm, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { FLATPAK_ID, IS_SANDBOXED } from './host'

/**
 * Autostart via the XDG spec (~/.config/autostart), rather than Electron's
 * setLoginItemSettings — on Linux that API is a thin and inconsistent wrapper,
 * and a plain .desktop file is inspectable and fixable by hand if it misbehaves.
 *
 * Three things about the entry vary with how the launcher was installed, and all
 * three are silent when wrong: the file is written, nothing complains, and the
 * launcher simply does not come up with the session.
 */

const ENTRY_NAME = 'gfn-launcher.desktop'

/**
 * Where the session actually reads autostart entries from.
 *
 * **`XDG_CONFIG_HOME` is the wrong answer inside a Flatpak.** The runtime points
 * it at `~/.var/app/<id>/config`, which is ours alone and which nothing at login
 * ever reads — so honouring it would write a file that works nowhere. The real
 * `~/.config/autostart` is bind-mounted at its true path by
 * `--filesystem=xdg-config/autostart:create`, so the literal path is the
 * portable one here and the environment variable is the trap.
 *
 * Outside a sandbox `XDG_CONFIG_HOME` still wins, because there it means what it
 * says.
 */
function autostartDir(): string {
  const configHome = IS_SANDBOXED
    ? join(homedir(), '.config')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'autostart')
}

function entryPath(): string {
  return join(autostartDir(), ENTRY_NAME)
}

/**
 * Command the autostart entry should run.
 *
 * Neither packaged form can use the path of the running executable:
 *
 * - Inside a Flatpak that path is `/app/...`, which exists only within the
 *   sandbox. The session has to be told to start the *app*, not the binary.
 * - Inside an AppImage the mounted exe path is temporary, so `APPIMAGE` — the
 *   path of the image itself — is the only stable target.
 */
function execCommand(): string {
  if (FLATPAK_ID) return `flatpak run ${FLATPAK_ID}`

  const appImage = process.env.APPIMAGE
  if (appImage) return appImage

  return app.getPath('exe')
}

/**
 * Icon name, not a path.
 *
 * An absolute path is wrong for both packaged forms for the same reason
 * `execCommand` cannot use one. As a theme name it resolves against whatever the
 * install put into hicolor: the .deb installs `gfn-launcher`, a Flatpak installs
 * its icons under the app id. Unintegrated, it degrades to the desktop's
 * generic icon rather than to a broken one.
 */
function iconName(): string {
  return FLATPAK_ID ?? 'gfn-launcher'
}

/**
 * Pure, so the three installation shapes are assertable without writing to
 * anyone's home directory — the same reason `buildPowerArgv` and
 * `buildLaunchArgv` are pure. This one writes a file that runs at every login,
 * which is a good argument for being able to read it in a test.
 */
export function buildDesktopEntry({
  exec,
  icon,
  flatpakId
}: {
  exec: string
  icon: string
  flatpakId?: string | null
}): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=GFN Launcher',
    'Comment=Gamepad-driven couch launcher for NVIDIA GeForce NOW',
    `Exec=${exec}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Game;Network;',
    'X-GNOME-Autostart-enabled=true',
    // Convention rather than requirement: it tells anyone reading the file by
    // hand which Flatpak put it there, and desktop tooling uses it to tie the
    // entry back to an installed app.
    ...(flatpakId ? [`X-Flatpak=${flatpakId}`] : []),
    ''
  ].join('\n')
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

  const contents = buildDesktopEntry({
    exec: execCommand(),
    icon: iconName(),
    flatpakId: FLATPAK_ID
  })

  await mkdir(autostartDir(), { recursive: true })
  await writeFile(entryPath(), contents, 'utf8')
}
