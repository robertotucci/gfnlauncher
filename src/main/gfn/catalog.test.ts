import { describe, expect, it, vi } from 'vitest'
import type { GfnGame } from '@shared/types'
import {
  fetchPublicCatalogGames,
  indexedRtx,
  mapApp,
  mapRtxIndex,
  markOwned,
  markSelected
} from './catalog'

vi.mock('./publicCatalog', () => ({
  fetchPublicCatalog: async () => ({
    truncated: false,
    items: [
      {
        title: 'Zeta',
        sortName: 'zeta',
        type: 'GAME',
        shortDescription: 'The last one alphabetically.',
        images: { SCREENSHOTS: ['z1.jpg'] },
        variants: [
          {
            id: 3,
            appStore: 'STEAM',
            supportedControls: ['GAMEPAD'],
            gfn: { features: [{ key: 'RTX_ENABLED', value: 'true' }] }
          }
        ]
      },
      {
        title: 'Beta: Season Pass',
        sortName: 'beta_season_pass',
        type: 'DLC',
        variants: [{ id: 2, appStore: 'STEAM' }]
      },
      {
        title: 'Alpha',
        sortName: 'alpha',
        type: 'GAME',
        shortDescription: 'The first one.',
        variants: [{ id: 1, appStore: 'STEAM', supportedControls: ['KEYBOARD', 'MOUSE'] }]
      }
    ]
  })
}))

/** As the feed writes them. Only `"true"` is ever emitted. */
const RTX = { key: 'RTX_ENABLED', value: 'true' }
const HDR = { key: 'HDR_ENABLED', value: 'true' }

