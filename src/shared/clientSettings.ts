/**
 * GeForce NOW's own settings — the stream quality, upscaling, DLSS overrides
 * and the rest of what the official app's Settings page manages — as the
 * launcher mirrors them.
 *
 * ── One store, and it is not ours ───────────────────────────────────────────
 *
 * The client keeps these in `appSettingsConfig` inside its `sharedstorage.json`
 * (`src/main/gfn/clientSettings.ts` reads and writes it). The launcher holds no
 * copy: every screen reads the file, every change is written into it, and the
 * client's native `SharedStorageWatcher` picks the change up live — measured
 * against a running client, see docs/gfn-api.md. That is what "always in sync"
 * means here: there is nothing to synchronise, because there is one value.
 *
 * ── Why the rules below exist ───────────────────────────────────────────────
 *
 * **The client throws a custom profile away if it does not like it.** At
 * launch, `isCustomDataInSubscription` checks the stored resolution × frame
 * rate against the list the membership allows, and Reflex, VRR, HDR, L4S and
 * 10-bit colour against its entitlements. Anything outside them and the client
 * *deletes* `customProfile` and streams Balanced, saying nothing. So every
 * option here is offered against the same server answer the client uses — the
 * membership, fetched from MES by `src/main/gfn/membership.ts` — and an option
 * the account is not entitled to is shown, disabled, with the reason. Main
 * re-checks every change against the same rows before anything reaches disk
 * (`applyChange`), so the renderer cannot write what the screen would refuse.
 *
 * What is *not* enforced is what depends on this machine — the decoder, the
 * display's refresh rate, whether it is HDR or VRR. The client logs those, but
 * only into a file that also carries tokens, which the launcher does not read.
 * The client adapts those at launch rather than resetting, and the row
 * descriptions say so.
 *
 * Every table and every cascade is transcribed from the shipped client
 * (2.0.89.141's bundles: `streaming-profile.service`, the custom-mode editor, the
 * DLSS overrides component) and the wording is the client's own `en_US`
 * strings, so a row here reads like the same row there.
 *
 * Pure, no Node and no DOM: this compiles into the main process and the
 * renderer alike, and the main process is the one that decides.
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** `appSettingsConfig.streamingProfiles`. A missing value means `balanced`. */
export type StreamMode = 'balanced' | 'dataSaver' | 'competitive' | 'cinematic' | 'custom'
export type PresetMode = Exclude<StreamMode, 'custom'>

export const STREAM_MODES: readonly StreamMode[] = [
  'balanced',
  'dataSaver',
  'competitive',
  'cinematic',
  'custom'
]

export function isStreamMode(value: unknown): value is StreamMode {
  return typeof value === 'string' && (STREAM_MODES as readonly string[]).includes(value)
}

export type HdrMode = 'OFF' | 'HDR' | 'HDR10_PLUS_GAMING'
export const HDR_MODES: readonly HdrMode[] = ['OFF', 'HDR', 'HDR10_PLUS_GAMING']

export function isHdrMode(value: unknown): value is HdrMode {
  return typeof value === 'string' && (HDR_MODES as readonly string[]).includes(value)
}

/** 0 Auto · 1 H.264 · 2 H.265 · 3 AV1 — the SDK's `CodecType`. */
export type Codec = 0 | 1 | 2 | 3
/** 0 Off · 1 On · 2 Adaptive — the SDK's `VsyncType`. */
export type VSync = 0 | 1 | 2
/** 0 Off · 1 Auto · 2 Custom — the SDK's `PrefilterMode`. */
export type PrefilterMode = 0 | 1 | 2
/** 0 none · 1 prefer fps · 2 prefer resolution · 3 on — `DynamicStreamingMode`. */
export type NetworkAdjust = 0 | 1 | 2 | 3
/** 0 Standard · 1 Enhanced · 2 AI-enhanced. */
export type Upscaling = 0 | 1 | 2
/** The stored *value*, not the option's id: 4 Off · 0 Low · 2 Medium · 3 High. */
export type Sharpness = 0 | 2 | 3 | 4

/**
 * The fields of `customProfile` a launch actually reads, by their wire names.
 *
 * The client stores more — `name`, `description`, `profile`, `networkInfo`,
 * `primaryDisplayResolution`, `audioMode`, `displayDpi` — and every one of
 * those is a copied artefact or recomputed at launch. `networkInfo` holds the
 * LAN IP and both MAC addresses, which is the other reason none of them is here.
 */
export interface CustomProfile {
  width: number
  height: number
  fps: number
  /** Mbps. 0 together with `maxBitrateAuto` is Auto. */
  maxBitrate: number
  maxBitrateAuto: boolean
  codec: Codec
  bitDepth: 8 | 10
  /** 0 = 4:2:0, 1 = 4:4:4. */
  chromaFormat: 0 | 1
  hdrStreamingMode: HdrMode
  vSync: VSync
  reflex: boolean
  cloudGsync: boolean
  l4sEnabled: boolean
  dynamicStreamingMode: NetworkAdjust
  prefilter: PrefilterMode
  sharpen: number
  denoise: number
  hudStreaming: boolean
}

export type DlssPresetMode = 'inGame' | 'recommended' | 'custom'

/**
 * `appSettingsConfig.dlssOverrides` — top level, whatever the stream mode.
 *
 * The client also leaves a copy inside `customProfile` when its custom editor
 * saves; the launch path does not read that one (`getDesiredDlssOverrides(
 * settingsBlock.dlssOverrides)`), and neither does this.
 */
export interface DlssOverrides {
  modelPresetMode: DlssPresetMode
  srMode: number
  srScale: number
  srModel: number
  rrModel: number
  fgMode: number
  fgModel: number
  /** Null until a multiplier is entitled; the client then defaults to the smallest. */
  fgMultiplier: number | null
  customSrModel: number
  customRrModel: number
  customFgModel: number
}

/** The client's own defaults (`O` in its settings constants). */
export const DLSS_DEFAULTS: DlssOverrides = {
  modelPresetMode: 'inGame',
  srMode: 0,
  srScale: 100,
  srModel: 0,
  rrModel: 0,
  fgMode: 0,
  fgModel: 0,
  fgMultiplier: null,
  customSrModel: 0,
  customRrModel: 0,
  customFgModel: 0
}

/**
 * What the launcher read out of `appSettingsConfig`.
 *
 * Effective values, not raw ones: a missing `networkQuality` is the client's
 * default of warnings-on, a missing `clipboardPaste` is on, and
 * `upScalingResolutionId` is Standard unless `upscalingModeUpdatedByUser` says
 * the user chose it — because that is what the client does at start, resetting
 * an unflagged value to its configured default.
 */
export interface ClientSettings {
  streamingProfiles: StreamMode
  /** Null when there is none — never set, or thrown away by the client. */
  customProfile: Partial<CustomProfile> | null
  /** 1 = "Only show warnings", 0 = off. */
  networkQuality: 0 | 1
  clipboardPaste: boolean
  inGameGraphics: boolean
  /** `"auto-<locale>"`, `"<locale>"`, or null for never set (Auto). */
  preferredGameLanguage: string | null
  upScalingResolutionId: Upscaling
  enhancedSharpnessValue: Sharpness
  aiSharpnessValue: Sharpness
  dlssOverrides: DlssOverrides
}

/** One resolution the membership allows, with every frame rate it allows at it. */
export interface EntitledResolution {
  width: number
  height: number
  /** Descending. */
  fps: readonly number[]
}

/** What a preset asks the server for, read off its `streamingQualities` entry. */
export interface PresetValues {
  width: number
  height: number
  fps: number
  maxBitrate: number
  maxBitrateAuto: boolean
}

