import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  DLSS_FG_MULTIPLIERS,
  FALLBACK_BITRATE,
  isHdrMode,
  type EntitledResolution,
  type HdrMode,
  type PresetMode,
  type PresetValues,
  type PrefilterMode,
  type StreamEntitlements
} from '@shared/clientSettings'
import { writeFileAtomic } from '../atomicFile'
import { readNesConfig, type NesConfig } from './appConfig'
import { detectGfn } from './flatpak'
import type { GfnGraphQLConfig } from './graphql'
import { getAuthSession } from './partition'
import { getIdToken, withIdToken } from './session'

/**
 * What the account's GeForce NOW membership allows — the resolutions and frame
 * rates, the bit-rate range, HDR, Reflex, VRR, L4S, colour depth, DLSS — from
 * NVIDIA's membership service (MES), the same answer the client builds its
 * Settings page from.
 *
 * ── Why the launcher has to ask ─────────────────────────────────────────────
 *
 * None of it is in the client's bundle or on disk; it is server data, and it
 * matters: the client deletes a custom profile at launch if it asks for
 * anything outside it (`isCustomDataInSubscription`). So the streaming page
 * offers exactly this list, and `applyChange` refuses anything else.
 *
 * ── The request ─────────────────────────────────────────────────────────────
 *
 *   GET {nes.server}/{nes.version}/subscriptions?serviceName=gfn_pc&languageCode=<locale>&vpcId=<vpcId>
 *   Authorization: GFNJWT <Starfleet id token>
 *
 * `nes.*` comes from the client's `config.json` (`appConfig.ts`); the token is
 * the one `webAuth.ts` already reads for ALS — the client's MES SDK and its ALS
 * client both get theirs from `IdmService.getAuthToken`. No `userId`: measured,
 * MES answers 200 without one.
 *
 * **The client-type headers decide the answer, and the capture's are wrong.**
 * The launcher's session comes from the hosted *web* player, and replayed as-is
 * its `NV-Client-Type: BROWSER` headers get the browser's membership: 1920×1200
 * at 60 fps, 75 Mbps, no Reflex — for an Ultimate account whose native client
 * offers 5K at 120 and 1080p at 360. So the `NV-*` headers are rebuilt as the
 * native client sends them on Linux (`NATIVE`, `NVIDIA-CLASSIC`, `LINUX`,
 * `DESKTOP`, its `lcars.clientId` and version — the client's header service,
 * `getCommonHeaders`, on the non-browser branch). docs/gfn-api.md has both
 * answers side by side.
 *
 * ── What is kept ────────────────────────────────────────────────────────────
 *
 * The answer also carries the subscription id, renewal dates, remaining play
 * time and the product URI. `parseEntitlements` keeps the entitlements and the
 * tier name and nothing else; `membership.test.ts` asserts its key set the way
 * `zone.test.ts` does. That narrow result is what is cached to disk — it says
 * what the membership allows, not whose it is.
 */

/** Read like every other bump of this kind: a cache from an older shape is dropped. */
export const ENTITLEMENTS_CACHE_VERSION = 1

/** How long one answer is used before the page asks again. Memberships change rarely. */
const MEMO_MS = 10 * 60_000

/**
 * The one other `fetch` with a timeout, and for the same reason as Status's
 * `REQUEST_TIMEOUT_MS`: this runs behind a button on a screen with no keyboard,
 * and a request that never finishes is a spinner nobody can explain.
 */
const REQUEST_TIMEOUT_MS = 8_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

interface Feature {
  key: string
  textValue?: string
  setValue?: string[]
}

function readFeatures(raw: unknown): Feature[] {
  if (!Array.isArray(raw)) return []
  const out: Feature[] = []
  for (const entry of raw) {
    const r = asRecord(entry)
    if (typeof r?.key !== 'string') continue
    out.push({
      key: r.key,
      textValue: typeof r.textValue === 'string' ? r.textValue : undefined,
      setValue: Array.isArray(r.setValue)
        ? r.setValue.filter((v): v is string => typeof v === 'string')
        : undefined
    })
  }
  return out
}

/** The client's `featureEntitled`: a JSON `true`, or a non-empty JSON array. */
function entitled(features: Feature[], key: string): boolean {
  const text = features.find((f) => f.key === key)?.textValue
  if (text === undefined) return false
  try {
    const value = JSON.parse(text) as unknown
    return Array.isArray(value) ? value.length > 0 : value === true
  } catch {
    return false
  }
}

function setValue(features: Feature[], key: string): string[] {
  return features.find((f) => f.key === key)?.setValue ?? []
}

/**
 * The client's `featureArrayItemEntitled`, as a list: a `textValue` holding a
 * JSON array of `{value, isEntitled}` — how `BIT_DEPTH` arrives — or a plain
 * `setValue`.
 */