describe('mapApp', () => {
  const base = {
    id: 1,
    title: 'Control Ultimate Edition',
    publisherName: 'Remedy',
    genres: ['Action'],
    variants: [{ id: 100, appStore: 'STEAM', gfn: { library: { status: 'NOT_OWNED' } } }]
  }

  it('maps store codes to names people recognise', () => {
    expect(mapApp(base)?.stores[0]?.storeLabel).toBe('Steam')
  })

  it('keeps each store its own launchable id, slug and product page', () => {
    // Without these a store chip is decoration: nothing to launch, nothing to
    // name in an ownership mutation, nothing to link to.
    const game = mapApp({
      ...base,
      variants: [
        { id: 100, appStore: 'STEAM', shortName: 'control_gfn_pc', storeUrl: 'https://s/100' },
        { id: 200, appStore: 'EPIC', shortName: 'control_epic', storeUrl: null }
      ]
    })
    expect(game?.stores).toEqual([
      {
        storeId: 'STEAM',
        storeLabel: 'Steam',
        owned: false,
        variantId: '100',
        shortName: 'control_gfn_pc',
        storeUrl: 'https://s/100'
      },
      {
        storeId: 'EPIC',
        storeLabel: 'Epic Games Store',
        owned: false,
        variantId: '200',
        shortName: 'control_epic',
        storeUrl: null
      }
    ])
  })

  it('drops a variant with no id rather than offering a chip that does nothing', () => {
    const game = mapApp({
      ...base,
      variants: [{ id: 100, appStore: 'STEAM' }, { appStore: 'EPIC' }]
    })
    expect(game?.stores.map((store) => store.storeId)).toEqual(['STEAM'])
  })

  it('reports the store GFN says is selected, and nothing when it says none', () => {
    expect(mapApp(base)?.selectedVariantId).toBeNull()

    const game = mapApp({
      ...base,
      variants: [
        { id: 100, appStore: 'STEAM', gfn: { library: { status: 'AVAILABLE' } } },
        { id: 200, appStore: 'EPIC', gfn: { library: { status: 'AVAILABLE', selected: true } } }
      ]
    })
    expect(game?.selectedVariantId).toBe('200')
  })

  it('treats an unseen store code as a store rather than dropping it', () => {
    const game = mapApp({ ...base, variants: [{ id: 1, appStore: 'NEW_STORE' }] })
    expect(game?.stores).toHaveLength(1)
    expect(game?.stores[0]?.storeId).toBe('NEW_STORE')
  })

  it('counts any library status other than NOT_OWNED as owned', () => {
    const game = mapApp({
      ...base,
      variants: [{ id: 100, appStore: 'STEAM', gfn: { library: { status: 'AVAILABLE' } } }]
    })
    expect(game?.owned).toBe(true)
  })

  it('does not treat a missing library status as ownership', () => {
    const game = mapApp({ ...base, variants: [{ id: 100, appStore: 'STEAM' }] })
    expect(game?.owned).toBe(false)
  })

  it('reads ray tracing off the variant features', () => {
    const game = mapApp({
      ...base,
      variants: [{ id: 100, appStore: 'STEAM', gfn: { features: [RTX, HDR] } }]
    })
    expect(game?.rtx).toBe(true)
  })

  it('badges a title when any one edition is ray-traced', () => {
    // 17 of the 171 carry the flag on some stores and not others — Black Ops 6
    // on one of four. The GFN client itself asks `variants.some(...)`, so a
    // stricter rule here would show the user less than NVIDIA's own UI does.
    const game = mapApp({
      ...base,
      variants: [
        { id: 100, appStore: 'STEAM' },
        { id: 200, appStore: 'EPIC', gfn: { features: [RTX] } }
      ]
    })
    expect(game?.rtx).toBe(true)
  })

  it('leaves rtx false when nothing says otherwise', () => {
    // Only `"true"` is ever emitted, and `SEARCH_APPS` does not select the
    // field at all, so absence has to read as "no" rather than "unknown".
    expect(mapApp(base)?.rtx).toBe(false)
    expect(mapApp({ ...base, variants: [{ id: 1, gfn: { features: [HDR] } }] })?.rtx).toBe(false)
    expect(mapApp({ ...base, variants: [{ id: 1, gfn: { features: [] } }] })?.rtx).toBe(false)
  })

  it('launches the variant GFN marked as selected', () => {
    const game = mapApp({
      ...base,
      variants: [
        { id: 100, appStore: 'STEAM', gfn: { library: { status: 'AVAILABLE' } } },
        { id: 200, appStore: 'EPIC', gfn: { library: { status: 'AVAILABLE', selected: true } } }
      ]
    })
    expect(game?.cmsId).toBe('200')
  })

  it('falls back to an owned variant when none is selected', () => {
    const game = mapApp({
      ...base,
      variants: [
        { id: 100, appStore: 'STEAM', gfn: { library: { status: 'NOT_OWNED' } } },
        { id: 200, appStore: 'EPIC', gfn: { library: { status: 'AVAILABLE' } } }
      ]
    })
    expect(game?.cmsId).toBe('200')
  })

  it('falls back to the Steam variant when ownership is unknown', () => {
    // The public feed carries no library data at all, so without this the
    // launch id would be whichever store the API happened to list first.
    const game = mapApp({
      ...base,
      variants: [
        { id: 100, appStore: 'EPIC' },
        { id: 200, appStore: 'STEAM' }
      ]
    })
    expect(game?.cmsId).toBe('200')
  })

  it('still prefers an owned variant over the Steam fallback', () => {
    const game = mapApp({
      ...base,
      variants: [
        { id: 100, appStore: 'EPIC', gfn: { library: { status: 'AVAILABLE' } } },
        { id: 200, appStore: 'STEAM', gfn: { library: { status: 'NOT_OWNED' } } }
      ]
    })
    expect(game?.cmsId).toBe('100')
  })

  it('rejects an app with no launchable variant', () => {
    // Without a variant id there is nothing to put in the deep link, so the
    // tile would render but never start.
    expect(mapApp({ ...base, variants: [] })).toBeNull()
  })

  it('rejects an untitled app', () => {
    expect(mapApp({ ...base, title: '   ' })).toBeNull()
  })

  it('rejects an entry the feed says is not a game', () => {
    // The public feed labels DLC and platform clients; they would render as
    // tiles that hand GFN an id it cannot play.
    expect(mapApp({ ...base, type: 'DLC' })).toBeNull()
    expect(mapApp({ ...base, type: 'GAME' })).not.toBeNull()
  })

  it('keeps an entry from a feed that does not report a type', () => {
    expect(mapApp(base)).not.toBeNull()
  })

  it('surfaces maintenance state', () => {
    const game = mapApp({ ...base, gfn: { playabilityState: 'MAINTENANCE' } })
    expect(game?.availability).toBe('maintenance')
  })

  it('prefers box art over the TV banner for the tile', () => {
    const game = mapApp({
      ...base,
      images: { GAME_BOX_ART: 'box.jpg', TV_BANNER: 'banner.jpg', HERO_IMAGE: 'hero.jpg' }
    })
    expect(game?.images.tile).toBe('box.jpg')
    expect(game?.images.hero).toBe('hero.jpg')
  })
})