/**
 * What the account's membership allows on this client, from MES.
 *
 * The launcher's own model of the subscription answer — `parseEntitlements` in
 * `src/main/gfn/membership.ts` is the only thing that builds one, and it keeps
 * nothing that identifies the account.
 */
export interface StreamEntitlements {
  /** `membershipTier` as sent, for display: `ULTIMATE`, `PERFORMANCE`, `FREE`. */
  tier: string | null
  /** Presets the membership has a streaming quality for. */
  modes: readonly PresetMode[]
  /** Sorted by pixel count, descending — the order the client lists them in. */
  resolutions: readonly EntitledResolution[]
  /** The Balanced quality's bit-rate range, which is the custom slider's. Mbps. */
  bitrate: { readonly min: number; readonly max: number }
  bitDepths: readonly (8 | 10)[]
  chromaFormats: readonly (0 | 1)[]
  /** HDR modes beyond Off that the membership lists. */
  hdrModes: readonly HdrMode[]
  /** `HDR_ENABLED`, or any `SUPPORTED_HDR_VERSION` — the client's reset check. */
  hdrEntitled: boolean
  reflex: boolean
  cloudGsync: boolean
  l4s: boolean
  hud: boolean
  inGameGraphics: boolean
  prefilterModes: readonly PrefilterMode[]
  dlss: {
    readonly superResolution: boolean
    readonly rayReconstruction: boolean
    readonly frameGeneration: boolean
    /** Of 3–6, the ones entitled. */
    readonly frameGenerationMultipliers: readonly number[]
  }
  presets: Partial<Record<PresetMode, PresetValues>>
}

/** The parts of the client's own `config.json` that change what the page offers. */
export interface ClientConfig {
  /** `client.supportedStreamingProfiles`. Null when unreadable: everything is offered. */
  supportedStreamingProfiles: Partial<Record<StreamMode, boolean>> | null
  /** `client.displayAllDynamicStreamingModes` — three network modes, or On/Off. */
  displayAllDynamicStreamingModes: boolean
  /** `client.streamingModeResolutionsConfiguration.resolutionBadges`, flattened. */
  resolutionBadges: readonly { width: number; height: number; badge: string }[]
}

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  supportedStreamingProfiles: null,
  displayAllDynamicStreamingModes: true,
  resolutionBadges: []
}

/** Everything a row needs to be drawn and a change needs to be judged. */
export interface SettingsContext {
  settings: ClientSettings
  /** Null when the launcher has never been able to ask MES. */
  entitlements: StreamEntitlements | null
  config: ClientConfig
  /** Game languages from GraphQL, or null when they could not be fetched. */
  languages: readonly string[] | null
  /** The launcher's locale, which an "Auto" game language is resolved against. */
  locale: string
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** Every setting with a list of values. The renderer opens a picker for these. */
export type ChoiceField =
  | 'mode'
  | 'resolution'
  | 'fps'
  | 'colorQuality'
  | 'hdr'
  | 'bitrate'
  | 'codec'
  | 'networkAdjust'
  | 'vSync'
  | 'prefilter'
  | 'sharpen'
  | 'denoise'
  | 'upscaling'
  | 'detailEnhancement'
  | 'gameLanguage'
  | 'dlssPreset'
  | 'dlssFgModel'
  | 'dlssSrModel'
  | 'dlssRrModel'
  | 'dlssFgMode'
  | 'dlssFgMultiplier'
  | 'dlssSrMode'
  | 'dlssSrScale'

/** Every on/off setting. The renderer flips these in place. */
export type ToggleField =
  | 'reflex'
  | 'cloudGsync'
  | 'l4s'
  | 'hudStreaming'
  | 'inGameGraphics'
  | 'clipboardPaste'
  | 'networkWarnings'

export type FieldId = ChoiceField | ToggleField

const CHOICE_FIELDS: ReadonlySet<string> = new Set<ChoiceField>([
  'mode',
  'resolution',
  'fps',
  'colorQuality',
  'hdr',
  'bitrate',
  'codec',
  'networkAdjust',
  'vSync',
  'prefilter',
  'sharpen',
  'denoise',
  'upscaling',
  'detailEnhancement',
  'gameLanguage',
  'dlssPreset',
  'dlssFgModel',
  'dlssSrModel',
  'dlssRrModel',
  'dlssFgMode',
  'dlssFgMultiplier',
  'dlssSrMode',
  'dlssSrScale'
])
const TOGGLE_FIELDS: ReadonlySet<string> = new Set<ToggleField>([
  'reflex',
  'cloudGsync',
  'l4s',
  'hudStreaming',
  'inGameGraphics',
  'clipboardPaste',
  'networkWarnings'
])

export interface SettingOption {
  /** What travels back in a change. Strings throughout, so the bridge carries one type. */
  readonly id: string
  readonly label: string
  /**
   * A second fact about this one value, set beside it in the picker — what a
   * bit rate costs per hour, the badge a resolution goes by, what a mode is for.
   */
  readonly detail: string | null
  /** A heading the picker files this value under — the aspect ratio of a resolution. */
  readonly group: string | null
  readonly enabled: boolean
  /** Why it cannot be picked. Null when it can. */
  readonly reason: string | null
}

interface RowBase<F extends FieldId> {
  readonly field: F
  readonly label: string
  readonly description: string
  /** Set when the whole row is inert, and says why — never a silent no. */
  readonly disabledReason: string | null
}

export interface ChoiceRow extends RowBase<ChoiceField> {
  readonly kind: 'choice'
  readonly options: readonly SettingOption[]
  /** The option id that is in effect, or null when the stored value is unreadable. */
  readonly selected: string | null
  /**
   * The values are figures — resolutions, rates, levels — and are set in the
   * mono face, the way every other figure in the launcher is. Words are not.
   */
  readonly figures: boolean
}

export interface ToggleRow extends RowBase<ToggleField> {
  readonly kind: 'toggle'
  readonly value: boolean
}

export type SettingRow = ChoiceRow | ToggleRow

export type SectionId =
  | 'mode'
  | 'picture'
  | 'bandwidth'
  | 'smoothness'
  | 'filters'
  | 'upscaling'
  | 'dlss'
  | 'network'
  | 'gameplay'

export interface SettingSection {
  readonly id: SectionId
  readonly title: string
  /**
   * The fact at the end of the section's rule, when there is one: "used by
   * Custom" on the groups a preset mode chooses for you. Null otherwise.
   */
  readonly note: string | null
  readonly rows: readonly SettingRow[]
}

/**
 * What the next game will stream at, in a sentence's worth of facts — the
 * page's nameplate. Computed from the same reading as the rows, so the two can
 * never disagree.
 */
export interface StreamSummary {
  readonly mode: StreamMode
  readonly modeLabel: string
  readonly modeDescription: string
  /** Set in Custom, where the launcher knows the figures. Null in a preset. */
  readonly resolution: string | null
  readonly fps: number | null
  /** `"100 Mbps"`, or `"Auto"`. Custom only. */
  readonly bitrate: string | null
  readonly codec: string | null
  readonly colour: string | null
  readonly hdr: string | null
  /** GB per hour at the custom bit rate. Null when Auto, or in a preset. */
  readonly dataPerHour: number | null
  /** What a preset asks the server for, its ceiling. Null in Custom or when unknown. */
  readonly cap: { readonly resolution: string; readonly fps: number } | null
}

/** One user action, as it crosses the bridge. Judged by `applyChange` in main. */
export type ClientSettingChange =
  | { readonly field: ChoiceField; readonly value: string }
  | { readonly field: ToggleField; readonly value: boolean }

/**
 * The bridge's check, per CONTRIBUTING: shape only. Whether the value is one
 * the account may have is `applyChange`'s question, asked in main against the
 * file as it is on disk.
 */
export function isClientSettingChange(value: unknown): value is ClientSettingChange {
  if (typeof value !== 'object' || value === null) return false
  const { field, value: payload } = value as { field?: unknown; value?: unknown }
  if (typeof field !== 'string') return false
  if (CHOICE_FIELDS.has(field)) return typeof payload === 'string' && payload.length <= 64
  if (TOGGLE_FIELDS.has(field)) return typeof payload === 'boolean'
  return false
}

/**
 * The streaming page, as main computes it.
 *
 * `sections` is the whole page, rows and reasons included, so the screen draws
 * it without deciding anything. Null when the client's file cannot be read —
 * `error` then says why, and there is nothing to show.
 */
export interface ClientSettingsSnapshot {
  /**
   * Monotonic. The page polls while it is open, and a slow poll must not land
   * after a change's own answer and put the old value back on screen.
   */
  readonly revision: number
  readonly sections: readonly SettingSection[] | null
  /** The nameplate. Null exactly when `sections` is. */
  readonly summary: StreamSummary | null
  /** The membership's tier, for the header. */
  readonly tier: string | null
  /** ISO 8601: when the membership in use was fetched. Null when never. */
  readonly entitlementsAsOf: string | null
  /** Why the last membership refresh failed, when it did. */
  readonly entitlementsError: string | null
  /** ISO 8601: when GeForce NOW last threw the custom profile away, this run. */
  readonly lastReset: string | null
  readonly error: string | null
}

/** What `stream:update` answers: the outcome and the page as it now is. */
export interface ClientSettingResult {
  readonly ok: boolean
  /** The refusal or the failure, in a sentence. Shown under the row. */
  readonly error: string | null
  readonly field: FieldId
  readonly snapshot: ClientSettingsSnapshot
}

// ── Tables, from the client ──────────────────────────────────────────────────

/**
 * Each mode's name, what it is for in four words — the tile — and the
 * sentence the nameplate gives it. The client's own `…Description` strings,
 * tightened for a television.
 */
const MODE_LABELS: Record<StreamMode, { label: string; essence: string; description: string }> = {
  balanced: {
    label: 'Balanced',
    essence: 'Best picture your bandwidth allows',
    description: 'Uses all the bandwidth there is for the best picture and play it allows.'
  },
  dataSaver: {
    label: 'Data Saver',
    essence: 'Least data, still a good picture',
    description: 'Uses as little data as it can while still looking and playing well.'
  },
  competitive: {
    label: 'Competitive',
    essence: 'Lowest latency',
    description: 'Tunes everything for the lowest latency it can reach.'
  },
  cinematic: {
    label: 'Cinematic',
    essence: 'Picture above everything',
    description: 'Puts image quality ahead of everything else.'
  },
  custom: {
    label: 'Custom',
    essence: 'Your own settings',
    description:
      'Streams exactly what is set below. Some combinations can cause connection problems.'
  }
}

/** The client's order: AV1 first, Auto last only in our list because it is the default. */
const CODECS: readonly { value: Codec; label: string }[] = [
  { value: 0, label: 'Auto' },
  { value: 3, label: 'AV1' },
  { value: 2, label: 'H.265' },
  { value: 1, label: 'H.264' }
]

const VSYNCS: readonly { value: VSync; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'On' },
  { value: 2, label: 'Adaptive' }
]

