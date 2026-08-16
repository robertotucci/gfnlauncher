import { describe, expect, it } from 'vitest'
import { readExpiry } from './session'

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'ES256' })}.${encode(payload)}.signature`
}

describe('readExpiry', () => {
  it('converts the exp claim from seconds to milliseconds', () => {
    expect(readExpiry(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000)
  })

  it('returns null when there is no exp claim', () => {
    expect(readExpiry(jwt({ sub: 'user' }))).toBeNull()
  })

  it('returns null for a non-numeric exp rather than trusting it', () => {
    expect(readExpiry(jwt({ exp: '1700000000' }))).toBeNull()
  })

  it('survives a malformed token instead of throwing', () => {
    // Callers treat null as "unknown lifetime"; a throw here would break sign-in.
    expect(readExpiry('not-a-jwt')).toBeNull()
    expect(readExpiry('')).toBeNull()
    expect(readExpiry('a.!!!not-base64!!!.c')).toBeNull()
  })

  it('handles base64url payloads containing - and _', () => {
    // Standard base64 decoding would mangle these; the claim must still parse.
    const token = jwt({ exp: 1_700_000_000, sub: 'a-b_c~d?e' })
    expect(readExpiry(token)).toBe(1_700_000_000_000)
  })
})
