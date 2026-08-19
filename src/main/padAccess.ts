import { existsSync } from 'node:fs'
import { IS_SANDBOXED, OWN_APP_ID } from './host'

/**
 * Whether Chromium can see a pad that was already connected.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * Switch the pad on during boot, let the launcher start, and nothing answers —
 * until the pad is switched off and on again, at which point it works for the
 * rest of the session. It reads as a pad fault or a driver fault. It is neither.
 *
 * `--device=all` opens /dev/input, and that is not what decides the question.
 * Chromium's Linux gamepad fetcher asks libudev for `ID_INPUT_JOYSTICK` before
 * it will treat an input device as a pad at all, and reads `ID_VENDOR_ID` and
 * `ID_BUS` for the id `scheme.ts` draws the footer legend from. udevd writes
 * those into its database under /run/udev/data — they are not in /sys, and they
 * are not on the device node. Flatpak gives the sandbox its own /run, so
 * enumeration at startup sees every input device and no properties on any of
 * them, and no pad is ever recognised.
 *
 * Hotplug is unaffected, which is the whole reason the symptom is so odd: a
 * udev monitor event arrives over netlink with the property set already
 * computed, so a pad connected *after* we start needs nothing from the
 * database. That is what switching the pad off and on again was doing.
 *
 * The fix is a permission, in flatpak/io.github.robertotucci.GfnLauncher.yml.
 * This module is what stops the fault from ever being silent again if that
 * permission is revoked — on a television the symptom is a launcher that does
 * not respond, which is the one failure nobody in the room can diagnose.
 */

/**
 * The udev database, and the thing actually probed.
 *
 * The directory rather than /run/udev itself: a sandbox can have the parent and
 * still not the database, and it is the database that carries the properties.
 */
export const UDEV_DATABASE_DIR = '/run/udev/data'

/**
 * The grant that fixes it, verbatim.
 *
 * **Must stay in step with `finish-args` in the Flatpak manifest.** This string
 * is what the launcher tells a user to type, so a drift between the two is a
 * log line that sends somebody to fix the wrong thing.
 */
export const UDEV_GRANT = '--filesystem=/run/udev:ro'

/**
 * The warning, or null when there is nothing wrong.
 *
 * Pure, and both facts are arguments, for the reason every other predicate here
 * is: the suite has no sandbox to be inside and no /run to take away.
 */
export function padEnumerationWarning(sandboxed: boolean, databaseVisible: boolean): string | null {
  // Unsandboxed the database is simply there, and the AppImage and the .deb
  // never had this problem. Nothing to say.
  if (!sandboxed || databaseVisible) return null

  return (
    `The udev database (${UDEV_DATABASE_DIR}) is not visible inside this Flatpak, so Chromium ` +
    'cannot tell which input device is a gamepad. A pad that was already switched on when the ' +
    'launcher started will not answer until it is switched off and on again, or unplugged and ' +
    'plugged back in. Grant it in Flatseal, or run: ' +
    `flatpak override --user ${UDEV_GRANT} ${OWN_APP_ID}`
  )
}

/**
 * Writes that warning if it applies. Once, at startup.
 *
 * The reads are default arguments rather than calls in the body so a test can
 * drive both branches without touching the filesystem, and so `existsSync` runs
 * when this is called rather than when the module loads.
 */
export function reportPadAccess(
  sandboxed: boolean = IS_SANDBOXED,
  databaseVisible: boolean = existsSync(UDEV_DATABASE_DIR)
): void {
  const warning = padEnumerationWarning(sandboxed, databaseVisible)
  if (warning) console.warn(warning)
}
