import { storeLabel } from '@shared/games'
import type { LinkedProvider } from '@shared/types'
import { execute, type GfnGraphQLConfig } from './graphql'
import {
  ADD_OWNED_VARIANT,
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

/**
 * Lists the user's linked store accounts and their sync state.
 *
 * A store with no `accountLinkingData` is offered by GFN but not linked by this
 * user, so it is reported as unlinked rather than dropped — the UI needs to
 * offer it as something they *could* connect.
 */
export async function listProviders(config: GfnGraphQLConfig): Promise<LinkedProvider[]> {
  const data = await execute<{ userAccount?: { storesData?: RawStoreData[] | null } | null }>(
    config,
    'userAccount',
    USER_ACCOUNT_LINKING,
    {}
  )

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
        gamesSynced: syncing?.totalNumberOfSyncedGfnGames ?? null
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
