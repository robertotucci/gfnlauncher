/**
 * The GeForce NOW status page, read as data.
 *
 * `status.geforcenow.com` is a stock Atlassian Statuspage, which means one
 * unauthenticated JSON endpoint returns the whole board: the page's own rollup,
 * every component, open incidents and scheduled maintenance. No token, no API
 * key, and — unlike NVIDIA's game list — no `User-Agent` requirement.
 *
 * Everything below the fetch is pure. `mapSummary` is this feature's `mapApp`:
 * the one place Statuspage's wire schema is allowed to be visible, so a change
 * on their side stops at a single function.
 *
 * See docs/gfn-api.md for the endpoint survey and the response shapes.
 */

import type {
  ComponentHealth,
  PageIndicator,
  StatusComponent,
  StatusIncident,
  StatusIncidentUpdate,
  StatusRegion
} from '@shared/types'
import { GfnApiError } from '../gfn/graphql'

/**
 * One request for the entire board — page, components, incidents and
 * maintenances, about 41 KB. The narrower endpoints (`components.json`,
 * `incidents/unresolved.json`) all work, but three round trips to rebuild what
 * this returns in one would be slower and could disagree with itself.
 */
export const STATUS_SUMMARY_URL = 'https://status.geforcenow.com/api/v2/summary.json'

/**
 * How long to wait for the status page before calling it unreachable.
 *
 * This is the only `fetch` in the launcher that carries a timeout, and the
 * exception is deliberate. Elsewhere a stalled request costs a background
 * refresh nobody is watching; here it costs a spinner on a button the user just
 * pressed, on a screen with no keyboard, where a control that never finishes is
 * the one failure that cannot be diagnosed from the sofa. Eight seconds is
 * generous for 41 KB off a CDN and short enough to read as a failure rather
 * than a hang.
 */
const REQUEST_TIMEOUT_MS = 8_000

/** Statuspage's component vocabulary. Anything unrecognised reads as unknown. */
const HEALTH_VALUES: ComponentHealth[] = [
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
  'under_maintenance'
]

const INDICATOR_VALUES: PageIndicator[] = ['none', 'minor', 'major', 'critical', 'maintenance']

/** Incident statuses that mean "over". Everything else is still open. */
const CLOSED_STATUSES = new Set(['resolved', 'completed', 'postmortem'])

// The wire shapes, kept local: nothing outside this file should know them.

interface WireComponent {
  id?: unknown
  name?: unknown
  status?: unknown
  group?: unknown
  group_id?: unknown
  components?: unknown
}

interface WireIncidentUpdate {
  id?: unknown
  status?: unknown
  body?: unknown
  display_at?: unknown
  created_at?: unknown
}

interface WireIncident {
  id?: unknown
  name?: unknown
  status?: unknown
  impact?: unknown
  started_at?: unknown
  created_at?: unknown
  scheduled_for?: unknown
  scheduled_until?: unknown
  incident_updates?: unknown
  components?: unknown
}

export interface StatusFeed {
  summary: string | null
  indicator: PageIndicator
  regions: StatusRegion[]
  incidents: StatusIncident[]
  maintenance: StatusIncident[]
}

export interface FetchSummaryResult {
  /** Absent on a 304 — the caller already has this data. */
  feed: StatusFeed | null
  notModified: boolean
  /** Hand back on the next call to get a 304 instead of 41 KB. */
  etag: string | null
}

/**
 * Fetches and maps the board.
 *
 * Plain global `fetch`, not the authenticated partition's: this endpoint takes
 * no credentials and there is no reason to hand Atlassian the user's cookie jar.
 */
