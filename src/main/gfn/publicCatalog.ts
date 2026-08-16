import { GfnApiError, paginate, type PageInfo } from './graphql'
import type { RawApp } from './wire'

/**
 * The public catalog feed — the whole GFN game list, with no sign-in.
 *
 * A separate service from the authenticated GraphQL API in `graphql.ts`, with a
 * separate schema. It is what NVIDIA's own "supported games" page and the
 * Playnite GeForce NOW extension read, and it is the only catalog source that
 * works signed out, which is what keeps the launcher useful before anyone has
 * ever logged in.
 *
 * Verified live on 2026-08-15 (see docs/gfn-api.md for the full probe):
 *
 * - 5.890 titles for `country: IT`, 8 pages of 750, about six seconds in total
 * - the cursor is base64 of the item offset (`NzUw` = `750`)
 * - **no ownership**: every field here is a property of the game, never of a
 *   user. `gfn.playabilityState` is deliberately not requested — signed out it
 *   comes back `UNPLAYABLE_DUE_TO_UPGRADE` for all 5.890 entries, which says
 *   nothing about the title.
 */

/**
 * Ray tracing, HDR and Reflex come from `variants.gfn.features`.
 *
 * **The field needs an inline fragment**, which is the only reason it took a
 * detour to find: `features` on its own is a 500, and so is `features { key }`,
 * because the declared type is abstract. `features { __typename }` answers
 * `GfnSubscriptionFeatureValue`, and spreading that concrete type is what makes
 * the selection legal. A bare object-typed field 500s exactly like a field that
 * does not exist, so probing names alone cannot tell the two apart — this one
 * was recovered from the GFN web client's own `isFeatureSupportedOnVariant`.
 *
 * Entries read `{ key: "RTX_ENABLED", value: "true" }`. Only `"true"` is ever
 * emitted; an absent key is a no. See docs/gfn-api.md.
 */
const FEATURES_SELECTION = `features {
            ... on GfnSubscriptionFeatureValue {
              key
              value
            }
          }`

export const PUBLIC_CATALOG_ENDPOINT =
  'https://api-prod.nvidia.com/services/gfngames/v1/gameList'

/**
 * A `User-Agent` is mandatory. Without one the edge closes the connection
 * straight after the TLS handshake — no status, no body — which reads as a
 * network fault rather than a rejection. Browser-shaped strings are accepted.
 */
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) GFN-Launcher'

/** `it_IT` -> country `IT`. Falls back to US English on anything unexpected. */
export function splitLocale(locale: string): { language: string; country: string } {
  const country = /^[a-z]{2}_([A-Z]{2})$/.exec(locale)?.[1]
  if (!country) return { language: 'en_US', country: 'US' }
  return { language: locale, country }
}

/**
 * Builds the request body.
 *
 * The body is a **bare GraphQL document sent as `application/json`** — the
 * usual `{"query": …}` envelope is rejected with a 500, as is
 * `Content-Type: application/graphql`. Values are interpolated through
 * `JSON.stringify`, which produces exactly the string literal syntax GraphQL
 * wants and keeps a stray quote out of the document.
 *
 * The selection is what `mapApp` and `mapDetails` consume. `searchQuery`,
 * `orderBy` and `filters` are *not* supported here (500), so this feed is
 * always the whole catalog and any filtering happens on our side.
 *
 * The detail half of the selection — `shortDescription`, `SCREENSHOTS`,
 * `KEY_ART`, and the extra variant fields — is not optional padding: there is
 * **no per-app query on this service**, so anything the details modal shows has
 * to come out of this same bulk walk. It roughly triples the payload (4.1 MB →
 * 13.1 MB, 6 s → 12.5 s), which is why `longDescription` is left out and why
 * the result is split into two caches downstream.
 *
 * `variants.gfn.features` is the cheapest thing here — 0.6 MB across the whole
 * walk — and the only source for the RTX flag. See `FEATURES_SELECTION`.
 *
 * Two fields are left out. `longDescription` runs 1.511 characters against
 * `shortDescription`'s 234, about 7.5 MB more, and is a wall of text at three
 * metres. `keywords` looks like Steam tags until you read it: a mean of 141 per
 * title, carrying every localisation of every tag plus the game's own title in
 * each language, for ~29 MB. It also holds a stale `rtx` marker on 89 titles
 * that is **not** the RTX list — Fortnite, Pragmata and Indiana Jones are all
 * ray-traced and carry none of it. See docs/gfn-api.md.
 */
export function buildGameListQuery(locale: string, cursor: string): string {
  const { language, country } = splitLocale(locale)
  return `{
  apps(country: ${JSON.stringify(country)}, language: ${JSON.stringify(language)}, after: ${JSON.stringify(cursor)}) {
    numberReturned
    pageInfo {
      hasNextPage
      endCursor
      totalCount
    }
    items {
      title
      sortName
      type
      publisherName
      developerName
      genres
      shortDescription
      images {
        GAME_BOX_ART
        TV_BANNER
        HERO_IMAGE
        KEY_ART
        SCREENSHOTS
      }
      variants {
        id
        appStore
        shortName
        storeUrl
        supportedControls
        subscriptions
        gfn {
          releaseDate
          ${FEATURES_SELECTION}
        }
      }
      gfn {
        minimumMembershipTierLabel
      }
    }
  }
}`
}

async function fetchPage(
  locale: string,
  cursor: string
): Promise<{ items: RawApp[]; pageInfo: PageInfo }> {
  let response: Response
  try {
    // Plain fetch, not the authenticated partition's: this endpoint takes no
    // credentials and there is no reason to hand it the user's cookie jar.
    response = await fetch(PUBLIC_CATALOG_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT
      },
      body: buildGameListQuery(locale, cursor)
    })
  } catch (cause) {
    throw new GfnApiError(cause instanceof Error ? cause.message : 'Network request failed')
  }

  if (!response.ok) {
    // The gateway answers a malformed document with a bare 500 and a Spring
    // error page rather than a GraphQL `errors` array, so the status is all
    // there is to report.
    throw new GfnApiError(`Public catalog request failed`, response.status)
  }

  const payload = (await response.json()) as {
    data?: { apps?: { items?: RawApp[] | null; pageInfo?: PageInfo } | null } | null
  }

  const apps = payload.data?.apps
  if (!apps) throw new GfnApiError('Public catalog response contained no apps')

  return { items: apps.items ?? [], pageInfo: apps.pageInfo as PageInfo }
}

/** Walks the whole feed. `maxItems` is the same guard the live catalog uses. */
export async function fetchPublicCatalog(
  locale: string,
  maxItems: number
): Promise<{ items: RawApp[]; truncated: boolean }> {
  return paginate<RawApp>((cursor) => fetchPage(locale, cursor), maxItems)
}
