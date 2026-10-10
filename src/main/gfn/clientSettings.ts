/**
 * GeForce NOW's own settings, read from and written to the client's storage.
 *
 *   ~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/sharedstorage.json
 *     → appSettingsConfig
 *
 * The one file the launcher writes that is not its own. ARCHITECTURE.md has the
 * section; this header has the rules a change here must not break.
 *
 * ── Tongs ───────────────────────────────────────────────────────────────────
 *
 * This is the file `status/zone.ts` reads, and everything said there holds: it
 * carries a live `accessToken`, a `clientToken`, an `idToken` JWT with the
 * account's email, the user id, and — inside `appSettingsConfig.customProfile.
 * networkInfo` itself — the LAN IP and two MAC addresses. So:
 *
 * - `parseClientSettings` returns a declared shape and nothing else, and
 *   `clientSettings.test.ts` asserts its key set against a fixture full of
 *   secrets, as `zone.test.ts` does.
 * - Nothing here logs content. Failures name the path and the errno.
 * - **Nothing outside `appSettingsConfig` is ever re-serialised.** A write
 *   splices the new value of that one key into the original text, so the
 *   session, the tokens and every byte the client wrote around them go back
 *   exactly as they came — not re-encoded by `JSON.stringify`, which rewrites
 *   the client's float timestamps and would at best be a diff nobody asked for.
 *
 * ── How a write reaches a running client ────────────────────────────────────
 *
 * Measured, not assumed (docs/gfn-api.md has the run): the client's native
 * `SharedStorageWatcher` watches this file with inotify and reloads it, its web
 * app logs `shared storage cache updated` within milliseconds, and later writes
 * of *other* blocks — the server location, a token — carry our change rather
 * than reverting it. So a change made here is live in an open client, and the
 * next game launched from the launcher — which restarts the client anyway —
 * certainly uses it.
 *
 * The write is in place, through the host: `dd conv=notrunc` built by
 * `buildInPlaceWriteArgv`, padded to at least the old length so the file is
 * never short and never empty. In place because that is how the client writes
 * it (same inode since the install) and what its watch follows; through the
 * host because the Flatpak grant on this directory is read-only, and the host
 * permission is the door `autostart.ts` already writes through. Atomic it is
 * not, and that is an accepted risk written down in CONTRIBUTING.md: the
 * client's own writes are no different.
 */

import { readFile, stat } from 'node:fs/promises'
import {
  DLSS_DEFAULTS,
  isHdrMode,
  isStreamMode,
  type ClientSettings,
  type ClientSettingsPatch,
  type CustomProfile,
  type DlssOverrides,
  type DlssPresetMode,
  type Sharpness,
  type Upscaling
} from '@shared/clientSettings'
import { buildInPlaceWriteArgv, classifyHostFailure, hostExecWithInput } from '../host'
import { clientStoragePath } from './clientState'

// ── Reading ──────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asInteger(value: unknown, min: number, max: number): number | undefined {
  const n = asNumber(value)
  return n !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

function oneOf<T extends number>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The user-facing fields of a stored `customProfile`, each one only if it is
 * the type the client would read. A field that is missing or malformed stays
 * missing, and `effectiveCustom` fills it the way the client would.
 */
function parseCustom(raw: Record<string, unknown>): Partial<CustomProfile> {
  const out: Partial<CustomProfile> = {}
  const set = <K extends keyof CustomProfile>(
    key: K,
    value: CustomProfile[K] | undefined
  ): void => {
    if (value !== undefined) out[key] = value
  }
  set('width', asInteger(raw.width, 1, 16384))
  set('height', asInteger(raw.height, 1, 16384))
  set('fps', asInteger(raw.fps, 1, 1000))
  set('maxBitrate', asInteger(raw.maxBitrate, 0, 10_000))
  set('maxBitrateAuto', asBoolean(raw.maxBitrateAuto))
  set('codec', oneOf(raw.codec, [0, 1, 2, 3] as const))
  set('bitDepth', oneOf(raw.bitDepth, [8, 10] as const))
  set('chromaFormat', oneOf(raw.chromaFormat, [0, 1] as const))
  if (isHdrMode(raw.hdrStreamingMode)) out.hdrStreamingMode = raw.hdrStreamingMode
  set('vSync', oneOf(raw.vSync, [0, 1, 2] as const))
  set('reflex', asBoolean(raw.reflex))
  set('cloudGsync', asBoolean(raw.cloudGsync))
  set('l4sEnabled', asBoolean(raw.l4sEnabled))
  set('dynamicStreamingMode', oneOf(raw.dynamicStreamingMode, [0, 1, 2, 3] as const))
  set('prefilter', oneOf(raw.prefilter, [0, 1, 2] as const))
  set('sharpen', asInteger(raw.sharpen, 0, 10))
  set('denoise', asInteger(raw.denoise, 0, 10))
  set('hudStreaming', asBoolean(raw.hudStreaming))
  return out
}

