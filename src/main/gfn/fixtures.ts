import { storeLabel } from '@shared/games'
import type { GfnGame, GameStoreOwnership } from '@shared/types'

/**
 * Development seed data, and the last resort at runtime.
 *
 * Titles are real so the UI can be judged with realistic string lengths, but
 * every `cmsId` here is a placeholder — these entries will NOT launch.
 *
 * This is now only reached on a machine that has never fetched anything and
 * cannot reach the network: signed out, the catalog comes from the public feed
 * (`publicCatalog.ts`), whose ids are real. Anything shown from here is a
 * placeholder the UI should replace as soon as a fetch succeeds.
 */

function sortNameOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

/**
 * Store codes are written the way the live catalog writes them, so the seed
 * data exercises the same label map the real feed does.
 */
function stores(cmsId: string, owned: string[], available: string[]): GameStoreOwnership[] {
  return available.map((storeId) => ({
    storeId,
    storeLabel: storeLabel(storeId),
    owned: owned.includes(storeId),
    // Placeholders, like the cmsId above them: these entries do not launch.
    variantId: `${cmsId}-${storeId.toLowerCase()}`,
    shortName: null,
    storeUrl: null
  }))
}

/**
 * Genres use the catalog's own codes, not free text.
 *
 * The live vocabulary is twenty `SCREAMING_SNAKE` values and nothing else —
 * there is no `HORROR`, no `ROGUELIKE`, no `OPEN_WORLD`. Seeding invented
 * genres would make the filter strip look richer here than it can ever be
 * against real data, which is the one thing seed data must not do.
 */
interface Seed {
  title: string
  publisher: string
  genres: string[]
  available: string[]
  owned?: string[]
  /** Set on the titles the live catalog really marks as ray-traced. */
  rtx?: boolean
}

const SEEDS: Seed[] = [
  { title: 'Cyberpunk 2077', publisher: 'CD PROJEKT RED', genres: ['ROLE_PLAYING', 'ACTION'], available: ['STEAM', 'EPIC', 'GOG'], owned: ['STEAM'], rtx: true },
  { title: 'Baldur’s Gate 3', publisher: 'Larian Studios', genres: ['ROLE_PLAYING', 'STRATEGY'], available: ['STEAM', 'GOG'], owned: ['STEAM'] },
  { title: 'Control Ultimate Edition', publisher: 'Remedy Entertainment', genres: ['ACTION', 'ADVENTURE'], available: ['STEAM', 'EPIC'], owned: ['EPIC'], rtx: true },
  { title: 'The Witcher 3: Wild Hunt', publisher: 'CD PROJEKT RED', genres: ['ROLE_PLAYING'], available: ['STEAM', 'EPIC', 'GOG'], owned: ['GOG'], rtx: true },
  { title: 'Hades II', publisher: 'Supergiant Games', genres: ['INDIE', 'ACTION'], available: ['STEAM', 'EPIC'], owned: ['STEAM'] },
  { title: 'Alan Wake 2', publisher: 'Remedy Entertainment', genres: ['ADVENTURE'], available: ['EPIC'], rtx: true },
  { title: 'Assassin’s Creed Mirage', publisher: 'Ubisoft', genres: ['ACTION'], available: ['UPLAY', 'EPIC'], owned: ['UPLAY'] },
  { title: 'Far Cry 6', publisher: 'Ubisoft', genres: ['FIRST_PERSON_SHOOTER', 'ADVENTURE'], available: ['UPLAY', 'EPIC'], rtx: true },
  { title: 'Dead Space', publisher: 'Electronic Arts', genres: ['ADVENTURE', 'FIRST_PERSON_SHOOTER'], available: ['STEAM', 'EA_APP'], owned: ['EA_APP'] },
  { title: 'It Takes Two', publisher: 'Electronic Arts', genres: ['CASUAL', 'PLATFORMER'], available: ['STEAM', 'EA_APP', 'EPIC'], owned: ['STEAM'] },
  { title: 'Forza Horizon 5', publisher: 'Xbox Game Studios', genres: ['RACING'], available: ['STEAM', 'XBOX'], owned: ['STEAM', 'XBOX'], rtx: true },
  { title: 'Halo Infinite', publisher: 'Xbox Game Studios', genres: ['FIRST_PERSON_SHOOTER'], available: ['STEAM', 'XBOX'] },
  { title: 'Elden Ring', publisher: 'Bandai Namco', genres: ['ROLE_PLAYING'], available: ['STEAM'], owned: ['STEAM'] },
  { title: 'Hogwarts Legacy', publisher: 'Warner Bros. Games', genres: ['ROLE_PLAYING', 'ADVENTURE'], available: ['STEAM', 'EPIC'] },
  { title: 'Stardew Valley', publisher: 'ConcernedApe', genres: ['SIMULATION', 'INDIE'], available: ['STEAM', 'GOG'], owned: ['STEAM'] },
  { title: 'No Man’s Sky', publisher: 'Hello Games', genres: ['ADVENTURE', 'SIMULATION'], available: ['STEAM', 'GOG'], owned: ['STEAM'] },
  { title: 'Dying Light 2 Stay Human', publisher: 'Techland', genres: ['ACTION', 'ADVENTURE'], available: ['STEAM', 'EPIC'], rtx: true },
  { title: 'Warframe', publisher: 'Digital Extremes', genres: ['FREE_TO_PLAY', 'FIRST_PERSON_SHOOTER'], available: ['STEAM', 'EPIC'], owned: ['STEAM'] },
  { title: 'Destiny 2', publisher: 'Bungie', genres: ['FREE_TO_PLAY', 'FIRST_PERSON_SHOOTER'], available: ['STEAM', 'EPIC'], owned: ['STEAM'] },
  { title: 'Path of Exile 2', publisher: 'Grinding Gear Games', genres: ['ROLE_PLAYING', 'FREE_TO_PLAY'], available: ['STEAM', 'EPIC'] },
  { title: 'Cities: Skylines II', publisher: 'Paradox Interactive', genres: ['SIMULATION', 'STRATEGY'], available: ['STEAM', 'EPIC'] },
  { title: 'Frostpunk 2', publisher: '11 bit studios', genres: ['STRATEGY', 'SIMULATION'], available: ['STEAM', 'EPIC', 'GOG'] },
  { title: 'Metro Exodus', publisher: 'Deep Silver', genres: ['FIRST_PERSON_SHOOTER', 'ADVENTURE'], available: ['STEAM', 'EPIC', 'GOG'], owned: ['STEAM'], rtx: true },
  { title: 'A Plague Tale: Requiem', publisher: 'Focus Entertainment', genres: ['ADVENTURE', 'ACTION'], available: ['STEAM', 'EPIC'], rtx: true }
]

export const FIXTURE_GAMES: GfnGame[] = SEEDS.map((seed, index) => {
  const cmsId = `fixture-${String(index + 1).padStart(4, '0')}`
  const storeList = stores(cmsId, seed.owned ?? [], seed.available)
  return {
    cmsId,
    title: seed.title,
    sortName: sortNameOf(seed.title),
    shortName: null,
    parentGameId: null,
    publisher: seed.publisher,
    developer: null,
    genres: seed.genres,
    rtx: seed.rtx ?? false,
    stores: storeList,
    images: { tile: null, hero: null, logo: null },
    availability: 'available',
    membershipTier: null,
    owned: storeList.some((s) => s.owned),
    selectedVariantId: null
  }
})
