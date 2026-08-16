import { type ReactNode } from 'react'
import type { ComponentHealth } from '@shared/types'
import { HEALTH_LABELS } from '@shared/status'
import { cn } from '@/lib/utils'

export type Health = ComponentHealth | 'unknown'

/**
 * The health scale.
 *
 * A solid dot per state, and the one place the launcher spends colour on
 * something other than the accent. The rest of the chrome stays colourless so
 * that cover art is the most saturated thing on any screen that has cover art
 * on it — but this screen has none, and it has 76 datacenters on it. Reading
 * "fine" against "degraded" against "down" from fill and weight alone stops
 * working somewhere past the first dozen rows, which is exactly where a fleet
 * list starts being worth having.
 *
 * `major_outage` reuses `--destructive` rather than inventing a second red.
 * Tokens live in `globals.css`; a literal colour here would be one the theme
 * cannot reach.
 */
const DOT: Record<Health, string> = {
  operational: 'bg-status-ok',
  under_maintenance: 'bg-status-info',
  degraded_performance: 'bg-status-warn',
  partial_outage: 'bg-status-alert',
  major_outage: 'bg-destructive',
  // Not a state of the service — a state of our knowledge. Stays grey, because
  // guessing a colour for it would be claiming to know something.
  unknown: 'bg-muted-foreground/50'
}

/**
 * The word beside the dot.
 *
 * Neutral for the two states that need no action, coloured for the three that
 * do. The colour is already carried by the dot; repeating it on every label
 * would turn a list of 36 healthy regions into 36 green words, and then the one
 * red word would have to shout over them instead of standing alone.
 */
export const HEALTH_TEXT: Record<Health, string> = {
  operational: 'text-muted-foreground',
  under_maintenance: 'text-muted-foreground',
  degraded_performance: 'text-status-warn',
  partial_outage: 'text-status-alert',
  major_outage: 'text-destructive',
  unknown: 'text-muted-foreground'
}

const SIZE = {
  sm: 'size-2',
  md: 'size-2.5',
  lg: 'size-3.5'
} as const

/**
 * The label grows with the mark.
 *
 * At `lg` this sits under the nameplate, where it is the answer the user came
 * for rather than an annotation on a list — and a caption-sized "Operational"
 * beneath a display-sized zone code reads as a footnote to the question.
 */
const LABEL_SIZE = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base font-medium'
} as const

/**
 * One health indicator, used at every scale on the status screen — beside a
 * datacenter code, on a region's rollup, and under the nameplate.
 *
 * Kept as a single component rather than three so the scale is defined once:
 * two places disagreeing about what "degraded" looks like is how a board stops
 * being readable.
 */
export function HealthMark({
  health,
  size = 'sm',
  label = false,
  className
}: {
  health: Health
  size?: keyof typeof SIZE
  /** Render the state in words beside the mark. */
  label?: boolean
  className?: string
}): ReactNode {
  const mark = <span className={cn('shrink-0 rounded-full', SIZE[size], DOT[health])} aria-hidden />

  if (!label) {
    return (
      <span className={cn('inline-flex', className)} role="img" aria-label={HEALTH_LABELS[health]}>
        {mark}
      </span>
    )
  }

  return (
    <span className={cn('inline-flex items-center gap-2', HEALTH_TEXT[health], className)}>
      {mark}
      <span className={LABEL_SIZE[size]}>{HEALTH_LABELS[health]}</span>
    </span>
  )
}