describe('fetchPublicCatalogGames', () => {
  it('sorts what the feed hands back in no particular order', async () => {
    const { games } = await fetchPublicCatalogGames('en_US')
    expect(games.map((game) => game.title)).toEqual(['Alpha', 'Zeta'])
  })

  it('drops the entries that are not games', async () => {
    const { games } = await fetchPublicCatalogGames('en_US')
    expect(games.some((game) => game.title.includes('Season Pass'))).toBe(false)
  })

  it('reports every title as unowned, because this feed cannot know', async () => {
    const { games } = await fetchPublicCatalogGames('en_US')
    expect(games.every((game) => !game.owned)).toBe(true)
  })

  it('indexes details under the same ids the tiles launch with', async () => {
    // The panel is looked up by the tile's cmsId. If the two mappers ever
    // disagreed about which variant they describe, every panel would come up
    // empty and nothing would throw.
    const { games, details } = await fetchPublicCatalogGames('en_US')
    for (const game of games) {
      expect(details[game.cmsId]?.cmsId).toBe(game.cmsId)
    }
  })

  it('does not index the entries it dropped from the grid', async () => {
    const { details } = await fetchPublicCatalogGames('en_US')
    expect(details['2']).toBeUndefined()
  })

  it('carries the RTX flag through from the feed', async () => {
    const { games } = await fetchPublicCatalogGames('en_US')
    expect(games.find((game) => game.title === 'Zeta')?.rtx).toBe(true)
    expect(games.find((game) => game.title === 'Alpha')?.rtx).toBe(false)
  })
})

describe('mapRtxIndex', () => {
  const app = {
    title: 'Cyberpunk 2077',
    sortName: 'Cyberpunk_2077',
    variants: [
      { id: 100, appStore: 'STEAM', gfn: { features: [RTX] } },
      { id: 200, appStore: 'EPIC', gfn: { features: [RTX] } },
      { id: 300, appStore: 'GOG', gfn: { features: [RTX] } }
    ]
  }

  it('indexes every variant, not just the one a launch would pick', () => {
    // Signed in, a tile's id is the edition the user owns, while this index is
    // built from the public feed, which settles on Steam. Keying only the
    // launch variant would drop the badge on every multi-store title.
    expect(mapRtxIndex([app]).variantIds).toEqual(new Set(['100', '200', '300']))
  })

  it('indexes the plain editions of a title whose flag is on one store only', () => {
    // The lookup is by the variant the *user owns*, which for Black Ops 6 is
    // usually not the one carrying the flag. Indexing only the flagged variant
    // would hide the badge from exactly the people who own the game.
    const index = mapRtxIndex([
      {
        ...app,
        variants: [
          { id: 100, appStore: 'STEAM' },
          { id: 200, appStore: 'EPIC', gfn: { features: [RTX] } }
        ]
      }
    ])
    expect(index.variantIds).toEqual(new Set(['100', '200']))
  })

  it('lowercases the sortName, so it matches what mapApp stored', () => {
    expect(mapRtxIndex([app]).sortNames).toEqual(new Set(['cyberpunk_2077']))
  })

  it('falls back to the title when the feed omits a sortName', () => {
    const { sortNames } = mapRtxIndex([{ ...app, sortName: null }])
    expect(sortNames).toEqual(new Set(['cyberpunk 2077']))
  })

  it('leaves out titles no edition of which is ray-traced', () => {
    const plain = { ...app, variants: [{ id: 100, gfn: { features: [HDR] } }] }
    expect(mapRtxIndex([plain]).variantIds.size).toBe(0)
    expect(mapRtxIndex([plain]).sortNames.size).toBe(0)
    expect(mapRtxIndex([{ ...app, variants: [{ id: 100 }] }]).variantIds.size).toBe(0)
  })

  it('skips an entry the feed says is not a game', () => {
    expect(mapRtxIndex([{ ...app, type: 'DLC' }].map((a) => a)).sortNames.size).toBe(0)
  })

  it('still indexes the sortName when no variant carries an id', () => {
    // The id half is useless here, but the fallback still badges the title.
    const index = mapRtxIndex([{ ...app, variants: [{ gfn: { features: [RTX] } }] }])
    expect(index.variantIds.size).toBe(0)
    expect(index.sortNames).toEqual(new Set(['cyberpunk_2077']))
  })
})

