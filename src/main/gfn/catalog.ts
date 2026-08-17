import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { writeFileAtomic } from '../atomicFile'
import {
  CATALOG_CACHE_VERSION,
  type CatalogSnapshot,
  type GameDetails,
  type GameStoreOwnership,
  type GfnGame
} from '@shared/types'
import { storeLabel } from '@shared/games'
import { mapDetailsIndex, saveDetails } from './details'
import { FIXTURE_GAMES } from './fixtures'
import { execute, paginate, type GfnGraphQLConfig, type PageInfo } from './graphql'
import { fetchPublicCatalog } from './publicCatalog'
import { NO_FILTER, OWNED_FILTER, SEARCH_APPS } from './queries'
import { imageUrl, pickLaunchVariant, variantOwned, variantRtx, type RawApp } from './wire'

/** Titles fetched per request. The client itself pages in chunks of this order. */
const PAGE_SIZE = 100

/**
 * Guard against an unbounded walk of an API we do not control.
 *
 * Headroom, not a target: the catalog measured 5.890 titles in August 2026, so
 * the previous 5.000 was quietly dropping about nine hundred games.
 */
const MAX_ITEMS = 10_000

/**
 * Collapses one catalog app into the launcher's model.
 *
 * An app carries one variant per store. The launcher needs a single launchable
 * id, so it prefers the variant GFN has marked `selected`, then any owned one,
 * then the first — which mirrors what the client does when you press play.
 */
export function mapApp(raw: RawApp): GfnGame | null {
  const variants = raw.variants ?? []
  const title = raw.title?.trim()
  if (!title) return null

  // Only when the feed says what kind of entry this is: a DLC or a platform
  // client would render as a tile that launches nothing useful.
  if (raw.type && raw.type !== 'GAME') return null

  const launchVariant = pickLaunchVariant(variants)

  const cmsId = launchVariant?.id != null ? String(launchVariant.id) : null
  if (!cmsId) return null

  const stores: GameStoreOwnership[] = variants
    // A variant with no id can neither be launched nor named in an ownership
    // mutation, so a chip for it would be a control that does nothing.
    .filter((variant) => variant.id != null)
    .map((variant) => ({
      storeId: variant.appStore ?? 'unknown',
      storeLabel: storeLabel(variant.appStore),
      owned: variantOwned(variant),
      variantId: String(variant.id),
      // `||`, not `??`: the feed returns an empty slug for a good few variants,
      // and "" is absence rather than a value the deep link should carry.
      shortName: variant.shortName || null,
      storeUrl: variant.storeUrl || null
    }))

  // Only what GFN itself reports. Absent on the public feed, which knows no
  // user, and absent signed in until the account has actually chosen a store.
  const selectedVariant = variants.find((variant) => variant.gfn?.library?.selected)

  const availability =
    raw.gfn?.playabilityState === 'MAINTENANCE'
      ? 'maintenance'
      : raw.gfn?.playabilityState === 'UNAVAILABLE'
        ? 'unavailable'
        : 'available'

  return {
    cmsId,
    title,
    sortName: raw.sortName?.toLowerCase() ?? title.toLowerCase(),
    shortName: launchVariant?.shortName || null,
    parentGameId: null,
    publisher: raw.publisherName ?? null,
    developer: raw.developerName ?? null,
    genres: raw.genres ?? [],
    // Public feed only: `SEARCH_APPS` does not select `features`, so a
    // signed-in walk leaves this false and `refreshCatalog` fills it in from
    // the public walk it already makes for the details panel.
    rtx: variants.some(variantRtx),
    stores,
    images: {
      tile: imageUrl(raw, 'GAME_BOX_ART') ?? imageUrl(raw, 'TV_BANNER'),
      hero: imageUrl(raw, 'HERO_IMAGE') ?? imageUrl(raw, 'TV_BANNER'),
      logo: null
    },
    availability,
    membershipTier: raw.gfn?.minimumMembershipTierLabel ?? null,
    owned: stores.some((store) => store.owned),
    selectedVariantId: selectedVariant?.id != null ? String(selectedVariant.id) : null
  }
}