const HDR_LABELS: Record<HdrMode, string> = {
  OFF: 'Off',
  HDR: 'HDR10',
  HDR10_PLUS_GAMING: 'HDR10+ Gaming'
}

const PREFILTERS: readonly { value: PrefilterMode; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Auto' },
  { value: 2, label: 'Custom' }
]

const UPSCALERS: readonly { value: Upscaling; label: string; detail: string }[] = [
  { value: 0, label: 'Standard', detail: 'The most compatible' },
  { value: 1, label: 'Enhanced', detail: 'A better picture' },
  { value: 2, label: 'AI-enhanced', detail: 'The best, on a supported GPU' }
]

/** In the client's order. The stored number is `value`; see `Sharpness`. */
const SHARPNESS: readonly { value: Sharpness; label: string }[] = [
  { value: 4, label: 'Off' },
  { value: 0, label: 'Low' },
  { value: 2, label: 'Medium' },
  { value: 3, label: 'High' }
]

const DLSS_PRESETS: readonly { value: DlssPresetMode; label: string }[] = [
  { value: 'inGame', label: 'Use in-game settings' },
  { value: 'recommended', label: 'Recommended' },
  { value: 'custom', label: 'Custom' }
]

const IN_GAME = 'Use in-game settings'

const DLSS_FG_MODELS = [
  { value: 0, label: IN_GAME },
  { value: 1, label: 'Recommended' },
  { value: 2, label: 'Preset A' },
  { value: 3, label: 'Preset B' }
] as const

const DLSS_SR_MODELS = [
  { value: 0, label: IN_GAME },
  { value: 1, label: 'Recommended' },
  { value: 2, label: 'Preset A' },
  { value: 3, label: 'Preset B' },
  { value: 4, label: 'Preset C' },
  { value: 5, label: 'Preset D' },
  { value: 6, label: 'Preset E' },
  { value: 7, label: 'Preset F' },
  { value: 11, label: 'Preset J' },
  { value: 12, label: 'Preset K' },
  { value: 13, label: 'Preset L' },
  { value: 14, label: 'Preset M' }
] as const

const DLSS_RR_MODELS = [
  { value: 0, label: IN_GAME },
  { value: 1, label: 'Recommended' },
  { value: 5, label: 'Preset D' },
  { value: 7, label: 'Preset F' }
] as const

const DLSS_FG_MODES = [
  { value: 0, label: IN_GAME },
  { value: 1, label: 'Dynamic' }
] as const

const DLSS_SR_MODES = [
  { value: 0, label: IN_GAME },
  { value: 5, label: 'DLAA' },
  { value: 3, label: 'Quality' },
  { value: 2, label: 'Balanced' },
  { value: 1, label: 'Performance' },
  { value: 4, label: 'Ultra performance' },
  { value: 6, label: 'Custom' }
] as const

/** The super-resolution mode that takes a typed scale. */
const DLSS_SR_CUSTOM = 6

/** Input scale per fixed mode (`_0` in the client). Custom starts at 75. */
const DLSS_SR_SCALES: Readonly<Record<number, number>> = {
  0: 100,
  5: 100,
  3: 67,
  2: 58,
  1: 50,
  4: 33
}
const DLSS_SR_CUSTOM_START = 75
const DLSS_SR_SCALE_MIN = 33
const DLSS_SR_SCALE_MAX = 100

/** Every multiplier the client knows; MES says which of them are entitled. */
export const DLSS_FG_MULTIPLIERS: readonly number[] = [3, 4, 5, 6]

/**
 * The aspect-ratio label the client stores beside a resolution — nearest match,
 * in the client's own table and order.
 */
const ASPECT_RATIOS: readonly { ratio: number; label: string }[] = [
  { ratio: 1.6, label: '(16:10)' },
  { ratio: 16 / 9, label: '(16:9)' },
  { ratio: 4 / 3, label: '(4:3)' },
  { ratio: 5 / 4, label: '(5:4)' },
  { ratio: 2.15, label: '(19.5:9)' },
  { ratio: 2.4, label: '(24:10)' },
  { ratio: 32 / 9, label: '(32:9)' },
  { ratio: 3440 / 1440, label: '(21:9)' },
  { ratio: 2560 / 1080, label: '(21:9)' },
  { ratio: 1680 / 720, label: '(21:9)' }
]

export function aspectRatioLabel(width: number, height: number): string {
  const ratio = width / height
  return ASPECT_RATIOS.reduce((best, candidate) =>
    Math.abs(candidate.ratio - ratio) < Math.abs(best.ratio - ratio) ? candidate : best
  ).label
}

