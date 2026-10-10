import { describe, expect, it } from 'vitest'
import {
  applyChange,
  aspectRatioLabel,
  DEFAULT_CLIENT_CONFIG,
  DLSS_DEFAULTS,
  dataUsageGbPerHour,
  effectiveCustom,
  isClientSettingChange,
  settingSections,
  streamSummary,
  type ChoiceRow,
  type ClientSettingChange,
  type ClientSettings,
  type FieldId,
  type SettingRow,
  type SettingsContext,
  type StreamEntitlements
} from './clientSettings'

/** What MES answered for an Ultimate account on the Linux client, trimmed. */
const ULTIMATE: StreamEntitlements = {
  tier: 'ULTIMATE',
  modes: ['balanced', 'dataSaver', 'competitive', 'cinematic'],
  resolutions: [
    { width: 3840, height: 2160, fps: [120, 60, 30] },
    { width: 2560, height: 1440, fps: [240, 120, 60, 30] },
    { width: 1920, height: 1080, fps: [360, 240, 120, 60, 30] },
    { width: 1280, height: 720, fps: [120, 60, 30] }
  ],
  bitrate: { min: 5, max: 100 },
  bitDepths: [10, 8],
  chromaFormats: [0, 1],
  hdrModes: [],
  hdrEntitled: true,
  reflex: true,
  cloudGsync: false,
  l4s: true,
  hud: true,
  inGameGraphics: true,
  prefilterModes: [0, 1, 2],
  dlss: {
    superResolution: false,
    rayReconstruction: false,
    frameGeneration: false,
    frameGenerationMultipliers: []
  },
  presets: {}
}

function settings(overrides: Partial<ClientSettings> = {}): ClientSettings {
  return {
    streamingProfiles: 'custom',
    customProfile: {
      width: 3840,
      height: 2160,
      fps: 60,
      maxBitrate: 100,
      maxBitrateAuto: false,
      codec: 0,
      bitDepth: 10,
      chromaFormat: 0,
      hdrStreamingMode: 'OFF',
      vSync: 0,
      reflex: false,
      cloudGsync: false,
      l4sEnabled: true,
      dynamicStreamingMode: 0,
      prefilter: 1,
      sharpen: 0,
      denoise: 0,
      hudStreaming: true
    },
    networkQuality: 1,
    clipboardPaste: true,
    inGameGraphics: true,
    preferredGameLanguage: null,
    upScalingResolutionId: 1,
    enhancedSharpnessValue: 0,
    aiSharpnessValue: 0,
    dlssOverrides: { ...DLSS_DEFAULTS },
    ...overrides
  }
}

function context(overrides: Partial<SettingsContext> = {}): SettingsContext {
  return {
    settings: settings(),
    entitlements: ULTIMATE,
    config: DEFAULT_CLIENT_CONFIG,
    languages: ['en_US', 'it_IT'],
    locale: 'en_US',
    ...overrides
  }
}

function row(ctx: SettingsContext, field: FieldId): SettingRow {
  for (const section of settingSections(ctx)) {
    for (const candidate of section.rows) if (candidate.field === field) return candidate
  }
  throw new Error(`no row ${field}`)
}

function choice(ctx: SettingsContext, field: FieldId): ChoiceRow {
  const found = row(ctx, field)
  if (found.kind !== 'choice') throw new Error(`${field} is not a choice`)
  return found
}

function patchOf(ctx: SettingsContext, change: ClientSettingChange): Record<string, unknown> {
  const result = applyChange(ctx, change)
  if (!result.ok) throw new Error(result.error)
  return { ...result.patch.appSettings, ...(result.patch.customProfile ?? {}) }
}

describe('isClientSettingChange', () => {
  it('accepts the three shapes', () => {
    expect(isClientSettingChange({ field: 'resolution', value: '1920x1080' })).toBe(true)
    expect(isClientSettingChange({ field: 'reflex', value: true })).toBe(true)
    expect(isClientSettingChange({ field: 'bitrate', value: '45' })).toBe(true)
  })

  it('rejects anything else', () => {
    for (const bad of [
      null,
      'reflex',
      { field: 'reflex', value: 'true' },
      { field: 'bitrate', value: 45 },
      { field: 'bitrateMode', value: 'auto' },
      { field: 'resolution', value: 1920 },
      { field: 'resolution', value: 'x'.repeat(65) },
      { field: 'networkInfo', value: 'aa:bb' },
      { value: true }
    ]) {
      expect(isClientSettingChange(bad)).toBe(false)
    }
  })
})

