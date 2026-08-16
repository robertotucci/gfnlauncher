/**
 * The server-status snapshot: NVIDIA's board, plus where this client points.
 *
 * ── Why there is no `status.json` on disk ───────────────────────────────────
 *
 * Every other store in the launcher persists — `catalog.json`, `details.json`,
 * `recent.json` — and this one deliberately does not, because a stale status
 * board is not the same kind of thing as a stale catalog. A catalog from last
 * week is merely missing a few titles; a board from last week says "all systems
 * operational" about a datacenter that is on fire. The value of the data decays
 * to nothing in minutes, so caching it across runs would only make the launcher
 * better at being confidently wrong.
 *
 * Two things make persistence unnecessary anyway. The payload is 41 KB behind a
 * CDN with `max-age=10` and ETag support, so a cold fetch is quick and a warm
 * one is a 304. And the half of this screen that matters most — the region,
 * zone code, routing mode and latency on the nameplate — is read from a local
 * file, so the screen still answers its primary question with no network at all.
 * Only the health verdict needs the wire.
 */

import type { StatusSnapshot } from '@shared/types'
import { fetchSummary, type StatusFeed } from './statuspage'
import { readZoneAssignment, resolveZone } from './zone'

/**
 * How long `get()` will serve what it already has.
 *
 * Above the endpoint's own `max-age=10`, because opening the view twice in a
 * minute is navigation rather than a request for fresh data — and the refresh
 * control is right there for when it is.
 */
const STATUS_TTL_MS = 60_000

let feed: StatusFeed | null = null
let etag: string | null = null
let fetchedAt: number | null = null
let inFlight: Promise<string | null> | null = null

/**
 * Refreshes the cached feed, returning an error message or null.
 *
 * Degrades rather than throws, the same posture as `refreshCatalog`: on failure
 * the last good feed is kept and dated, so a dropped connection turns the board
 * stale rather than blank.
 */
async function revalidate(): Promise<string | null> {
  try {
    const result = await fetchSummary(etag)
    etag = result.etag
    // A 304 means what we hold is still current — so it is freshly checked,
    // not merely unchanged, and the timestamp has to move.
    if (result.feed) feed = result.feed
    fetchedAt = Date.now()
    return null
  } catch (error) {
    console.warn('GFN status refresh failed:', error)
    return error instanceof Error ? error.message : 'The status page could not be reached.'
  }
}

/** Shares one request between concurrent callers, mirroring `loadSnapshot` in gfn/catalog.ts. */
function revalidateOnce(): Promise<string | null> {
  inFlight ??= revalidate().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function snapshot(error: string | null): Promise<StatusSnapshot> {
  // Read every time, cached feed or not: this is a local file, and the user may
  // have changed their server location in the GFN app since the launcher started.
  const assignment = await readZoneAssignment()
  const regions = feed?.regions ?? []

  return {
    summary: feed?.summary ?? null,
    indicator: feed?.indicator ?? 'unknown',
    regions,
    incidents: feed?.incidents ?? [],
    maintenance: feed?.maintenance ?? [],
    zone: resolveZone(assignment, regions),
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
    error
  }
}

/** Serves the cached board while it is fresh, revalidating when it is not. */
export async function getStatus(): Promise<StatusSnapshot> {
  const fresh = feed !== null && fetchedAt !== null && Date.now() - fetchedAt < STATUS_TTL_MS
  return snapshot(fresh ? null : await revalidateOnce())
}

/** Re-checks now, whatever the cache says. What the refresh control calls. */
export async function refreshStatus(): Promise<StatusSnapshot> {
  return snapshot(await revalidateOnce())
}

/** Test seam, mirroring `resetCatalog`. */
export function resetStatus(): void {
  feed = null
  etag = null
  fetchedAt = null
  inFlight = null
}
