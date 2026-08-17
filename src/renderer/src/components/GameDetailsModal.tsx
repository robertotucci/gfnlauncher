import { type ReactNode } from 'react'
import { Check, Play, X } from 'lucide-react'
import { formatReleaseDate, genreLabel } from '@shared/games'
import type { GameDetails, GameStoreOwnership, GfnGame } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { StoreQr } from '@/components/StoreQr'
import { useFocusable, useSpatialFocus } from '@/focus/SpatialFocus'
import { placeholderBackdrop } from '@/lib/artwork'
import { cn } from '@/lib/utils'

export const DETAILS_SCOPE = 'details'

function ActionButton({
  id,
  label,
  icon,
  primary,
  onPress
}: {
  id: string
  label: string
  icon: ReactNode
  primary?: boolean
  onPress: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(id, {
    scope: DETAILS_SCOPE,
    onConfirm: onPress
  })

  return (
    <button
      ref={ref}
      type="button"
      onClick={onPress}
      className={cn(
        'flex items-center gap-2.5 rounded-md border px-6 py-2.5 text-sm font-medium transition-all duration-150',
        focused
          ? 'focus-ring border-primary bg-primary text-primary-foreground scale-[1.03]'
          : primary
            ? 'border-foreground/25 bg-accent text-foreground'
            : 'border-border bg-card text-muted-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/** One machine fact. Label quiet, value legible. */
function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex min-w-0 gap-4">
      <p className="text-muted-foreground/80 w-36 shrink-0 pt-[0.15rem] text-xs font-medium tracking-widest uppercase">
        {label}
      </p>
      <div className="text-foreground/90 min-w-0 text-sm">{children}</div>
    </div>
  )
}

function gamepadLine(details: GameDetails): { text: string; tone: string } {
  switch (details.gamepad) {
    case 'full':
      return { text: 'Full gamepad support', tone: 'text-foreground' }
    case 'partial':
      return { text: 'Partial gamepad support', tone: 'text-foreground/75' }
    default:
      return { text: 'Keyboard and mouse only', tone: 'text-muted-foreground' }
  }
}

function Shot({
  src,
  index,
  onOpen
}: {
  src: string
  index: number
  onOpen: (index: number) => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(`detail:shot:${index}`, {
    scope: DETAILS_SCOPE,
    onConfirm: () => onOpen(index)
  })

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(index)}
      className={cn(
        'w-[13rem] shrink-0 overflow-hidden rounded-md transition-all duration-150',
        focused ? 'focus-ring scale-[1.03]' : 'ring-1 ring-white/10 ring-inset'
      )}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn(
          'aspect-video w-full object-cover transition-opacity duration-150',
          focused ? 'opacity-100' : 'opacity-75'
        )}
      />
    </button>
  )
}

/**
 * One store's edition of the title.
 *
 * Carries two facts that must not be confused: the dot says the machine
 * believes the user owns it, the tick says the user chose to launch from it.
 * Neither takes the accent, which belongs to the cursor alone.
 */
function StoreChip({
  store,
  selected,
  onSelect
}: {
  store: GameStoreOwnership
  selected: boolean
  onSelect: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(`detail:store:${store.variantId}`, {
    scope: DETAILS_SCOPE,
    onConfirm: onSelect
  })

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      className={cn(
        'flex items-center gap-2.5 rounded-md border px-3.5 py-1.5 transition-all duration-150',
        focused
          ? 'focus-ring border-primary bg-primary text-primary-foreground scale-[1.03]'
          : selected
            ? 'border-foreground/25 bg-accent text-foreground'
            : 'border-border bg-card text-muted-foreground'
      )}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          store.owned
            ? focused
              ? 'bg-primary-foreground'
              : 'bg-foreground'
            : 'bg-muted-foreground/40'
        )}
      />
      <span className="text-sm font-medium whitespace-nowrap">{store.storeLabel}</span>
      {selected && !focused && <Check className="size-3.5 shrink-0" />}
    </button>
  )
}