describe('the client’s own formulas', () => {
  // Read off a real file: 100 Mbps at 60 fps carried 29, and 95 the 28 the
  // client wrote back when the bit rate was changed underneath it.
  it('estimates data usage as the client does', () => {
    expect(dataUsageGbPerHour(60, 100)).toBe(29)
    expect(dataUsageGbPerHour(60, 95)).toBe(28)
    expect(dataUsageGbPerHour(30, 100)).toBeLessThan(dataUsageGbPerHour(60, 100))
    expect(dataUsageGbPerHour(120, 100)).toBeGreaterThan(dataUsageGbPerHour(60, 100))
  })

  it('labels the aspect ratio by the nearest of the client’s table', () => {
    expect(aspectRatioLabel(3840, 2160)).toBe('(16:9)')
    expect(aspectRatioLabel(1920, 1200)).toBe('(16:10)')
    expect(aspectRatioLabel(3440, 1440)).toBe('(21:9)')
    expect(aspectRatioLabel(2560, 1080)).toBe('(21:9)')
    expect(aspectRatioLabel(5120, 1440)).toBe('(32:9)')
    expect(aspectRatioLabel(1024, 768)).toBe('(4:3)')
  })
})

describe('settingSections', () => {
  it('lays the page out in the official app’s order', () => {
    expect(settingSections(context()).map((s) => s.id)).toEqual([
      'mode',
      'picture',
      'bandwidth',
      'smoothness',
      'filters',
      'upscaling',
      'network',
      'gameplay'
    ])
  })

  it('offers the resolutions and frame rates the membership allows', () => {
    expect(choice(context(), 'resolution').options.map((o) => o.id)).toEqual([
      '3840x2160',
      '2560x1440',
      '1920x1080',
      '1280x720'
    ])
    expect(choice(context(), 'fps').options.map((o) => o.id)).toEqual(['120', '60', '30'])
  })

  // A mirror shows what is in effect, even when it is not something this page
  // would offer — otherwise the screen and the official app disagree.
  it('shows a stored value the membership does not cover, disabled, with why', () => {
    const ctx = context({
      settings: settings({
        customProfile: { ...settings().customProfile, width: 5120, height: 2880 }
      })
    })
    const resolution = choice(ctx, 'resolution')
    expect(resolution.selected).toBe('5120x2880')
    expect(resolution.options.at(-1)).toMatchObject({ id: '5120x2880', enabled: false })
    expect(resolution.options.at(-1)?.reason).toMatch(/membership/)
  })

  it('keeps the custom rows in place outside Custom, and says why they are off', () => {
    const ctx = context({ settings: settings({ streamingProfiles: 'balanced' }) })
    for (const field of ['resolution', 'fps', 'bitrate', 'codec', 'reflex'] as const) {
      expect(row(ctx, field).disabledReason).toMatch(/Custom/)
    }
    expect(row(ctx, 'upscaling').disabledReason).toBeNull()
  })

  // Without the membership there is no knowing what the reset check accepts,
  // so the fields it covers are closed; the rest are not.
  it('closes the fields the reset check covers when there is no membership answer', () => {
    const ctx = context({ entitlements: null })
    for (const field of ['resolution', 'fps', 'colorQuality', 'hdr', 'reflex', 'l4s'] as const) {
      expect(row(ctx, field).disabledReason).toMatch(/Sign in/)
    }
    for (const field of ['codec', 'vSync', 'bitrate', 'upscaling', 'clipboardPaste'] as const) {
      expect(row(ctx, field).disabledReason).toBeNull()
    }
  })

  it('names the missing entitlement on a feature row', () => {
    expect(row(context(), 'cloudGsync').disabledReason).toMatch(/membership/)
    const hdr = choice(context(), 'hdr')
    expect(hdr.options.find((o) => o.id === 'HDR')).toMatchObject({ enabled: false })
  })

  it('hides DLSS overrides when nothing about them is entitled, as the client does', () => {
    expect(settingSections(context()).some((s) => s.id === 'dlss')).toBe(false)
    const dlss = {
      ...ULTIMATE,
      dlss: {
        superResolution: true,
        rayReconstruction: false,
        frameGeneration: false,
        frameGenerationMultipliers: []
      }
    }
    const rows =
      settingSections(context({ entitlements: dlss })).find((s) => s.id === 'dlss')?.rows ?? []
    expect(rows.map((r) => r.field)).toEqual([
      'dlssPreset',
      'dlssSrModel',
      'dlssSrMode',
      'dlssSrScale'
    ])
  })

  // A 37 set with the official app's slider is listed where it falls, rather
  // than rounded to the grid the moment the page opens.
  it('lists the bit rate exactly as stored, each with the client’s data estimate', () => {
    const at37 = context({
      settings: settings({ customProfile: { ...settings().customProfile, maxBitrate: 37 } })
    })
    const bitrate = choice(at37, 'bitrate')
    expect(bitrate.selected).toBe('37')
    expect(bitrate.options[0]).toMatchObject({ id: 'auto', label: 'Auto' })
    expect(bitrate.options.find((o) => o.id === '37')).toMatchObject({ label: '37 Mbps' })
    expect(bitrate.options.find((o) => o.id === '100')?.detail).toBe('~29 GB an hour')
    const ids = bitrate.options.slice(1).map((o) => Number(o.id))
    expect(ids).toEqual([...ids].sort((x, y) => y - x))
    expect(ids.at(-1)).toBe(5)
    expect(bitrate.figures).toBe(true)
  })

  it('files resolutions under their aspect ratio, common shapes first', () => {
    const wide = {
      ...ULTIMATE,
      resolutions: [
        { width: 5120, height: 1440, fps: [120] },
        { width: 3440, height: 1440, fps: [120] },
        { width: 2560, height: 1600, fps: [120] },
        ...ULTIMATE.resolutions
      ]
    }
    const options = choice(context({ entitlements: wide }), 'resolution').options
    expect(options.map((o) => o.group)).toEqual([
      '16:9',
      '16:9',
      '16:9',
      '16:9',
      '16:10',
      '21:9',
      '32:9'
    ])
  })
})

