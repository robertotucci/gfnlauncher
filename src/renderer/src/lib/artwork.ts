/**
 * Placeholder artwork, shared by the tile, the hero band and the details panel.
 *
 * A title without art still has to look deliberate — fixtures carry none, and
 * remote images do fail. The shade is derived from the title so a given game
 * always looks the same, and two placeholders side by side never merge into one
 * rectangle.
 *
 * Neutral, not tinted: the shell has exactly one colour in it and the user owns
 * that one. Inventing a hue per title here would put more colour in an empty
 * tile than there is in the entire interface around it.
 */

/** A stable 0–1 position derived from the title. */
function coverSeed(title: string): number {
  let hash = 0
  for (let i = 0; i < title.length; i += 1) {
    hash = (hash * 31 + title.charCodeAt(i)) % 100000
  }
  return (hash % 100) / 100
}

/** Diagonal wash for a portrait surface — tiles and the panel's cover slot. */
export function placeholderGradient(title: string): string {
  // A narrow band: wide enough to tell two neighbours apart, tight enough that
  // no tile reads as lighter than the surface it sits on.
  const top = 0.3 + coverSeed(title) * 0.1
  return `linear-gradient(158deg,
    oklch(${top.toFixed(3)} 0 0) 0%,
    oklch(${(top - 0.1).toFixed(3)} 0 0) 58%,
    oklch(${(top - 0.16).toFixed(3)} 0 0) 100%)`
}

/**
 * Wider, flatter version for the hero band. The same shade, but it has to sit
 * under body text, so it stays darker than the tile wash.
 */
export function placeholderBackdrop(title: string): string {
  const top = 0.24 + coverSeed(title) * 0.08
  return `radial-gradient(120% 140% at 78% 18%,
    oklch(${top.toFixed(3)} 0 0) 0%,
    oklch(${(top - 0.08).toFixed(3)} 0 0) 52%,
    oklch(${(top - 0.13).toFixed(3)} 0 0) 100%)`
}