export function GameDetailsModal({
  game,
  details,
  loading,
  closing,
  locale,
  authenticated,
  busy,
  notice,
  onPlay,
  onClose,
  onOpenShot,
  onSelectStore
}: {
  game: GfnGame
  /** Null while loading, and also for a title the feed had nothing on. */
  details: GameDetails | null
  loading: boolean
  closing: boolean
  locale: string
  /** Store changes are server-side, so signed out they can only be described. */
  authenticated: boolean
  /** A store mutation is in flight. */
  busy: boolean
  /** Why the last store action refused, or what it did. */
  notice: string | null
  onPlay: () => void
  onClose: () => void
  onOpenShot: (index: number) => void
  onSelectStore: (store: GameStoreOwnership) => void
}): ReactNode {
  const backdrop = game.images.hero ?? game.images.tile
  const released = formatReleaseDate(details?.releaseDate, locale)
  const shots = details?.screenshots ?? []
  const gamepad = details ? gamepadLine(details) : null

  // The link is offered for the chip under the cursor only. A wall of codes
  // would be unreadable, and one that follows focus reads as belonging to the
  // store the user is looking at.
  const { focusedId } = useSpatialFocus()
  const focusedStore = game.stores.find((store) => focusedId === `detail:store:${store.variantId}`)

  return (
    <div
      className={cn(
        'bg-background/80 absolute inset-0 z-30 grid place-items-center p-6 backdrop-blur-[3px]',
        closing ? 'animate-out fade-out duration-150' : 'animate-in fade-in duration-200'
      )}
    >
      <div
        className={cn(
          'border-border bg-card flex max-h-full w-full max-w-[62rem] flex-col overflow-hidden rounded-xl border shadow-lg',
          closing
            ? 'animate-out fade-out zoom-out-95 duration-150'
            : 'animate-in fade-in zoom-in-95 duration-200'
        )}
      >
        {/* Artwork band. Same treatment as the hero, so the panel reads as the
            same object opening up rather than a different screen. */}
        <div
          className="relative h-[15rem] shrink-0 overflow-hidden"
          style={{ background: placeholderBackdrop(game.title) }}
        >
          {backdrop && (
            <img
              src={backdrop}
              alt=""
              decoding="async"
              className="animate-in fade-in absolute inset-0 size-full object-cover duration-500"
            />
          )}
          <div className="from-card via-card/70 to-card/10 absolute inset-0 bg-gradient-to-t" />
          <div className="from-card/90 absolute inset-0 bg-gradient-to-r to-transparent" />

          <div className="absolute inset-x-0 bottom-0 p-8">
            <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
              {[game.publisher, game.developer !== game.publisher ? game.developer : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <h2 className="mt-2 text-[clamp(1.75rem,3.2vw,2.5rem)] leading-none font-semibold tracking-tight">
              {game.title}
            </h2>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto scroll-py-4 px-8 py-7">
          <div className="flex flex-wrap items-center gap-2">
            {game.genres.map((genre) => (
              <Badge key={genre} variant="outline" className="font-mono text-xs">
                {genreLabel(genre)}
              </Badge>
            ))}
            {game.membershipTier && (
              <Badge variant="secondary" className="font-mono text-xs">
                {game.membershipTier}
              </Badge>
            )}
          </div>

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : (
            details?.description && (
              <p className="animate-in fade-in text-foreground/85 max-w-[52rem] text-base leading-relaxed duration-300">
                {details.description}
              </p>
            )
          )}

          {shots.length > 0 && (
            // A strip rather than a fixed grid: every shot is reachable, and
            // `focus()` scrolls the focused one to centre, so it carousels.
            //
            // **`shrink-0` is load-bearing.** `overflow-x-auto` makes this a
            // scroll container on both axes, and a scroll container's automatic
            // minimum size is zero — so as a flex item in the scrolling column
            // above it is the one child here that *can* be squashed, and the
            // flex algorithm runs before the column decides it has anything to
            // scroll. Every other child resists at its min-content height, so
            // this one absorbed the whole overflow: at the default 1600×900 the
            // strip collapsed to a three-pixel sliver and the screenshots simply
            // were not on screen — while the buttons stayed focusable, so the
            // cursor could sit on an image nobody could see.
            <div className="animate-in fade-in flex shrink-0 gap-3 overflow-x-auto scroll-px-2 px-0.5 py-1.5 duration-300 [scrollbar-width:none]">
              {shots.map((shot, index) => (
                <Shot key={shot} src={shot} index={index} onOpen={onOpenShot} />
              ))}
            </div>
          )}

          <Separator />

          <div className="flex flex-col gap-3">
            <Fact label="Available on">
              <div className="flex items-start gap-5">
                <div className={cn('flex min-w-0 flex-wrap gap-2', busy && 'animate-pulse')}>
                  {game.stores.map((store) => (
                    <StoreChip
                      key={store.variantId}
                      store={store}
                      selected={store.variantId === game.selectedVariantId}
                      onSelect={() => onSelectStore(store)}
                    />
                  ))}
                </div>

                {/* The slot is held open whenever any edition has a link, so
                    that moving the cursor along the chips reveals a code
                    instead of reflowing the row out from under it. */}
                {game.stores.some((store) => store.storeUrl) && (
                  <div className="w-[7rem] shrink-0">
                    {focusedStore?.storeUrl && (
                      <StoreQr url={focusedStore.storeUrl} label="SCAN TO OPEN STORE" />
                    )}
                  </div>
                )}
              </div>

              <p className="text-muted-foreground/80 mt-2 font-mono text-xs">
                {notice ??
                  (authenticated
                    ? 'Set which store launches, or mark one you own that sync missed.'
                    : 'Sign in to set the launch store or mark ownership.')}
              </p>
            </Fact>

            {released && <Fact label="Released">{released}</Fact>}

            {gamepad && (
              <Fact label="Controls">
                <span className={gamepad.tone}>{gamepad.text}</span>
                {details && details.controls.length > 0 && (
                  <span className="text-muted-foreground"> · {details.controls.join(' · ')}</span>
                )}
              </Fact>
            )}

            {details && details.subscriptions.length > 0 && (
              <Fact label="Included with">{details.subscriptions.join(' · ')}</Fact>
            )}

            {!loading && !details && (
              <Fact label="Details">
                <span className="text-muted-foreground">
                  Nothing beyond the catalog entry — refresh the catalog signed out to pull
                  descriptions and screenshots.
                </span>
              </Fact>
            )}
          </div>
        </div>

        <div className="border-border/60 flex shrink-0 items-center justify-end gap-3 border-t px-8 py-5">
          <ActionButton
            id="detail:play"
            label="Play"
            primary
            icon={<Play className="size-4" />}
            onPress={onPlay}
          />
          <ActionButton
            id="detail:close"
            label="Close"
            icon={<X className="size-4" />}
            onPress={onClose}
          />
        </div>
      </div>
    </div>
  )
}
