import { describe, expect, it } from 'vitest'
import {
  ALL_GENRES,
  RTX_FILTER,
  collectGenres,
  cycleGenre,
  formatReleaseDate,
  genreLabel,
  resolveLaunchPath,
  resolveLaunchTarget,
  storeLabel
} from './games'
import { DEFAULT_SETTINGS, type GameStoreOwnership, type GfnGame } from './types'

function store(patch: Partial<GameStoreOwnership> = {}): GameStoreOwnership {
  return {
    storeId: 'STEAM',
    storeLabel: 'Steam',
    owned: false,
    variantId: '100',
    shortName: 'steam_slug',
    storeUrl: null,
    ...patch
  }
}

function game(patch: Partial<GfnGame> = {}): GfnGame {
  return {
    cmsId: '100',
    title: 'Control',
    sortName: 'control',
    shortName: 'steam_slug',
    parentGameId: null,
    publisher: 'Remedy',
    developer: 'Remedy',
    genres: [],
    rtx: false,
    stores: [store()],
    images: { tile: null, hero: null, logo: null },
    availability: 'available',
    membershipTier: null,
    owned: false,
    selectedVariantId: null,
    ...patch
  }
}

describe('storeLabel', () => {
  it('names the stores the catalog actually returns', () => {
    expect(storeLabel('STEAM')).toBe('Steam')
    expect(storeLabel('UPLAY')).toBe('Ubisoft Connect')
  })

  it('names the long-tail codes that used to render as lowercase noise', () => {
    // These reach the store row on a few dozen titles each. Before they were
    // mapped they read as "ea app" and "nv bundle", which looks like a bug.
    expect(storeLabel('EA_APP')).toBe('EA app')
    expect(storeLabel('NV_BUNDLE')).toBe('NVIDIA bundle')
    expect(storeLabel('GAIJIN')).toBe('Gaijin')
    expect(storeLabel('WARGAMING')).toBe('Wargaming')
  })

  it('degrades a code it has never seen into something readable', () => {
    expect(storeLabel('SOME_NEW_STORE')).toBe('some new store')
  })

  it('has an answer for a variant with no store at all', () => {
    expect(storeLabel(null)).toBe('Unknown store')
  })
})

describe('genreLabel', () => {
  it('abbreviates the codes that are unreadable at three metres', () => {
    expect(genreLabel('FIRST_PERSON_SHOOTER')).toBe('FPS')
    expect(genreLabel('MULTIPLAYER_ONLINE_BATTLE_ARENA')).toBe('MOBA')
    expect(genreLabel('MASSIVELY_MULTIPLAYER_ONLINE')).toBe('MMO')
    expect(genreLabel('ROLE_PLAYING')).toBe('RPG')
  })

  it('title-cases a genre the map has not seen rather than shouting it', () => {
    expect(genreLabel('DECK_BUILDER')).toBe('Deck builder')
  })
})

describe('collectGenres', () => {
  it('counts only the genres present in the games it was given', () => {
    // The library view passes a handful of titles. Offering the catalog's full
    // twenty chips there would be twenty ways to empty the grid.
    const facets = collectGenres([
      game({ cmsId: '1', genres: ['ACTION', 'INDIE'] }),
      game({ cmsId: '2', genres: ['ACTION'] })
    ])

    expect(facets).toEqual([
      { code: 'ACTION', label: 'Action', count: 2 },
      { code: 'INDIE', label: 'Indie', count: 1 }
    ])
  })

  it('breaks ties alphabetically so the strip does not reshuffle', () => {
    const facets = collectGenres([game({ genres: ['STRATEGY', 'ACTION', 'PUZZLE'] })])
    expect(facets.map((facet) => facet.code)).toEqual(['ACTION', 'PUZZLE', 'STRATEGY'])
  })

  it('is empty for a catalog that has not loaded', () => {
    expect(collectGenres([])).toEqual([])
  })
})

describe('resolveLaunchTarget', () => {
  it('launches the harvested variant when the user has chosen nothing', () => {
    expect(resolveLaunchTarget(game())).toEqual({
      cmsId: '100',
      gameId: '100',
      shortName: 'steam_slug',
      parentGameId: null
    })
  })

  it('launches the chosen store edition, slug and all', () => {
    const target = resolveLaunchTarget(
      game({
        selectedVariantId: '200',
        stores: [
          store(),
          store({ storeId: 'EPIC', variantId: '200', shortName: 'epic_slug', owned: true })
        ]
      })
    )
    expect(target).toEqual({
      cmsId: '200',
      gameId: '100',
      shortName: 'epic_slug',
      parentGameId: null
    })
  })

  it('keeps the game id even when another edition is launched', () => {
    // Play history and focus ids are keyed on the game. Recording the variant
    // would leave the multi-store titles unmatchable against their own tiles.
    const target = resolveLaunchTarget(
      game({
        cmsId: '100',
        selectedVariantId: '200',
        stores: [store(), store({ storeId: 'EPIC', variantId: '200' })]
      })
    )
    expect(target.cmsId).toBe('200')
    expect(target.gameId).toBe('100')
  })

  it('never pairs a chosen edition with another store slug', () => {
    // Several editions come back with no slug at all. Falling back field by
    // field would send the Epic id with the Steam slug: still a valid deep
    // link, pointing at the wrong thing, and silent about it.
    const target = resolveLaunchTarget(
      game({
        selectedVariantId: '200',
        stores: [store(), store({ storeId: 'EPIC', variantId: '200', shortName: null })]
      })
    )
    expect(target).toEqual({ cmsId: '200', gameId: '100', shortName: null, parentGameId: null })
  })

  it('falls back when the selection names a variant the catalog no longer has', () => {
    // A refresh after a store delisting drops the variant while the selection
    // survives. Handing GFN a dead id would fail the launch outright.
    const target = resolveLaunchTarget(game({ selectedVariantId: '999' }))
    expect(target.cmsId).toBe('100')
  })
})

