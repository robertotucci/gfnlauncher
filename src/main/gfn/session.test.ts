import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapturedSession } from './webAuth'
import { getAlsToken, getSession, invalidateSession, readExpiry, signIn } from './session'

// The real one hosts a BrowserWindow. Everything under test here is what the
// session module does with what comes back from it.
const captured = vi.hoisted(() => ({ value: null as CapturedSession | null }))

vi.mock('./webAuth', () => ({
  captureSession: async (): Promise<CapturedSession> => {
    if (!captured.value) throw new Error('no session')
    return captured.value
  },
  clearAuthSession: async (): Promise<void> => {}
}))

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'ES256' })}.${encode(payload)}.signature`
}

/** Signs in with a session carrying the given Starfleet id token. */
async function signInWith(idToken: string | null): Promise<void> {
  captured.value = {
    token: null,
    idToken,
    clientId: 'GFN-PC',
    clientVersion: '2.0.87.130',
    vpcId: 'NP-EU-WEST',
    endpoint: 'https://apps.gxn.nvidia.com/graphql',
    headers: {}
  }
  await signIn('en_US')
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

describe('getAlsToken', () => {
  beforeEach(() => {
    invalidateSession()
  })

  it('returns nothing when there is no session at all', () => {
    expect(getAlsToken()).toBeNull()
  })

  it('hands back a live id token', async () => {
    const token = jwt({ exp: 2_000_000_000 })
    await signInWith(token)
    expect(getAlsToken(1_900_000_000_000)).toBe(token)
  })

  it('withholds an expired one rather than letting ALS answer 401', async () => {
    const token = jwt({ exp: 1_700_000_000 })
    await signInWith(token)
    expect(getAlsToken(1_800_000_000_000)).toBeNull()
  })

  it('withholds one inside the skew, before it is strictly spent', async () => {
    const token = jwt({ exp: 1_700_000_000 })
    await signInWith(token)
    expect(getAlsToken(1_700_000_000_000 - 30_000)).toBeNull()
  })

  it('keeps a token whose lifetime cannot be read', async () => {
    // Unknown is not the same as expired; let the server be the judge.
    const token = jwt({ sub: 'user' })
    await signInWith(token)
    expect(getAlsToken()).toBe(token)
  })

  it('returns nothing when the capture could not read one', async () => {
    await signInWith(null)
    expect(getAlsToken()).toBeNull()
  })
})

describe('invalidateSession', () => {
  it('drops the session so the next request re-captures', async () => {
    await signInWith(jwt({ exp: 2_000_000_000 }))
    expect(getSession()).not.toBeNull()

    invalidateSession()

    expect(getSession()).toBeNull()
    expect(getAlsToken()).toBeNull()
  })
})
