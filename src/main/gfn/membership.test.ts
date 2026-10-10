import { describe, expect, it } from 'vitest'
import { buildSubscriptionsRequest, parseEntitlements } from './membership'

const feature = (key: string, textValue: string): Record<string, unknown> => ({ key, textValue })
const set = (key: string, setValue: string[]): Record<string, unknown> => ({ key, setValue })
const resolution = (
  w: number,
  h: number,
  fps: number,
  isEntitled = true
): Record<string, unknown> => ({
  widthInPixels: w,
  heightInPixels: h,
  framesPerSecond: fps,
  isEntitled
})
const quality = (
  mode: string,
  w: number,
  h: number,
  fps: number,
  bitrate: Record<string, unknown>
): Record<string, unknown> => ({
  clientStreamingQualityMode: mode,
  features: [feature('PROFILE_VSYNC', '2')],
  maxBitRate: bitrate,
  resolution: { widthInPixels: w, heightInPixels: h, framesPerSecond: fps }
})

/**
 * Shaped like the answer MES gave the native client on Linux for an Ultimate
 * account (docs/gfn-api.md), values trimmed — including the parts that say
 * whose membership it is, which must not survive the parse.
 */
function answer(): Record<string, unknown> {
  return {
    addons: [{ type: 'STORAGE', subType: 'EPHEMERAL_STORAGE', attributes: [] }],
    allottedTimeInMinutes: 1200,
    currentSubscriptionState: { isGamePlayAllowed: true, state: 'FULL' },
    features: {
      features: [
        feature('RTX_ENABLED', 'true'),
        feature('IN_GAME_SETTINGS_PERSISTENCE_ENABLED', 'true'),
        feature('SUPPORTED_AUDIO_FORMATS', 'UP_TO_7_1_SURROUND_PCM'),
        set('ENABLED_FPS', ['30', '60', '120', '240', '360']),
        feature('ENABLED_REFLEX', 'true'),
        feature('ENABLED_L4S', 'true'),
        feature('BIT_DEPTH', '[{"value":"10","isEntitled":true},{"value":"8","isEntitled":true}]'),
        feature(
          'SUPPORTED_CHROMA_FORMAT',
          '[{"value":"YUV420","isEntitled":true},{"value":"YUV444","isEntitled":true}]'
        ),
        set('SUPPORTED_HDR_VERSION', ['OFF']),
        set('SUPPORTED_DL_PREFILTERING', ['OFF', 'AUTO', 'CUSTOM']),
        feature('HUD_STREAMING', 'true'),
        feature('STREAMING_SUPPORT', 'ENABLED')
      ],
      resolutions: [
        resolution(1920, 1080, 60),
        resolution(1920, 1080, 30),
        resolution(3840, 2160, 60),
        resolution(3840, 2160, 120),
        resolution(1920, 1080, 360),
        resolution(5120, 2880, 120),
        resolution(7680, 4320, 60, false)
      ]
    },
    membershipTier: 'ULTIMATE',
    membershipType: 'EXAMPLE_TYPE',
    productSku: '99999',
    productUri: 'https://example.test/product/opaque-product-uri',
    remainingTimeInMinutes: 4321,
    renewalDateTime: '2031-02-03T04:05:06.000Z',
    streamingQualities: [
      quality('BALANCED', 5120, 2880, 120, {
        bitrateOption: false,
        bitrateValue: 0,
        maxBitrateValue: 100,
        minBitrateValue: 5
      }),
      quality('DATA_SAVER', 1280, 720, 60, {
        bitrateOption: true,
        bitrateValue: 12,
        maxBitrateValue: 100,
        minBitrateValue: 5
      }),
      quality('COMPETITIVE', 1920, 1200, 360, {
        bitrateOption: false,
        bitrateValue: 0,
        maxBitrateValue: 100,
        minBitrateValue: 5
      }),
      quality('CINEMATIC', 5120, 2880, 60, {
        bitrateOption: false,
        bitrateValue: 0,
        maxBitrateValue: 0,
        minBitrateValue: 0
      })
    ],
    subscriptionId: 'sub-0123456789abcdefghijkl',
    type: 'PAID',
    upsells: [{ key: 'DAY_PASS', booleanValue: true }]
  }
}