/**
 * GB per hour at a frame rate and a bit rate, the client's own estimate.
 *
 * Transcribed from the SDK's formula (`oc` in its vendor bundle); the desktop
 * client asks its native layer, which agrees — 100 Mbps at 60 fps is the 29 GB
 * this machine's file carried, and 95 the 28 the client wrote when the bit rate
 * was changed underneath it.
 */
export function dataUsageGbPerHour(fps: number, mbps: number): number {
  const bits = 1e6 * mbps
  let gb = (3600 * (fps === 120 ? 0.916 * bits + 293098 : 0.678 * bits + 910569)) / 1e9 / 8
  if (fps === 30) gb *= 0.625
  return Math.round(gb * 0.95)
}

/** The bit-rate slider's range when MES has never answered (`J` in the client). */
export const FALLBACK_BITRATE = { min: 5, max: 75 } as const

/** The bit-rate picker's grid. The official slider steps by 1; a list of 96 would not be read. */
export const BITRATE_STEP = 5

// ── Reading ──────────────────────────────────────────────────────────────────

/** The client's built-in Balanced preset, for fields nothing else answers. */
const BUILT_IN_CUSTOM: CustomProfile = {
  width: 1920,
  height: 1080,
  fps: 60,
  maxBitrate: 0,
  maxBitrateAuto: true,
  codec: 0,
  bitDepth: 8,
  chromaFormat: 0,
  hdrStreamingMode: 'OFF',
  vSync: 2,
  reflex: false,
  cloudGsync: false,
  l4sEnabled: false,
  dynamicStreamingMode: 1,
  prefilter: 0,
  sharpen: 0,
  denoise: 0,
  hudStreaming: false
}

/**
 * Where a brand-new custom profile starts.
 *
 * 1920 × 1080 at 60 when the membership allows it, because it is the one mode
 * every decoder and every television handles — the client would otherwise
 * start from its own Balanced, resolved against this machine's display, which
 * the launcher cannot see. Then the largest entitled mode at or under it, then
 * whatever is first.
 */
function seedResolution(entitlements: StreamEntitlements | null): {
  width: number
  height: number
  fps: number
} {
  const list = entitlements?.resolutions ?? []
  const fhd = list.find((r) => r.width === 1920 && r.height === 1080)
  if (fhd) return { width: 1920, height: 1080, fps: fhd.fps.includes(60) ? 60 : (fhd.fps[0] ?? 60) }
  const under = list.find((r) => r.width * r.height <= 1920 * 1080)
  const pick = under ?? list[0]
  if (pick) {
    return {
      width: pick.width,
      height: pick.height,
      fps: pick.fps.includes(60) ? 60 : (pick.fps[0] ?? 60)
    }
  }
  return { width: 1920, height: 1080, fps: 60 }
}

/**
 * The custom profile as the client would stream it: what is stored, with the
 * gaps filled the way the client fills them — from Balanced.
 */
export function effectiveCustom(
  settings: ClientSettings,
  entitlements: StreamEntitlements | null
): CustomProfile {
  const stored = settings.customProfile ?? {}
  const seed = { ...BUILT_IN_CUSTOM, ...seedResolution(entitlements) }
  return { ...seed, ...stored }
}

// ── Building the page ────────────────────────────────────────────────────────

const NOT_ENTITLED = 'Not part of your membership on this client.'
const SIGN_IN = 'Sign in to see what your membership allows.'
const CUSTOM_ONLY = 'Used by the Custom mode — choose Custom to change it.'

function option(
  id: string,
  label: string,
  {
    detail = null,
    group = null,
    reason = null
  }: { detail?: string | null; group?: string | null; reason?: string | null } = {}
): SettingOption {
  return { id, label, detail, group, enabled: reason === null, reason }
}

/**
 * Appends the stored value as a disabled option when the list does not have it.
 *
 * The page is a mirror: a value set in the official app — or one the
 * membership no longer covers — has to be shown as what is in effect, not
 * silently replaced by whatever the list happens to start with.
 */
function withStored(
  options: SettingOption[],
  storedId: string | null,
  label: string,
  reason: string
): SettingOption[] {
  if (storedId === null || options.some((o) => o.id === storedId)) return options
  return [...options, option(storedId, label, { reason })]
}

function resolutionId(width: number, height: number): string {
  return `${width}x${height}`
}

function resolutionLabel(width: number, height: number): string {
  return `${width} × ${height}`
}

function resolutionBadge(width: number, height: number, config: ClientConfig): string | null {
  return (
    config.resolutionBadges.find((b) => b.width === width && b.height === height)?.badge ?? null
  )
}

/** `(16:9)` → `16:9`. The picker's group headings. */
function aspectGroup(width: number, height: number): string {
  return aspectRatioLabel(width, height).replace(/[()]/g, '')
}

/** The order aspect ratios are listed in: the common shapes first. */
const ASPECT_ORDER = ['16:9', '16:10', '21:9', '32:9', '24:10', '19.5:9', '4:3', '5:4']

function colorId(bitDepth: number, chroma: number): string {
  return `${bitDepth}:${chroma}`
}

function colorLabel(bitDepth: number, chroma: number): string {
  return `${bitDepth}-bit, ${chroma === 1 ? '4:4:4' : '4:2:0'}`
}

function languageLabel(locale: string, displayNames: Intl.DisplayNames | null): string {
  try {
    return displayNames?.of(locale.replace('_', '-')) ?? locale
  } catch {
    return locale
  }
}

function makeDisplayNames(): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' })
  } catch {
    return null
  }
}

function choiceRow(row: Omit<ChoiceRow, 'kind' | 'figures'> & { figures?: boolean }): ChoiceRow {
  return { kind: 'choice', figures: false, ...row }
}

function toggleRow(row: Omit<ToggleRow, 'kind'>): ToggleRow {
  return { kind: 'toggle', ...row }
}

function modeSection(context: SettingsContext): SettingSection {
  const { settings, entitlements, config } = context
  const supported = (mode: StreamMode): boolean => config.supportedStreamingProfiles?.[mode] ?? true

  const options = STREAM_MODES.filter(supported).map((mode) => {
    const { label, essence } = MODE_LABELS[mode]
    // Custom streams through the Balanced quality, so it needs that one listed.
    const quality: PresetMode = mode === 'custom' ? 'balanced' : mode
    if (entitlements && !entitlements.modes.includes(quality)) {
      return option(mode, label, { detail: essence, reason: NOT_ENTITLED })
    }
    // A custom profile nobody has set yet is built from the membership — so
    // without one, there is nothing safe to build it from.
    if (mode === 'custom' && settings.customProfile === null && !entitlements) {
      return option(mode, label, { detail: essence, reason: SIGN_IN })
    }
    return option(mode, label, { detail: essence })
  })

  return {
    id: 'mode',
    title: 'Mode',
    note: null,
    rows: [
      choiceRow({
        field: 'mode',
        label: 'Mode',
        description: MODE_LABELS[settings.streamingProfiles].description,
        disabledReason: null,
        options: withStored(
          options,
          settings.streamingProfiles,
          MODE_LABELS[settings.streamingProfiles].label,
          'Not offered on this client.'
        ),
        selected: settings.streamingProfiles
      })
    ]
  }
}

/**
 * The four groups a custom profile is made of, in the order someone thinks
 * about a stream: what it looks like, what it costs, how it feels, what is done
 * to it on the way. The official app lists the same rows in one column.
 */
