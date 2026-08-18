import type { SyncResult } from '@shared/types'
import { getAuthSession } from './partition'

/**
 * Client for NVIDIA's Account Linking Service (ALS) — the REST service that
 * backs GFN's store-account linking and library sync. It is a *different*
 * backend from the GraphQL catalog API; do not conflate the two.
 *
 * Surface, read out of the shipped client bundle:
 *   POST {serverUrl}/v1/token           -> JWT (guest-mode nonce exchange only)
 *   POST {serverUrl}/v1/sync/{provider} -> 202 Accepted, sync runs async
 *   operations: GetApps, GetOAuthURL, LinkAccount, UnlinkAccount, LibrarySync
 *
 * It authenticates with `Bearer <Starfleet id token>` — see `AlsConfig.token`.
 * The partition's cookies, which are all the GraphQL API needs, are not enough
 * here; assuming otherwise is what made every sync answer 401.
 *
 * `serverUrl` comes from the client's runtime `appConfig.accountLinking`, and a
 * proxy override can replace it, so it is configuration here rather than a
 * constant — see `appConfig.ts`, which reads it off the installed Flatpak.
 *
 * These are private, undocumented APIs. Treat every response as untrusted and
 * make sure a shape change degrades the launcher instead of breaking it.
 */

/**
 * The client builds every ALS URL as `server + "/v1/" + path`
 * (`buildApiUrl`, client 2.0.87.130).
 *
 * `docs/gfn-api.md` carried `/v2/` for two sweeps, transcribed from an older
 * note and never observed. If a future client moves on, this is the one line to
 * change; a wrong version reads as a 404, not as an auth failure.
 */
const API_VERSION = 'v1'

export interface AlsConfig {
  /** Base URL, without the trailing /v1. */
  serverUrl: string
  /**
   * The Starfleet id token, which is what ALS authenticates against — **not**
   * the GraphQL credential.
   *
   * `webAuth.ts` reads it out of the hosted web client's own Starfleet session;
   * `session.getAlsToken()` withholds it once expired. Null when it could not
   * be read, and then the request goes out unauthenticated and is refused,
   * which is a truthful outcome rather than a silent one.
   */
  token: string | null
  clientId: string
  clientVersion: string
  /** Every header the captured request carried. Replayed minus Authorization. */
  headers?: Record<string, string>
}

function apiUrl(config: AlsConfig, path: string): string {
  return `${config.serverUrl.replace(/\/+$/, '')}/${API_VERSION}/${path}`
}

/**
 * The captured headers with the GraphQL credential taken back out.
 *
 * The session's `Authorization` belongs to `apps.gxn.nvidia.com` — a real
 * capture reads `authScheme=GFNJWT` — and ALS is a different service wanting a
 * different scheme. Forwarding it is the exact mistake `webAuth.ts` records: a
 * server honours the header over the cookie and *then* rejects it. The right
 * credential is put back by `buildSyncRequest`, from `config.token`.
 */
function replayableHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')
  )
}

export interface SyncRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * Everything about the sync request that can be decided without a network.
 *
 * Separated out because the credential rules here are the whole bug: this ran
 * for a release sending no `Authorization` at all, on the theory that the
 * partition's `.geforcenow.com` cookies would carry it, and every sync came
 * back 401. The shipped client's `AlsService.providerSync` sends
 * `Bearer <Starfleet id token>` and nothing else does — so the ordering below
 * matters, and the `Authorization` that arrives in `config.headers` must lose
 * to the one built here.
 */
export function buildSyncRequest(config: AlsConfig, providerId: string): SyncRequest {
  return {
    url: apiUrl(config, `sync/${encodeURIComponent(providerId)}`),
    headers: {
      ...replayableHeaders(config.headers),
      'Content-Type': 'application/json',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(config.clientId ? { 'NV-Client-ID': config.clientId } : {}),
      ...(config.clientVersion ? { 'NV-Client-Version': config.clientVersion } : {})
    },
    // The client posts an empty JSON object, not an absent body, under a
    // Content-Type that promises one.
    body: '{}'
  }
}

/**
 * Triggers a library resync for one linked store — the same call GFN's own
 * "Refresh library" button makes.
 *
 * A 202 means the request was accepted, not that the sync finished. Poll the
 * provider list afterwards rather than assuming the library is current.
 *
 * A 401 is reported as an expired sign-in rather than as a status, because that
 * is what it means here and it is the one thing the user can act on. The status
 * still travels on the result so the caller can decide to re-capture and retry.
 */
export async function syncProvider(
  config: AlsConfig,
  providerId: string
): Promise<SyncResult> {
  const request = buildSyncRequest(config, providerId)

  try {
    // Electron's net stack bound to the signed-in partition, not Node's fetch:
    // a bare fetch from the main process carries none of the session and was
    // rejected 401 on the GraphQL API for exactly this reason.
    const response = await getAuthSession().fetch(request.url, {
      method: 'POST',
      credentials: 'include',
      headers: request.headers,
      body: request.body
    })

    if (response.status === 202) {
      return { accepted: true, providerId, status: response.status, error: null }
    }

    if (response.status === 401) {
      return {
        accepted: false,
        providerId,
        status: response.status,
        error: 'Sign-in expired — sign in to GeForce NOW again'
      }
    }

    // A bare status says nothing about why. ALS usually explains.
    const detail = await response.text().catch(() => '')
    return {
      accepted: false,
      providerId,
      status: response.status,
      error: `Sync refused (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`
    }
  } catch (err) {
    return {
      accepted: false,
      providerId,
      status: null,
      error: err instanceof Error ? err.message : 'Sync request failed'
    }
  }
}
