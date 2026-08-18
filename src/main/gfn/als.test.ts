import { describe, expect, it } from 'vitest'
import { buildSyncRequest, type AlsConfig } from './als'

function config(overrides: Partial<AlsConfig> = {}): AlsConfig {
  return {
    serverUrl: 'https://als.geforcenow.com',
    token: null,
    clientId: 'GFN-PC',
    clientVersion: '2.0.87.130',
    ...overrides
  }
}

/** Shaped like a JWT, and deliberately not one. Never use a real token here. */
const ID_TOKEN = 'header.payload.signature'

describe('buildSyncRequest', () => {
  it('builds the v1 sync path for a provider', () => {
    expect(buildSyncRequest(config(), 'STEAM').url).toBe(
      'https://als.geforcenow.com/v1/sync/STEAM'
    )
  })

  it('does not double the slash when the configured url has a trailing one', () => {
    // The base url comes out of the installed client's config.json, which is
    // not ours to normalise.
    expect(buildSyncRequest(config({ serverUrl: 'https://als.geforcenow.com/' }), 'EPIC').url).toBe(
      'https://als.geforcenow.com/v1/sync/EPIC'
    )
  })

  it('encodes a provider id rather than pasting it into the path', () => {
    expect(buildSyncRequest(config(), 'a/b?c').url).toBe(
      'https://als.geforcenow.com/v1/sync/a%2Fb%3Fc'
    )
  })

  it('sends the Starfleet id token as a bearer', () => {
    // The whole bug: without this header ALS answers 401 for every store.
    expect(buildSyncRequest(config({ token: ID_TOKEN }), 'STEAM').headers.Authorization).toBe(
      `Bearer ${ID_TOKEN}`
    )
  })

  it('sends no Authorization at all when there is no token', () => {
    expect(buildSyncRequest(config(), 'STEAM').headers).not.toHaveProperty('Authorization')
  })

  it('never replays the captured GraphQL credential', () => {
    // That one is a GFNJWT scoped to apps.gxn.nvidia.com. A server honours the
    // header over the cookie and then rejects it, so replaying it is worse than
    // sending nothing.
    const request = buildSyncRequest(
      config({ headers: { authorization: 'GFNJWT captured', 'NV-Device-ID': 'device' } }),
      'STEAM'
    )
    expect(request.headers).not.toHaveProperty('authorization')
    expect(request.headers).not.toHaveProperty('Authorization')
    expect(request.headers['NV-Device-ID']).toBe('device')
  })

  it('strips a captured credential whatever its casing', () => {
    const request = buildSyncRequest(
      config({ token: ID_TOKEN, headers: { AUTHORIZATION: 'GFNJWT captured' } }),
      'STEAM'
    )
    expect(Object.entries(request.headers).filter(([name]) => /^authorization$/i.test(name))).toEqual(
      [['Authorization', `Bearer ${ID_TOKEN}`]]
    )
  })

  it('posts an empty JSON object under the Content-Type that promises one', () => {
    const request = buildSyncRequest(config(), 'STEAM')
    expect(request.headers['Content-Type']).toBe('application/json')
    expect(request.body).toBe('{}')
  })

  it('omits the NV-Client headers when the capture did not yield them', () => {
    const request = buildSyncRequest(config({ clientId: '', clientVersion: '' }), 'STEAM')
    expect(request.headers).not.toHaveProperty('NV-Client-ID')
    expect(request.headers).not.toHaveProperty('NV-Client-Version')
  })
})