function customSections(context: SettingsContext): SettingSection[] {
  const { settings, entitlements, config } = context
  const custom = effectiveCustom(settings, entitlements)
  const isCustom = settings.streamingProfiles === 'custom'
  /** The row-level reason that wins over everything: not in Custom at all. */
  const gate = isCustom ? null : CUSTOM_ONLY
  /** For rows the client's reset check covers: no membership answer, no edit. */
  const gated = (reason: string | null): string | null => gate ?? (entitlements ? reason : SIGN_IN)
  const note = isCustom ? null : 'used by Custom'

  // ── Picture
  const resolutions = [...(entitlements?.resolutions ?? [])].sort((a, b) => {
    const ga = ASPECT_ORDER.indexOf(aspectGroup(a.width, a.height))
    const gb = ASPECT_ORDER.indexOf(aspectGroup(b.width, b.height))
    return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb) || b.width * b.height - a.width * a.height
  })
  const current = resolutions.find((r) => r.width === custom.width && r.height === custom.height)
  const hdrOn = custom.hdrStreamingMode !== 'OFF'
  const depths = entitlements?.bitDepths ?? []
  const chromas = entitlements?.chromaFormats ?? []
  const colors: SettingOption[] = []
  for (const depth of [...depths].sort((a, b) => b - a)) {
    for (const chroma of [...chromas].sort((a, b) => b - a)) {
      colors.push(
        option(colorId(depth, chroma), colorLabel(depth, chroma), {
          reason: hdrOn && depth !== 10 ? 'HDR needs 10-bit colour.' : null
        })
      )
    }
  }
  const hdrModes = entitlements?.hdrModes ?? []

  const picture: SettingSection = {
    id: 'picture',
    title: 'Picture',
    note,
    rows: [
      choiceRow({
        field: 'resolution',
        label: 'Resolution',
        description: 'What the game is rendered at. GeForce NOW fits it to your screen.',
        disabledReason: gated(null),
        figures: true,
        options: withStored(
          resolutions.map((r) =>
            option(resolutionId(r.width, r.height), resolutionLabel(r.width, r.height), {
              detail: resolutionBadge(r.width, r.height, config),
              group: aspectGroup(r.width, r.height)
            })
          ),
          resolutionId(custom.width, custom.height),
          resolutionLabel(custom.width, custom.height),
          entitlements ? NOT_ENTITLED : SIGN_IN
        ),
        selected: resolutionId(custom.width, custom.height)
      }),
      choiceRow({
        field: 'fps',
        label: 'Frame rate',
        description: 'Frames per second, as many as the resolution allows.',
        disabledReason: gated(null),
        figures: true,
        options: withStored(
          (current?.fps ?? []).map((fps) => option(String(fps), `${fps} fps`)),
          String(custom.fps),
          `${custom.fps} fps`,
          entitlements ? 'Not offered at this resolution by your membership.' : SIGN_IN
        ),
        selected: String(custom.fps)
      }),
      choiceRow({
        field: 'colorQuality',
        label: 'Colour quality',
        description:
          'More bits and 4:4:4 look better and need more from the connection and this computer.',
        disabledReason: gated(null),
        options: withStored(
          colors,
          colorId(custom.bitDepth, custom.chromaFormat),
          colorLabel(custom.bitDepth, custom.chromaFormat),
          entitlements ? NOT_ENTITLED : SIGN_IN
        ),
        selected: colorId(custom.bitDepth, custom.chromaFormat)
      }),
      choiceRow({
        field: 'hdr',
        label: 'HDR',
        description: 'Needs an HDR display; GeForce NOW turns it off at launch on one that is not.',
        disabledReason: gated(null),
        options: HDR_MODES.map((mode) =>
          option(mode, HDR_LABELS[mode], {
            reason:
              mode === 'OFF'
                ? null
                : !hdrModes.includes(mode)
                  ? NOT_ENTITLED
                  : !depths.includes(10)
                    ? 'Needs 10-bit colour, which your membership does not include.'
                    : null
          })
        ),
        selected: custom.hdrStreamingMode
      })
    ]
  }

  // ── Bandwidth. The bit rate is not part of the reset check, so it does not
  // need the membership to be edited — only to know how far it goes.
  const range = entitlements?.bitrate ?? FALLBACK_BITRATE
  const rates = new Set<number>([range.max, range.min])
  for (
    let rate = Math.ceil(range.min / BITRATE_STEP) * BITRATE_STEP;
    rate < range.max;
    rate += BITRATE_STEP
  ) {
    rates.add(rate)
  }
  // A value set with the official app's slider is listed where it falls, so
  // the row and the picker both show exactly what is stored.
  if (!custom.maxBitrateAuto && custom.maxBitrate > 0) rates.add(custom.maxBitrate)
  const adjustOptions = config.displayAllDynamicStreamingModes
    ? [
        option('1', 'Optimal latency', { detail: 'Lowers the resolution first' }),
        option('2', 'Optimal quality', { detail: 'Lowers the frame rate first' }),
        option('0', 'No adjustment')
      ]
    : [option('3', 'On'), option('0', 'Off')]

  const bandwidth: SettingSection = {
    id: 'bandwidth',
    title: 'Bandwidth',
    note,
    rows: [
      choiceRow({
        field: 'bitrate',
        label: 'Max bit rate',
        description: 'A ceiling for the stream. Lower it on a busy or metered connection.',
        disabledReason: gate,
        figures: true,
        options: [
          option('auto', 'Auto', { detail: 'GeForce NOW decides' }),
          ...[...rates]
            .sort((a, b) => b - a)
            .map((rate) =>
              option(String(rate), `${rate} Mbps`, {
                detail: `~${dataUsageGbPerHour(custom.fps, rate)} GB an hour`
              })
            )
        ],
        selected:
          custom.maxBitrateAuto || custom.maxBitrate <= 0 ? 'auto' : String(custom.maxBitrate)
      }),
      choiceRow({
        field: 'codec',
        label: 'Codec',
        description:
          'Auto picks the best one this computer can decode, and so does a fallback at launch.',
        disabledReason: gate,
        options: CODECS.map((c) => option(String(c.value), c.label)),
        selected: String(custom.codec)
      }),
      choiceRow({
        field: 'networkAdjust',
        label: 'Adjust for network conditions',
        description: 'What gives first when the connection gets worse.',
        disabledReason: gate,
        options: withStored(
          adjustOptions,
          String(custom.dynamicStreamingMode),
          `Mode ${custom.dynamicStreamingMode}`,
          'Not offered on this client.'
        ),
        selected: String(custom.dynamicStreamingMode)
      }),
      toggleRow({
        field: 'l4s',
        label: 'L4S',
        description: 'Low-latency queueing, on networks that support it.',
        disabledReason: gated(
          !entitlements?.l4s
            ? NOT_ENTITLED
            : custom.dynamicStreamingMode === 0
              ? 'Turn on Adjust for network conditions first.'
              : null
        ),
        value: custom.l4sEnabled
      })
    ]
  }

  // ── Smoothness
  const smoothness: SettingSection = {
    id: 'smoothness',
    title: 'Smoothness',
    note,
    rows: [
      choiceRow({
        field: 'vSync',
        label: 'VSync',
        description: 'Adaptive stops tearing without the latency of On.',
        disabledReason: gate,
        options: VSYNCS.map((v) => option(String(v.value), v.label)),
        selected: String(custom.vSync)
      }),
      toggleRow({
        field: 'reflex',
        label: 'Reflex',
        description:
          'Lower latency at high frame rates or with a VRR display; off at launch otherwise.',
        disabledReason: gated(
          !entitlements?.reflex
            ? NOT_ENTITLED
            : custom.cloudGsync
              ? 'Stays on while VRR display is on.'
              : null
        ),
        value: custom.reflex
      }),
      toggleRow({
        field: 'cloudGsync',
        label: 'VRR display (G-SYNC)',
        description:
          'For a variable refresh rate display. Needs VSync on Adaptive and 60 fps or more.',
        disabledReason: gated(
          !entitlements?.cloudGsync
            ? NOT_ENTITLED
            : custom.cloudGsync
              ? null
              : custom.vSync !== 2
                ? 'Set VSync to Adaptive first.'
                : custom.fps < 60
                  ? 'Set the frame rate to 60 fps or more first.'
                  : null
        ),
        value: custom.cloudGsync
      })
    ]
  }

  // ── Filters
  const prefilterModes = entitlements?.prefilterModes ?? []
  const levels = Array.from({ length: 11 }, (_, i) => option(String(i), String(i)))
  const filters: SettingSection = {
    id: 'filters',
    title: 'Filters',
    note,
    rows: [
      choiceRow({
        field: 'prefilter',
        label: 'AI video filter',
        description: 'Cleans the picture up before it is sent. Custom sets how much, below.',
        disabledReason: gated(null),
        options: PREFILTERS.map((p) =>
          option(String(p.value), p.label, {
            reason: p.value === 0 || prefilterModes.includes(p.value) ? null : NOT_ENTITLED
          })
        ),
        selected: String(custom.prefilter)
      }),
      ...(['sharpen', 'denoise'] as const).map((field) =>
        choiceRow({
          field,
          label: field === 'sharpen' ? 'Sharpen' : 'Denoise',
          description:
            field === 'sharpen'
              ? 'How much the filter sharpens, 0 to 10.'
              : 'How much noise it removes, 0 to 10.',
          disabledReason:
            gate ??
            (entitlements
              ? custom.prefilter === 2
                ? null
                : 'Set the AI video filter to Custom first.'
              : SIGN_IN),
          figures: true,
          options: levels,
          selected: String(custom[field])
        })
      ),
      toggleRow({
        field: 'hudStreaming',
        label: 'HUD sharpness filter',
        description: 'Keeps text and the HUD crisp, in games that support it.',
        disabledReason: gated(entitlements?.hud ? null : NOT_ENTITLED),
        value: custom.hudStreaming
      })
    ]
  }

  return [picture, bandwidth, smoothness, filters]
}

