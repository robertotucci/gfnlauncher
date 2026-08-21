/**
 * GraphQL documents, lifted from the GFN client bundle.
 *
 * Field selections are kept close to what the client itself asks for: a
 * narrower selection risks tripping over required-field behaviour we cannot see
 * from outside, and the response size is dominated by the item count anyway.
 *
 * See docs/gfn-api.md for provenance.
 */

/** Browse or search the catalog. Cursor-paginated; filtering is server-side. */
export const SEARCH_APPS = `
query GetSearchFilterResults(
  $vpcId: String!,
  $locale: String!,
  $sortString: String!,
  $fetchCount: Int!,
  $cursor: String!,
  $searchString: String!,
  $filters: AppFilterFields!) {
  apps(
    vpcId: $vpcId,
    language: $locale,
    orderBy: $sortString,
    first: $fetchCount,
    after: $cursor,
    searchQuery: $searchString,
    filters: $filters
    ){
    numberReturned
    pageInfo {
      hasNextPage
      endCursor
      totalCount
    }
    items {
      id
      title
      sortName
      publisherName
      developerName
      genres
      images {
        GAME_BOX_ART
        TV_BANNER
        HERO_IMAGE
      }
      variants {
        id
        appStore
        shortName
        storeUrl
        gfn {
          status
          library {
            status
            selected
          }
        }
      }
      gfn {
        playabilityState
        minimumMembershipTierLabel
      }
    }
  }
}`

export const USER_ACCOUNT_LINKING = `
query GetUserAccountLinkingData{
  userAccount {
    storesData {
      store
      accountLinkingData {
        userDisplayName
        expiresIn
        userIdentifier
        accountSyncingData {
          totalNumberOfSyncedGfnGames
          syncState
          syncDate
        }
      }
    }
  }
}`

export const ADD_OWNED_VARIANT = `
mutation AddOwnedVariant($cmsId: String!, $locale: String!) {
  addOwnedVariant(language: $locale, variantId: $cmsId) {
    app {
      id
    }
  }
}`

export const REMOVE_OWNED_VARIANT = `
mutation RemoveOwnedVariant($cmsId: String!, $locale: String!) {
  removeOwnedVariant(language: $locale, variantId: $cmsId) {
    app {
      id
    }
  }
}`

/**
 * Picks which store's edition a title launches from.
 *
 * Transcribed from the client bundle, like the two above — it sits in the same
 * operation table, and the client calls it through
 * `addPlatformPreference(variantId)`. What is unobserved is a *successful
 * response* to it from here: treat a failure as expected rather than
 * exceptional, and do not persist a selection the server did not take. The name
 * says `owned`, and the client only ever calls it once ownership is
 * established, so it may well refuse a variant the user has not been marked as
 * owning; that is why the panel offers "mark owned" beside it.
 *
 * What it sets is the `selected` flag `pickLaunchVariant` reads. That decides
 * which edition the launcher hands over — the deep link's `shortName` is what
 * makes the client accept it rather than resolve one of its own. See
 * `buildUrlRoute`.
 */
export const SELECT_OWNED_VARIANT = `
mutation SelectOwnedVariant($cmsId: String!, $locale: String!) {
  selectOwnedVariant(language: $locale, variantId: $cmsId) {
    app {
      id
    }
  }
}`

/**
 * Which stores GFN will actually pull a library from.
 *
 * A narrowed `appStoreDefinitions` selection out of the client's
 * `GetStaticAppData`, which asks for the same `features` union alongside a
 * great deal the launcher has no use for. `AccountLinkingSso` and
 * `AccountGamesSyncing` are separate members of it, and a store can support the
 * first without the second — Epic is exactly that, and asking ALS to sync it
 * answers 400. `AccountGamesSyncing.supported` is what the client's
 * `isAccountSyncingSupported` reads before it asks.
 *
 * Sent under `requestType=staticAppData`, as the client sends it.
 */
export const APP_STORE_FEATURES = `
query GetAppStoreDefinitions($locale: String!) {
  appStoreDefinitions(language: $locale) {
    store
    features {
      __typename
      ... on AccountGamesSyncing {
        supported
      }
    }
  }
}`

/**
 * "My library" is a filter on the same `apps` query, not a separate endpoint:
 * every variant whose GFN library status is anything other than NOT_OWNED.
 */
export const OWNED_FILTER = {
  variants: { gfn: { library: { status: { notEquals: 'NOT_OWNED' } } } }
} as const

export const NO_FILTER = {} as const