function parseDlss(raw: unknown): DlssOverrides {
  const r = asRecord(raw)
  if (!r) return { ...DLSS_DEFAULTS }
  const preset: DlssPresetMode =
    r.modelPresetMode === 'recommended' ||
    r.modelPresetMode === 'custom' ||
    r.modelPresetMode === 'inGame'
      ? r.modelPresetMode
      : DLSS_DEFAULTS.modelPresetMode
  const int = (value: unknown, fallback: number): number => asInteger(value, 0, 100) ?? fallback
  return {
    modelPresetMode: preset,
    srMode: int(r.srMode, DLSS_DEFAULTS.srMode),
    srScale: int(r.srScale, DLSS_DEFAULTS.srScale),
    srModel: int(r.srModel, DLSS_DEFAULTS.srModel),
    rrModel: int(r.rrModel, DLSS_DEFAULTS.rrModel),
    fgMode: int(r.fgMode, DLSS_DEFAULTS.fgMode),
    fgModel: int(r.fgModel, DLSS_DEFAULTS.fgModel),
    fgMultiplier: asInteger(r.fgMultiplier, 1, 16) ?? null,
    customSrModel: int(r.customSrModel, DLSS_DEFAULTS.customSrModel),
    customRrModel: int(r.customRrModel, DLSS_DEFAULTS.customRrModel),
    customFgModel: int(r.customFgModel, DLSS_DEFAULTS.customFgModel)
  }
}

const SHARPNESS_VALUES = [0, 2, 3, 4] as const

/**
 * The settings out of a parsed `sharedstorage.json`.
 *
 * Pure and tolerant, and narrow on purpose: it reads `appSettingsConfig` and
 * nothing beside it, and from that only the fields the official Settings page
 * manages. Missing values come back as the client's own defaults — a client
 * that has never been opened has no `appSettingsConfig` at all, and its
 * settings are then exactly those defaults.
 *
 * Returns null only when the input is not an object, which is a file that is
 * not this file.
 */
export function parseClientSettings(raw: unknown): ClientSettings | null {
  const root = asRecord(raw)
  if (!root) return null
  const a = asRecord(root.appSettingsConfig) ?? {}
  const customRaw = asRecord(a.customProfile)

  const upscaling = oneOf(a.upScalingResolutionId, [0, 1, 2] as const)
  return {
    streamingProfiles: isStreamMode(a.streamingProfiles) ? a.streamingProfiles : 'balanced',
    customProfile: customRaw ? parseCustom(customRaw) : null,
    // `?? 1` is the client's own read; a stored 2 ("always on", which no UI
    // writes any more) behaves as off there, and reads as off here.
    networkQuality: a.networkQuality === undefined || a.networkQuality === 1 ? 1 : 0,
    // Missing means the clipboard service has not run yet, and it then writes
    // `client.clipboardConfig.isClipboardEnabled` — true in every config seen.
    clipboardPaste: asBoolean(a.clipboardPaste) ?? true,
    inGameGraphics: asBoolean(a.inGameGraphics) ?? false,
    preferredGameLanguage:
      typeof a.preferredGameLanguage === 'string' && a.preferredGameLanguage.length > 0
        ? a.preferredGameLanguage.slice(0, 32)
        : null,
    // Honoured only with the flag, because the client resets an unflagged
    // value to Standard at every start.
    upScalingResolutionId:
      upscaling !== undefined && a.upscalingModeUpdatedByUser === true
        ? (upscaling as Upscaling)
        : 0,
    // An unknown sharpness reads as Low in the client.
    enhancedSharpnessValue: (oneOf(a.enhancedSharpnessValue, SHARPNESS_VALUES) ?? 0) as Sharpness,
    aiSharpnessValue: (oneOf(a.aiSharpnessValue, SHARPNESS_VALUES) ?? 0) as Sharpness,
    dlssOverrides: parseDlss(a.dlssOverrides)
  }
}

