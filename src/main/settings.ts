import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, isLaunchMode, type Settings } from '@shared/types'
import { isAccentId, isKeyboardScaleId, isScaleId } from '@shared/theme'
import { writeFileAtomic } from './atomicFile'
import { isAutostartEnabled, setAutostart } from './autostart'

let cached: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** Keeps only known keys, so a hand-edited or stale file cannot inject junk. */
function sanitise(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const input = raw as Partial<Settings>
  return {
    autostart: typeof input.autostart === 'boolean' ? input.autostart : DEFAULT_SETTINGS.autostart,
    fullscreen:
      typeof input.fullscreen === 'boolean' ? input.fullscreen : DEFAULT_SETTINGS.fullscreen,
    // Checked against the union rather than typed as a string: this value picks
    // which of two launch paths runs, and an unrecognised one would fall
    // through to neither.
    launchMode: isLaunchMode(input.launchMode) ? input.launchMode : DEFAULT_SETTINGS.launchMode,
    // Checked against the preset list, not just typed as a string: this value
    // ends up in a CSS custom property, and an id is the only thing that
    // guarantees a hand-edited file cannot put arbitrary CSS there.
    accentColor: isAccentId(input.accentColor)
      ? input.accentColor
      : DEFAULT_SETTINGS.accentColor,
    // Same reasoning one step further: this one becomes an argument to
    // `setZoomFactor`, where an arbitrary number is an unusable window.
    uiScale: isScaleId(input.uiScale) ? input.uiScale : DEFAULT_SETTINGS.uiScale,
    // Its own guard and **not** `isScaleId`: the two preset lists share only
    // "100", so borrowing the interface one here would reject every step the
    // keyboard row can produce and pin the user at 100% for ever — saving
    // nothing, reporting nothing. `theme.test.ts` pins that they differ.
    keyboardScale: isKeyboardScaleId(input.keyboardScale)
      ? input.keyboardScale
      : DEFAULT_SETTINGS.keyboardScale,
    locale: typeof input.locale === 'string' ? input.locale : DEFAULT_SETTINGS.locale,
    gfnLinked: typeof input.gfnLinked === 'boolean' ? input.gfnLinked : DEFAULT_SETTINGS.gfnLinked,
    updateCheck:
      typeof input.updateCheck === 'boolean' ? input.updateCheck : DEFAULT_SETTINGS.updateCheck,
    // Bounded rather than merely typed. It is only ever compared for equality
    // against a version string, so nothing here can execute — but this file is
    // hand-editable, and a megabyte in one field would be carried into memory
    // and back out to disk on every write.
    dismissedUpdate:
      typeof input.dismissedUpdate === 'string' ? input.dismissedUpdate.slice(0, 64) : null,
    clientFullscreen:
      typeof input.clientFullscreen === 'boolean'
        ? input.clientFullscreen
        : DEFAULT_SETTINGS.clientFullscreen,
    pointerDesktop:
      typeof input.pointerDesktop === 'boolean'
        ? input.pointerDesktop
        : DEFAULT_SETTINGS.pointerDesktop,
    // Bounded for the same reason as `dismissedUpdate`, and a little more
    // generously: the portal decides this string's shape, not us, and it is
    // handed straight back to the portal. Anything longer than this is not a
    // token, it is a hand-edited file.
    pointerRestoreToken:
      typeof input.pointerRestoreToken === 'string'
        ? input.pointerRestoreToken.slice(0, 256)
        : null
  }
}

/**
 * Shared between concurrent first callers, the same way `loadSnapshot` and
 * `revalidateOnce` are.
 *
 * It is not merely a saved file read. `isAutostartEnabled()` below is a *host*
 * call inside a Flatpak — a round trip through the portal — and the cold start
 * has at least two callers racing for it: `createWindow`, which cannot open a
 * window until this resolves, and the `did-finish-load` handler that re-applies
 * the zoom factor. Without this they each pay for their own.
 */
let loading: Promise<Settings> | null = null

async function load(): Promise<Settings> {
  let stored: Settings
  try {
    stored = sanitise(JSON.parse(await readFile(settingsPath(), 'utf8')))
  } catch (error) {
    // ENOENT is the ordinary first start and says nothing. Anything else means
    // a file that exists and could not be read or parsed, which is the launcher
    // silently reverting every preference the user has ever set — the one
    // outcome here worth a line in the log.
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      console.warn(
        `Settings could not be read, falling back to defaults: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`
      )
    }
    stored = { ...DEFAULT_SETTINGS }
  }

  // The desktop entry is the source of truth for autostart: the user may have
  // removed it outside the launcher.
  stored.autostart = await isAutostartEnabled()
  return stored
}

export async function getSettings(): Promise<Settings> {
  if (cached) return cached

  loading ??= load().finally(() => {
    loading = null
  })
  cached = await loading
  return cached
}

/**
 * Serialises writes.
 *
 * Not a nicety — without it two settings changes in quick succession lose one
 * of them, and the launcher makes that easy: `setAutostart` is a host call that
 * takes hundreds of milliseconds inside a Flatpak, and the user can walk down
 * the Settings screen flicking rows the whole time. Both calls would read the
 * same `current`, and whichever finished last would write its own patch over
 * the other's.
 *
 * A promise chain rather than a lock, because there is nothing to fail: each
 * link reads `cached` after the previous one has replaced it.
 */
let writes: Promise<unknown> = Promise.resolve()

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const queued = writes.then(() => applyUpdate(patch))
  // The chain must not break on a failure, or every later write would be
  // rejected by a fault that has nothing to do with it.
  writes = queued.catch(() => undefined)
  return queued
}

async function applyUpdate(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const next = sanitise({ ...current, ...patch })

  if (next.autostart !== current.autostart) {
    try {
      await setAutostart(next.autostart)
      console.info(`Autostart entry ${next.autostart ? 'written' : 'removed'}`)
    } catch (error) {
      // The entry is a *host* file, so this is the one setting that can fail
      // for a reason outside this process: a sandbox with the host permission
      // revoked cannot write it. Recording the request anyway would leave the
      // toggle claiming something the session does not agree with — and
      // `getSettings` re-reads the entry on the next start, so the lie would
      // not even survive a restart.
      next.autostart = current.autostart
      console.error(
        `Autostart could not be ${patch.autostart ? 'enabled' : 'disabled'}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`
      )
    }
  }

  cached = next

  try {
    await writeFileAtomic(settingsPath(), JSON.stringify(next, null, 2))
  } catch (error) {
    // **Deliberately not rethrown.** A rejected `settings:update` crosses the
    // bridge as a rejected promise — the one result shape the renderer does not
    // model — and the user would see a control that does nothing at all. The
    // change is already in `cached`, so it holds for this session and simply
    // does not survive a restart, which is a far better failure than a dead
    // toggle. The log is where it stops being invisible.
    console.error(
      `Settings could not be saved to ${settingsPath()}: ` +
        `${error instanceof Error ? error.message : 'unknown error'}. ` +
        'The change applies to this session only.'
    )
  }

  return next
}

/** Test seam, mirroring `resetCatalog`. */
export function resetSettings(): void {
  cached = null
  loading = null
  writes = Promise.resolve()
}