describe('applyChange', () => {
  it('refuses a value that is not offered, or not allowed', () => {
    expect(applyChange(context(), { field: 'resolution', value: '7680x4320' }).ok).toBe(false)
    expect(applyChange(context(), { field: 'hdr', value: 'HDR' })).toMatchObject({ ok: false })
    expect(applyChange(context(), { field: 'bitrate', value: '500' })).toMatchObject({ ok: false })
    expect(
      applyChange(context({ entitlements: null }), { field: 'fps', value: '60' })
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Sign in/)
    })
  })

  it('refuses a custom field outside Custom mode', () => {
    const ctx = context({ settings: settings({ streamingProfiles: 'cinematic' }) })
    expect(applyChange(ctx, { field: 'codec', value: '3' }).ok).toBe(false)
  })

  it('keeps the frame rate when the new resolution allows it, and snaps it when not', () => {
    expect(patchOf(context(), { field: 'resolution', value: '1920x1080' })).toMatchObject({
      fps: 60
    })
    const at120 = context({
      settings: settings({ customProfile: { ...settings().customProfile, fps: 120 } })
    })
    expect(patchOf(at120, { field: 'resolution', value: '2560x1440' })).toMatchObject({ fps: 120 })
    const at360 = context({
      settings: settings({
        customProfile: { ...settings().customProfile, width: 1920, height: 1080, fps: 360 }
      })
    })
    expect(patchOf(at360, { field: 'resolution', value: '3840x2160' })).toMatchObject({ fps: 120 })
  })

  it('keeps the display-only fields the official app shows truthful', () => {
    expect(patchOf(context(), { field: 'resolution', value: '1920x1080' })).toMatchObject({
      aspectRatio: '(16:9)',
      dataUsage: 29
    })
    expect(patchOf(context(), { field: 'bitrate', value: '95' })).toMatchObject({
      maxBitrate: 95,
      dataUsage: 28
    })
  })

  it('moves colour to 10-bit with HDR, as the client’s editor does', () => {
    const hdr = { ...ULTIMATE, hdrModes: ['HDR'] as const }
    const ctx = context({
      entitlements: hdr,
      settings: settings({ customProfile: { ...settings().customProfile, bitDepth: 8 } })
    })
    expect(patchOf(ctx, { field: 'hdr', value: 'HDR' })).toMatchObject({
      hdrStreamingMode: 'HDR',
      bitDepth: 10
    })
  })

  it('turns Reflex on with VRR, and VRR off when VSync leaves Adaptive', () => {
    const gsync = { ...ULTIMATE, cloudGsync: true }
    const adaptive = context({
      entitlements: gsync,
      settings: settings({ customProfile: { ...settings().customProfile, vSync: 2 } })
    })
    expect(patchOf(adaptive, { field: 'cloudGsync', value: true })).toMatchObject({
      cloudGsync: true,
      reflex: true
    })

    const on = context({
      entitlements: gsync,
      settings: settings({
        customProfile: { ...settings().customProfile, vSync: 2, cloudGsync: true, reflex: true }
      })
    })
    expect(patchOf(on, { field: 'vSync', value: '1' })).toMatchObject({
      vSync: 1,
      cloudGsync: false
    })
    expect(row(on, 'reflex').disabledReason).toMatch(/VRR/)
  })

  it('will not turn VRR on before VSync is Adaptive', () => {
    const ctx = context({ entitlements: { ...ULTIMATE, cloudGsync: true } })
    expect(applyChange(ctx, { field: 'cloudGsync', value: true })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Adaptive/)
    })
  })

  // The two traps of a profile written from nothing: a missing HDR mode reads
  // as "not OFF" at launch, and the reset check matches the mode exactly.
  it('builds a whole custom profile when Custom is chosen with none stored', () => {
    const ctx = context({
      settings: settings({ streamingProfiles: 'balanced', customProfile: null })
    })
    const result = applyChange(ctx, { field: 'mode', value: 'custom' })
    if (!result.ok) throw new Error(result.error)
    expect(result.patch.appSettings).toEqual({ streamingProfiles: 'custom' })
    expect(result.patch.customProfile).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 60,
      hdrStreamingMode: 'OFF',
      maxBitrateAuto: true
    })
  })

  it('will not build one without knowing the membership', () => {
    const ctx = context({
      entitlements: null,
      settings: settings({ streamingProfiles: 'balanced', customProfile: null })
    })
    expect(applyChange(ctx, { field: 'mode', value: 'custom' }).ok).toBe(false)
    // …but returning to a profile that exists is the client's to judge.
    const existing = context({
      entitlements: null,
      settings: settings({ streamingProfiles: 'balanced' })
    })
    expect(applyChange(existing, { field: 'mode', value: 'custom' }).ok).toBe(true)
  })

  it('fills the fields a partial stored profile lacks', () => {
    const ctx = context({
      settings: settings({ customProfile: { maxBitrate: 40, maxBitrateAuto: false } })
    })
    expect(patchOf(ctx, { field: 'codec', value: '2' })).toMatchObject({
      codec: 2,
      width: 1920,
      height: 1080,
      fps: 60,
      hdrStreamingMode: 'OFF'
    })
  })

  it('writes the upscaling choice with the flag that keeps it', () => {
    expect(patchOf(context(), { field: 'upscaling', value: '2' })).toEqual({
      upScalingResolutionId: 2,
      upscalingModeUpdatedByUser: true
    })
  })

  it('stores detail enhancement against the upscaler in use', () => {
    expect(patchOf(context(), { field: 'detailEnhancement', value: '3' })).toEqual({
      enhancedSharpnessValue: 3
    })
    const ai = context({ settings: settings({ upScalingResolutionId: 2 }) })
    expect(patchOf(ai, { field: 'detailEnhancement', value: '4' })).toEqual({ aiSharpnessValue: 4 })
  })

  it('writes the game language the client’s way', () => {
    expect(patchOf(context(), { field: 'gameLanguage', value: 'it_IT' })).toEqual({
      preferredGameLanguage: 'it_IT'
    })
    expect(patchOf(context(), { field: 'gameLanguage', value: 'auto' })).toEqual({
      preferredGameLanguage: 'auto-en_US'
    })
  })

  it('maps the network warnings toggle onto the client’s two codes', () => {
    expect(patchOf(context(), { field: 'networkWarnings', value: false })).toEqual({
      networkQuality: 0
    })
  })

  // One row for the official app's switch and slider: Auto, or a ceiling, and
  // picking a ceiling is what turns Auto off.
  it('bit rate Auto clears the number, and a number turns Auto off', () => {
    expect(patchOf(context(), { field: 'bitrate', value: 'auto' })).toMatchObject({
      maxBitrateAuto: true,
      maxBitrate: 0
    })
    const auto = context({
      settings: settings({
        customProfile: { ...settings().customProfile, maxBitrateAuto: true, maxBitrate: 0 }
      })
    })
    expect(choice(auto, 'bitrate').selected).toBe('auto')
    expect(patchOf(auto, { field: 'bitrate', value: '50' })).toMatchObject({
      maxBitrateAuto: false,
      maxBitrate: 50
    })
  })
})

