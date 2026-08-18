import { storeLabel } from '@shared/games'
import type { LinkedProvider } from '@shared/types'
import { execute, type GfnGraphQLConfig } from './graphql'
import {
  ADD_OWNED_VARIANT,
  APP_STORE_FEATURES,
  REMOVE_OWNED_VARIANT,
  SELECT_OWNED_VARIANT,
  USER_ACCOUNT_LINKING
} from './queries'

interface RawStoreData {
  store?: string | null
  accountLinkingData?: {
    userDisplayName?: string | null
    expiresIn?: number | null
    accountSyncingData?: {
      totalNumberOfSyncedGfnGames?: number | null
      syncState?: string | null
      syncDate?: string | null
    } | null
  } | null
}

interface RawStoreDefinition {
  store?: string | null
  features?: ({ __typename?: string | null; supported?: boolean | null } | null)[] | null
}

/**
 * The stores GFN will pull a library from, by store id.
 *
 * Its own failure is swallowed on purpose, and only this one: the answer is an
 * optimisation — it spares ALS a request it would refuse — and losing it must
 * not cost the sync everywhere else. An absent entry therefore reads as "may
 * sync", which is what the launcher assumed before this query existed.
 */
export async function readSyncableStores(
  config: GfnGraphQLConfig
): Promise<Set<string> | null> {
  try {
    const data = await execute<{ appStoreDefinitions?: RawStoreDefinition[] | null }>(
      config,
      'staticAppData',
      APP_STORE_FEATURES,
      { locale: config.locale }
    )

    const syncable = new Set<string>()
    for (const definition of data.appStoreDefinitions ?? []) {
      if (!definition?.store) continue
      const supported = (definition.features ?? []).some(
        (feature) => feature?.__typename === 'AccountGamesSyncing' && feature.supported === true
      )
      if (supported) syncable.add(definition.store)
    }
    // An empty set is indistinguishable from a schema change that renamed the
    // union member, and acting on it would disable sync for every store.
    return syncable.size > 0 ? syncable : null
  } catch (error) {
    console.error('Store sync capabilities could not be read:', error)
    return null
  }
}

/**
 * Lists the user's linked store accounts and their sync state.
 *
 * A store with no `accountLinkingData` is offered by GFN but not linked by this
 * user, so it is reported as unlinked rather than dropped — the UI needs to
 * offer it as something they *could* connect.
 */
export async function listProviders(config: GfnGraphQLConfig): Promise<LinkedProvider[]> {
  const [data, syncable] = await Promise.all([
    execute<{ userAccount?: { storesData?: RawStoreData[] | null } | null }>(
      config,
      'userAccount',
      USER_ACCOUNT_LINKING,
      {}
    ),
    readSyncableStores(config)
  ])

  return (data.userAccount?.storesData ?? [])
    .filter((entry): entry is RawStoreData & { store: string } => Boolean(entry?.store))
    .map((entry) => {
      const linking = entry.accountLinkingData
      const syncing = linking?.accountSyncingData

      const state: LinkedProvider['state'] = !linking
        ? 'unlinked'
        : typeof linking.expiresIn === 'number' && linking.expiresIn <= 0
          ? 'expired'
          : 'linked'

      return {
        id: entry.store,
        label: storeLabel(entry.store),
        state,
        syncedAt: syncing?.syncDate ?? null,
        gamesSynced: syncing?.totalNumberOfSyncedGfnGames ?? null,
        canSync: syncable?.has(entry.store) ?? true
      }
    })
}

/**
 * Marks a title as owned, or clears that mark.
 *
 * The normal path is still *link once, sync many* — GFN pulls a linked store's
 * whole library and new catalog titles appear on their own. This is the manual
 * override for the cases that misses, Epic being the one most people hit, and
 * it takes the **variant** id: ownership is per store edition, not per title.
 */
export async function setOwned(
  config: GfnGraphQLConfig,
  variantId: string,
  owned: boolean
): Promise<void> {
  await execute(config, 'appMetaData', owned ? ADD_OWNED_VARIANT : REMOVE_OWNED_VARIANT, {
    cmsId: variantId,
    locale: config.locale
  })
}

/**
 * Tells GFN which store's edition of a title to launch.
 *
 * The launcher could simply point its own deep link at another variant, but
 * that choice would live nowhere: press play in NVIDIA's own client and it
 * would still start the edition GFN thinks is selected. Recording it here is
 * what makes the setting mean the same thing in both places.
 */
export async function selectVariant(
  config: GfnGraphQLConfig,
  variantId: string
): Promise<void> {
  await execute(config, 'appMetaData', SELECT_OWNED_VARIANT, {
    cmsId: variantId,
    locale: config.locale
  })
}