function upscalingSection(context: SettingsContext): SettingSection {
  const { settings } = context
  const upscaling = settings.upScalingResolutionId
  const sharpness = upscaling === 2 ? settings.aiSharpnessValue : settings.enhancedSharpnessValue

  return {
    id: 'upscaling',
    title: 'Upscaling',
    note: null,
    rows: [
      choiceRow({
        field: 'upscaling',
        label: 'Resolution upscaling',
        description: 'How the stream is fitted to your screen when the two resolutions differ.',
        disabledReason: null,
        options: UPSCALERS.map((u) => option(String(u.value), u.label, { detail: u.detail })),
        selected: String(upscaling)
      }),
      choiceRow({
        field: 'detailEnhancement',
        label: 'Detail enhancement',
        description: 'Sharpening applied while upscaling.',
        disabledReason: upscaling === 0 ? 'Only with Enhanced or AI-enhanced upscaling.' : null,
        options: SHARPNESS.map((s) => option(String(s.value), s.label)),
        selected: String(sharpness)
      })
    ]
  }
}

function dlssSection(context: SettingsContext): SettingSection | null {
  const ent = context.entitlements?.dlss
  if (!ent || (!ent.frameGeneration && !ent.superResolution && !ent.rayReconstruction)) return null

  const dlss = context.settings.dlssOverrides
  const custom = dlss.modelPresetMode === 'custom'
  const fromPreset =
    dlss.modelPresetMode === 'recommended'
      ? 'Set by Model presets (Recommended). Choose Custom there to pick a model.'
      : 'Set by Model presets (in-game settings). Choose Custom there to pick a model.'
  const models = <T extends { value: number; label: string }>(
    list: readonly T[]
  ): SettingOption[] => list.map((m) => option(String(m.value), m.label))

  const rows: SettingRow[] = [
    choiceRow({
      field: 'dlssPreset',
      label: 'Model presets',
      description: 'Overrides the DLSS settings of compatible games while you play them.',
      disabledReason: null,
      options: DLSS_PRESETS.map((p) => option(p.value, p.label)),
      selected: dlss.modelPresetMode
    })
  ]

  if (ent.frameGeneration) {
    rows.push(
      choiceRow({
        field: 'dlssFgModel',
        label: 'Frame generation',
        description: 'The frame generation model.',
        disabledReason: custom ? null : fromPreset,
        options: models(DLSS_FG_MODELS),
        selected: String(dlss.fgModel)
      })
    )
  }
  if (ent.superResolution) {
    rows.push(
      choiceRow({
        field: 'dlssSrModel',
        label: 'Super resolution',
        description: 'The super resolution model.',
        disabledReason: custom ? null : fromPreset,
        options: models(DLSS_SR_MODELS),
        selected: String(dlss.srModel)
      })
    )
  }
  if (ent.rayReconstruction) {
    rows.push(
      choiceRow({
        field: 'dlssRrModel',
        label: 'Ray reconstruction',
        description: 'The ray reconstruction model.',
        disabledReason: custom ? null : fromPreset,
        options: models(DLSS_RR_MODELS),
        selected: String(dlss.rrModel)
      })
    )
  }
  if (ent.frameGeneration) {
    const multipliers = DLSS_FG_MULTIPLIERS.filter((m) =>
      ent.frameGenerationMultipliers.includes(m)
    )
    rows.push(
      choiceRow({
        field: 'dlssFgMode',
        label: 'Frame generation mode',
        description: 'Dynamic generates frames only as needed to reach the target frame rate.',
        disabledReason: null,
        options: models(DLSS_FG_MODES),
        selected: String(dlss.fgMode)
      }),
      choiceRow({
        field: 'dlssFgMultiplier',
        label: 'Multiplier',
        description: 'How many frames Dynamic may generate for each one rendered.',
        disabledReason:
          dlss.fgMode !== 1
            ? 'Only with frame generation mode on Dynamic.'
            : multipliers.length === 0
              ? NOT_ENTITLED
              : null,
        figures: true,
        options: multipliers.map((m) => option(String(m), `Up to ${m}×`)),
        selected: dlss.fgMultiplier === null ? null : String(dlss.fgMultiplier)
      })
    )
  }
  if (ent.superResolution) {
    const scale = DLSS_SR_SCALES[dlss.srMode] ?? dlss.srScale
    const scales = new Set<number>([DLSS_SR_SCALE_MAX, DLSS_SR_SCALE_MIN, scale])
    for (let s = 35; s < DLSS_SR_SCALE_MAX; s += 5) scales.add(s)
    rows.push(
      choiceRow({
        field: 'dlssSrMode',
        label: 'Super resolution mode',
        description: 'How much of the picture the game renders before DLSS scales it up.',
        disabledReason: null,
        options: models(DLSS_SR_MODES),
        selected: String(dlss.srMode)
      }),
      choiceRow({
        field: 'dlssSrScale',
        label: 'Input resolution',
        description: 'The render scale. Only the Custom mode takes one of your own.',
        disabledReason:
          dlss.srMode === DLSS_SR_CUSTOM ? null : 'Set super resolution mode to Custom first.',
        figures: true,
        options: [...scales].sort((a, b) => b - a).map((s) => option(String(s), `${s}%`)),
        selected: String(scale)
      })
    )
  }

  return { id: 'dlss', title: 'DLSS overrides', note: null, rows }
}

function networkSection(context: SettingsContext): SettingSection {
  return {
    id: 'network',
    title: 'Network',
    note: null,
    rows: [
      toggleRow({
        field: 'networkWarnings',
        label: 'Network warnings',
        description: 'Shows a warning during play when the connection is struggling.',
        disabledReason: null,
        value: context.settings.networkQuality === 1
      })
    ]
  }
}

