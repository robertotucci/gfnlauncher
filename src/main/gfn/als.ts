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
   * A token ALS itself issued or accepts — **not** the GraphQL credential.
   *
   * Null in practice today: the client authenticates ALS with the Starfleet id
   * token, which the launcher does not capture. See `authorization()`.
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
 * The captured headers with any credential taken back out.
 *
 * The session's `Authorization` belongs to `apps.gxn.nvidia.com` — a real
 * capture reads `authScheme=GFNJWT`, not even a Bearer — and ALS is a different
 * service. Forwarding it is the exact mistake `webAuth.ts` records: a server
 * honours the header over the cookie and *then* rejects it, so sending someone
 * else's credential is worse than sending none. Dropping it can only help: if
 * ALS accepts the partition's cookies this is what makes that work, and if it
 * insists on its own token we have none either way.
 */
function replayableHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')
  )
}

/**
 * Triggers a library resync for one linked store — the same call GFN's own
 * "Refresh library" button makes.
 *
 * A 202 means the request was accepted, not that the sync finished. Poll the
 * provider list afterwards rather than assuming the library is current.
 *
 * The bundle authenticates this with the Starfleet *id* token, which is not
 * what the launcher captures. ALS sits on `.geforcenow.com`, the same
 * registrable domain the auth partition holds cookies for, so the request goes
 * out through that partition exactly like a GraphQL call and lets the cookies
 * do the work. If that turns out not to be enough the answer is a 401, and the
 * caller is expected to show it rather than treat it as an internal error.
 */
export async function syncProvider(
  config: AlsConfig,
  providerId: string
): Promise<SyncResult> {
  try {
    // Electron's net stack bound to the signed-in partition, not Node's fetch:
    // a bare fetch from the main process carries none of the session and was
    // rejected 401 on the GraphQL API for exactly this reason.
    const response = await getAuthSession().fetch(
      apiUrl(config, `sync/${encodeURIComponent(providerId)}`),
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...replayableHeaders(config.headers),
          'Content-Type': 'application/json',
          // Only ever an ALS token, never the GraphQL one — see above.
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
          ...(config.clientId ? { 'NV-Client-ID': config.clientId } : {}),
          ...(config.clientVersion ? { 'NV-Client-Version': config.clientVersion } : {})
        }
      }
    )

    if (response.status === 202) {
      return { accepted: true, providerId, error: null }
    }

    // A bare status says nothing about why. ALS usually explains.
    const detail = await response.text().catch(() => '')
    return {
      accepted: false,
      providerId,
      error: `Sync refused (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`
    }
  } catch (err) {
    return {
      accepted: false,
      providerId,
      error: err instanceof Error ? err.message : 'Sync request failed'
    }
  }
}