/**
 * The public feed's ray-traced titles, in the two shapes the authenticated
 * catalog can be matched against.
 */
export interface RtxIndex {
  /**
   * Every variant id of a ray-traced title — including the editions that are
   * *not* themselves flagged. The flag is per variant, but a title carries one
   * badge (see `variantRtx`), and the lookup happens against whichever edition
   * the signed-in user owns, which for Black Ops 6 is usually not the flagged
   * one. Indexing per variant at all is for the reason `mapDetailsIndex` does
   * it: signed in, a tile's id is the user's edition, while this is built from
   * the public feed, which knows no ownership and settles on Steam.
   */
  variantIds: Set<string>
  /**
   * Lowercased `sortName`s, because the two feeds do not always agree on ids.
   * Every Battle.net title has a different variant id on each side — World of
   * Warcraft: Midnight is `102758611` publicly and `103255961` in a session —
   * so an id-only match silently drops them. `sortName` is an unlocalised slug
   * both feeds emit, and it lifts the match from 166 titles to 170 of 171.
   */
  sortNames: Set<string>
}

export function mapRtxIndex(items: RawApp[]): RtxIndex {
  const variantIds = new Set<string>()
  const sortNames = new Set<string>()

  for (const item of items) {
    // Same gate as `mapApp`: an entry that never becomes a tile cannot be
    // badged, and indexing it only risks colliding with one that is.
    if (item.type && item.type !== 'GAME') continue

    const variants = item.variants ?? []
    if (!variants.some(variantRtx)) continue

    for (const variant of variants) {
      if (variant.id != null) variantIds.add(String(variant.id))
    }
    const sortName = item.sortName?.toLowerCase() || item.title?.trim().toLowerCase()
    if (sortName) sortNames.add(sortName)
  }

  return { variantIds, sortNames }
}

/**
 * Whether the index covers a game the authenticated walk produced.
 *
 * Id first, because it is the exact identity; `sortName` only as the fallback
 * the id mismatch above forces. Nine sortNames collide across the 5.889-title
 * catalog, and every one of those pairs is the same game listed twice, so a
 * fallback hit on one is not a way to badge the wrong title.
 */
export function indexedRtx(game: GfnGame, index: RtxIndex): boolean {
  return (
    game.stores.some((store) => index.variantIds.has(store.variantId)) ||
    index.sortNames.has(game.sortName)
  )
}

function cachePath(): string {
  return join(app.getPath('userData'), 'cache', 'catalog.json')
}

/**
 * The snapshot currently in play, memoised the way `details.ts` memoises its
 * index and for the same reason: this is four megabytes of JSON, and every
 * ownership change would otherwise re-read and re-parse the lot to touch one
 * field. Concurrent callers share the read.
 */
let snapshot: CatalogSnapshot | null = null
let loading: Promise<CatalogSnapshot | null> | null = null

async function readCache(): Promise<CatalogSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), 'utf8')) as CatalogSnapshot
    if (!Array.isArray(parsed.games)) return null
    // A cache from an older harvest is incomplete rather than broken, but the
    // gaps are invisible — a catalog written before details existed has no
    // details file beside it. Reporting it as absent lets the renderer's
    // background refresh replace it.
    if (parsed.version !== CATALOG_CACHE_VERSION) return null
    return { ...parsed, source: 'cache' }
  } catch {
    return null
  }
}

async function loadSnapshot(): Promise<CatalogSnapshot | null> {
  if (snapshot) return snapshot
  loading ??= readCache().finally(() => {
    loading = null
  })
  snapshot = await loading
  return snapshot
}

async function writeCache(next: CatalogSnapshot): Promise<void> {
  snapshot = next
  // Atomic: four megabytes takes long enough to write that a `poweroff` from
  // the launcher's own power menu can land in the middle of it, and half a
  // catalog is a twelve-second re-walk on the next start.
  await writeFileAtomic(cachePath(), JSON.stringify(next))
}

