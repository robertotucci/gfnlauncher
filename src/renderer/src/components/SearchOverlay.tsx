import { useEffect, type ReactNode } from 'react'
import { Delete, Eraser, Space } from 'lucide-react'
import type { GfnGame } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { useFocusable } from '@/focus/SpatialFocus'
import { cn } from '@/lib/utils'

export const SEARCH_SCOPE = 'search'

/**
 * Alphabetical, not QWERTY.
 *
 * On a pad you scan for a letter rather than reach for it from muscle memory,
 * and A–Z in a grid is the only layout where the next letter's position is
 * predictable without looking for it.
 */
const KEY_ROWS: string[][] = [
  ['A', 'B', 'C', 'D', 'E', 'F'],
  ['G', 'H', 'I', 'J', 'K', 'L'],
  ['M', 'N', 'O', 'P', 'Q', 'R'],
  ['S', 'T', 'U', 'V', 'W', 'X'],
  ['Y', 'Z', '0', '1', '2', '3'],
  ['4', '5', '6', '7', '8', '9']
]

function Key({
  id,
  onPress,
  children,
  wide
}: {
  id: string
  onPress: () => void
  children: ReactNode
  wide?: boolean
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(id, {
    scope: SEARCH_SCOPE,
    onConfirm: onPress
  })

  return (
    <button
      ref={ref}
      type="button"
      onClick={onPress}
      className={cn(
        'grid h-12 place-items-center rounded-md border text-base transition-all duration-150',
        wide ? 'col-span-2' : '',
        focused
          ? 'focus-ring border-primary bg-primary text-primary-foreground scale-105'
          : 'border-border bg-card text-muted-foreground'
      )}
    >
      {children}
    </button>
  )
}

function ResultRow({
  game,
  onActivate
}: {
  game: GfnGame
  onActivate: (game: GfnGame) => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(`result:${game.cmsId}`, {
    scope: SEARCH_SCOPE,
    onConfirm: () => onActivate(game)
  })

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onActivate(game)}
      className={cn(
        'flex w-full items-center justify-between gap-4 rounded-md border px-4 py-3 text-left transition-all duration-150',
        focused ? 'focus-ring border-primary bg-accent' : 'border-border bg-card'
      )}
    >
      <span className="min-w-0">
        <span
          className={cn(
            'block truncate text-sm font-medium',
            focused ? 'text-foreground' : 'text-foreground/80'
          )}
        >
          {game.title}
        </span>
        <span className="text-muted-foreground block truncate font-mono text-xs">
          {game.publisher ?? 'Unknown publisher'}
        </span>
      </span>
      {game.owned && (
        <Badge variant="secondary" className="shrink-0 font-mono text-xs">
          OWNED
        </Badge>
      )}
    </button>
  )
}

export function SearchOverlay({
  query,
  results,
  closing,
  suspended,
  onQueryChange,
  onActivate
}: {
  query: string
  results: GfnGame[]
  /** Set while the overlay plays its exit before App unmounts it. */
  closing?: boolean
  /** Set when a layer above owns input — typing must not edit a hidden query. */
  suspended?: boolean
  onQueryChange: (next: string) => void
  onActivate: (game: GfnGame) => void
}): ReactNode {
  // The on-screen keyboard is the gamepad path. A physical keyboard, when one
  // is attached, should still just work.
  useEffect(() => {
    if (suspended) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.altKey || event.metaKey) return

      if (event.key === 'Backspace') {
        event.preventDefault()
        onQueryChange(query.slice(0, -1))
        return
      }

      if (event.key.length === 1 && /[a-z0-9 ]/i.test(event.key)) {
        event.preventDefault()
        onQueryChange(query + event.key.toUpperCase())
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [query, suspended, onQueryChange])

  return (
    <div
      className={cn(
        'bg-background absolute inset-0 z-20 flex gap-10 px-10 py-8',
        closing ? 'animate-out fade-out duration-150' : 'animate-in fade-in duration-200'
      )}
    >
      <div className="flex w-[26rem] shrink-0 flex-col">
        <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          Search the catalog
        </p>

        <div className="border-border bg-card mt-4 flex h-14 items-center rounded-md border px-4">
          <span className="truncate text-2xl font-medium tracking-tight">
            {query || <span className="text-muted-foreground/60">Type a title</span>}
          </span>
          <span className="bg-primary ml-1 inline-block h-6 w-[2px] animate-pulse" />
        </div>

        <div className="mt-5 grid grid-cols-6 gap-2">
          {KEY_ROWS.flat().map((char) => (
            <Key key={char} id={`key:${char}`} onPress={() => onQueryChange(query + char)}>
              {char}
            </Key>
          ))}

          <Key id="key:space" onPress={() => onQueryChange(`${query} `)} wide>
            <Space className="size-4" />
          </Key>
          <Key id="key:backspace" onPress={() => onQueryChange(query.slice(0, -1))} wide>
            <Delete className="size-4" />
          </Key>
          <Key id="key:clear" onPress={() => onQueryChange('')} wide>
            <Eraser className="size-4" />
          </Key>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          {query ? `${results.length} matching` : 'Everything'}
        </p>

        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scroll-py-3 px-1 py-1 pr-2">
          {results.length === 0 ? (
            <p className="text-muted-foreground mt-6 text-sm">
              No titles match “{query}”. Try a shorter search.
            </p>
          ) : (
            results
              .slice(0, 40)
              .map((game) => (
                <ResultRow key={game.cmsId} game={game} onActivate={onActivate} />
              ))
          )}
        </div>
      </div>
    </div>
  )
}
