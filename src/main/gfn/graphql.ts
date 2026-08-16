import { getAuthSession } from './partition'

/**
 * Client for GFN's GraphQL API.
 *
 * The endpoint was recovered from the shipped client's HTTP cache and is stable
 * enough to default, but stays overridable: the client itself reads its hosts
 * from runtime config and honours a proxy override.
 */

export const DEFAULT_GRAPHQL_ENDPOINT = 'https://apps.gxn.nvidia.com/graphql'

export interface GfnGraphQLConfig {
  endpoint?: string
  /**
   * Bearer token, when the session has one. Usually null: the web client
   * authenticates with session cookies, and sending a bearer the server does
   * not expect makes it reject the request rather than fall back to the cookie.
   */
  token: string | null
  clientId: string
  clientVersion: string
  /** Server zone id, resolved from the zone service — not an account id. */
  vpcId: string
  locale: string
  /**
   * Every header the captured request carried. Replayed verbatim, because
   * sending only the bearer and the NV-Client-* pair was rejected 401 and the
   * API does not document what else it wants.
   */
  headers?: Record<string, string>
}

export class GfnApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'GfnApiError'
  }
}

/**
 * `requestType` is a cache-partitioning hint rather than a selector — the
 * operation itself travels in the body — but the client always sends one, and
 * mirroring that keeps us on the same cache behaviour as the real app.
 */
export async function execute<T>(
  config: GfnGraphQLConfig,
  requestType: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const url = `${config.endpoint ?? DEFAULT_GRAPHQL_ENDPOINT}?requestType=${requestType}`

  let response: Response
  try {
    // Electron's net stack rather than Node fetch, bound to the partition the
    // user signed in on: that carries the session cookies, proxy settings and
    // TLS behaviour of the window whose credentials these are. A bare fetch
    // from the main process sends none of that and was rejected 401.
    response = await getAuthSession().fetch(url, {
      method: 'POST',
      // Send the partition's cookies with it.
      credentials: 'include',
      headers: {
        ...config.headers,
        // Must be application/json. The bundle mentions application/graphql,
        // but the server rejects that transport outright:
        //   POST … Content-Type: application/graphql -> 400 "transport not supported"
        //   POST … Content-Type: application/json    -> reaches auth (401/403)
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        ...(config.clientId ? { 'NV-Client-ID': config.clientId } : {}),
        ...(config.clientVersion ? { 'NV-Client-Version': config.clientVersion } : {})
      },
      body: JSON.stringify({ query, variables })
    })
  } catch (cause) {
    throw new GfnApiError(cause instanceof Error ? cause.message : 'Network request failed')
  }

  if (!response.ok) {
    // A bare status says nothing about *why*. The gateway usually explains.
    const detail = await response.text().catch(() => '')
    throw new GfnApiError(
      `GraphQL request failed${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      response.status
    )
  }

  const payload = (await response.json()) as {
    data?: T
    errors?: { message?: string }[]
  }

  if (payload.errors?.length) {
    throw new GfnApiError(payload.errors[0]?.message ?? 'GraphQL error')
  }
  if (!payload.data) {
    throw new GfnApiError('GraphQL response contained no data')
  }

  return payload.data
}

export interface PageInfo {
  hasNextPage: boolean
  endCursor: string
  totalCount: number
}

/**
 * Walks a cursor-paginated `apps` query to completion.
 *
 * `maxItems` is a guard, not a feature: the full catalog runs to thousands of
 * titles and an unbounded loop against an API we do not control is a hang
 * waiting to happen. Callers are told when it truncates.
 */
export async function paginate<TItem>(
  fetchPage: (cursor: string) => Promise<{ items: TItem[]; pageInfo: PageInfo }>,
  maxItems: number
): Promise<{ items: TItem[]; truncated: boolean }> {
  const items: TItem[] = []
  let cursor = ''

  for (;;) {
    const page = await fetchPage(cursor)
    items.push(...page.items)

    if (items.length >= maxItems) return { items: items.slice(0, maxItems), truncated: true }
    if (!page.pageInfo?.hasNextPage || !page.pageInfo.endCursor) {
      return { items, truncated: false }
    }
    cursor = page.pageInfo.endCursor
  }
}