describe('DLSS overrides', () => {
  const all = {
    ...ULTIMATE,
    dlss: {
      superResolution: true,
      rayReconstruction: true,
      frameGeneration: true,
      frameGenerationMultipliers: [3, 4]
    }
  }
  const dlssOf = (ctx: SettingsContext, change: ClientSettingChange): Record<string, unknown> =>
    patchOf(ctx, change).dlssOverrides as Record<string, unknown>

  it('Recommended puts every model on 1', () => {
    expect(
      dlssOf(context({ entitlements: all }), { field: 'dlssPreset', value: 'recommended' })
    ).toMatchObject({
      modelPresetMode: 'recommended',
      fgModel: 1,
      srModel: 1,
      rrModel: 1
    })
  })

  // A mode needs a model; from "in-game" the client picks Recommended and moves
  // the presets to Custom, and picks the smallest entitled multiplier.
  it('a frame-generation mode from in-game settings switches to Custom with a model', () => {
    expect(
      dlssOf(context({ entitlements: all }), { field: 'dlssFgMode', value: '1' })
    ).toMatchObject({
      modelPresetMode: 'custom',
      fgMode: 1,
      fgModel: 1,
      customFgModel: 1,
      fgMultiplier: 3
    })
  })

  it('a super-resolution mode carries its scale, and Custom starts at 75', () => {
    const custom = dlssOf(context({ entitlements: all }), { field: 'dlssSrMode', value: '6' })
    expect(custom).toMatchObject({
      srMode: 6,
      srScale: 75,
      srModel: 1,
      rrModel: 1,
      modelPresetMode: 'custom'
    })
    expect(
      dlssOf(context({ entitlements: all }), { field: 'dlssSrMode', value: '1' })
    ).toMatchObject({ srScale: 50 })
  })

  it('model 0 hands the mode back to the game', () => {
    const ctx = context({
      entitlements: all,
      settings: settings({
        dlssOverrides: {
          ...DLSS_DEFAULTS,
          modelPresetMode: 'custom',
          srModel: 1,
          srMode: 3,
          srScale: 67
        }
      })
    })
    expect(dlssOf(ctx, { field: 'dlssSrModel', value: '0' })).toMatchObject({
      srModel: 0,
      srMode: 0,
      srScale: 100
    })
  })

  it('Custom presets bring back the models Custom had', () => {
    const ctx = context({
      entitlements: all,
      settings: settings({
        dlssOverrides: { ...DLSS_DEFAULTS, modelPresetMode: 'recommended', customSrModel: 13 }
      })
    })
    expect(dlssOf(ctx, { field: 'dlssPreset', value: 'custom' })).toMatchObject({
      modelPresetMode: 'custom',
      srModel: 13
    })
  })

  it('only takes a typed scale in Custom mode', () => {
    expect(
      applyChange(context({ entitlements: all }), { field: 'dlssSrScale', value: '60' }).ok
    ).toBe(false)
  })
})