/**
 * Whether the client has just thrown a custom profile away.
 *
 * Its launch-time check deletes `customProfile` when the stored mode is not one
 * the membership — or this machine — allows, and streams Balanced while the
 * mode still reads Custom. The official app's RESET does the same thing, which
 * is why the notice this drives is worded for both. Either reading being
 * unknown is not evidence of anything.
 */
export function customProfileDropped(
  previous: ClientSettings | null,
  next: ClientSettings | null
): boolean {
  if (!previous || !next) return false
  return (
    previous.streamingProfiles === 'custom' &&
    previous.customProfile !== null &&
    next.streamingProfiles === 'custom' &&
    next.customProfile === null
  )
}

// ── Writing, pure ────────────────────────────────────────────────────────────

/** Recursively sorts object keys — the client's own order (nlohmann's map). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  const record = asRecord(value)
  if (!record) return value
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])])
  )
}

/**
 * The stored `appSettingsConfig` with a patch applied.
 *
 * Takes and returns the *raw* block, so every field the launcher does not
 * manage — `networkInfo`, `udsSnoozeStopDateTime`, whatever the next client
 * adds — goes back untouched. Keys come out sorted, which is how the client
 * writes them.
 */
export function applyClientSettingsPatch(
  appSettingsConfig: unknown,
  patch: ClientSettingsPatch
): Record<string, unknown> {
  const current = asRecord(appSettingsConfig) ?? {}
  const next: Record<string, unknown> = { ...current, ...patch.appSettings }
  if (patch.customProfile) {
    next.customProfile = { ...(asRecord(current.customProfile) ?? {}), ...patch.customProfile }
  }
  return sortKeys(next) as Record<string, unknown>
}

/** Where a value ends, starting at its first character. JSON grammar, no more. */
function skipValue(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') {
        inString = false
        if (depth === 0) return i + 1
      }
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i + 1
      if (depth < 0) return i
    } else if (depth === 0 && (c === ',' || c === '}')) return i
  }
  return text.length
}

/**
 * The `[start, end)` span of a top-level key's value, or null when absent.
 *
 * A scanner rather than an `indexOf`, because the key's name could also occur
 * inside a string — a token is unlikely to spell `"appSettingsConfig":`, but
 * "unlikely" is not the standard for a file holding somebody's login.
 */
export function topLevelValueSpan(text: string, key: string): [number, number] | null {
  let i = text.indexOf('{')
  if (i < 0) return null
  i++
  const ws = (at: number): boolean => /\s/.test(text.charAt(at))
  while (i < text.length) {
    while (i < text.length && (ws(i) || text[i] === ',')) i++
    if (text[i] !== '"') return null
    const keyEnd = skipValue(text, i)
    const name = JSON.parse(text.slice(i, keyEnd)) as string
    i = keyEnd
    while (i < text.length && ws(i)) i++
    if (text[i] !== ':') return null
    i++
    while (i < text.length && ws(i)) i++
    const valueEnd = skipValue(text, i)
    if (name === key) return [i, valueEnd]
    i = valueEnd
  }
  return null
}

/**
 * The bytes to write: the original text with only `appSettingsConfig`
 * replaced, padded with spaces to at least the original length.
 *
 * Padding is what lets `dd conv=notrunc` stand in for a truncating write:
 * trailing whitespace is valid JSON, so a shorter payload leaves no tail of the
 * old one behind and the file is never, at any instant, short or empty. The
 * client truncates on its own next write, so the spaces do not accumulate.
 *
 * Refuses rather than writes when the result would not parse, or when the block
 * holds an integer JavaScript cannot represent — the client is C++ and could
 * store one, and rewriting it here would quietly change it.
 */
