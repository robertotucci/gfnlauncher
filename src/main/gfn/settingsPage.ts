import {
  applyChange,
  settingSections,
  streamSummary,
  type ClientConfig,
  type ClientSettingChange,
  type ClientSettingResult,
  type ClientSettings,
  type ClientSettingsSnapshot,
  type SettingsContext
} from '@shared/clientSettings'
import { getSettings } from '../settings'
import { readStreamingClientConfig } from './appConfig'
import {
  readClientSettings,
  sameMark,
  writeClientSettings,
  type StorageMark
} from './clientSettings'
import { fetchGameLanguages } from './library'
import {
  getCachedEntitlements,
  refreshEntitlements,
  resetEntitlements,
  type EntitlementsState
} from './membership'
import { ensureSession } from './session'

/**
 * The streaming page, assembled: the client's file, the membership, the
 * client's own config, the game languages and the launcher's locale, folded
 * into the rows `settingSections` draws and `applyChange` judges.
 *
 * Three entry points, mirroring `status:get` / `status:refresh`:
 *
 * - `getSettingsPage` — no network, ever. The page calls it on entry and polls
 *   it while open, so it has to be cheap: an unchanged file answers with the
 *   last snapshot without being re-read.
 * - `refreshSettingsPage` — asks MES and GraphQL. Never speculatively: only
 *   with the persisted `gfnLinked`, exactly as every other capture is gated.
 * - `changeSetting` — one write, judged against the file as it is on disk.
 */

/** The game languages, per session. Cleared with the membership on sign-in and out. */
let languages: string[] | null = null
/** When the client last threw the custom profile away. See `noteCustomProfileReset`. */
let lastReset: string | null = null

let revision = 0
let last: { key: string; mark: StorageMark; snapshot: ClientSettingsSnapshot } | null = null

function contextFor(
  settings: ClientSettings,
  entitlements: EntitlementsState,
  config: ClientConfig,
  locale: string
): SettingsContext {
  return { settings, entitlements: entitlements.entitlements, config, languages, locale }
}

/** Everything besides the file that changes the page. */
function inputsKey(entitlements: EntitlementsState, config: ClientConfig, locale: string): string {
  return JSON.stringify([
    entitlements.fetchedAt,
    entitlements.error,
    config,
    locale,
    languages?.length ?? null,
    lastReset
  ])
}

async function build(entitlements: EntitlementsState): Promise<ClientSettingsSnapshot> {
  const [read, config, { locale }] = await Promise.all([
    readClientSettings(),
    readStreamingClientConfig(),
    getSettings()
  ])
  const key = inputsKey(entitlements, config, locale)

  if (!read.ok) {
    last = null
    return {
      revision: ++revision,
      sections: null,
      summary: null,
      tier: entitlements.entitlements?.tier ?? null,
      entitlementsAsOf: entitlements.fetchedAt,
      entitlementsError: entitlements.error,
      lastReset,
      error: read.error
    }
  }

  if (last && last.key === key && sameMark(last.mark, read.mark)) return last.snapshot

  const context = contextFor(read.settings, entitlements, config, locale)
  const snapshot: ClientSettingsSnapshot = {
    revision: ++revision,
    sections: settingSections(context),
    summary: streamSummary(context),
    tier: entitlements.entitlements?.tier ?? null,
    entitlementsAsOf: entitlements.fetchedAt,
    entitlementsError: entitlements.error,
    lastReset,
    error: null
  }
  last = { key, mark: read.mark, snapshot }
  return snapshot
}

/** The page from what is on disk and in memory. No network. */
export async function getSettingsPage(): Promise<ClientSettingsSnapshot> {
  return build(await getCachedEntitlements())
}

/**
 * Asks NVIDIA again — the membership and the language list — then answers with
 * the page. A failure of either keeps what was there and says so; neither one
 * takes the page down, because the file half of it needs no network at all.
 */
export async function refreshSettingsPage(force = false): Promise<ClientSettingsSnapshot> {
  const { locale, gfnLinked } = await getSettings()
  const entitlements = await refreshEntitlements(locale, gfnLinked, force)

  if (languages === null || force) {
    const session = await ensureSession(locale, gfnLinked)
    if (session) {
      try {
        const list = await fetchGameLanguages(session)
        if (list.length > 0) languages = list
      } catch (error) {
        console.warn(
          `Could not load the game languages: ${error instanceof Error ? error.message : 'unknown error'}`
        )
      }
    }
  }

  return build(entitlements)
}

/**
 * One change, decided against the file as it is when the write starts.
 *
 * Never throws: the bridge carries a result, and a refusal or a failure is a
 * sentence for under the row rather than a rejected promise the renderer does
 * not model.
 */
export async function changeSetting(change: ClientSettingChange): Promise<ClientSettingResult> {
  try {
    const [entitlements, config, { locale }] = await Promise.all([
      getCachedEntitlements(),
      readStreamingClientConfig(),
      getSettings()
    ])
    const written = await writeClientSettings((settings) =>
      applyChange(contextFor(settings, entitlements, config, locale), change)
    )
    if (written.ok) console.info(`GeForce NOW setting changed: ${change.field}`)
    else console.warn(`GeForce NOW setting not changed: ${change.field} — ${written.error}`)
    return {
      ok: written.ok,
      error: written.ok ? null : written.error,
      field: change.field,
      snapshot: await build(entitlements)
    }
  } catch (error) {
    console.error('Changing a GeForce NOW setting failed:', error)
    return {
      ok: false,
      error: 'The change could not be made.',
      field: change.field,
      snapshot: await getSettingsPage().catch(() => ({
        revision: ++revision,
        sections: null,
        summary: null,
        tier: null,
        entitlementsAsOf: null,
        entitlementsError: null,
        lastReset,
        error: 'GeForce NOW’s settings could not be read.'
      }))
    }
  }
}

/** Recorded by `clientWatch.ts` when the client deletes the custom profile. */
export function noteCustomProfileReset(at: Date = new Date()): void {
  lastReset = at.toISOString()
}

/** On sign-in and sign-out: the next account's page owes the last one nothing. */
export async function resetSettingsPage(): Promise<void> {
  languages = null
  last = null
  await resetEntitlements()
}