/** Test seam: drops the memoised snapshot. */
export function resetCatalog(): void {
  snapshot = null
  loading = null
}

/**
 * Applies a change one title at a time, in memory and on disk.
 *
 * Marking a game owned or picking its store are single-field edits to a catalog
 * that costs twelve seconds to re-walk, so this is what stands between the user
 * and a progress bar every time they press a button. It is a bridge, not a
 * store of record: the mutation itself happened on NVIDIA's side, and the next
 * authenticated refresh brings the same answer back on its own.
 *
 * Returns null when the game is not in the snapshot, which is what a mutation
 * racing a refresh looks like.
 */
export async function patchGame(
  cmsId: string,
  patch: (game: GfnGame) => GfnGame
): Promise<GfnGame | null> {
  const current = await loadSnapshot()
  if (!current) return null

  const index = current.games.findIndex((game) => game.cmsId === cmsId)
  if (index === -1) return null

  const updated = patch(current.games[index] as GfnGame)
  const games = [...current.games]
  games[index] = updated

  await writeCache({ ...current, games })
  return updated
}

/** Marks one store's edition owned, or clears that mark. */
export function markOwned(variantId: string, owned: boolean) {
  return (game: GfnGame): GfnGame => {
    const stores = game.stores.map((store) =>
      store.variantId === variantId ? { ...store, owned } : store
    )
    // `owned` drives the whole library view, so it has to be recomputed rather
    // than assumed: clearing one store does not un-own a title held on two.
    return { ...game, stores, owned: stores.some((store) => store.owned) }
  }
}

/** Records which store's edition GFN launches. */
export function markSelected(variantId: string) {
  return (game: GfnGame): GfnGame => ({ ...game, selectedVariantId: variantId })
}

function fixtureSnapshot(): CatalogSnapshot {
  return { games: FIXTURE_GAMES, fetchedAt: new Date().toISOString(), source: 'fixture' }
}

export interface CatalogQuery {
  /** Restrict to titles the user owns on a linked store. */
  ownedOnly?: boolean
  /** Server-side search. Filtering the full catalog client-side does not scale. */
  search?: string
  sort?: string
}

/** Fetches the live catalog, walking every page. */
export async function fetchLiveCatalog(
  config: GfnGraphQLConfig,
  query: CatalogQuery = {}
): Promise<{ games: GfnGame[]; truncated: boolean }> {
  const { items, truncated } = await paginate<RawApp>(async (cursor) => {
    const data = await execute<{ apps: { items: RawApp[]; pageInfo: PageInfo } }>(
      config,
      query.ownedOnly ? 'library' : 'panels',
      SEARCH_APPS,
      {
        vpcId: config.vpcId,
        locale: config.locale,
        sortString: query.sort ?? 'ALPHABETICAL',
        fetchCount: PAGE_SIZE,
        cursor,
        searchString: query.search ?? '',
        filters: query.ownedOnly ? OWNED_FILTER : NO_FILTER
      }
    )
    return { items: data.apps?.items ?? [], pageInfo: data.apps?.pageInfo }
  }, MAX_ITEMS)

  // Sorted here rather than trusted from `sortString: 'ALPHABETICAL'` above:
  // the gateway ignores it. See `sortByName`.
  const games = sortByName(items.map(mapApp).filter((game): game is GfnGame => game !== null))
  return { games, truncated }
}

/**
 * Fetches the sign-in-free public feed.
 *
 * Strictly less than the authenticated catalog — it cannot know what the user
 * owns, so every title comes back unowned — but the ids are real, so every tile
 * it produces launches.
 */
export async function fetchPublicCatalogGames(
  locale: string
): Promise<{ games: GfnGame[]; truncated: boolean; details: Record<string, GameDetails> }> {
  const { items, truncated } = await fetchPublicCatalog(locale, MAX_ITEMS)
  const games = sortByName(items.map(mapApp).filter((game): game is GfnGame => game !== null))
  // Same walk, second model: this feed has no per-app query, so the details
  // panel's data has to be harvested here or not at all.
  return { games, truncated, details: mapDetailsIndex(items) }
}

