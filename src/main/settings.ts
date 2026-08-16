import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, isLaunchMode, type Settings } from '@shared/types'
import { isAccentId, isScaleId } from '@shared/theme'
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
    hideOnLaunch:
      typeof input.hideOnLaunch === 'boolean' ? input.hideOnLaunch : DEFAULT_SETTINGS.hideOnLaunch,
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
    locale: typeof input.locale === 'string' ? input.locale : DEFAULT_SETTINGS.locale,
    gfnLinked: typeof input.gfnLinked === 'boolean' ? input.gfnLinked : DEFAULT_SETTINGS.gfnLinked
  }
}

export async function getSettings(): Promise<Settings> {
  if (cached) return cached

  let stored: Settings
  try {
    stored = sanitise(JSON.parse(await readFile(settingsPath(), 'utf8')))
  } catch {
    stored = { ...DEFAULT_SETTINGS }
  }

  // The desktop entry is the source of truth for autostart: the user may have
  // removed it outside the launcher.
  stored.autostart = await isAutostartEnabled()

  cached = stored
  return cached
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const next = sanitise({ ...current, ...patch })

  if (next.autostart !== current.autostart) {
    await setAutostart(next.autostart)
  }

  cached = next
  const path = settingsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
  return next
}
