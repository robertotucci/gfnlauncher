/**
 * Pure vocabulary shared by all three contexts: store names, genre names, the
 * launch target, and the one date format the feed uses.
 *
 * Lives beside `types.ts` for the same reason that file does — main maps the
 * wire into this vocabulary and the renderer draws it, so the two have to agree
 * on the words. Keep it free of Node and DOM APIs.
 */

import type { GfnGame, LaunchMode, LaunchPath, LaunchRequest } from './types'

/**
 * Store codes as the catalog returns them, mapped to the names those stores
 * call themselves.
 *
 * Every code here was observed in a real 5.879-title harvest. The long tail
 * (`NV_BUNDLE`, `GAIJIN`, `WARGAMING`…) is a handful of titles each, but a
 * launcher that renders "nv bundle" in a store row looks broken in a way the
 * user cannot act on.
 */
export const STORE_LABELS: Record<string, string> = {
  STEAM: 'Steam',
  EPIC: 'Epic Games Store',
  EPIC_GAMES_STORE: 'Epic Games Store',
  UBISOFT_CONNECT: 'Ubisoft Connect',
  UPLAY: 'Ubisoft Connect',
  EA: 'EA app',
  EA_APP: 'EA app',
  ORIGIN: 'EA app',
  GOG: 'GOG.com',
  XBOX: 'Xbox',
  MICROSOFT_STORE: 'Xbox',
  BATTLENET: 'Battle.net',
  NV_BUNDLE: 'NVIDIA bundle',
  NVIDIA: 'NVIDIA',
  GAIJIN: 'Gaijin',
  WARGAMING: 'Wargaming',
  NONE: 'No store',
  UNKNOWN: 'Unknown store'
}

/** The name a store calls itself, or a readable fallback for a new code. */
export function storeLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown store'
  return STORE_LABELS[code] ?? code.replaceAll('_', ' ').toLowerCase()
}

/**
 * Genre codes as the catalog returns them.
 *
 * Twenty codes cover the whole catalog. The abbreviations are deliberate: at
 * three metres a chip reading `FIRST_PERSON_SHOOTER` is a paragraph, and the
 * short forms are what players call these genres anyway.
 */
export const GENRE_LABELS: Record<string, string> = {
  ACTION: 'Action',
  ADVENTURE: 'Adventure',
  ARCADE: 'Arcade',
  CASUAL: 'Casual',
  DEMO: 'Demo',
  FAMILY: 'Family',
  FIGHTING: 'Fighting',
  FIRST_PERSON_SHOOTER: 'FPS',
  FREE_TO_PLAY: 'Free to play',
  INDIE: 'Indie',
  MASSIVELY_MULTIPLAYER_ONLINE: 'MMO',
  MULTIPLAYER_ONLINE_BATTLE_ARENA: 'MOBA',
  PLATFORMER: 'Platformer',
  PUZZLE: 'Puzzle',
  RACING: 'Racing',
  ROLE_PLAYING: 'RPG',
  SIMULATION: 'Simulation',
  SPORTS: 'Sports',
  STRATEGY: 'Strategy',
  TECH_DEMO: 'Tech demo'
}

/**
 * The name to print for a genre code.
 *
 * A code the map has not seen is title-cased rather than passed through, so a
 * genre NVIDIA adds tomorrow reads as a word instead of shouting.
 */
export function genreLabel(code: string): string {
  return (
    GENRE_LABELS[code] ??
    code
      .toLowerCase()
      .split('_')
      .filter(Boolean)
      .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
      .join(' ')
  )
}

export interface GenreFacet {
  code: string
  label: string
  count: number
}

/**
 * The filter value meaning "no filter". Lowercase, so it can never collide with
 * a genre code — the catalog's are all `SCREAMING_SNAKE`.
 */
export const ALL_GENRES = 'all'

/**
 * Ray tracing, filtered as though it were a genre.
 *
 * A peer of "All" rather than a second dimension: one filter value keeps one
 * ring for the shoulder buttons, one `view/genre` landing key and one legend.
 * Crossing it with a genre would be a two-axis filter on a screen with no
 * pointer, which is a menu, not a couch control.
 *
 * Lowercase for the same reason `ALL_GENRES` is — the catalog's genre codes are
 * all `SCREAMING_SNAKE`, so this can never collide with one.
 */
export const RTX_FILTER = 'rtx'

