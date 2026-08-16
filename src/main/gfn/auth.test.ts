import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildAuthorizationUrl,
  generatePkce,
  generateState,
  isExpired,
  type OAuthConfig
} from './auth'

const config: OAuthConfig = {
  clientId: 'test-client',
  redirectUri: 'http://127.0.0.1:41234/callback'
}

describe('generatePkce', () => {
  it('derives the challenge as base64url(sha256(verifier)) per RFC 7636 S256', () => {
    const { verifier, challenge } = generatePkce()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('produces url-safe values needing no further encoding', () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePkce().verifier))
    expect(seen.size).toBe(50)
  })
})

describe('generateState', () => {
  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateState()))
    expect(seen.size).toBe(50)
  })
})

describe('buildAuthorizationUrl', () => {
  const pkce = generatePkce()
  const url = new URL(buildAuthorizationUrl(config, pkce, 'state-123'))

  it('requests an authorization code', () => {
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it('sends the challenge, never the verifier', () => {
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(url.toString()).not.toContain(pkce.verifier)
  })

  it('declares S256 rather than plain', () => {
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('round-trips a redirect URI that needs escaping', () => {
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri)
  })

  it('honours an endpoint override', () => {
    const overridden = buildAuthorizationUrl(
      { ...config, authorizationEndpoint: 'https://example.test/auth' },
      pkce,
      'x'
    )
    expect(overridden.startsWith('https://example.test/auth?')).toBe(true)
  })
})

describe('isExpired', () => {
  it('reports a future token as usable', () => {
    expect(isExpired({ accessToken: 'a', refreshToken: null, expiresAt: 2_000 }, 1_000)).toBe(false)
  })

  it('reports a token as expired at the boundary', () => {
    expect(isExpired({ accessToken: 'a', refreshToken: null, expiresAt: 1_000 }, 1_000)).toBe(true)
  })
})