describe('parseEntitlements', () => {
  it('reads what the membership allows', () => {
    const parsed = parseEntitlements(answer())
    expect(parsed).toMatchObject({
      tier: 'ULTIMATE',
      modes: ['balanced', 'dataSaver', 'competitive', 'cinematic'],
      bitrate: { min: 5, max: 100 },
      bitDepths: [10, 8],
      chromaFormats: [0, 1],
      reflex: true,
      cloudGsync: false,
      l4s: true,
      hud: true,
      inGameGraphics: true,
      prefilterModes: [0, 1, 2]
    })
  })

  // The guard, as in `zone.test.ts`: the answer names the subscription, its
  // renewal date and its product; the result says what it allows and no more.
  it('does not carry anything else across', () => {
    const parsed = parseEntitlements(answer())
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      'bitDepths',
      'bitrate',
      'chromaFormats',
      'cloudGsync',
      'dlss',
      'hdrEntitled',
      'hdrModes',
      'hud',
      'inGameGraphics',
      'l4s',
      'modes',
      'prefilterModes',
      'presets',
      'reflex',
      'resolutions',
      'tier'
    ])
    const text = JSON.stringify(parsed)
    for (const secret of ['sub-0123', 'opaque-product-uri', '2031-02-03', 'EXAMPLE_TYPE', '4321']) {
      expect(text).not.toContain(secret)
    }
  })

  it('groups frame rates under their resolution, largest first, entitled only', () => {
    expect(parseEntitlements(answer())?.resolutions).toEqual([
      { width: 5120, height: 2880, fps: [120] },
      { width: 3840, height: 2160, fps: [120, 60] },
      { width: 1920, height: 1080, fps: [360, 60, 30] }
    ])
  })

  // `SUPPORTED_HDR_VERSION: ["OFF"]` is what this account gets on Linux: the
  // menu has nothing to offer, but the client's reset check still passes.
  it('separates the HDR menu from the reset check, as the client does', () => {
    const parsed = parseEntitlements(answer())
    expect(parsed?.hdrModes).toEqual([])
    expect(parsed?.hdrEntitled).toBe(true)

    const withHdr = answer()
    ;(withHdr.features as { features: unknown[] }).features.push(feature('HDR_ENABLED', 'true'))
    expect(parseEntitlements(withHdr)?.hdrModes).toEqual(['HDR'])
  })

  it('keeps what each preset asks for, and Data Saver’s capped bit rate', () => {
    expect(parseEntitlements(answer())?.presets.dataSaver).toEqual({
      width: 1280,
      height: 720,
      fps: 60,
      maxBitrate: 12,
      maxBitrateAuto: false
    })
  })

  it('reads DLSS and its multipliers only where they are entitled', () => {
    const parsed = parseEntitlements(answer())
    expect(parsed?.dlss).toEqual({
      superResolution: false,
      rayReconstruction: false,
      frameGeneration: false,
      frameGenerationMultipliers: []
    })

    const dlss = answer()
    const list = (dlss.features as { features: unknown[] }).features
    list.push(feature('SUPPORTED_DLSS_OVERRIDE_FG', 'true'))
    list.push(
      feature(
        'SUPPORTED_DLSS_FG_MULTIPLIERS',
        '[{"value":"3X","isEntitled":true},{"value":"4X","isEntitled":false}]'
      )
    )
    expect(parseEntitlements(dlss)?.dlss).toMatchObject({
      frameGeneration: true,
      frameGenerationMultipliers: [3]
    })
  })

  it('falls back to the client’s own bit-rate range when Balanced has none', () => {
    const bare = answer()
    bare.streamingQualities = []
    expect(parseEntitlements(bare)?.bitrate).toEqual({ min: 5, max: 75 })
  })

  it('is total over junk', () => {
    for (const raw of [null, 'x', 42, []]) expect(parseEntitlements(raw)).toBeNull()
    expect(parseEntitlements({ features: 'nope', streamingQualities: 'nope' })).toMatchObject({
      resolutions: [],
      modes: [],
      reflex: false
    })
  })
})

describe('buildSubscriptionsRequest', () => {
  const input = {
    nes: { server: 'https://mes.geforcenow.com/', version: 'v4', serviceName: 'gfn_pc' },
    clientId: 'ec7e38d4-03af-4b58-b131-cfb0495903ab',
    clientVersion: '2.0.87.130',
    vpcId: 'NP-FRK-08',
    locale: 'en_US',
    token: 'eyJ.token.sig',
    captured: {
      'NV-Client-Type': 'BROWSER',
      'NV-Browser-Type': 'CHROME',
      'NV-Client-Streamer': 'WEBRTC',
      Authorization: 'GFNJWT graphql-credential',
      'User-Agent': 'Mozilla/5.0',
      Accept: '*/*'
    }
  }

  it('asks for the subscription the way the client does', () => {
    expect(buildSubscriptionsRequest(input).url).toBe(
      'https://mes.geforcenow.com/v4/subscriptions?serviceName=gfn_pc&languageCode=en_US&vpcId=NP-FRK-08'
    )
  })

  // The browser's headers get the browser's membership — 1080p at 60 for an
  // Ultimate account. The native ones are the whole fix.
  it('speaks as the native Linux client, never as the browser it captured', () => {
    const { headers } = buildSubscriptionsRequest(input)
    expect(headers).toMatchObject({
      'NV-Client-Type': 'NATIVE',
      'NV-Client-Streamer': 'NVIDIA-CLASSIC',
      'NV-Device-OS': 'LINUX',
      'NV-Device-Type': 'DESKTOP',
      'NV-Client-ID': input.clientId,
      'NV-Client-Version': '2.0.87.130',
      Authorization: 'GFNJWT eyJ.token.sig',
      'User-Agent': 'Mozilla/5.0'
    })
    expect(headers).not.toHaveProperty('NV-Browser-Type')
    expect(JSON.stringify(headers)).not.toContain('graphql-credential')
  })

  it('goes without a credential rather than with the wrong one', () => {
    expect(buildSubscriptionsRequest({ ...input, token: null }).headers).not.toHaveProperty(
      'Authorization'
    )
  })
})