export function encodeClientStorage(
  originalText: string,
  appSettingsConfig: Record<string, unknown>
): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  let unsafe = false
  ;(function walk(value: unknown): void {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))
      unsafe = true
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  })(appSettingsConfig)
  if (unsafe)
    return { ok: false, error: 'The settings hold a number the launcher cannot rewrite safely.' }

  const value = JSON.stringify(appSettingsConfig)
  const span = topLevelValueSpan(originalText, 'appSettingsConfig')
  let text: string
  if (span) {
    text = originalText.slice(0, span[0]) + value + originalText.slice(span[1])
  } else {
    // Never written yet: the client has not saved a setting. First key, which
    // is also where its sorted order would put it.
    const open = originalText.indexOf('{')
    if (open < 0) return { ok: false, error: 'The client’s storage file is not what was expected.' }
    const rest = originalText.slice(open + 1)
    const empty = rest.trim().startsWith('}')
    text = `${originalText.slice(0, open + 1)}"appSettingsConfig":${value}${empty ? '' : ','}${rest}`
  }

  try {
    JSON.parse(text)
  } catch {
    return { ok: false, error: 'The client’s storage file is not what was expected.' }
  }

  const bytes = Buffer.from(text, 'utf8')
  const oldLength = Buffer.byteLength(originalText, 'utf8')
  return {
    ok: true,
    bytes:
      bytes.length >= oldLength
        ? bytes
        : Buffer.concat([bytes, Buffer.alloc(oldLength - bytes.length, 0x20)])
  }
}

