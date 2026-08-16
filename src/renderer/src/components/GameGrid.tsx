import { type ReactNode } from 'react'
import type { GfnGame } from '@shared/types'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { GameTile } from './GameTile'

/** Enough to fill a 16:9 screen below the hero band, and no more. */
const SKELETON_TILES = 14

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-5'

/**
 * A focused tile grows and wears a ring, and both of those draw outside its
 * box. The padding buys room for the top row, and `scroll-pt` makes
 * `scrollIntoView` respect the same margin — without it every row reached by
 * scrolling ends up flush against the top edge with its ring sheared off.
 */
const PAD = 'px-10 pt-4 pb-10 scroll-pt-4 scroll-pb-4'

export function GameGrid({
  games,
  scope,
  loading,
  emptyMessage,
  showOwnership,
  onActivate
}: {
  games: GfnGame[]
  scope: string
  /** Waiting on the catalog: show the shape of the grid, not an empty room. */
  loading?: boolean
  emptyMessage: ReactNode
  showOwnership: boolean
  onActivate: (game: GfnGame) => void
}): ReactNode {
  if (loading) {
    return (
      <div className={cn('min-h-0 flex-1 overflow-hidden', PAD)}>
        <div className={GRID}>
          {Array.from({ length: SKELETON_TILES }, (_, index) => (
            <Skeleton
              key={index}
              className="aspect-[3/4] w-full rounded-lg"
              // Staggered so the grid breathes across the screen rather than
              // blinking in unison, which reads as a broken render.
              style={{ animationDelay: `${index * 70}ms` }}
            />
          ))}
        </div>
      </div>
    )
  }

  if (games.length === 0) {
    return <div className="px-10 py-10">{emptyMessage}</div>
  }

  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto', PAD)}>
      <div className={GRID}>
        {games.map((game) => (
          <GameTile
            key={game.cmsId}
            game={game}
            scope={scope}
            showOwnership={showOwnership}
            onActivate={onActivate}
          />
        ))}
      </div>
    </div>
  )
}