function entitledItems(features: Feature[], key: string): string[] {
  const feature = features.find((f) => f.key === key)
  if (!feature) return []
  if (feature.textValue !== undefined) {
    try {
      const value = JSON.parse(feature.textValue) as unknown
      if (Array.isArray(value)) {
        return value
          .map((item) => asRecord(item))
          .filter((item) => item?.isEntitled === true && typeof item.value === 'string')
          .map((item) => item?.value as string)
      }
    } catch {
      return []
    }
    return []
  }
  return feature.setValue ?? []
}

const QUALITY_MODES: Record<string, PresetMode> = {
  BALANCED: 'balanced',
  DATA_SAVER: 'dataSaver',
  COMPETITIVE: 'competitive',
  CINEMATIC: 'cinematic'
}

const PREFILTER_CODES: Record<string, PrefilterMode> = { OFF: 0, AUTO: 1, CUSTOM: 2 }

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 100_000
    ? value
    : null
}

/**
 * The membership answer, reduced to what it allows.
 *
 * Pure and tolerant, and narrow: entitlements and the tier's name, nothing that
 * identifies the account. Null only for something that is not an answer at all.
 */
export function parseEntitlements(raw: unknown): StreamEntitlements | null {
  const root = asRecord(raw)
  if (!root) return null
  const features = readFeatures(asRecord(root.features)?.features)

  // Resolution × frame rate pairs, entitled only, grouped the way the client
  // groups them and sorted the way it lists them: by pixel count, descending.
  const byResolution = new Map<string, EntitledResolution & { fps: number[] }>()
  const rawResolutions = asRecord(root.features)?.resolutions
  for (const entry of Array.isArray(rawResolutions) ? rawResolutions : []) {
    const r = asRecord(entry)
    const width = positive(r?.widthInPixels)
    const height = positive(r?.heightInPixels)
    const fps = positive(r?.framesPerSecond)
    if (!width || !height || !fps || r?.isEntitled !== true) continue
    const key = `${width}x${height}`
    const existing = byResolution.get(key) ?? { width, height, fps: [] }
    if (!existing.fps.includes(fps)) existing.fps.push(fps)
    byResolution.set(key, existing)
  }
  const resolutions = [...byResolution.values()]
    .map((r) => ({ width: r.width, height: r.height, fps: [...r.fps].sort((a, b) => b - a) }))
    .sort((a, b) => b.width * b.height - a.width * a.height || b.width - a.width)

  // Streaming qualities: which presets exist, what each asks for, and the
  // Balanced one's bit-rate range, which is the custom slider's.
  const modes: PresetMode[] = []
  const presets: Partial<Record<PresetMode, PresetValues>> = {}
  let bitrate: { min: number; max: number } = { ...FALLBACK_BITRATE }
  const qualities = Array.isArray(root.streamingQualities) ? root.streamingQualities : []
  for (const entry of qualities) {
    const q = asRecord(entry)
    const mode =
      typeof q?.clientStreamingQualityMode === 'string'
        ? QUALITY_MODES[q.clientStreamingQualityMode]
        : undefined
    if (!mode || modes.includes(mode)) continue
    modes.push(mode)
    const resolution = asRecord(q?.resolution)
    const maxBitRate = asRecord(q?.maxBitRate)
    const width = positive(resolution?.widthInPixels)
    const height = positive(resolution?.heightInPixels)
    const fps = positive(resolution?.framesPerSecond)
    if (width && height && fps) {
      presets[mode] = {
        width,
        height,
        fps,
        maxBitrate: positive(maxBitRate?.bitrateValue) ?? 0,
        maxBitrateAuto: maxBitRate?.bitrateOption !== true
      }
    }
    if (mode === 'balanced') {
      const min = positive(maxBitRate?.minBitrateValue)
      const max = positive(maxBitRate?.maxBitrateValue)
      if (min && max && min < max) bitrate = { min, max }
    }
  }

  const hdrSet = setValue(features, 'SUPPORTED_HDR_VERSION')
  const hdrModes: HdrMode[] = hdrSet.filter((v): v is HdrMode => isHdrMode(v) && v !== 'OFF')
  if (entitled(features, 'HDR_ENABLED') && !hdrModes.includes('HDR')) hdrModes.push('HDR')

  return {
    tier:
      typeof root.membershipTier === 'string' && /^[A-Z_]{1,24}$/.test(root.membershipTier)
        ? root.membershipTier
        : null,
    modes,
    resolutions,
    bitrate,
    bitDepths: entitledItems(features, 'BIT_DEPTH')
      .map(Number)
      .filter((d): d is 8 | 10 => d === 8 || d === 10),
    chromaFormats: entitledItems(features, 'SUPPORTED_CHROMA_FORMAT')
      .map((c) => (c === 'YUV444' ? 1 : c === 'YUV420' ? 0 : null))
      .filter((c): c is 0 | 1 => c !== null),
    hdrModes,
    // The client's reset check accepts any `SUPPORTED_HDR_VERSION` list at all.
    hdrEntitled: hdrSet.length > 0 || entitled(features, 'HDR_ENABLED'),
    reflex: entitled(features, 'ENABLED_REFLEX'),
    cloudGsync: entitled(features, 'CLOUD_GSYNC'),
    l4s: entitled(features, 'ENABLED_L4S'),
    hud: entitled(features, 'HUD_STREAMING'),
    inGameGraphics: entitled(features, 'IN_GAME_SETTINGS_PERSISTENCE_ENABLED'),
    prefilterModes: setValue(features, 'SUPPORTED_DL_PREFILTERING')
      .map((v) => PREFILTER_CODES[v])
      .filter((v): v is PrefilterMode => v !== undefined),
    dlss: {
      superResolution: entitled(features, 'SUPPORTED_DLSS_OVERRIDE_SR'),
      rayReconstruction: entitled(features, 'SUPPORTED_DLSS_OVERRIDE_RR'),
      frameGeneration: entitled(features, 'SUPPORTED_DLSS_OVERRIDE_FG'),
      frameGenerationMultipliers: DLSS_FG_MULTIPLIERS.filter((m) =>
        entitledItems(features, 'SUPPORTED_DLSS_FG_MULTIPLIERS').includes(`${m}X`)
      )
    },
    presets
  }
}

