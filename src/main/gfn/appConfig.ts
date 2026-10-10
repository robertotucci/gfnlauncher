import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_CLIENT_CONFIG,
  STREAM_MODES,
  type ClientConfig,
  type StreamMode
} from '@shared/clientSettings'
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
 * This is how the ALS and MES base URLs stop being hardcoded constants — which
 * they must not be, since a proxy override can replace them — without needing
 * to intercept a request that only happens when the user opens GFN's own
 * settings. It is also where the client decides which streaming modes it
 * offers, which the launcher's streaming page has to agree with.
 *
 * One read, memoised, and a pure extractor per question, so `resetAppConfig`
 * clears one thing and every extractor is testable without an install.
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

/** What `nes.*` read on client 2.0.89.141, for the same last-resort reason. */
export const NES_FALLBACK = {
  server: 'https://mes.geforcenow.com',
  version: 'v4',
  serviceName: 'gfn_pc'
} as const

export interface NesConfig {
  server: string
  version: string
  serviceName: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^https?:\/\/\S+$/.test(value.trim()) ? value.trim() : null
}

/**
 * Pulls `accountLinking.server` out of a parsed config.
 *
 * Pure and tolerant: this is a third-party file that can change shape between
 * client releases, and a wrong guess must return null rather than hand a
 * non-URL to `fetch`.
 */
export function parseAlsServerUrl(raw: unknown): string | null {
  return asUrl(asRecord(asRecord(raw)?.accountLinking)?.server)
}

/**
 * The membership service's base, version and service name (`nes.*`).
 *
 * Field by field, each falling back on its own: a config that moved the
 * version but kept the host is still worth reading.
 */
export function parseNesConfig(raw: unknown): NesConfig {
  const nes = asRecord(asRecord(raw)?.nes)
  const word = (value: unknown, fallback: string): string =>
    typeof value === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(value) ? value : fallback
  return {
    server: asUrl(nes?.server) ?? NES_FALLBACK.server,
    version: word(nes?.version, NES_FALLBACK.version),
    serviceName: word(nes?.serviceName, NES_FALLBACK.serviceName)
  }
}

/**
 * `lcars.clientId` — what the client sends as `NV-Client-ID` to NVIDIA's
 * services when it is speaking as itself rather than as a browser (its header
 * service's `getClientIdHeaderValue`). Null when unreadable; the request then
 * goes without it.
 */
export function parseLcarsClientId(raw: unknown): string | null {
  const id = asRecord(asRecord(raw)?.lcars)?.clientId
  return typeof id === 'string' && /^[0-9a-f-]{8,64}$/i.test(id) ? id : null
}

/**
 * The `client.*` keys that change what the streaming page offers.
 *
 * On Linux the client merges `linuxOSConfig` over the base before reading
 * anything (its `AppConfigService`, `case Linux: N(this.get().linuxOSConfig)`),
 * so this does too — that is how SteamOS loses Competitive, and how a future
 * Linux override would reach here without a code change.
 */
export function parseStreamingClientConfig(raw: unknown): ClientConfig {
  const root = asRecord(raw)
  const base = asRecord(root?.client) ?? {}
  const linux = asRecord(asRecord(root?.linuxOSConfig)?.client) ?? {}
  const client = { ...base, ...linux }

  const profiles = asRecord(client.supportedStreamingProfiles)
  const supported: Partial<Record<StreamMode, boolean>> | null = profiles
    ? Object.fromEntries(
        STREAM_MODES.filter((mode) => typeof profiles[mode] === 'boolean').map((mode) => [
          mode,
          profiles[mode] as boolean
        ])
      )
    : null

  return {
    supportedStreamingProfiles: supported,
    displayAllDynamicStreamingModes:
      typeof client.displayAllDynamicStreamingModes === 'boolean'
        ? client.displayAllDynamicStreamingModes
        : DEFAULT_CLIENT_CONFIG.displayAllDynamicStreamingModes,
    resolutionBadges: parseResolutionBadges(client.streamingModeResolutionsConfiguration)
  }
}

/**
 * `resolutionBadges` is a map of named groups, each with a badge and the
 * resolutions it applies to — `{ uhd: { badgeText: '4K', resolutions: [...] } }`.
 * Flattened to one entry per resolution, which is the question a chip asks.
 */
export function parseResolutionBadges(raw: unknown): ClientConfig['resolutionBadges'] {
  const groups = asRecord(asRecord(raw)?.resolutionBadges)
  if (!groups) return []
  const out: { width: number; height: number; badge: string }[] = []
  for (const group of Object.values(groups)) {
    const g = asRecord(group)
    const badge = g?.badgeText
    if (typeof badge !== 'string' || badge.length === 0 || badge.length > 16) continue
    for (const entry of Array.isArray(g?.resolutions) ? g.resolutions : []) {
      const r = asRecord(entry)
      if (typeof r?.width === 'number' && typeof r.height === 'number') {
        out.push({ width: r.width, height: r.height, badge })
      }
    }
  }
  return out
}

/** The parsed file, or null when it could not be read. */
let cached: unknown = undefined

/**
 * The parsed `config.json` of the installed client.
 *
 * Memoised, but **only a successful read** — and that distinction is the bug it
 * was written to fix. The install path this reads under is a commit directory
 * that an update prunes (see `probeGfn`), so a client updating mid-run turns
 * one lookup into an ENOENT. Caching a failure on that would lose a
 * proxy-overridden host for the rest of the run, silently, and every request
 * afterwards would talk to the wrong service. Recomputing costs a `flatpak
 * info` and a failed `open` on a path that is about to be corrected by
 * `clientWatch.ts` anyway.
 */
async function readConfig(): Promise<unknown> {
  if (cached !== undefined) return cached

  const { installPath } = await detectGfn()
  if (!installPath) return null
  try {
    cached = JSON.parse(await readFile(join(installPath, CONFIG_RELATIVE_PATH), 'utf8')) as unknown
    return cached
  } catch (error) {
    console.warn(
      `Could not read GFN appConfig: ${error instanceof Error ? error.message : 'unknown error'}`
    )
    return null
  }
}

/** Base URL of the Account Linking Service, from the installed client. */
export async function readAlsServerUrl(): Promise<string> {
  const config = await readConfig()
  const server = parseAlsServerUrl(config)
  if (!server && config) console.warn('GFN appConfig has no accountLinking.server; falling back')
  return server ?? ALS_FALLBACK_URL
}

/** Where the membership service is, and what this client calls itself to it. */
export async function readNesConfig(): Promise<NesConfig & { clientId: string | null }> {
  const config = await readConfig()
  return { ...parseNesConfig(config), clientId: parseLcarsClientId(config) }
}

/** What the installed client offers on its streaming page. */
export async function readStreamingClientConfig(): Promise<ClientConfig> {
  return parseStreamingClientConfig(await readConfig())
}

/**
 * Test seam, mirroring `resetCatalog` — and what `clientWatch.ts` calls when
 * the client's deploy moves, since the file this read came out of has been
 * replaced by then. Belt and braces rather than load-bearing: only a successful
 * read is cached, so the worst a missed call costs is a value from the previous
 * install of the same client.
 */
export function resetAppConfig(): void {
  cached = undefined
}
