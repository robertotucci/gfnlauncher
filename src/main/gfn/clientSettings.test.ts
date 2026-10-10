import { describe, expect, it } from 'vitest'
import type { ClientSettings, ClientSettingsPatch } from '@shared/clientSettings'
import {
  applyClientSettingsPatch,
  customProfileDropped,
  encodeClientStorage,
  parseClientSettings,
  patchLanded,
  topLevelValueSpan
} from './clientSettings'

/**
 * A storage file shaped like the real one — keys sorted, compact — including
 * everything that must never leave `clientSettings.ts`: a session blob, consent
 * ids, and the MAC and IP addresses the client keeps *inside* the very block
 * this module reads.
 */
function storage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appSettingsConfig: {
      clipboardPaste: true,
      customProfile: {
        aspectRatio: '(16:9)',
        audioMode: 2,
        bitDepth: 10,
        chromaFormat: 0,
        cloudGsync: false,
        codec: 0,
        dataUsage: 29,
        denoise: 0,
        description: 'settings.streamingProfiles.balancedDescription',
        displayDpi: 0,
        dynamicStreamingMode: 0,
        fps: 60,
        hdrStreamingMode: 'OFF',
        height: 2160,
        hudStreaming: true,
        l4sEnabled: true,
        maxBitrate: 100,
        maxBitrateAuto: false,
        name: 'balanced',
        networkInfo: {
          GatewayIP: '192.168.1.1',
          IPAddress: '192.168.1.23',
          MACAddress: 'aa:bb:cc:dd:ee:ff',
          RouterMACAddress: '11:22:33:44:55:66'
        },
        prefilter: 1,
        primaryDisplayResolution: { fps: 60, height: 2160, width: 3840 },
        profile: 1,
        reflex: false,
        sharpen: 0,
        vSync: 0,
        width: 3840
      },
      inGameGraphics: true,
      streamingProfiles: 'custom',
      upScalingResolutionId: 1,
      upscalingModeUpdatedByUser: true
    },
    gfnTelemetry: { clientVersion: '2.0.87.130', deviceId: 'f'.repeat(64) },
    networkConfig: { currentFingerPrint: 'c847d04d', routingOverride: { name: 'Germany' } },
    remoteOverrides: { metaData: { lastFetchedAt: 1.791659007736e12, zoneName: 'NP-FRK-08' } },
    starfleetSession: {
      authProvider: 'starfleet',
      data: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig'
    },
    userConsentInfo: { externalUserId: '123456789012345678', userId: 'opaque-user-id' },
    ...overrides
  }
}

/** The settings block of a fixture, typed loosely for the tests that edit it. */
function block(root: Record<string, unknown>): Record<string, unknown> {
  return root.appSettingsConfig as Record<string, unknown>
}