export interface SubscriptionsRequest {
  url: string
  headers: Record<string, string>
}

/**
 * The request as the native client on Linux would make it.
 *
 * Pure and tested, like `buildSyncRequest`, because the headers are the whole
 * bug: the captured ones describe a browser, and a browser gets a different
 * membership. The neutral captured headers — `Accept`, `User-Agent`, the
 * tracing pair — are kept, being what the measured request carried; every
 * `NV-*` one and the GraphQL `Authorization` are replaced.
 */
export function buildSubscriptionsRequest(input: {
  nes: NesConfig
  clientId: string | null
  clientVersion: string | null
  vpcId: string
  locale: string
  token: string | null
  captured?: Record<string, string>
}): SubscriptionsRequest {
  const neutral = Object.fromEntries(
    Object.entries(input.captured ?? {}).filter(
      ([name]) => !/^nv-/i.test(name) && name.toLowerCase() !== 'authorization'
    )
  )
  const query = new URLSearchParams({
    serviceName: input.nes.serviceName,
    languageCode: input.locale,
    vpcId: input.vpcId
  })
  return {
    url: `${input.nes.server.replace(/\/+$/, '')}/${input.nes.version}/subscriptions?${query}`,
    headers: {
      ...neutral,
      Accept: 'application/json',
      'NV-Client-Type': 'NATIVE',
      'NV-Client-Streamer': 'NVIDIA-CLASSIC',
      'NV-Device-OS': 'LINUX',
      'NV-Device-Type': 'DESKTOP',
      'NV-Device-Make': 'UNKNOWN',
      'NV-Device-Model': 'UNKNOWN',
      ...(input.clientId ? { 'NV-Client-ID': input.clientId } : {}),
      ...(input.clientVersion ? { 'NV-Client-Version': input.clientVersion } : {}),
      ...(input.token ? { Authorization: `GFNJWT ${input.token}` } : {})
    }
  }
}

export interface EntitlementsState {
  entitlements: StreamEntitlements | null
  /** ISO 8601. When the answer in `entitlements` was fetched. */
  fetchedAt: string | null
  /** Why the last refresh did not produce one. Null after a good one. */
  error: string | null
}

interface CacheFile {
  version: number
  fetchedAt: string
  entitlements: StreamEntitlements
}

let memo: { entitlements: StreamEntitlements; fetchedAt: string } | null = null
let loaded = false
let inFlight: Promise<EntitlementsState> | null = null

function cachePath(): string {
  return join(app.getPath('userData'), 'entitlements.json')
}

/**
 * The last answer, from memory or from disk, with no network.
 *
 * What the page uses on entry and while signed out — the membership of the
 * last account seen, labelled with its date, so the page is not empty offline.
 */
