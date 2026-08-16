import { useEffect, useRef, type ReactNode } from 'react'
import { ALL_GENRES, RTX_FILTER, type GenreFacet } from '@shared/games'
import { useFocusable } from '@/focus/SpatialFocus'
import { GlyphBadge, glyphFor } from '@/components/glyphs'
import type { InputScheme } from '@/gamepad/scheme'
import { cn } from '@/lib/utils'

/**
 * `rtx` paints the chip in the accent at rest, which is the one place in the
 * shell besides the cursor that is allowed to be chromatic — it is the whole
 * point of the filter. It stops short of a solid fill so the *focused* state
 * still has somewhere brighter to go.
 */
type Tone = 'neutral' | 'rtx'

function Chip({
  id,
  label,
  count,
  active,
  scope,
  tone = 'neutral',
  onSelect
}: {
  id: string
  label: string
  count: number
  active: boolean
  scope: string
  tone?: Tone
  onSelect: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(id, { scope, onConfirm: onSelect })

  return (
    <button
      ref={ref}
      type="button"
      data-active={active}
      onClick={onSelect}
      className={cn(
        'flex shrink-0 items-baseline gap-2 rounded-md border px-3.5 py-1.5 transition-all duration-150',
        // Three states. The focused one is the accent, because the cursor has
        // to outrank a filter that merely happens to be on — which is why the
        // RTX chip only ever wears the accent as an outline until it is focused.
        focused
          ? 'focus-ring border-primary bg-primary text-primary-foreground scale-[1.04]'
          : tone === 'rtx'
            ? active
              ? 'border-primary bg-primary/20 text-primary'
              : 'border-primary/70 bg-primary/10 text-primary'
            : active
              ? 'border-foreground/25 bg-accent text-foreground'
              : 'border-border bg-card text-muted-foreground'
      )}
    >
      <span className="text-sm font-medium whitespace-nowrap">{label}</span>
      <span className={cn('font-mono text-[0.65rem] tabular-nums', !focused && 'opacity-70')}>
        {count}
      </span>
    </button>
  )
}

/** The shoulder button drawn at a strip end, or nothing on a scheme with none. */
function PageHint({
  action,
  scheme
}: {
  action: 'pageLeft' | 'pageRight'
  scheme: InputScheme
}): ReactNode {
  const glyph = glyphFor(action, scheme)
  if (!glyph) return null

  return <GlyphBadge glyph={glyph} />
}

/**
 * The filter strip: All, RTX ON, then the genres present in the view.
 *
 * It sits in the page rather than behind a button because the face buttons are
 * all spoken for and, more to the point, a filter the user cannot see is a
 * filter they will forget is on. The shoulder buttons cycle it from anywhere in
 * the grid, so the common case never costs a trip up here at all — which is why
 * the LB/RB glyphs are drawn on the strip itself rather than in the footer: the
 * affordance belongs on the thing it operates.
 */
export function GenreStrip({
  genres,
  active,
  total,
  rtxCount,
  scope,
  scheme,
  onSelect
}: {
  genres: GenreFacet[]
  /** `ALL_GENRES`, `RTX_FILTER`, or a genre code. */
  active: string
  /** How many titles the unfiltered view holds, for the "All" chip. */
  total: number
  /** Ray-traced titles in the view. Zero hides the chip entirely. */
  rtxCount: number
  scope: string
  scheme: InputScheme
  onSelect: (genre: string) => void
}): ReactNode {
  const track = useRef<HTMLDivElement>(null)

  // Cycling with the shoulder buttons deliberately leaves focus in the grid, so
  // nothing else brings the chip that just became active into view.
  useEffect(() => {
    track.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [active])

  // One genre is not a choice, and none at all means nothing has loaded yet —
  // unless there are RTX titles, in which case "All / RTX ON" already is one.
  if (genres.length < 2 && rtxCount === 0) return null

  return (
    <div className="flex shrink-0 items-center gap-3 px-10 pb-2">
      <PageHint action="pageLeft" scheme={scheme} />

      <div
        ref={track}
        // `overflow-x` makes this clip on both axes, so the focus ring needs
        // room above and below as well as scroll padding at the ends.
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto scroll-px-2 scroll-smooth px-0.5 py-1.5 [scrollbar-width:none]"
      >
        <Chip
          id={`genre:${ALL_GENRES}`}
          label="All"
          count={total}
          active={active === ALL_GENRES}
          scope={scope}
          onSelect={() => onSelect(ALL_GENRES)}
        />
        {rtxCount > 0 && (
          <Chip
            id={`genre:${RTX_FILTER}`}
            label="RTX ON"
            count={rtxCount}
            active={active === RTX_FILTER}
            scope={scope}
            tone="rtx"
            onSelect={() => onSelect(RTX_FILTER)}
          />
        )}
        {genres.map((genre) => (
          <Chip
            key={genre.code}
            id={`genre:${genre.code}`}
            label={genre.label}
            count={genre.count}
            active={active === genre.code}
            scope={scope}
            onSelect={() => onSelect(genre.code)}
          />
        ))}
      </div>

      <PageHint action="pageRight" scheme={scheme} />
    </div>
  )
}