describe('effectiveCustom', () => {
  it('fills what is missing the way the client does, from Balanced', () => {
    const filled = effectiveCustom(settings({ customProfile: { maxBitrate: 40 } }), ULTIMATE)
    expect(filled).toMatchObject({
      maxBitrate: 40,
      width: 1920,
      height: 1080,
      fps: 60,
      hdrStreamingMode: 'OFF',
      vSync: 2
    })
  })
})

describe('streamSummary', () => {
  it('reads out a custom stream in figures', () => {
    expect(streamSummary(context())).toMatchObject({
      mode: 'custom',
      modeLabel: 'Custom',
      resolution: '3840 × 2160',
      fps: 60,
      bitrate: '100 Mbps',
      codec: 'Auto',
      colour: '10-bit, 4:2:0',
      hdr: 'Off',
      dataPerHour: 29,
      cap: null
    })
  })

  it('says Auto, with no estimate, when GeForce NOW picks the bit rate', () => {
    const auto = context({
      settings: settings({
        customProfile: { ...settings().customProfile, maxBitrateAuto: true, maxBitrate: 0 }
      })
    })
    expect(streamSummary(auto)).toMatchObject({ bitrate: 'Auto', dataPerHour: null })
  })

  // A preset adapts to the screen and the connection, so the launcher cannot
  // promise figures — only the ceiling the server gave that preset.
  it('names a preset and its ceiling, never figures it cannot know', () => {
    const balanced = context({
      settings: settings({ streamingProfiles: 'balanced' }),
      entitlements: {
        ...ULTIMATE,
        presets: {
          balanced: { width: 5120, height: 2880, fps: 120, maxBitrate: 0, maxBitrateAuto: true }
        }
      }
    })
    expect(streamSummary(balanced)).toMatchObject({
      modeLabel: 'Balanced',
      resolution: null,
      bitrate: null,
      cap: { resolution: '5120 × 2880', fps: 120 }
    })
  })
})
