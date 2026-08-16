import { createHash, randomBytes } from 'node:crypto'

/**
 * OAuth 2.0 Authorization Code flow with PKCE against NVIDIA accounts.
 *
 * Endpoints come from NVIDIA's OIDC discovery document
 * (`https://login.nvidia.com/.well-known/openid-configuration`), which returns
 * 200 and advertises the two below. They are defaulted rather than hardcoded so
 * a discovery refresh can override them.
 *
 * Why this and not the desktop client's token: the GFN client keeps its access
 * token in memory. The only copies on disk are incidental — request headers the
 * service worker happened to cache — they carry no refresh token, and they
 * expire within about a day. See docs/gfn-api.md.
 */

export const DEFAULT_AUTHORIZATION_ENDPOINT = 'https://login.nvidia.com/authorize'
export const DEFAULT_TOKEN_ENDPOINT = 'https://login.nvidia.com/token'
export const OIDC_DISCOVERY_URL = 'https://login.nvidia.com/.well-known/openid-configuration'

export interface OAuthConfig {
  /**
   * OAuth client id. Not defaulted on purpose — see docs/gfn-api.md. The
   * redirect URI has to be one this client is registered for, which is why the
   * two travel together.
   */
  clientId: string
  /**
   * RFC 8252 recommends a loopback redirect for native apps
   * (`http://127.0.0.1:<port>/callback`). Whether the authorization server
   * accepts one depends entirely on how `clientId` is registered.
   */
  redirectUri: string
  scope?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
}

export interface PkcePair {
  verifier: string
  challenge: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  /** Epoch milliseconds. */
  expiresAt: number
}

/**
 * RFC 7636 S256. The verifier is 32 random bytes base64url-encoded, matching
 * what the GFN bundle does (`crypto.getRandomValues(new Uint8Array(32))`).
 */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Opaque value tying the callback back to the request that started it. */
export function generateState(): string {
  return randomBytes(16).toString('base64url')
}

export function buildAuthorizationUrl(
  config: OAuthConfig,
  pkce: PkcePair,
  state: string
): string {
  const url = new URL(config.authorizationEndpoint ?? DEFAULT_AUTHORIZATION_ENDPOINT)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('scope', config.scope ?? 'openid profile')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/** Treats a token as stale a minute early, so it is never used mid-expiry. */
const EXPIRY_SKEW_MS = 60_000

function toTokenSet(raw: RawTokenResponse): TokenSet {
  if (!raw.access_token) {
    throw new Error(raw.error_description ?? raw.error ?? 'Token response carried no access token')
  }
  const lifetimeMs = (raw.expires_in ?? 3600) * 1000
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresAt: Date.now() + lifetimeMs - EXPIRY_SKEW_MS
  }
}

async function postForm(endpoint: string, body: URLSearchParams): Promise<RawTokenResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  })

  const raw = (await response.json().catch(() => ({}))) as RawTokenResponse
  if (!response.ok) {
    throw new Error(raw.error_description ?? raw.error ?? `Token request failed (${response.status})`)
  }
  return raw
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  verifier: string
): Promise<TokenSet> {
  return toTokenSet(
    await postForm(
      config.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        code_verifier: verifier
      })
    )
  )
}

export async function refreshTokens(
  config: OAuthConfig,
  refreshToken: string
): Promise<TokenSet> {
  const tokens = toTokenSet(
    await postForm(
      config.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId
      })
    )
  )
  // Servers may omit the refresh token on renewal; keep using the current one.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
}

export function isExpired(tokens: TokenSet, now = Date.now()): boolean {
  return now >= tokens.expiresAt
}