export async function getCachedEntitlements(): Promise<EntitlementsState> {
  if (!loaded) {
    loaded = true
    try {
      const file = JSON.parse(await readFile(cachePath(), 'utf8')) as Partial<CacheFile>
      if (
        file.version === ENTITLEMENTS_CACHE_VERSION &&
        file.entitlements &&
        typeof file.fetchedAt === 'string'
      ) {
        // Re-parsed through nothing: the file was written from a parsed answer.
        memo = { entitlements: file.entitlements, fetchedAt: file.fetchedAt }
      }
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') {
        console.warn(`Could not read the cached membership: ${(error as Error).message}`)
      }
    }
  }
  return {
    entitlements: memo?.entitlements ?? null,
    fetchedAt: memo?.fetchedAt ?? null,
    error: null
  }
}

type Attempt =
  | { ok: true; entitlements: StreamEntitlements }
  | { ok: false; status: number | null; error: string }

async function ask(session: GfnGraphQLConfig): Promise<Attempt> {
  if (!session.vpcId) {
    return {
      ok: false,
      status: null,
      error: 'The sign-in did not say which GeForce NOW region to ask. Sign in again.'
    }
  }
  const [nes, client] = await Promise.all([readNesConfig(), detectGfn()])
  const request = buildSubscriptionsRequest({
    nes,
    clientId: nes.clientId,
    clientVersion: client.version,
    vpcId: session.vpcId,
    locale: session.locale,
    token: getIdToken(),
    captured: session.headers
  })

  let response: Response
  try {
    // The signed-in partition's net stack, as every other NVIDIA request here:
    // its proxy and TLS behaviour are the ones the credentials came through.
    response = await getAuthSession().fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
    return {
      ok: false,
      status: null,
      error: timedOut
        ? 'NVIDIA’s membership service did not respond in time.'
        : 'NVIDIA’s membership service could not be reached.'
    }
  }

  // Never the URL and never the body in a log line or an error: the answer
  // names the subscription, and the query names the region.
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: response.status,
      error: 'Sign-in expired — sign in to GeForce NOW again.'
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `NVIDIA’s membership service refused (${response.status}).`
    }
  }
  try {
    const entitlements = parseEntitlements(await response.json())
    if (entitlements) return { ok: true, entitlements }
  } catch {
    // Fall through to the same sentence as a shapeless answer.
  }
  return {
    ok: false,
    status: response.status,
    error: 'NVIDIA’s membership service answered in a shape the launcher does not know.'
  }
}

/**
 * Asks MES, with the id token's one re-capture on a refusal.
 *
 * Memoised for `MEMO_MS` and shared between concurrent callers. A failure keeps
 * the previous answer and says why, rather than throwing the page back to
 * "sign in" over one bad request. `linked` gates any capture, as everywhere.
 */
export async function refreshEntitlements(
  locale: string,
  linked: boolean,
  force = false
): Promise<EntitlementsState> {
  await getCachedEntitlements()
  if (!force && memo && Date.now() - Date.parse(memo.fetchedAt) < MEMO_MS) {
    return { entitlements: memo.entitlements, fetchedAt: memo.fetchedAt, error: null }
  }
  if (inFlight) return inFlight

  inFlight = (async (): Promise<EntitlementsState> => {
    try {
      const result = await withIdToken(
        locale,
        linked,
        ask,
        (attempt) => !attempt.ok && (attempt.status === 401 || attempt.status === 403),
        () => console.warn('Membership request refused; re-capturing the session')
      )
      const previous = {
        entitlements: memo?.entitlements ?? null,
        fetchedAt: memo?.fetchedAt ?? null
      }
      if (result === null)
        return { ...previous, error: 'Sign in to GeForce NOW to see what your membership allows.' }
      if (!result.ok) {
        console.warn(`Membership request failed: status=${result.status ?? 'none'}`)
        return { ...previous, error: result.error }
      }

      const fetchedAt = new Date().toISOString()
      memo = { entitlements: result.entitlements, fetchedAt }
      const file: CacheFile = {
        version: ENTITLEMENTS_CACHE_VERSION,
        fetchedAt,
        entitlements: result.entitlements
      }
      await writeFileAtomic(cachePath(), JSON.stringify(file, null, 2)).catch((error: unknown) => {
        console.warn(`Could not cache the membership: ${(error as Error).message}`)
      })
      console.info(
        `Membership: ${result.entitlements.tier ?? 'unknown tier'}, ` +
          `${result.entitlements.resolutions.length} resolutions, ` +
          `${result.entitlements.bitrate.min}–${result.entitlements.bitrate.max} Mbps`
      )
      return { entitlements: result.entitlements, fetchedAt, error: null }
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * Forgets the membership, on sign-in and sign-out: the next account is not the
 * last one, and its page must not be drawn from the last one's allowances.
 */
export async function resetEntitlements(): Promise<void> {
  memo = null
  loaded = true
  await rm(cachePath(), { force: true }).catch((error: unknown) => {
    console.warn(`Could not remove the cached membership: ${(error as Error).message}`)
  })
}
