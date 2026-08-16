/**
 * Vocabulary and pure helpers for the server-status view.
 *
 * Shared rather than renderer-local for the same reason `genreLabel` is: main
 * maps the wire data, the renderer names it, and one of them having its own
 * private copy of the words is how the two drift apart.
 */

import type { ComponentHealth, PageIndicator } from './types'

/**
 * Statuspage's component states, in the launcher's words.
 *
 * Shorter than the source in two places — "Degraded" rather than "Degraded
 * performance", "Maintenance" rather than "Under maintenance" — because these
 * sit at the end of a row that already says what it is describing, and the full
 * phrases wrap at three metres.
 */
export const HEALTH_LABELS: Record<ComponentHealth | 'unknown', string> = {
  operational: 'Operational',
  degraded_performance: 'Degraded',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  under_maintenance: 'Maintenance',
  unknown: 'Unknown'
}

/**
 * How bad a state is, so regions can be sorted worst-first.
 *
 * Maintenance ranks *below* operational rather than above it: planned work is
 * not a fault, and floating every maintenance window to the top of the fleet
 * would bury a real outage under scheduled ones.
 */
const HEALTH_RANK: Record<ComponentHealth | 'unknown', number> = {
  major_outage: 4,
  partial_outage: 3,
  degraded_performance: 2,
  unknown: 1,
  operational: 0,
  under_maintenance: -1
}

export function healthRank(health: ComponentHealth | 'unknown'): number {
  return HEALTH_RANK[health] ?? 0
}

/** True for anything the user would want to know about without asking. */
export function isNotable(health: ComponentHealth | 'unknown'): boolean {
  return health !== 'operational'
}

/**
 * The page-level line, for when Statuspage's own `description` is missing.
 *
 * NVIDIA can edit that string, so it is preferred when present — this is only
 * the floor.
 */
export const INDICATOR_LABELS: Record<PageIndicator, string> = {
  none: 'All systems operational',
  minor: 'Minor service disruption',
  major: 'Major service disruption',
  critical: 'Critical service disruption',
  maintenance: 'Maintenance in progress',
  unknown: 'Status unavailable'
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "40 seconds ago", "3 days ago".
 *
 * Takes `now` rather than reading the clock so it is testable, and so a list of
 * incidents rendered in one pass all date themselves from the same instant.
 * Deliberately coarse: on a status board the difference between 40 and 50
 * seconds is noise, and the reader is checking whether the number is small.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'unknown'

  const elapsed = now - then
  if (elapsed < 0) return 'just now'
  if (elapsed < 10_000) return 'just now'
  if (elapsed < MINUTE) return `${Math.floor(elapsed / 1000)} seconds ago`
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour')
  return plural(Math.floor(elapsed / DAY), 'day')
}

/** "1 hour ago" / "3 hours ago" — the `s` is the only thing that varies. */
function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}

/**
 * A scheduled-maintenance window, as one line.
 *
 * Same-day windows drop the second date: "16 Aug, 23:00 – 06:00" reads faster
 * than repeating a date the eye has just taken in.
 */
export function formatWindow(from: string, until: string, locale: string): string {
  const start = new Date(from)
  const end = new Date(until)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return ''

  const day: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

  const startLabel = `${start.toLocaleDateString(locale, day)}, ${start.toLocaleTimeString(locale, time)}`
  const endLabel =
    start.toDateString() === end.toDateString()
      ? end.toLocaleTimeString(locale, time)
      : `${end.toLocaleDateString(locale, day)}, ${end.toLocaleTimeString(locale, time)}`

  return `${startLabel} – ${endLabel}`
}