describe('indexedRtx', () => {
  const game = mapApp({
    title: 'World of Warcraft: Midnight',
    sortName: 'world_of_warcraft_midnight',
    variants: [{ id: 103255961, appStore: 'BATTLENET' }]
  }) as GfnGame

  it('matches on the variant id when the two feeds agree', () => {
    const index = { variantIds: new Set(['103255961']), sortNames: new Set<string>() }
    expect(indexedRtx(game, index)).toBe(true)
  })

  it('falls back to sortName when they hand out different ids', () => {
    // Every Battle.net title does this: 102758611 publicly, 103255961 in a
    // session. Without the fallback the four WoW entries lose the badge.
    const index = {
      variantIds: new Set(['102758611']),
      sortNames: new Set(['world_of_warcraft_midnight'])
    }
    expect(indexedRtx(game, index)).toBe(true)
  })

  it('says no when neither key is in the index', () => {
    const index = { variantIds: new Set(['999']), sortNames: new Set(['something_else']) }
    expect(indexedRtx(game, index)).toBe(false)
  })
})

describe('markOwned', () => {
  const game = mapApp({
    id: 1,
    title: 'Thief',
    variants: [
      { id: 100, appStore: 'STEAM' },
      { id: 200, appStore: 'EPIC' }
    ]
  }) as GfnGame

  it('marks the store the user named, and only that one', () => {
    const next = markOwned('200', true)(game)
    expect(next.stores.map((store) => store.owned)).toEqual([false, true])
  })

  it('lifts the title into the library the moment any store owns it', () => {
    expect(game.owned).toBe(false)
    expect(markOwned('200', true)(game).owned).toBe(true)
  })

  it('does not un-own a title still held on another store', () => {
    // The whole library view hangs off `owned`, so it is recomputed from the
    // store list rather than assumed to follow the store just cleared.
    const both = markOwned('100', true)(markOwned('200', true)(game))
    expect(markOwned('200', false)(both).owned).toBe(true)
  })

  it('leaves a game alone when the variant is not one of its stores', () => {
    expect(markOwned('999', true)(game)).toEqual(game)
  })
})

describe('markSelected', () => {
  it('records the chosen edition without touching the launch id', () => {
    const game = mapApp({
      id: 1,
      title: 'Thief',
      variants: [
        { id: 100, appStore: 'STEAM' },
        { id: 200, appStore: 'EPIC' }
      ]
    }) as GfnGame

    const next = markSelected('200')(game)
    expect(next.selectedVariantId).toBe('200')
    // cmsId is the game's identity — focus ids and the details index are keyed
    // on it, so a store change must not move it.
    expect(next.cmsId).toBe(game.cmsId)
  })
})
