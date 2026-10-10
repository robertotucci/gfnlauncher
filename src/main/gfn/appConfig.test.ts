import { describe, expect, it } from 'vitest'
import { DEFAULT_CLIENT_CONFIG } from '@shared/clientSettings'
import {
  NES_FALLBACK,
  parseAlsServerUrl,
  parseLcarsClientId,
  parseNesConfig,
  parseStreamingClientConfig
} from './appConfig'

describe('parseAlsServerUrl', () => {
  it('reads the server out of the shape the client ships', () => {
    // Trimmed from the real file at
    // <install>/files/mall/shared/assets/config/config.json, client 2.0.87.130.
    const config = {
      lcars: { serverUrl: 'https://apps.gxn.nvidia.com/graphql' },
      accountLinking: {
        server: 'https://als.geforcenow.com',
        clientId: 'gfn-pc',
        defaultSyncWaitInterval: 10000
      }
    }
    expect(parseAlsServerUrl(config)).toBe('https://als.geforcenow.com')
  })

  it('has nothing to say about a config with no accountLinking block', () => {
    expect(parseAlsServerUrl({ lcars: { serverUrl: 'https://example.test' } })).toBeNull()
  })

  it('refuses a server that is not a URL', () => {
    // This value goes straight into a fetch. A relative path or a leftover
    // placeholder must fall through to the documented default rather than
    // producing a request to nowhere.
    expect(parseAlsServerUrl({ accountLinking: { server: '/v1' } })).toBeNull()
    expect(parseAlsServerUrl({ accountLinking: { server: '{{alsServer}}' } })).toBeNull()
    expect(parseAlsServerUrl({ accountLinking: { server: '' } })).toBeNull()
  })

  it('survives anything that is not a config at all', () => {
    // A client release can reshape this file freely; it is not ours.
    expect(parseAlsServerUrl(null)).toBeNull()
    expect(parseAlsServerUrl('nope')).toBeNull()
    expect(parseAlsServerUrl([])).toBeNull()
    expect(parseAlsServerUrl({ accountLinking: 'https://als.geforcenow.com' })).toBeNull()
    expect(parseAlsServerUrl({ accountLinking: { server: 42 } })).toBeNull()
  })
})

describe('parseNesConfig', () => {
  it('reads the membership service out of the shape the client ships', () => {
    const config = {
      nes: {
        server: 'https://mes.geforcenow.com',
        version: 'v4',
        serviceName: 'gfn_pc',
        freeProductId: '1000'
      }
    }
    expect(parseNesConfig(config)).toEqual({
      server: 'https://mes.geforcenow.com',
      version: 'v4',
      serviceName: 'gfn_pc'
    })
  })

  // Each field falls back on its own: a host that moved is still worth reading
  // when the version did not, and a placeholder never reaches a URL.
  it('falls back field by field', () => {
    expect(
      parseNesConfig({ nes: { server: 'https://mes.example.test', version: '../v9' } })
    ).toEqual({
      server: 'https://mes.example.test',
      version: NES_FALLBACK.version,
      serviceName: NES_FALLBACK.serviceName
    })
    expect(parseNesConfig(null)).toEqual(NES_FALLBACK)
  })
})

describe('parseLcarsClientId', () => {
  it('reads the client id the native client sends', () => {
    expect(
      parseLcarsClientId({ lcars: { clientId: 'ec7e38d4-03af-4b58-b131-cfb0495903ab' } })
    ).toBe('ec7e38d4-03af-4b58-b131-cfb0495903ab')
  })

  it('refuses anything that is not an id', () => {
    expect(parseLcarsClientId({ lcars: { clientId: 'x y' } })).toBeNull()
    expect(parseLcarsClientId({})).toBeNull()
  })
})

describe('parseStreamingClientConfig', () => {
  const config = {
    client: {
      supportedStreamingProfiles: {
        balanced: true,
        dataSaver: true,
        competitive: true,
        cinematic: true,
        custom: true
      },
      displayAllDynamicStreamingModes: true,
      streamingModeResolutionsConfiguration: {
        resolutionBadges: {
          uhd: {
            badgeText: '4K',
            resolutions: [
              { width: 3840, height: 2160 },
              { width: 3840, height: 2400 }
            ]
          },
          fiveK: { badgeText: '5K', resolutions: [{ width: 5120, height: 2880 }] }
        }
      }
    },
    linuxOSConfig: { client: { supportsWheelsGames: false } }
  }

  it('reads the modes, the network modes and the badges', () => {
    expect(parseStreamingClientConfig(config)).toEqual({
      supportedStreamingProfiles: {
        balanced: true,
        dataSaver: true,
        competitive: true,
        cinematic: true,
        custom: true
      },
      displayAllDynamicStreamingModes: true,
      resolutionBadges: [
        { width: 3840, height: 2160, badge: '4K' },
        { width: 3840, height: 2400, badge: '4K' },
        { width: 5120, height: 2880, badge: '5K' }
      ]
    })
  })

  // The client merges its Linux overrides before reading anything; the
  // SteamOS block is how Competitive disappears there.
  it('applies the Linux overrides the way the client does', () => {
    const overridden = {
      ...config,
      linuxOSConfig: {
        client: {
          supportedStreamingProfiles: { competitive: false },
          displayAllDynamicStreamingModes: false
        }
      }
    }
    expect(parseStreamingClientConfig(overridden)).toMatchObject({
      supportedStreamingProfiles: { competitive: false },
      displayAllDynamicStreamingModes: false
    })
  })

  it('degrades to offering everything', () => {
    expect(parseStreamingClientConfig(null)).toEqual(DEFAULT_CLIENT_CONFIG)
  })
})
