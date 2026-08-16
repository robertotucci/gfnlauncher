import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { RECENT_LIMIT } from '@shared/types'

/**
 * Play history: which titles were last launched from the launcher.
 *
 * Its own file rather than a field on `GfnGame`, because the catalog cache is
 * rewritten wholesale on every refresh — anything hand-added to an entry there
 * is destroyed within twelve seconds of the next network walk. This one is the
 * launcher's own record and outlives the catalog entirely.
 *
 * Entries are keyed on `GfnGame.cmsId`, never on the launched variant: the two
 * differ on the ~850 multi-store titles, and only the former matches a tile.
 */

interface RecentEntry {
  cmsId: string
  /** ISO 8601. Not shown anywhere yet — kept so ordering can be re-derived. */
  playedAt: string
}

interface RecentFile {
  version: number
  entries: RecentEntry[]
}

const RECENT_FILE_VERSION = 1

function recentPath(): string {
  return join(app.getPath('userData'), 'recent.json')
}

/**
 * Puts one title at the front of the history.
 *
 * Pure, so the ordering rules are unit-testable without touching disk — the
 * same reason `buildPowerArgv` and `buildLaunchArgv` are separate from the code
 * that runs them. Replaying a title moves it up instead of duplicating it, and
 * the list is truncated from the back.
 */
export function pushRecent(
  entries: RecentEntry[],
  cmsId: string,
  playedAt: string,
  limit = RECENT_LIMIT
): RecentEntry[] {
  const withoutDuplicate = entries.filter((entry) => entry.cmsId !== cmsId)
  return [{ cmsId, playedAt }, ...withoutDuplicate].slice(0, limit)
}

let cached: RecentEntry[] | null = null
let loading: Promise<RecentEntry[]> | null = null

async function load(): Promise<RecentEntry[]> {
  if (cached) return cached

  loading ??= (async () => {
    try {
      const parsed = JSON.parse(await readFile(recentPath(), 'utf8')) as Partial<RecentFile>
      if (parsed.version !== RECENT_FILE_VERSION || !Array.isArray(parsed.entries)) return []
      // Keep only entries that still look like entries: this file is small
      // enough to hand-edit, and a bad one must cost the history, not the boot.
      return parsed.entries.filter(
        (entry): entry is RecentEntry =>
          typeof entry?.cmsId === 'string' && typeof entry?.playedAt === 'string'
      )
    } catch {
      // Nothing played yet, or a truncated write.
      return []
    } finally {
      loading = null
    }
  })()

  cached = await loading
  return cached
}

/** Records a launch. Failures are logged, never surfaced: play still happened. */
export async function recordPlay(cmsId: string, playedAt = new Date().toISOString()): Promise<void> {
  if (!cmsId) return

  cached = pushRecent(await load(), cmsId, playedAt)
  try {
    const path = recentPath()
    await mkdir(dirname(path), { recursive: true })
    const file: RecentFile = { version: RECENT_FILE_VERSION, entries: cached }
    await writeFile(path, JSON.stringify(file, null, 2), 'utf8')
  } catch (error) {
    console.warn(
      `Could not write play history: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

/** Game ids, most recently played first. */
export async function listRecent(): Promise<string[]> {
  return (await load()).map((entry) => entry.cmsId)
}

/** Test seam, mirroring `resetCatalog`. */
export function resetRecent(): void {
  cached = null
}
