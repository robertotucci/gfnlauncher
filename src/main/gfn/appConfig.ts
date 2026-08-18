import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectGfn } from './flatpak'

/**
 * Reads the GFN client's own runtime configuration off the installed Flatpak.
 *
 * The web app the client hosts ships its `appConfig` as a plain JSON file, so
 * hosts the launcher would otherwise have to guess at can simply be read from
 * the same place the real client reads them:
 *
 *   <installPath>/files/mall/shared/assets/config/config.json
 *
 * This is how the ALS base URL stops being a hardcoded constant — which it must
 * not be, since a proxy override can replace it — without needing to intercept
 * a request that only happens when the user opens GFN's own settings.
 *
 * Everything here degrades: an install that is missing, moved, or has reshaped
 * its bundle yields the fallback rather than an error, because a launcher that
 * cannot read one URL should still start.
 */

/** Path of the web bundle's config, relative to the Flatpak install root. */
const CONFIG_RELATIVE_PATH = join('files', 'mall', 'shared', 'assets', 'config', 'config.json')

/**
 * What `accountLinking.server` read on client 2.0.87.130.
 *
 * Only used when the file cannot be read at all. Kept as a last resort rather
 * than a default so the configured value always wins.
 */
export const ALS_FALLBACK_URL = 'https://als.geforcenow.com'

/**
 * Pulls `accountLinking.server` out of a parsed config.
 *
 * Pure and tolerant: this is a third-party file that can change shape between
 * client releases, and a wrong guess must return null rather than hand a
 * non-URL to `fetch`.
 */
export function parseAlsServerUrl(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const linking = (raw as { accountLinking?: unknown }).accountLinking
  if (typeof linking !== 'object' || linking === null) return null
  const server = (linking as { server?: unknown }).server
  if (typeof server !== 'string') return null
  return /^https?:\/\/\S+$/.test(server.trim()) ? server.trim() : null
}

let cached: string | null = null

/**
 * Base URL of the Account Linking Service, from the installed client.
 *
 * Memoised, but **only a successful read** — and that distinction is the bug it
 * was written to fix. The install path this reads under is a commit directory
 * that an update prunes (see `probeGfn`), so a client updating mid-run turns
 * one lookup into an ENOENT. Caching the fallback on that would lose a
 * proxy-overridden ALS host for the rest of the run, silently, and every
 * library sync afterwards would talk to the wrong service. Recomputing the
 * fallback costs a `flatpak info` and a failed `open` on a path that is about
 * to be corrected by `clientWatch.ts` anyway.
 */
export async function readAlsServerUrl(): Promise<string> {
  if (cached) return cached

  const { installPath } = await detectGfn()
  if (installPath) {
    try {
      const raw = await readFile(join(installPath, CONFIG_RELATIVE_PATH), 'utf8')
      const server = parseAlsServerUrl(JSON.parse(raw))
      if (server) {
        cached = server
        return cached
      }
      console.warn('GFN appConfig has no accountLinking.server; falling back')
    } catch (error) {
      console.warn(
        `Could not read GFN appConfig: ${error instanceof Error ? error.message : 'unknown error'}`
      )
    }
  }

  return ALS_FALLBACK_URL
}

/**
 * Test seam, mirroring `resetCatalog` — and what `clientWatch.ts` calls when
 * the client's deploy moves, since the file this read came out of has been
 * replaced by then. Belt and braces rather than load-bearing: only a successful
 * read is cached, so the worst a missed call costs is a URL from the previous
 * install of the same client.
 */
export function resetAppConfig(): void {
  cached = null
}
