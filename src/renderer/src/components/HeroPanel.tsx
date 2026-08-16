import { useEffect, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { genreLabel } from '@shared/games'
import type { GfnGame } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { placeholderBackdrop } from '@/lib/artwork'
import { cn } from '@/lib/utils'

function ownershipLine(game: GfnGame): { text: string; owned: boolean } {
  const owned = game.stores.filter((store) => store.owned)
  if (owned.length > 0) {
    return {
      text: `In your library on ${owned.map((store) => store.storeLabel).join(', ')}`,
      owned: true
    }
  }
  return {
    text: `Requires a purchase on ${game.stores.map((store) => store.storeLabel).join(' or ')}`,
    owned: false
  }
}

/**
 * The cover art behind the title.
 *
 * Two stacked layers rather than one: moving across a grid changes the focused
 * game every 90 ms at full repeat, and swapping a single `<img>` would flash the
 * page colour between every title. The outgoing image stays until the incoming
 * one has faded over it.
 */
function HeroBackdrop({ game }: { game: GfnGame }): ReactNode {
  const incoming = game.images.hero ?? game.images.tile
  const [settled, setSettled] = useState<string | null>(incoming)
  const [failed, setFailed] = useState<Set<string>>(new Set())

  // Once the new artwork is on screen it becomes the layer everything else
  // fades over.
  useEffect(() => {
    if (!incoming) setSettled(null)
  }, [incoming])

  const usable = incoming && !failed.has(incoming) ? incoming : null
  const beneath = settled && settled !== usable && !failed.has(settled) ? settled : null

  return (
    <div
      className="absolute inset-0 -z-10 overflow-hidden"
      style={{ background: placeholderBackdrop(game.title) }}
    >
      {beneath && <img src={beneath} alt="" className="absolute inset-0 size-full object-cover" />}

      {usable && (
        <img
          key={usable}
          src={usable}
          alt=""
          decoding="async"
          onLoad={() => setSettled(usable)}
          onError={() => setFailed((current) => new Set(current).add(usable))}
          className="animate-in fade-in absolute inset-0 size-full object-cover duration-700"
        />
      )}

      {/* Two scrims, each doing one job: the horizontal one buys legibility for
          the text column, the vertical one dissolves the band into the grid so
          the artwork never competes with the focused tile below. */}
      <div className="from-background via-background/80 absolute inset-0 bg-gradient-to-r to-transparent" />
      <div className="from-background via-background/45 to-background/10 absolute inset-0 bg-gradient-to-t" />
    </div>
  )
}

/**
 * The band above the grid: whatever the cursor is standing on, at full size.
 *
 * It runs to the top edge of the window — there is no bar above it. On a TV the
 * one thing the panel does better than anything else is show a picture, so the
 * picture starts at the first pixel.
 */
export function HeroPanel({
  game,
  loading
}: {
  game: GfnGame | null
  /** Waiting on the catalog — hold the layout instead of saying nothing. */
  loading?: boolean
}): ReactNode {
  if (loading) {
    return (
      <section className="flex h-[34vh] shrink-0 flex-col justify-end px-10 pt-6 pb-8">
        <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          Loading the catalog
        </p>
        <Skeleton className="mt-4 h-[clamp(2.5rem,5vw,4rem)] w-[42%]" />
        <div className="mt-5 flex gap-3">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-6 w-20" />
        </div>
        <p className="text-muted-foreground mt-5 text-sm">
          Fetching every GeForce NOW title. This takes a few seconds and only happens when the
          catalog is out of date.
        </p>
      </section>
    )
  }

  if (!game) {
    return (
      <section className="flex h-[34vh] shrink-0 flex-col justify-end px-10 pt-6 pb-8">
        <p className="text-muted-foreground text-sm">Nothing to show yet.</p>
      </section>
    )
  }

  const ownership = ownershipLine(game)

  return (
    <section className="relative isolate flex h-[34vh] shrink-0 flex-col justify-end overflow-hidden px-10 pt-6 pb-8">
      <HeroBackdrop game={game} />

      <div key={game.cmsId} className="animate-in fade-in slide-in-from-bottom-3 duration-300">
        <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          {game.publisher ?? 'Unknown publisher'}
        </p>

        <h1 className="mt-3 text-[clamp(2.25rem,4.5vw,3.75rem)] leading-none font-semibold tracking-tight">
          {game.title}
        </h1>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {game.genres.map((genre) => (
            <Badge key={genre} variant="outline" className="bg-background/40 font-mono text-xs">
              {genreLabel(genre)}
            </Badge>
          ))}
        </div>

        <p
          className={cn(
            'mt-5 flex items-center gap-1.5 text-sm',
            ownership.owned ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {ownership.owned && <Check className="text-primary size-4" />}
          {ownership.text}
        </p>
      </div>
    </section>
  )
}