describe('formatReleaseDate', () => {
  it('reads the feed format, six-digit fraction and colon-less offset included', () => {
    expect(formatReleaseDate('2018-12-13T01:00:00.000000+0000', 'en_US')).toBe(
      'December 13, 2018'
    )
  })

  it('prints the date the feed states, not the one the local zone implies', () => {
    // 01:00 +0000 is the previous day anywhere west of Greenwich. Parsing this
    // with `new Date` and formatting locally would print 12 December.
    expect(formatReleaseDate('2018-12-13T01:00:00.000000+0000', 'it_IT')).toBe(
      '13 dicembre 2018'
    )
  })

  it('has nothing to say about a title with no release date', () => {
    expect(formatReleaseDate(null, 'en_US')).toBeNull()
    expect(formatReleaseDate('', 'en_US')).toBeNull()
    expect(formatReleaseDate('not a date', 'en_US')).toBeNull()
  })
})

describe('cycleGenre', () => {
  const facets = collectGenres([
    game({ cmsId: '1', genres: ['ACTION'] }),
    game({ cmsId: '2', genres: ['RACING'] })
  ])

  it('steps forward from "all" into the list', () => {
    expect(cycleGenre(facets, ALL_GENRES, 1)).toBe('ACTION')
  })

  it('wraps rather than dead-ending under a held shoulder button', () => {
    expect(cycleGenre(facets, 'RACING', 1)).toBe(ALL_GENRES)
    expect(cycleGenre(facets, ALL_GENRES, -1)).toBe('RACING')
  })

  it('keeps "all" in the ring, so the way back is the same gesture', () => {
    expect(cycleGenre(facets, 'ACTION', -1)).toBe(ALL_GENRES)
  })

  it('recovers when the active genre has dropped out of the list', () => {
    // Un-owning the last RPG in the library empties that facet while the filter
    // still names it. Stepping has to land somewhere real.
    expect(cycleGenre(facets, 'ROLE_PLAYING', 1)).toBe(ALL_GENRES)
  })

  it('has somewhere to go with no genres at all', () => {
    expect(cycleGenre([], ALL_GENRES, 1)).toBe(ALL_GENRES)
  })

  it('sits RTX between "all" and the genres when the view has any', () => {
    // The chip is drawn there too, so the shoulder buttons walk the strip in
    // the order the strip is painted.
    expect(cycleGenre(facets, ALL_GENRES, 1, 3)).toBe(RTX_FILTER)
    expect(cycleGenre(facets, RTX_FILTER, 1, 3)).toBe('ACTION')
    expect(cycleGenre(facets, RTX_FILTER, -1, 3)).toBe(ALL_GENRES)
  })

  it('leaves RTX out of the ring when nothing in the view has it', () => {
    // A stop that filters down to an empty grid, on a strip with no chip for it.
    expect(cycleGenre(facets, ALL_GENRES, 1)).toBe('ACTION')
    expect(cycleGenre(facets, ALL_GENRES, -1)).toBe('RACING')
  })

  it('recovers from RTX after the last ray-traced title leaves the view', () => {
    expect(cycleGenre(facets, RTX_FILTER, 1)).toBe(ALL_GENRES)
  })

  it('is the whole ring on its own when a view has RTX titles but one genre', () => {
    const single = collectGenres([game({ genres: ['ACTION'] })])
    expect(cycleGenre(single, ALL_GENRES, 1, 1)).toBe(RTX_FILTER)
    expect(cycleGenre(single, RTX_FILTER, 1, 1)).toBe('ACTION')
  })
})

describe('resolveLaunchPath', () => {
  it('never reaches the web player without being told to', () => {
    // The whole point of the default. `auto` is the only mode that can
    // substitute one client for the other, and it is not what ships — a
    // detection that fails for a transient reason would otherwise move someone
    // to a browser window without saying so.
    expect(DEFAULT_SETTINGS.launchMode).toBe('native')
    expect(resolveLaunchPath(DEFAULT_SETTINGS.launchMode, false)).toBe('native')
  })

  it('follows the machine on auto', () => {
    expect(resolveLaunchPath('auto', true)).toBe('native')
    expect(resolveLaunchPath('auto', false)).toBe('web')
  })

  it('honours a pinned mode even when it is the worse choice', () => {
    // Pinning `native` without the Flatpak is how someone asks for a real
    // error instead of a silent substitution — the launcher should not decide
    // it knows better and quietly stream in a window instead.
    expect(resolveLaunchPath('native', false)).toBe('native')
    // And pinning `web` is the only way to exercise that path on a machine
    // that does have the client, which is where it gets tested.
    expect(resolveLaunchPath('web', true)).toBe('web')
  })
})