export async function fetchSummary(etag: string | null): Promise<FetchSummaryResult> {
  let response: Response
  try {
    response = await fetch(STATUS_SUMMARY_URL, {
      headers: etag ? { 'If-None-Match': etag } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (cause) {
    // A timeout arrives here as a TimeoutError, which reads as nothing useful
    // to someone holding a gamepad.
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      throw new GfnApiError('status.geforcenow.com did not respond in time.')
    }
    throw new GfnApiError(cause instanceof Error ? cause.message : 'Network request failed')
  }

  // The whole point of sending If-None-Match: nothing changed, keep what we have.
  if (response.status === 304) {
    return { feed: null, notModified: true, etag }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new GfnApiError(
      `Status request failed${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      response.status
    )
  }

  return {
    feed: mapSummary(await response.json()),
    notModified: false,
    etag: response.headers.get('etag') ?? null
  }
}

/**
 * Turns the summary payload into the launcher's model.
 *
 * The tree is the awkward part. `components` arrives as a **flat array in no
 * particular order**: a group carries `group: true` and a `components` array of
 * child ids, a leaf carries a `group_id` back-pointer, and one component
 * ("NVIDIA Global Services") belongs to neither. `position` is scoped per level,
 * so it cannot be used to reconstruct nesting — only `group_id` can.
 */
export function mapSummary(raw: unknown): StatusFeed {
  const root = asRecord(raw)
  const page = asRecord(root?.status)
  const wire = Array.isArray(root?.components) ? (root.components as WireComponent[]) : []

  const groups: StatusRegion[] = []
  const byGroup = new Map<string, StatusComponent[]>()
  /** Leaf id -> region id, so an incident's components can be mapped to regions. */
  const regionOfComponent = new Map<string, string>()

  for (const entry of wire) {
    const id = asString(entry.id)
    const name = asString(entry.name)
    if (!id || !name) continue

    if (entry.group === true) {
      const { label, tier, partner } = splitGroupName(name)
      groups.push({
        id,
        name: label,
        tier,
        partner,
        // Statuspage computes the rollup itself and it is the value its own page
        // renders. Re-deriving it from the children would be a second opinion
        // nobody asked for, and would disagree during a partial outage.
        health: asHealth(entry.status),
        components: []
      })
      continue
    }

    const groupId = asString(entry.group_id)
    // The one ungrouped component is a global service, not a datacenter. It has
    // no region to sit under and the page-level indicator already covers it.
    if (!groupId) continue

    const leaf: StatusComponent = { id, name: stripTier(name), health: asHealth(entry.status) }
    const siblings = byGroup.get(groupId)
    if (siblings) siblings.push(leaf)
    else byGroup.set(groupId, [leaf])
    regionOfComponent.set(id, groupId)
  }

  const regions = groups
    .map((group) => ({ ...group, components: byGroup.get(group.id) ?? [] }))
    // A group with nothing in it is a page-authoring artefact, not a region.
    .filter((group) => group.components.length > 0)

  const known = new Set(regions.map((region) => region.id))

  return {
    summary: asString(page?.description),
    indicator: asIndicator(page?.indicator),
    regions,
    incidents: mapIncidents(root?.incidents, regionOfComponent, known, false),
    maintenance: mapIncidents(root?.scheduled_maintenances, regionOfComponent, known, true)
  }
}

function mapIncidents(
  raw: unknown,
  regionOfComponent: Map<string, string>,
  knownRegions: Set<string>,
  scheduled: boolean
): StatusIncident[] {
  if (!Array.isArray(raw)) return []

  return (raw as WireIncident[])
    .filter((entry) => !CLOSED_STATUSES.has(asString(entry.status) ?? ''))
    .map((entry) => {
      const id = asString(entry.id)
      const title = asString(entry.name)
      if (!id || !title) return null

      const from = asString(entry.scheduled_for)
      const until = asString(entry.scheduled_until)

      return {
        id,
        title,
        status: asString(entry.status) ?? 'investigating',
        impact: asImpact(entry.impact, scheduled),
        startedAt: asString(entry.started_at) ?? asString(entry.created_at) ?? '',
        updates: mapUpdates(entry.incident_updates),
        // `components` arrives as full objects rather than ids, so the region
        // each one belongs to is one lookup away and needs no second request.
        regionIds: [
          ...new Set(
            (Array.isArray(entry.components) ? (entry.components as WireComponent[]) : [])
              .map((component) => {
                const componentId = asString(component.id)
                if (!componentId) return null
                // An incident can name a group directly as well as a leaf.
                if (knownRegions.has(componentId)) return componentId
                return regionOfComponent.get(componentId) ?? null
              })
              .filter((value): value is string => value !== null)
          )
        ],
        window: from && until ? { from, until } : null
      } satisfies StatusIncident
    })
    .filter((incident): incident is StatusIncident => incident !== null)
}

function mapUpdates(raw: unknown): StatusIncidentUpdate[] {
  if (!Array.isArray(raw)) return []

  return (raw as WireIncidentUpdate[])
    .map((entry) => {
      const id = asString(entry.id)
      const body = asString(entry.body)
      if (!id || !body) return null
      return {
        id,
        status: asString(entry.status) ?? '',
        body,
        at: asString(entry.display_at) ?? asString(entry.created_at) ?? ''
      } satisfies StatusIncidentUpdate
    })
    .filter((update): update is StatusIncidentUpdate => update !== null)
}

/**
 * Pulls a group name apart into region, GPU tier and partner flag.
 *
 * The four shapes that actually occur, and every one of them is load-bearing:
 *
 *   "Germany [RTX 5080]"              -> Germany, RTX 5080
 *   "Poland [RTX-5080]"               -> Poland, RTX 5080      (hyphen, not space)
 *   "France 2"                        -> France 2, null        (no suffix at all)
 *   "KR GFN1  - Alliance Partner"     -> KR GFN1, null, partner (double space)
 *
 * The tier is not part of the region's name — NVIDIA's own client calls the
 * region "Germany" — so it is lifted out rather than shown inline.
 */
export function splitGroupName(name: string): {
  label: string
  tier: string | null
  partner: boolean
} {
  const collapsed = name.replace(/\s+/g, ' ').trim()
  const partner = / - Alliance Partner$/.test(collapsed)
  const withoutPartner = collapsed.replace(/ - Alliance Partner$/, '')

  const tierMatch = /\s*\[([^\]]+)\]\s*$/.exec(withoutPartner)
  return {
    label: withoutPartner.replace(/\s*\[[^\]]+\]\s*$/, '').trim(),
    // "RTX-5080" is the same tier as "RTX 5080" and must not read as a second one.
    tier: tierMatch?.[1] ? tierMatch[1].replace(/-/g, ' ').replace(/\s+/g, ' ').trim() : null,
    partner
  }
}

/** Leaf names carry the same suffix: "NP-FRK-08 [RTX 5080]" -> "NP-FRK-08". */
export function stripTier(name: string): string {
  return name
    .replace(/\s+/g, ' ')
    .replace(/\s*\[[^\]]+\]\s*$/, '')
    .trim()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asHealth(value: unknown): ComponentHealth {
  return HEALTH_VALUES.includes(value as ComponentHealth) ? (value as ComponentHealth) : 'operational'
}

function asIndicator(value: unknown): PageIndicator {
  return INDICATOR_VALUES.includes(value as PageIndicator) ? (value as PageIndicator) : 'unknown'
}

function asImpact(value: unknown, scheduled: boolean): StatusIncident['impact'] {
  if (scheduled) return 'maintenance'
  const impacts = ['none', 'minor', 'major', 'critical'] as const
  return impacts.includes(value as (typeof impacts)[number])
    ? (value as StatusIncident['impact'])
    : 'none'
}