/**
 * The filter one step either side of the current one.
 *
 * Wraps, because the shoulder buttons are held down and a filter that stops
 * dead at the end of the list reads as a dropped input rather than a boundary.
 * "All" is part of the ring rather than a separate reset, so the way back to
 * the whole catalog is the same gesture as everything else.
 *
 * `rtxCount` decides whether RTX is in the ring at all: a view holding no
 * ray-traced title must not have a stop that filters down to nothing, and the
 * chip is hidden in that case too.
 */
export function cycleGenre(
  genres: GenreFacet[],
  active: string,
  step: number,
  rtxCount = 0
): string {
  const ring = [
    ALL_GENRES,
    ...(rtxCount > 0 ? [RTX_FILTER] : []),
    ...genres.map((genre) => genre.code)
  ]
  const current = ring.indexOf(active)
  // An active filter that just fell out of the ring — the last owned title in a
  // genre was un-owned, or the last RTX one — lands back at "All" rather than
  // nowhere.
  if (current === -1) return ALL_GENRES

  const next = (current + step + ring.length) % ring.length
  return ring[next] ?? ALL_GENRES
}

/**
 * The genres actually present in a list of games, most populated first.
 *
 * Derived from the games passed in rather than from a fixed table: a library of
 * thirty titles must not offer twenty genre chips that filter down to nothing.
 * Ties break alphabetically so the strip does not reshuffle between renders of
 * equally-sized genres.
 */
export function collectGenres(games: GfnGame[]): GenreFacet[] {
  const counts = new Map<string, number>()
  for (const game of games) {
    for (const code of game.genres) {
      counts.set(code, (counts.get(code) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .map(([code, count]) => ({ code, label: genreLabel(code), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * What a play press should hand to the GFN client.
 *
 * `cmsId` is the variant the harvest chose and stays the game's identity
 * everywhere else — focus ids, the details index — so a store the user picked
 * is applied here instead of rewriting it. Falls back to `cmsId` when the
 * selection names a variant this game no longer carries, which is what a
 * catalog refresh after a store delisting looks like.
 *
 * `gameId` carries the game's own identity alongside the resolved variant, so
 * play history can be keyed on the tile the user pressed rather than on the
 * edition GFN was handed.
 */
export function resolveLaunchTarget(game: GfnGame): LaunchRequest {
  const selected = game.selectedVariantId
    ? game.stores.find((store) => store.variantId === game.selectedVariantId)
    : undefined

  // Id and slug travel together. Falling back field by field would pair the
  // chosen edition's id with a different store's slug — the deep link would
  // still resolve, but to the wrong thing, and nothing would report an error.
  if (selected) {
    return {
      cmsId: selected.variantId,
      gameId: game.cmsId,
      shortName: selected.shortName,
      parentGameId: game.parentGameId
    }
  }

  return {
    cmsId: game.cmsId,
    gameId: game.cmsId,
    shortName: game.shortName,
    parentGameId: game.parentGameId
  }
}

/**
 * Which of the two launch paths a play press should take.
 *
 * The other half of `resolveLaunchTarget`: that one answers *what* to start,
 * this one answers *how*. The explicit modes are honoured even when they are
 * the worse choice — pinning `native` without the Flatpak is how a user asks
 * for a real error instead of a silent substitution, and pinning `web` is the
 * only way to exercise that path on a machine that does have the client.
 *
 * `auto` is the only branch that decides anything, which is exactly why it is
 * not the default. See `LaunchMode`.
 */
export function resolveLaunchPath(mode: LaunchMode, clientInstalled: boolean): LaunchPath {
  if (mode === 'auto') return clientInstalled ? 'native' : 'web'
  return mode
}

/**
 * Formats the feed's release date.
 *
 * The wire format is `2018-12-13T01:00:00.000000+0000`: a six-digit fraction
 * and a colon-less offset, neither of which the ECMAScript date grammar
 * requires an engine to accept. Reading the calendar fields off the string
 * avoids both that and the worse failure — `new Date()` parsing it as UTC and
 * printing the day before for anyone west of Greenwich.
 */
export function formatReleaseDate(iso: string | null | undefined, locale: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  if (!match) return null

  // Noon UTC, purely so the formatter cannot shift the date across a boundary:
  // only the calendar fields are ever read back out.
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))
  if (Number.isNaN(date.getTime())) return null

  return new Intl.DateTimeFormat(locale.replace('_', '-'), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(date)
}