describe('parseClientSettings', () => {
  it('reads what the official Settings page manages', () => {
    const settings = parseClientSettings(storage())
    expect(settings?.streamingProfiles).toBe('custom')
    expect(settings?.customProfile).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 60,
      maxBitrate: 100
    })
    expect(settings?.upScalingResolutionId).toBe(1)
    expect(settings?.inGameGraphics).toBe(true)
  })

  // The guard, in the spirit of `zone.test.ts`: a fixture full of secrets in,
  // declared fields out. Widening either list is a review-level decision.
  it('does not carry anything else across', () => {
    const settings = parseClientSettings(storage())
    expect(Object.keys(settings ?? {}).sort()).toEqual([
      'aiSharpnessValue',
      'clipboardPaste',
      'customProfile',
      'dlssOverrides',
      'enhancedSharpnessValue',
      'inGameGraphics',
      'networkQuality',
      'preferredGameLanguage',
      'streamingProfiles',
      'upScalingResolutionId'
    ])
    expect(Object.keys(settings?.customProfile ?? {})).not.toContain('networkInfo')
    const text = JSON.stringify(settings)
    for (const secret of [
      'eyJ',
      'aa:bb:cc',
      '192.168',
      'opaque-user-id',
      'Germany',
      'description'
    ]) {
      expect(text).not.toContain(secret)
    }
  })

  it('answers with the client’s own defaults where nothing is stored', () => {
    expect(parseClientSettings({})).toEqual({
      streamingProfiles: 'balanced',
      customProfile: null,
      networkQuality: 1,
      clipboardPaste: true,
      inGameGraphics: false,
      preferredGameLanguage: null,
      upScalingResolutionId: 0,
      enhancedSharpnessValue: 0,
      aiSharpnessValue: 0,
      dlssOverrides: expect.objectContaining({ modelPresetMode: 'inGame', srScale: 100 })
    })
  })

  // The client resets an unflagged upscaling choice to Standard at every start,
  // so reading it without the flag would show a mode that is not in effect.
  it('honours the upscaling mode only when the user chose it', () => {
    const root = storage()
    block(root).upscalingModeUpdatedByUser = false
    expect(parseClientSettings(root)?.upScalingResolutionId).toBe(0)
  })

  it('drops a field of the wrong type rather than guessing', () => {
    const root = storage()
    const custom = block(root).customProfile as Record<string, unknown>
    custom.width = '3840'
    custom.codec = 9
    custom.hdrStreamingMode = 'MAYBE'
    const parsed = parseClientSettings(root)?.customProfile
    expect(parsed).not.toHaveProperty('width')
    expect(parsed).not.toHaveProperty('codec')
    expect(parsed).not.toHaveProperty('hdrStreamingMode')
    expect(parsed).toHaveProperty('height', 2160)
  })

  it('treats a stored 2 for network warnings the way the client does — off', () => {
    const root = storage()
    block(root).networkQuality = 2
    expect(parseClientSettings(root)?.networkQuality).toBe(0)
  })

  it('is total over junk', () => {
    for (const raw of [null, 'a string', 42, []]) expect(parseClientSettings(raw)).toBeNull()
    expect(parseClientSettings({ appSettingsConfig: 'nope' })?.streamingProfiles).toBe('balanced')
  })
})

describe('customProfileDropped', () => {
  const custom = parseClientSettings(storage()) as ClientSettings
  const dropped: ClientSettings = { ...custom, customProfile: null }

  it('notices the client deleting the profile while the mode stays Custom', () => {
    expect(customProfileDropped(custom, dropped)).toBe(true)
  })

  it('is not fooled by the user leaving Custom', () => {
    expect(customProfileDropped(custom, { ...dropped, streamingProfiles: 'balanced' })).toBe(false)
  })

  // An unreadable file is a file caught mid-write, not evidence of a reset.
  it('takes an unknown reading as nothing', () => {
    expect(customProfileDropped(custom, null)).toBe(false)
    expect(customProfileDropped(null, dropped)).toBe(false)
  })
})

describe('applyClientSettingsPatch', () => {
  const patch: ClientSettingsPatch = {
    appSettings: { networkQuality: 0 },
    customProfile: { maxBitrate: 50 }
  }

  it('changes the patched fields and nothing else', () => {
    const next = applyClientSettingsPatch(block(storage()), patch)
    expect(next.networkQuality).toBe(0)
    const custom = next.customProfile as Record<string, unknown>
    expect(custom.maxBitrate).toBe(50)
    // Everything the launcher does not manage goes back untouched — the
    // network block included, since it is the client's and not ours.
    expect(custom.networkInfo).toEqual(
      (block(storage()).customProfile as Record<string, unknown>).networkInfo
    )
    expect(custom.width).toBe(3840)
  })

  it('writes keys in the client’s sorted order', () => {
    const next = applyClientSettingsPatch(block(storage()), patch)
    expect(Object.keys(next)).toEqual([...Object.keys(next)].sort())
    const custom = next.customProfile as Record<string, unknown>
    expect(Object.keys(custom)).toEqual([...Object.keys(custom)].sort())
  })

  it('creates a profile where there was none', () => {
    const next = applyClientSettingsPatch({}, { appSettings: {}, customProfile: { fps: 60 } })
    expect(next.customProfile).toEqual({ fps: 60 })
  })
})

describe('topLevelValueSpan', () => {
  it('finds a value by its key', () => {
    const text = '{"a":{"b":[1,{"c":"}"}]},"z":2}'
    const span = topLevelValueSpan(text, 'a')
    expect(span && text.slice(...span)).toBe('{"b":[1,{"c":"}"}]}')
    const z = topLevelValueSpan(text, 'z')
    expect(z && text.slice(...z)).toBe('2')
  })

  // The name of the key appearing inside somebody's string is the case an
  // `indexOf` gets wrong, in a file that holds a login.
  it('is not fooled by the key spelled inside a string', () => {
    const text = '{"note":"\\"appSettingsConfig\\":{}","appSettingsConfig":{"x":1}}'
    const span = topLevelValueSpan(text, 'appSettingsConfig')
    expect(span && text.slice(...span)).toBe('{"x":1}')
  })

  it('answers null for a key that is not there', () => {
    expect(topLevelValueSpan('{"a":1}', 'appSettingsConfig')).toBeNull()
  })
})