/** Whether every patched field reads back as written. */
export function patchLanded(root: unknown, patch: ClientSettingsPatch): boolean {
  const a = asRecord(asRecord(root)?.appSettingsConfig)
  if (!a) return false
  const same = (x: unknown, y: unknown): boolean =>
    JSON.stringify(sortKeys(x)) === JSON.stringify(sortKeys(y))
  for (const [key, value] of Object.entries(patch.appSettings))
    if (!same(a[key], value)) return false
  if (patch.customProfile) {
    const c = asRecord(a.customProfile)
    if (!c) return false
    for (const [key, value] of Object.entries(patch.customProfile))
      if (!same(c[key], value)) return false
  }
  return true
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/** What one `stat` said, so a poll can answer "unchanged" without reading. */
export interface StorageMark {
  readonly ino: number
  readonly mtimeMs: number
  readonly size: number
}

export function sameMark(a: StorageMark | null, b: StorageMark | null): boolean {
  return a !== null && b !== null && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size
}

export type ClientSettingsRead =
  | { readonly ok: true; readonly settings: ClientSettings; readonly mark: StorageMark }
  | { readonly ok: false; readonly error: string; readonly missing: boolean }

const NOT_SET_UP =
  'GeForce NOW has not been set up on this computer yet — open it once and sign in.'
const UNREADABLE = 'GeForce NOW’s settings could not be read.'

function errno(error: unknown): string {
  return (error as { code?: unknown } | null)?.code
    ? String((error as { code: unknown }).code)
    : 'unknown error'
}

async function readRaw(
  path: string
): Promise<
  | { ok: true; text: string; root: unknown; mark: StorageMark }
  | { ok: false; error: string; missing: boolean }
> {
  let text: string
  let mark: StorageMark
  try {
    const before = await stat(path)
    text = await readFile(path, 'utf8')
    mark = { ino: before.ino, mtimeMs: before.mtimeMs, size: before.size }
  } catch (error) {
    const code = errno(error)
    if (code === 'ENOENT') return { ok: false, error: NOT_SET_UP, missing: true }
    // Path and errno only: never a byte of what was in there.
    console.warn(`Could not read GeForce NOW's settings at ${path}: ${code}`)
    return { ok: false, error: UNREADABLE, missing: false }
  }
  try {
    return { ok: true, text, root: JSON.parse(text) as unknown, mark }
  } catch {
    // A file caught mid-write. Not quoted, for the reason above.
    return { ok: false, error: UNREADABLE, missing: false }
  }
}

export async function readClientSettings(
  path: string = clientStoragePath()
): Promise<ClientSettingsRead> {
  const raw = await readRaw(path)
  if (!raw.ok) return raw
  const settings = parseClientSettings(raw.root)
  if (!settings) return { ok: false, error: UNREADABLE, missing: false }
  return { ok: true, settings, mark: raw.mark }
}

/** How many times a write re-reads when the client wrote in between. */
const WRITE_ATTEMPTS = 3

export type ClientSettingsWrite =
  | { readonly ok: true; readonly settings: ClientSettings }
  | { readonly ok: false; readonly error: string }

/**
 * Applies one change to the file.
 *
 * `decide` is handed the settings as they are on disk *now* and returns the
 * patch — or a refusal — so the judgement is always made against the file and
 * never against whatever the screen last drew. That is `applyChange` in
 * practice; it is a parameter so this module stays I/O and the rules stay in
 * `@shared`, where both sides can see them.
 *
 * Serialised: one write at a time, the `settings.ts` queue, because two writes
 * interleaving their read and their `dd` would each undo the other.
 */
let queue: Promise<unknown> = Promise.resolve()

export function writeClientSettings(
  decide: (
    settings: ClientSettings
  ) => { ok: true; patch: ClientSettingsPatch } | { ok: false; error: string },
  path: string = clientStoragePath()
): Promise<ClientSettingsWrite> {
  const run = queue.then(() => writeOnce(decide, path))
  queue = run.catch(() => undefined)
  return run
}

async function writeOnce(
  decide: (
    settings: ClientSettings
  ) => { ok: true; patch: ClientSettingsPatch } | { ok: false; error: string },
  path: string
): Promise<ClientSettingsWrite> {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const raw = await readRaw(path)
    if (!raw.ok) return { ok: false, error: raw.error }
    const settings = parseClientSettings(raw.root)
    if (!settings) return { ok: false, error: UNREADABLE }

    const decision = decide(settings)
    if (!decision.ok) return decision

    const block = applyClientSettingsPatch(asRecord(raw.root)?.appSettingsConfig, decision.patch)
    const encoded = encodeClientStorage(raw.text, block)
    if (!encoded.ok) return encoded

    // The client may have written while we were deciding. Its watcher has then
    // already reloaded a newer file than the one we are about to overwrite, so
    // start again from that one rather than put the old one back.
    try {
      const now = await stat(path)
      if (!sameMark(raw.mark, { ino: now.ino, mtimeMs: now.mtimeMs, size: now.size })) continue
    } catch (error) {
      console.warn(`Could not re-check GeForce NOW's settings at ${path}: ${errno(error)}`)
      return { ok: false, error: UNREADABLE }
    }

    const written = await writeBytes(path, encoded.bytes, false)
    if (!written.ok) return written

    const back = await readRaw(path)
    if (!back.ok) {
      // Unparseable after our write means the file grew under us and a padded
      // payload left the tail of the client's version behind. Write ours whole,
      // truncating — the client's own way of writing — and say so.
      console.warn(`GeForce NOW's settings did not parse after a write at ${path}; rewriting whole`)
      const whole = await writeBytes(
        path,
        Buffer.from(encoded.bytes.toString('utf8').trimEnd(), 'utf8'),
        true
      )
      if (!whole.ok) return whole
      const again = await readRaw(path)
      if (!again.ok) return { ok: false, error: UNREADABLE }
      return finish(again.root, decision.patch, path)
    }
    return finish(back.root, decision.patch, path)
  }

  console.warn(
    `GeForce NOW kept rewriting its settings at ${path}; gave up after ${WRITE_ATTEMPTS} attempts`
  )
  return {
    ok: false,
    error: 'GeForce NOW was saving its own settings at the same time. Try again.'
  }
}

function finish(root: unknown, patch: ClientSettingsPatch, path: string): ClientSettingsWrite {
  const settings = parseClientSettings(root)
  if (!settings || !patchLanded(root, patch)) {
    console.warn(`A change to GeForce NOW's settings at ${path} did not read back as written`)
    return {
      ok: false,
      error: 'The change did not stick — GeForce NOW may have overwritten it. Try again.'
    }
  }
  return { ok: true, settings }
}

async function writeBytes(
  path: string,
  bytes: Buffer,
  truncate: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [command, args] = buildInPlaceWriteArgv(path, { truncate })
  try {
    await hostExecWithInput(command, args, bytes)
    return { ok: true }
  } catch (error) {
    // `hostExecWithInput` has already logged the argv — which carries the path
    // and never the payload — and the classified reason.
    const failure = classifyHostFailure(error)
    return {
      ok: false,
      error:
        failure.kind === 'failed' ? 'GeForce NOW’s settings could not be saved.' : failure.message
    }
  }
}