function gameplaySection(context: SettingsContext): SettingSection {
  const { settings, entitlements, languages, locale } = context
  const names = makeDisplayNames()
  const stored = settings.preferredGameLanguage
  const isAuto = stored === null || stored.startsWith('auto-')
  const autoLocale = isAuto && stored !== null ? stored.slice('auto-'.length) : locale

  const languageOptions: SettingOption[] = [
    option('auto', 'Auto', { detail: languageLabel(autoLocale, names) }),
    ...(languages ?? [])
      .map((l) => option(l, languageLabel(l, names)))
      .sort((a, b) => a.label.localeCompare(b.label, 'en'))
  ]

  return {
    id: 'gameplay',
    title: 'Gameplay',
    note: null,
    rows: [
      toggleRow({
        field: 'inGameGraphics',
        label: 'Keep my in-game graphics settings',
        description: 'Off uses NVIDIA’s recommended graphics settings every time a game starts.',
        disabledReason: entitlements
          ? entitlements.inGameGraphics
            ? null
            : NOT_ENTITLED
          : SIGN_IN,
        value: settings.inGameGraphics
      }),
      toggleRow({
        field: 'clipboardPaste',
        label: 'Paste into games',
        description: 'Ctrl+V pastes text from this computer into a game. NVIDIA does not store it.',
        disabledReason: null,
        value: settings.clipboardPaste
      }),
      choiceRow({
        field: 'gameLanguage',
        label: 'Game language',
        description: 'The language games use, when they can.',
        disabledReason:
          languages === null ? 'Sign in to load the languages GeForce NOW offers.' : null,
        options: withStored(
          languageOptions,
          isAuto ? 'auto' : stored,
          isAuto ? 'Auto' : languageLabel(stored ?? '', names),
          'Not offered any more.'
        ),
        selected: isAuto ? 'auto' : stored
      })
    ]
  }
}

/**
 * The whole page: the mode, the four groups a custom profile is made of, then
 * what applies whatever the mode. Computed in main and sent whole, so the
 * screen stays presentational and the rows it draws are exactly the rows
 * `applyChange` judges against.
 */
export function settingSections(context: SettingsContext): SettingSection[] {
  const sections = [
    modeSection(context),
    ...customSections(context),
    upscalingSection(context),
    dlssSection(context),
    networkSection(context),
    gameplaySection(context)
  ]
  return sections.filter((section): section is SettingSection => section !== null)
}

/** The nameplate: what the next game will stream at. */
export function streamSummary(context: SettingsContext): StreamSummary {
  const { settings, entitlements } = context
  const mode = settings.streamingProfiles
  const { label, description } = MODE_LABELS[mode]
  if (mode !== 'custom') {
    const preset = entitlements?.presets[mode]
    return {
      mode,
      modeLabel: label,
      modeDescription: description,
      resolution: null,
      fps: null,
      bitrate: null,
      codec: null,
      colour: null,
      hdr: null,
      dataPerHour: null,
      cap: preset
        ? { resolution: resolutionLabel(preset.width, preset.height), fps: preset.fps }
        : null
    }
  }

  const custom = effectiveCustom(settings, entitlements)
  const auto = custom.maxBitrateAuto || custom.maxBitrate <= 0
  return {
    mode,
    modeLabel: label,
    modeDescription: description,
    resolution: resolutionLabel(custom.width, custom.height),
    fps: custom.fps,
    bitrate: auto ? 'Auto' : `${custom.maxBitrate} Mbps`,
    codec: CODECS.find((c) => c.value === custom.codec)?.label ?? 'Auto',
    colour: colorLabel(custom.bitDepth, custom.chromaFormat),
    hdr: HDR_LABELS[custom.hdrStreamingMode],
    dataPerHour: auto ? null : dataUsageGbPerHour(custom.fps, custom.maxBitrate),
    cap: null
  }
}

// ── Changing ─────────────────────────────────────────────────────────────────

/**
 * What a change writes. Top-level fields by their wire names, and the fields of
 * `customProfile` to merge into whatever is stored.
 */
export interface ClientSettingsPatch {
  readonly appSettings: Readonly<Record<string, unknown>>
  readonly customProfile: Readonly<Record<string, unknown>> | null
}

export type ChangeResult =
  | { readonly ok: true; readonly patch: ClientSettingsPatch }
  | { readonly ok: false; readonly error: string }

function findRow(sections: readonly SettingSection[], field: FieldId): SettingRow | null {
  for (const section of sections) {
    for (const row of section.rows) if (row.field === field) return row
  }
  return null
}

/** The fields the client needs spelled out, which a partial stored profile may lack. */
const EXPLICIT_FIELDS = ['width', 'height', 'fps', 'hdrStreamingMode'] as const

/**
 * A `customProfile` patch, completed so the client can never misread it.
 *
 * Two traps decide what "complete" means. With no stored profile at all, the
 * launch path fills gaps from the Balanced preset — but `hdrStreamingMode` is
 * not in that preset, and a missing one reads as *not OFF*, which requests HDR.
 * And the reset check matches width × height × fps exactly. So those four are
 * always written, and a profile created from nothing is written whole.
 */
function customPatch(
  context: SettingsContext,
  fields: Partial<CustomProfile>
): Record<string, unknown> {
  const stored = context.settings.customProfile
  const base = effectiveCustom(context.settings, context.entitlements)
  const next: CustomProfile = { ...base, ...fields }
  const patch: Record<string, unknown> = stored === null ? { ...next } : { ...fields }
  for (const key of EXPLICIT_FIELDS) {
    if (stored === null || stored[key] === undefined) patch[key] = next[key]
  }
  // Display-only, but the official app shows them, so keep them truthful.
  if ('width' in patch || 'height' in patch) {
    patch.aspectRatio = aspectRatioLabel(next.width, next.height)
  }
  if (('fps' in patch || 'maxBitrate' in patch) && !next.maxBitrateAuto && next.maxBitrate > 0) {
    patch.dataUsage = dataUsageGbPerHour(next.fps, next.maxBitrate)
  }
  return patch
}

function custom(context: SettingsContext, fields: Partial<CustomProfile>): ChangeResult {
  return { ok: true, patch: { appSettings: {}, customProfile: customPatch(context, fields) } }
}

function top(appSettings: Record<string, unknown>): ChangeResult {
  return { ok: true, patch: { appSettings, customProfile: null } }
}

/**
 * Turns one action into what gets written — the client's cascades included —
 * after checking it against the page as it would be drawn right now.
 *
 * Main calls this with the file it has just read and the membership it holds,
 * so a stale screen, a hand-built IPC call or a membership that changed since
 * the page was drawn all meet the same refusal, with a sentence.
 */
