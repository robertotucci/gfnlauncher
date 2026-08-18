import type { GfnGraphQLConfig } from './graphql'
import { captureSession, clearAuthSession, type CapturedSession } from './webAuth'

/**
 * The authenticated GFN session.
 *
 * Held in memory only. The login itself persists in the auth window's session
 * partition — that is a browser cookie jar, which is the appropriate place for
 * it — but the bearer token is never written to disk.
 */

interface ActiveSession {
  captured: CapturedSession
  /** Epoch ms, read from the token's own `exp`. */
  expiresAt: number
  locale: string
}

/** Treat a token as spent a minute early so it is never used mid-expiry. */
const EXPIRY_SKEW_MS = 60_000

/**
 * Fallback lifetime when there is no token to read an `exp` from.
 *
 * Cookie-backed sessions are the normal case and carry no expiry we can see, so
 * this is a re-check interval rather than a real deadline: when it lapses the
 * launcher silently re-captures, which costs nothing if the login is still good.
 */
const ASSUMED_LIFETIME_MS = 60 * 60_000

let active: ActiveSession | null = null
let inFlight: Promise<GfnGraphQLConfig | null> | null = null

/**
 * Reads `exp` out of a JWT.
 *
 * The signature is deliberately not verified: we are not the audience and hold
 * no key. This value is only used to decide when to refresh, and a wrong guess
 * costs one rejected request, not a security hole.
 */
export function readExpiry(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

function toConfig(session: ActiveSession): GfnGraphQLConfig {
  return {
    endpoint: session.captured.endpoint,
    token: session.captured.token,
    clientId: session.captured.clientId,
    clientVersion: session.captured.clientVersion,
    vpcId: session.captured.vpcId,
    locale: session.locale,
    headers: session.captured.headers
  }
}

function store(captured: CapturedSession, locale: string): ActiveSession {
  const expiresAt =
    (captured.token ? readExpiry(captured.token) : null) ?? Date.now() + ASSUMED_LIFETIME_MS
  active = { captured, expiresAt, locale }
  return active
}

export function isExpired(now = Date.now()): boolean {
  return active === null || now >= active.expiresAt - EXPIRY_SKEW_MS
}

export function isAuthenticated(): boolean {
  return active !== null
}

/**
 * The credential ALS wants, which is not the one GraphQL uses.
 *
 * GraphQL rides on the partition's cookies; ALS refuses those and insists on
 * `Bearer <Starfleet id token>`. Unlike the cookie session this one carries a
 * readable `exp`, so a stale token can be recognised here instead of becoming a
 * 401 the user has to interpret. Null means "re-capture before asking ALS".
 */
export function getAlsToken(now = Date.now()): string | null {
  const token = active?.captured.idToken
  if (!token) return null
  const expiry = readExpiry(token)
  if (expiry !== null && now >= expiry - EXPIRY_SKEW_MS) return null
  return token
}

/**
 * Forgets the current session so the next `ensureSession` re-captures.
 *
 * The clock is not the only way a session dies: cookies can be revoked
 * server-side, and nothing about that is visible until a request comes back
 * 401. Without this seam the launcher kept using a session the server had
 * already rejected until `ASSUMED_LIFETIME_MS` ran out.
 */
export function invalidateSession(): void {
  active = null
}

/** Current session without touching the network. Null when absent or stale. */
export function getSession(): GfnGraphQLConfig | null {
  if (!active || isExpired()) return null
  return toConfig(active)
}

/**
 * Returns a usable session, silently topping up an expired token.
 *
 * The persisted partition means a headless re-capture needs no user
 * interaction — the hosted web app signs itself back in and we read the fresh
 * token off its next request. Returns null when the login has lapsed.
 *
 * `linked` gates that attempt. A headless capture boots the whole GFN web app
 * and can sit there for its full timeout, so it must never run speculatively:
 * on a launcher that has never been signed in there is nothing to revive, and
 * the wait would stall whatever asked. Callers pass the persisted flag.
 *
 * Concurrent callers share one capture; several screens refreshing at once must
 * not each spawn a window.
 */
export async function ensureSession(
  locale = 'en_US',
  linked = false
): Promise<GfnGraphQLConfig | null> {
  if (active && !isExpired()) return toConfig(active)
  if (!linked) return null
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      return toConfig(store(await captureSession({ interactive: false }), locale))
    } catch {
      // Login has lapsed; the user has to sign in again.
      active = null
      return null
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/** Opens the sign-in window. Rejects if the user closes it or it times out. */
export async function signIn(locale = 'en_US'): Promise<GfnGraphQLConfig> {
  const captured = await captureSession({ interactive: true })
  return toConfig(store(captured, locale))
}

export async function signOut(): Promise<void> {
  active = null
  await clearAuthSession()
}
