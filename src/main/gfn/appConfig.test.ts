import { describe, expect, it } from 'vitest'
import { parseAlsServerUrl } from './appConfig'

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