export function applyChange(context: SettingsContext, change: ClientSettingChange): ChangeResult {
  const row = findRow(settingSections(context), change.field)
  if (!row) return { ok: false, error: 'That setting is not available on this client.' }
  if (row.disabledReason) return { ok: false, error: row.disabledReason }

  if (row.kind === 'choice') {
    const picked = row.options.find((o) => o.id === change.value)
    if (!picked) return { ok: false, error: 'That value is not offered.' }
    if (!picked.enabled) return { ok: false, error: picked.reason ?? 'That value is not offered.' }
  }
  const c = effectiveCustom(context.settings, context.entitlements)
  const ent = context.entitlements

  switch (change.field) {
    case 'mode': {
      const mode = change.value as StreamMode
      if (mode === 'custom' && context.settings.customProfile === null) {
        // Selecting Custom with nothing stored writes a whole profile, built
        // from the membership, in the same write that flips the mode.
        return {
          ok: true,
          patch: {
            appSettings: { streamingProfiles: mode },
            customProfile: customPatch(context, {})
          }
        }
      }
      return top({ streamingProfiles: mode })
    }

    case 'resolution': {
      const [width, height] = change.value.split('x').map(Number)
      const allowed = ent?.resolutions.find((r) => r.width === width && r.height === height)
      // Keep the frame rate when the new resolution allows it; otherwise the
      // highest it does, which is the first in the list.
      const fps = allowed && !allowed.fps.includes(c.fps) ? allowed.fps[0] : c.fps
      return custom(context, { width, height, fps })
    }

    case 'fps': {
      const fps = Number(change.value)
      // VRR needs 60 or more; the client switches it off below that.
      return custom(context, fps < 60 && c.cloudGsync ? { fps, cloudGsync: false } : { fps })
    }

    case 'bitrate':
      // One row for what the official app splits across a switch and a slider:
      // Auto, or a ceiling — and choosing a ceiling is what turns Auto off.
      return custom(
        context,
        change.value === 'auto'
          ? { maxBitrateAuto: true, maxBitrate: 0 }
          : { maxBitrateAuto: false, maxBitrate: Number(change.value) }
      )

    case 'codec':
      return custom(context, { codec: Number(change.value) as Codec })

    case 'colorQuality': {
      const [bitDepth, chromaFormat] = change.value.split(':').map(Number) as [8 | 10, 0 | 1]
      return custom(context, { bitDepth, chromaFormat })
    }

    case 'hdr': {
      const hdrStreamingMode = change.value as HdrMode
      // Choosing HDR moves colour to 10-bit, as the client's editor does.
      return custom(
        context,
        hdrStreamingMode === 'OFF' ? { hdrStreamingMode } : { hdrStreamingMode, bitDepth: 10 }
      )
    }

    case 'vSync': {
      const vSync = Number(change.value) as VSync
      // VRR rides on Adaptive; changing VSync away from it turns VRR off, as
      // the client's in-stream overlay does.
      return custom(context, vSync !== 2 && c.cloudGsync ? { vSync, cloudGsync: false } : { vSync })
    }

    case 'reflex':
      return custom(context, { reflex: change.value as boolean })

    case 'cloudGsync':
      // VRR forces Reflex on and keeps it there.
      return custom(
        context,
        change.value ? { cloudGsync: true, reflex: true } : { cloudGsync: false }
      )

    case 'l4s':
      return custom(context, { l4sEnabled: change.value as boolean })

    case 'networkAdjust':
      return custom(context, { dynamicStreamingMode: Number(change.value) as NetworkAdjust })

    case 'prefilter':
      return custom(context, { prefilter: Number(change.value) as PrefilterMode })

    case 'sharpen':
      return custom(context, { sharpen: Number(change.value) })

    case 'denoise':
      return custom(context, { denoise: Number(change.value) })

    case 'hudStreaming':
      return custom(context, { hudStreaming: change.value as boolean })

    case 'upscaling':
      // Without the flag the client resets the mode to its default at every
      // start, which would make this row lie the next day.
      return top({ upScalingResolutionId: Number(change.value), upscalingModeUpdatedByUser: true })

    case 'detailEnhancement':
      return top(
        context.settings.upScalingResolutionId === 2
          ? { aiSharpnessValue: Number(change.value) }
          : { enhancedSharpnessValue: Number(change.value) }
      )

    case 'gameLanguage':
      return top({
        preferredGameLanguage: change.value === 'auto' ? `auto-${context.locale}` : change.value
      })

    case 'inGameGraphics':
      return top({ inGameGraphics: change.value })

    case 'clipboardPaste':
      return top({ clipboardPaste: change.value })

    case 'networkWarnings':
      return top({ networkQuality: change.value ? 1 : 0 })

    case 'dlssPreset':
    case 'dlssFgModel':
    case 'dlssSrModel':
    case 'dlssRrModel':
    case 'dlssFgMode':
    case 'dlssFgMultiplier':
    case 'dlssSrMode':
    case 'dlssSrScale':
      return top({ dlssOverrides: nextDlss(context, change) })
  }
}

/**
 * The DLSS overrides after one change, transcribed handler by handler from the
 * client's DLSS component (`onModelPresetModeChanged` and friends). The shape
 * of the rules is theirs: a model of 0 means "the game decides" and forces its
 * mode to 0 with it; a mode other than 0 needs a model, so it picks Recommended
 * and leaves "in-game" for Custom; Custom remembers the models it had.
 */
function nextDlss(context: SettingsContext, change: ClientSettingChange): DlssOverrides {
  const s = context.settings.dlssOverrides
  const ent = context.entitlements?.dlss
  const fg = ent?.frameGeneration ?? false
  const sr = ent?.superResolution ?? false
  const rr = ent?.rayReconstruction ?? false
  const value = change.value
  const n: DlssOverrides = { ...s }

  switch (change.field) {
    case 'dlssPreset': {
      const preset = value as DlssPresetMode
      n.modelPresetMode = preset
      if (preset === 'custom') {
        if (fg) {
          n.fgModel = s.customFgModel
          if (n.fgModel === 0) n.fgMode = 0
        }
        if (sr) {
          n.srModel = s.customSrModel
          if (n.srModel === 0) {
            n.srMode = 0
            n.srScale = DLSS_DEFAULTS.srScale
          }
        }
        if (rr) n.rrModel = s.customRrModel
        break
      }
      if (s.modelPresetMode === 'custom') {
        if (fg) n.customFgModel = s.fgModel
        if (sr) n.customSrModel = s.srModel
        if (rr) n.customRrModel = s.rrModel
      }
      const model = preset === 'recommended' ? 1 : 0
      if (fg) {
        n.fgModel = model
        if (model === 0) n.fgMode = 0
      }
      if (sr) {
        n.srModel = model
        if (model === 0) {
          n.srMode = 0
          n.srScale = DLSS_DEFAULTS.srScale
        }
      }
      if (rr) n.rrModel = model
      break
    }
    case 'dlssFgModel': {
      const model = Number(value)
      n.fgModel = model
      n.customFgModel = model
      if (model === 0) n.fgMode = 0
      break
    }
    case 'dlssSrModel': {
      const model = Number(value)
      n.srModel = model
      n.customSrModel = model
      if (model === 0) {
        n.srMode = 0
        n.srScale = DLSS_DEFAULTS.srScale
      }
      break
    }
    case 'dlssRrModel': {
      const model = Number(value)
      n.rrModel = model
      n.customRrModel = model
      break
    }
    case 'dlssFgMode': {
      const mode = Number(value)
      n.fgMode = mode
      if (mode !== 0) {
        if (s.modelPresetMode === 'inGame' || s.fgModel === 0) {
          n.fgModel = 1
          n.customFgModel = 1
        }
        if (s.modelPresetMode === 'inGame') n.modelPresetMode = 'custom'
        const multipliers = ent?.frameGenerationMultipliers ?? []
        if (n.fgMultiplier === null || !multipliers.includes(n.fgMultiplier)) {
          n.fgMultiplier = multipliers.length > 0 ? Math.min(...multipliers) : null
        }
      }
      break
    }
    case 'dlssFgMultiplier':
      n.fgMultiplier = Number(value)
      break
    case 'dlssSrMode': {
      const mode = Number(value)
      n.srMode = mode
      n.srScale =
        mode === DLSS_SR_CUSTOM ? DLSS_SR_CUSTOM_START : (DLSS_SR_SCALES[mode] ?? s.srScale)
      if (mode !== 0) {
        if (s.modelPresetMode === 'inGame' || s.srModel === 0) {
          n.srModel = 1
          n.customSrModel = 1
        }
        if (rr && (s.modelPresetMode === 'inGame' || s.rrModel === 0)) {
          n.rrModel = 1
          n.customRrModel = 1
        }
        if (s.modelPresetMode === 'inGame') n.modelPresetMode = 'custom'
      }
      break
    }
    case 'dlssSrScale':
      n.srScale = Number(value)
      break
    default:
      break
  }

  return n
}
