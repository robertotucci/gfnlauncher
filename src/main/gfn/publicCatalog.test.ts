import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PUBLIC_CATALOG_ENDPOINT,
  buildGameListQuery,
  fetchPublicCatalog,
  splitLocale
} from './publicCatalog'

function page(items: unknown[], hasNextPage: boolean, endCursor = ''): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: { apps: { numberReturned: items.length, pageInfo: { hasNextPage, endCursor }, items } }
    })
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('splitLocale', () => {
  it('takes the country from the locale', () => {
    expect(splitLocale('it_IT')).toEqual({ language: 'it_IT', country: 'IT' })
  })

  it('falls back rather than sending a malformed locale to the API', () => {
    expect(splitLocale('nonsense')).toEqual({ language: 'en_US', country: 'US' })
  })
})

describe('buildGameListQuery', () => {
  it('sends the country and language the locale asks for', () => {
    const query = buildGameListQuery('de_DE', '')
    expect(query).toContain('country: "DE"')
    expect(query).toContain('language: "de_DE"')
  })

  it('quotes the cursor as a GraphQL string', () => {
    expect(buildGameListQuery('en_US', 'NzUw')).toContain('after: "NzUw"')
  })

  it('cannot be broken out of by a value containing a quote', () => {
    const query = buildGameListQuery('en_US', 'a" b')
    expect(query).toContain('after: "a\\" b"')
  })

  it('asks for the fields the mappers need', () => {
    const query = buildGameListQuery('en_US', '')
    for (const field of ['title', 'sortName', 'type', 'GAME_BOX_ART', 'variants', 'appStore']) {
      expect(query).toContain(field)
    }
  })

  it('asks for the detail fields too, since there is no per-app query', () => {
    const query = buildGameListQuery('en_US', '')
    for (const field of [
      'shortDescription',
      'SCREENSHOTS',
      'KEY_ART',
      'supportedControls',
      'subscriptions',
      'releaseDate'
    ]) {
      expect(query).toContain(field)
    }
  })

  it('asks for the per-variant store page, which nothing else carries', () => {
    // The details panel turns this into a QR: the only way to act on a link
    // from a sofa with no keyboard and no browser.
    expect(buildGameListQuery('en_US', '')).toContain('storeUrl')
  })

  it('leaves out longDescription, which nobody reads at three metres', () => {
    // It alone would take the walk from 13 MB to 22 MB.
    expect(buildGameListQuery('en_US', '')).not.toContain('longDescription')
  })

  it('spreads the concrete type on features, without which the query is a 500', () => {
    // `features` is abstractly typed: a bare `features` and a plain
    // `features { key }` both fail, and they fail with the same opaque 500 a
    // nonexistent field gives. The inline fragment is the whole trick.
    const query = buildGameListQuery('en_US', '')
    expect(query).toContain('... on GfnSubscriptionFeatureValue')
    expect(query).toMatch(/features\s*\{\s*\.\.\. on GfnSubscriptionFeatureValue\s*\{\s*key\s+value/)
  })

  it('leaves out keywords, which look like tags and are not', () => {
    // A mean of 141 per title, carrying every localisation of every tag plus
    // the game's own title in each language: ~29 MB. Its `rtx` marker is also
    // not the RTX list — it misses Fortnite, Pragmata and Indiana Jones.
    expect(buildGameListQuery('en_US', '')).not.toContain('keywords')
  })

  it('leaves out playabilityState, which is meaningless without a session', () => {
    // Signed out the API returns UNPLAYABLE_DUE_TO_UPGRADE for every title, so
    // reading it would mark the whole catalog unavailable.
    expect(buildGameListQuery('en_US', '')).not.toContain('playabilityState')
  })
})

describe('fetchPublicCatalog', () => {
  it('posts a bare GraphQL document, not a { query } envelope', async () => {
    const fetchMock = vi.fn(async () => page([{ title: 'A' }], false))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPublicCatalog('en_US', 100)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(PUBLIC_CATALOG_ENDPOINT)
    expect(init.method).toBe('POST')
    expect(String(init.body).startsWith('{\n  apps(')).toBe(true)
  })

  it('sends a User-Agent, without which the connection is dropped', async () => {
    const fetchMock = vi.fn(async () => page([], false))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPublicCatalog('en_US', 100)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['User-Agent']).toBeTruthy()
  })

  it('follows the cursor until the feed says there is no next page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([{ title: 'A' }], true, 'NzUw'))
      .mockResolvedValueOnce(page([{ title: 'B' }], false))
    vi.stubGlobal('fetch', fetchMock)

    const { items, truncated } = await fetchPublicCatalog('en_US', 100)

    expect(items.map((item) => item.title)).toEqual(['A', 'B'])
    expect(truncated).toBe(false)
    expect(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).toContain(
      'after: "NzUw"'
    )
  })

  it('reports truncation instead of walking an API we do not control forever', async () => {
    const fetchMock = vi.fn(async () => page([{ title: 'A' }, { title: 'B' }], true, 'more'))
    vi.stubGlobal('fetch', fetchMock)

    const { items, truncated } = await fetchPublicCatalog('en_US', 2)

    expect(items).toHaveLength(2)
    expect(truncated).toBe(true)
  })

  it('raises a GfnApiError on a rejected request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response)
    )

    await expect(fetchPublicCatalog('en_US', 100)).rejects.toThrow(/500|failed/i)
  })

  it('raises rather than reporting an empty catalog when the shape changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }) as unknown as Response
      )
    )

    await expect(fetchPublicCatalog('en_US', 100)).rejects.toThrow(/no apps/i)
  })
})