describe('encodeClientStorage', () => {
  const original = JSON.stringify(storage())

  it('changes nothing when nothing changed', () => {
    const result = encodeClientStorage(
      original,
      block(JSON.parse(original) as Record<string, unknown>)
    )
    expect(result.ok && result.bytes.toString('utf8')).toBe(original)
  })

  // The tokens are never re-encoded: they go back as the bytes they came as.
  it('leaves every byte outside the settings block alone', () => {
    const next = applyClientSettingsPatch(block(storage()), {
      appSettings: { clipboardPaste: false },
      customProfile: null
    })
    const result = encodeClientStorage(original, next)
    if (!result.ok) throw new Error(result.error)
    const text = result.bytes.toString('utf8').trimEnd()
    const span = topLevelValueSpan(original, 'appSettingsConfig') as [number, number]
    const newSpan = topLevelValueSpan(text, 'appSettingsConfig') as [number, number]
    expect(text.slice(newSpan[1])).toBe(original.slice(span[1]))
    expect(text.slice(0, newSpan[0])).toBe(original.slice(0, span[0]))
  })

  it('keeps the float timestamps in the client’s own notation', () => {
    const withExponent = original.replace('1791659007736', '1.791659007736e+12')
    const result = encodeClientStorage(withExponent, block(storage()))
    expect(result.ok && result.bytes.toString('utf8')).toContain('1.791659007736e+12')
  })

  it('pads a shorter payload so the file is never shorter than before', () => {
    const next = applyClientSettingsPatch(block(storage()), {
      appSettings: { clipboardPaste: false },
      customProfile: { maxBitrate: 5 }
    })
    const result = encodeClientStorage(original, next)
    if (!result.ok) throw new Error(result.error)
    expect(result.bytes.length).toBe(Buffer.byteLength(original))
    expect(() => JSON.parse(result.bytes.toString('utf8'))).not.toThrow()
  })

  it('measures in bytes, not characters', () => {
    const accented = JSON.stringify({ ...storage(), z: 'perché' })
    const next = applyClientSettingsPatch(block(storage()), {
      appSettings: {},
      customProfile: { fps: 30 }
    })
    const result = encodeClientStorage(accented, next)
    expect(result.ok && result.bytes.length).toBeGreaterThanOrEqual(Buffer.byteLength(accented))
  })

  it('adds the block, first, to a file that has never had one', () => {
    const bare = '{"gfnTelemetry":{"deviceId":"x"}}'
    const result = encodeClientStorage(bare, { clipboardPaste: false })
    expect(result.ok && result.bytes.toString('utf8').trimEnd()).toBe(
      '{"appSettingsConfig":{"clipboardPaste":false},"gfnTelemetry":{"deviceId":"x"}}'
    )
    const empty = encodeClientStorage('{}', { clipboardPaste: false })
    expect(empty.ok && empty.bytes.toString('utf8').trimEnd()).toBe(
      '{"appSettingsConfig":{"clipboardPaste":false}}'
    )
  })

  it('refuses a number it could not write back faithfully', () => {
    expect(encodeClientStorage(original, { huge: 2 ** 60 }).ok).toBe(false)
  })

  it('refuses a file that is not an object', () => {
    expect(encodeClientStorage('[]', {}).ok).toBe(false)
  })
})

describe('patchLanded', () => {
  const patch: ClientSettingsPatch = {
    appSettings: { networkQuality: 0 },
    customProfile: { fps: 120 }
  }

  it('confirms a write that read back', () => {
    const root = storage()
    block(root).networkQuality = 0
    ;(block(root).customProfile as Record<string, unknown>).fps = 120
    expect(patchLanded(root, patch)).toBe(true)
  })

  it('catches one that did not', () => {
    expect(patchLanded(storage(), patch)).toBe(false)
    expect(patchLanded({}, patch)).toBe(false)
  })
})
