import { useState, type ReactNode } from 'react'
import type { GfnGame } from '@shared/types'
import { useFocusable } from '@/focus/SpatialFocus'
import { placeholderGradient } from '@/lib/artwork'
import { cn } from '@/lib/utils'

export function GameTile({
  game,
  scope,
  showOwnership,
  onActivate
}: {
  game: GfnGame
  scope: string
  /** Only meaningful where the grid mixes owned and unowned titles. */
  showOwnership: boolean
  onActivate: (game: GfnGame) => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(`tile:${game.cmsId}`, {
    scope,
    onConfirm: () => onActivate(game)
  })

  // A dead URL must fall back to the gradient rather than to a blank rectangle,
  // so the placeholder is always painted and the image sits on top of it.
  const [artworkFailed, setArtworkFailed] = useState(false)
  const artwork = artworkFailed ? null : game.images.tile

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onActivate(game)}
      className={cn(
        'group relative aspect-[3/4] w-full overflow-hidden rounded-lg text-left',
        'transition-transform duration-200 ease-out will-change-transform',
        // The resting hairline keeps the tile a rectangle even where the scrim
        // reaches the page colour — without it the artwork bleeds into the
        // background and the grid loses its structure. It has to give way
        // entirely when focused: `ring-inset` survives merging with
        // `focus-ring` and would draw the focus ring *under* the artwork.
        focused
          ? 'focus-ring scale-[1.06]'
          : 'scale-100 opacity-85 ring-1 ring-white/10 ring-inset'
      )}
      style={{ background: placeholderGradient(game.title) }}
    >
      {artwork && (
        <img
          src={artwork}
          alt=""
          // The grid mounts one of these per catalog entry, and the catalog
          // runs to thousands: without lazy loading a refresh fires every
          // request at once.
          loading="lazy"
          decoding="async"
          onError={() => setArtworkFailed(true)}
          className="animate-in fade-in absolute inset-0 size-full object-cover duration-500"
          draggable={false}
        />
      )}

      {/* Legibility floor for the title over arbitrary artwork. Stops short of
          the page colour so the tile keeps a visible bottom edge. */}
      <div className="from-background/92 via-background/55 absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t to-transparent" />

      {/* Left corner, because the right one belongs to the RTX badge and the
          two would otherwise jostle on a title that is both. */}
      {showOwnership && game.owned && (
        <span
          className="bg-primary absolute top-2.5 left-2.5 size-2 rounded-full"
          title="In your library"
        />
      )}

      {/* Ungated by `showOwnership`: ray tracing is a fact about the game, so it
          reads the same in Library and Catalog. It sits above the artwork, where
          the bottom scrim does not reach, so it carries its own legibility floor
          — and it is accent *text* rather than an accent fill, because a grid of
          solid accent pills would out-shout the focus ring. */}
      {game.rtx && (
        <span className="bg-background/75 ring-primary/30 text-primary absolute top-2.5 right-2.5 rounded px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-widest uppercase ring-1 backdrop-blur-sm">
          RTX ON
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 p-3">
        <p
          className={cn(
            'line-clamp-2 text-sm leading-tight font-medium',
            focused ? 'text-foreground' : 'text-foreground/85'
          )}
        >
          {game.title}
        </p>
      </div>
    </button>
  )
}
