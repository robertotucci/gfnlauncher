import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { GameDetails, GamepadSupport } from '@shared/types'
import { imageUrl, pickLaunchVariant, type RawApp, type RawVariant } from './wire'

/**
 * The second half of the wire→model boundary, alongside `mapApp`.
 *
 * Details live apart from `GfnGame` for one reason: the catalog snapshot is
 * structured-cloned to the renderer on every start, and this is per-title text
 * and screenshot URLs that the UI shows one game at a time. Same walk, two
 * caches — `catalog.json` stays the ~4 MB it was, `details.json` carries the
 * rest and is only read when someone opens the panel.
 */

/**
 * Screenshots per title.
 *
 * The feed offers about ten 1920×1080 shots each and their URLs alone dominate
 * the detail payload, so this used to be capped at six — enough for the row of
 * thumbnails the panel showed. Now that a thumbnail opens into a fullscreen
 * viewer the shots are the feature rather than a garnish, and taking the lot
 * costs roughly 1.5 MB on a 7.7 MB cache.
 */
const MAX_SCREENSHOTS = 10

/** Labels for the controls the feed reports, in the order they should read. */
const CONTROL_LABELS: Record<string, string> = {
  GAMEPAD: 'Gamepad',
  GAMEPAD_PARTIAL: 'Gamepad (partial)',
  KEYBOARD: 'Keyboard',
  MOUSE: 'Mouse',
  DUALSENSE_GAMEPAD: 'DualSense',
  DUALSHOCK4_GAMEPAD: 'DualShock 4',
  TOUCHSCREEN: 'Touchscreen',
  WHEEL: 'Racing wheel',
  FLIGHT_CONTROLS: 'Flight stick'
}

const SUBSCRIPTION_LABELS: Record<string, string> = {
  XBOX_GAME_PASS: 'Xbox Game Pass',
  UBISOFT_PREMIUM: 'Ubisoft+ Premium',
  UBISOFT_CLASSIC: 'Ubisoft+ Classics'
}

function label(codes: string[] | null | undefined, table: Record<string, string>): string[] {
  return (codes ?? [])
    .filter((code): code is string => Boolean(code))
    .map((code) => table[code] ?? code.replaceAll('_', ' ').toLowerCase())
}

/**
 * Reduces the control list to the single fact that decides whether a title is
 * usable from a sofa. A quarter of the catalog is keyboard-and-mouse only.
 */
export function gamepadSupport(controls: string[] | null | undefined): GamepadSupport {
  const set = new Set(controls ?? [])
  if (set.has('GAMEPAD')) return 'full'
  if (set.has('GAMEPAD_PARTIAL')) return 'partial'
  return 'none'
}

function screenshots(raw: RawApp): string[] {
  const value = raw.images?.['SCREENSHOTS']
  if (!Array.isArray(value)) return []
  return value.filter((url): url is string => typeof url === 'string').slice(0, MAX_SCREENSHOTS)
}

/**
 * Builds the detail record for one variant of a catalog entry, or null when the
 * feed carried nothing worth opening a panel for.
 *
 * Defaults to the variant `mapApp` would launch, so a tile and its panel cannot
 * disagree about which edition they describe.
 */
export function mapDetails(raw: RawApp, target?: RawVariant): GameDetails | null {
  // Same gate as `mapApp`: an entry with no tile can have no panel, and
  // indexing it would only make the cache bigger.
  if (raw.type && raw.type !== 'GAME') return null

  const variant = target ?? pickLaunchVariant(raw.variants ?? [])
  const cmsId = variant?.id != null ? String(variant.id) : null
  if (!cmsId) return null

  const description = raw.shortDescription?.trim() || null
  const shots = screenshots(raw)
  const controls = label(variant?.supportedControls, CONTROL_LABELS)
  const subscriptions = label(variant?.subscriptions, SUBSCRIPTION_LABELS)
  const releaseDate = variant?.gfn?.releaseDate ?? null
  const keyArt = imageUrl(raw, 'KEY_ART')

  // An entry with none of this is the authenticated feed, which returns no
  // detail fields at all. Storing an empty husk would make the panel render a
  // frame around nothing.
  if (!description && shots.length === 0 && controls.length === 0 && !releaseDate) {
    return null
  }

  return {
    cmsId,
    description,
    screenshots: shots,
    keyArt,
    releaseDate,
    gamepad: gamepadSupport(variant?.supportedControls),
    controls,
    subscriptions
  }
}

/**
 * Builds the whole map in one pass over a walk's items.
 *
 * **Every variant is indexed, not just the launchable one.** The two feeds pick
 * different editions: signed in, a tile's id is the variant the user owns,
 * while this index is built from the public feed, which knows no ownership and
 * settles on Steam. Keying only the launch variant would leave the 850
 * multi-store titles with a panel that silently comes up empty. Per-variant
 * records also make the controls and release date match the edition on screen.
 */
export function mapDetailsIndex(items: RawApp[]): Record<string, GameDetails> {
  const index: Record<string, GameDetails> = {}
  for (const item of items) {
    for (const variant of item.variants ?? []) {
      const details = mapDetails(item, variant)
      if (details) index[details.cmsId] = details
    }
  }
  return index
}

function detailsPath(): string {
  return join(app.getPath('userData'), 'cache', 'details.json')
}

let index: Record<string, GameDetails> | null = null
let loading: Promise<Record<string, GameDetails>> | null = null

/** Replaces the in-memory index after a refresh, and persists it. */
export async function saveDetails(next: Record<string, GameDetails>): Promise<void> {
  index = next
  const path = detailsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(next), 'utf8')
}

/**
 * Reads one title's details.
 *
 * On a cold start the index is on disk, so the first call parses the file once
 * and every later one is a map lookup. Concurrent callers share the read: the
 * panel and a second press must not each parse several megabytes.
 */
export async function getDetails(cmsId: string): Promise<GameDetails | null> {
  if (!index) {
    loading ??= (async () => {
      try {
        return JSON.parse(await readFile(detailsPath(), 'utf8')) as Record<string, GameDetails>
      } catch {
        // No cache yet, or a truncated write. Details are an enhancement; the
        // panel renders without them.
        return {}
      } finally {
        loading = null
      }
    })()
    index = await loading
  }

  return index[cmsId] ?? null
}

/** Test seam: drops the memoised index. */
export function resetDetails(): void {
  index = null
  loading = null
}