/**
 * Puts the grid in the order a person reads it in.
 *
 * **Applied to both feeds, and the authenticated one is the reason it exists.**
 * `fetchLiveCatalog` asks for `sortString: 'ALPHABETICAL'` and the gateway does
 * not honour it — a signed-in walk of 5.879 titles comes back in the order
 * NVIDIA's panels happen to be assembled in, which begins "Wolcen: Lords of
 * Mayhem, Half-Life 2, Rage, Tomb Raider: Anniversary". The public feed has no
 * `orderBy` at all and never claimed to. So neither source can be trusted for
 * this, and sorting on the way out is the only thing that makes the Catalog grid
 * the same object whichever one filled it — verified against a real signed-in
 * cache, which was not sorted.
 *
 * `sortName` rather than `title`: it is the unlocalised slug both feeds emit,
 * with the leading articles and trademark symbols already resolved the way GFN
 * itself resolves them.
 */
function sortByName(games: GfnGame[]): GfnGame[] {
  return games.sort((a, b) => a.sortName.localeCompare(b.sortName))
}

/**
 * Walks the public feed for everything the authenticated catalog cannot say.
 *
 * Descriptions, screenshots, control support and the RTX flag exist *only* on
 * the public feed — the authenticated catalog knows who owns what and nothing
 * about what a game is. A signed-in user would otherwise get tiles with no panel
 * behind them and a filter that matched nothing.
 *
 * One walk, two products, because the walk is the expensive part.
 */
export async function fetchPublicFacts(
  locale: string
): Promise<{ details: Record<string, GameDetails>; rtx: RtxIndex }> {
  const { items } = await fetchPublicCatalog(locale, MAX_ITEMS)
  return { details: mapDetailsIndex(items), rtx: mapRtxIndex(items) }
}

/** Best catalog available without hitting the network. */
export async function getCatalog(): Promise<CatalogSnapshot> {
  return (await loadSnapshot()) ?? fixtureSnapshot()
}

/**
 * Refreshes the catalog, falling back to whatever is already available. A
 * launcher showing a stale list beats a launcher showing nothing.
 *
 * Signed in, the authenticated feed wins: it is the only one that knows what
 * the user owns, which is what the library view is made of. Signed out we take
 * the public feed rather than giving up, because a full catalog of launchable
 * titles is worth far more than the fixture placeholders it replaces.
 */
export async function refreshCatalog(
  config?: GfnGraphQLConfig,
  locale = 'en_US'
): Promise<CatalogSnapshot> {
  try {
    const source: CatalogSnapshot['source'] = config ? 'network' : 'public'
    let games: GfnGame[]
    let truncated: boolean

    if (config) {
      ;({ games, truncated } = await fetchLiveCatalog(config))
      // Ownership comes from the session, everything the panel shows — and the
      // RTX flag — comes from the public feed. Two walks, because no single
      // endpoint has both, and a failure here costs the panel and the badge
      // rather than the catalog.
      try {
        const facts = await fetchPublicFacts(locale)
        await saveDetails(facts.details)
        games = games.map((game) => ({ ...game, rtx: indexedRtx(game, facts.rtx) }))
      } catch (error) {
        console.warn('Details refresh failed; panels will show the catalog entry only:', error)
      }
    } else {
      const result = await fetchPublicCatalogGames(locale)
      games = result.games
      truncated = result.truncated
      // Written separately from the snapshot: `catalog:get` is on the
      // first-paint path and must not carry a title's prose and screenshots
      // across the bridge on every start.
      await saveDetails(result.details)
    }

    if (truncated) {
      console.warn(`Catalog truncated at ${MAX_ITEMS} titles`)
    }

    const next: CatalogSnapshot = {
      games,
      version: CATALOG_CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      source
    }
    await writeCache(next)
    return next
  } catch (error) {
    console.error('Catalog refresh failed:', error)
    return getCatalog()
  }
}
