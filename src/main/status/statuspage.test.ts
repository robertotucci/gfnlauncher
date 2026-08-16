import { afterEach, describe, expect, it, vi } from 'vitest'
import { GfnApiError } from '../gfn/graphql'
import {
  STATUS_SUMMARY_URL,
  fetchSummary,
  mapSummary,
  splitGroupName,
  stripTier
} from './statuspage'

/**
 * A trimmed but faithful summary payload.
 *
 * `components` is deliberately shuffled — the real endpoint returns the global
 * component first, then every group's `position: 1` leaf, then the rest — so a
 * mapper that leans on array order rather than `group_id` fails here.
 */
function summary(): unknown {
  return {
    page: { id: '2bdwmtrb0hg9', name: 'NVIDIA GeForce NOW' },
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [
      { id: 'global', name: 'NVIDIA Global Services', status: 'operational', group: false },
      { id: 'frk-6', name: 'NP-FRK-06', status: 'operational', group: false, group_id: 'de' },
      { id: 'par-4', name: 'NP-PAR-04', status: 'major_outage', group: false, group_id: 'fr2' },
      {
        id: 'de',
        name: 'Germany [RTX 5080]',
        status: 'operational',
        group: true,
        group_id: null,
        components: ['frk-6', 'frk-8', 'de-storage']
      },
      { id: 'de-storage', name: 'Cloud Storage', status: 'operational', group: false, group_id: 'de' },
      {
        id: 'pl',
        name: 'Poland [RTX-5080]',
        status: 'degraded_performance',
        group: true,
        group_id: null,
        components: ['waw-1']
      },
      { id: 'frk-8', name: 'NP-FRK-08 [RTX 5080]', status: 'operational', group: false, group_id: 'de' },
      {
        id: 'fr2',
        name: 'France 2',
        status: 'major_outage',
        group: true,
        group_id: null,
        components: ['par-4']
      },
      { id: 'waw-1', name: 'NP-WAW-01 [RTX-5080]', status: 'degraded_performance', group: false, group_id: 'pl' },
      {
        id: 'kr',
        name: 'KR GFN1  - Alliance Partner',
        status: 'operational',
        group: true,
        group_id: null,
        components: ['sel-2']
      },
      { id: 'sel-2', name: 'NPA-GKR-SEL-02 [RTX 4080]', status: 'operational', group: false, group_id: 'kr' },
      { id: 'pl-storage', name: 'Cloud Storage', status: 'operational', group: false, group_id: 'pl' },
      // A group the page still lists but has emptied out.
      { id: 'ghost', name: 'Retired Region', status: 'operational', group: true, group_id: null, components: [] }
    ],
    incidents: [
      {
        id: 'open-1',
        name: 'Elevated latency in France',
        status: 'identified',
        impact: 'minor',
        started_at: '2026-08-14T10:00:00.000-07:00',
        incident_updates: [
          {
            id: 'u2',
            status: 'identified',
            body: 'We have identified the cause.',
            display_at: '2026-08-14T11:00:00.000-07:00'
          },
          {
            id: 'u1',
            status: 'investigating',
            body: 'We are investigating.',
            display_at: '2026-08-14T10:00:00.000-07:00'
          }
        ],
        components: [{ id: 'par-4', name: 'France 2 - NP-PAR-04' }]
      },
      {
        id: 'open-2',
        name: 'Fortnite performance mode issue',
        status: 'monitoring',
        impact: 'none',
        started_at: '2026-08-12T17:06:38.516-07:00',
        incident_updates: [],
        components: []
      },
      {
        id: 'done',
        name: 'Something that ended',
        status: 'resolved',
        impact: 'major',
        started_at: '2026-08-01T00:00:00.000-07:00',
        incident_updates: [],
        components: []
      }
    ],
    scheduled_maintenances: [
      {
        id: 'maint-1',
        name: 'Membership maintenance',
        status: 'scheduled',
        impact: 'maintenance',
        started_at: '2026-08-20T00:00:00.000-07:00',
        scheduled_for: '2026-08-20T23:00:00.000-07:00',
        scheduled_until: '2026-08-21T06:00:00.000-07:00',
        incident_updates: [],
        components: []
      },
      {
        id: 'maint-old',
        name: 'Already done',
        status: 'completed',
        impact: 'maintenance',
        started_at: '2025-01-12T23:00:00.000-08:00',
        incident_updates: [],
        components: []
      }
    ]
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('splitGroupName', () => {
  it('lifts the tier out of the region name', () => {
    expect(splitGroupName('Germany [RTX 5080]')).toEqual({
      label: 'Germany',
      tier: 'RTX 5080',
      partner: false
    })
  })

  it('reads a hyphenated tier as the same tier', () => {
    expect(splitGroupName('Poland [RTX-5080]').tier).toBe('RTX 5080')
  })

  it('leaves a trailing number alone when there is no suffix', () => {
    expect(splitGroupName('France 2')).toEqual({ label: 'France 2', tier: null, partner: false })
  })

  it('flags a partner region and collapses the double space in its name', () => {
    expect(splitGroupName('KR GFN1  - Alliance Partner')).toEqual({
      label: 'KR GFN1',
      tier: null,
      partner: true
    })
  })
})

describe('stripTier', () => {
  it('leaves a bare datacenter code untouched', () => {
    expect(stripTier('NP-FRK-06')).toBe('NP-FRK-06')
  })

  it('removes the suffix so the code matches what the client reports', () => {
    expect(stripTier('NP-FRK-08 [RTX 5080]')).toBe('NP-FRK-08')
  })
})

describe('mapSummary', () => {
  const feed = mapSummary(summary())

  it('takes the page line and indicator', () => {
    expect(feed.summary).toBe('All Systems Operational')
    expect(feed.indicator).toBe('none')
  })

  it('builds the tree from group_id rather than array order', () => {
    const germany = feed.regions.find((region) => region.id === 'de')
    expect(germany?.components.map((component) => component.name)).toEqual([
      'NP-FRK-06',
      'Cloud Storage',
      'NP-FRK-08'
    ])
  })

  it('drops the ungrouped global component', () => {
    const names = feed.regions.flatMap((region) => region.components.map((c) => c.id))
    expect(names).not.toContain('global')
  })

  it('drops a group with nothing left in it', () => {
    expect(feed.regions.map((region) => region.id)).not.toContain('ghost')
  })

  it('keeps same-named leaves apart by id', () => {
    const storage = feed.regions
      .flatMap((region) => region.components)
      .filter((component) => component.name === 'Cloud Storage')
    expect(storage.map((component) => component.id)).toEqual(['de-storage', 'pl-storage'])
  })

  it('takes the group rollup as Statuspage reports it, not from the children', () => {
    // Poland's leaves are degraded and its Cloud Storage is fine; the group
    // status is the page's own answer either way.
    expect(feed.regions.find((region) => region.id === 'pl')?.health).toBe('degraded_performance')
  })

  it('separates partner regions', () => {
    expect(feed.regions.find((region) => region.id === 'kr')?.partner).toBe(true)
    expect(feed.regions.find((region) => region.id === 'de')?.partner).toBe(false)
  })

  it('keeps only unresolved incidents', () => {
    expect(feed.incidents.map((incident) => incident.id)).toEqual(['open-1', 'open-2'])
  })

  it('maps an incident onto the region its component belongs to', () => {
    expect(feed.incidents[0]?.regionIds).toEqual(['fr2'])
  })

  it('leaves regionIds empty for a game-specific incident', () => {
    expect(feed.incidents[1]?.regionIds).toEqual([])
  })

  it('keeps incident updates newest first', () => {
    expect(feed.incidents[0]?.updates.map((update) => update.id)).toEqual(['u2', 'u1'])
  })

  it('keeps only maintenance that has not finished, with its window', () => {
    expect(feed.maintenance.map((entry) => entry.id)).toEqual(['maint-1'])
    expect(feed.maintenance[0]?.window).toEqual({
      from: '2026-08-20T23:00:00.000-07:00',
      until: '2026-08-21T06:00:00.000-07:00'
    })
  })

  it('survives a payload that is nothing like the real one', () => {
    expect(mapSummary(null).regions).toEqual([])
    expect(mapSummary({ components: 'not an array' }).indicator).toBe('unknown')
  })
})

describe('fetchSummary', () => {
  it('asks the summary endpoint and maps what comes back', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ etag: 'W/"abc"' }),
          json: async () => summary()
        }) as unknown as Response
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchSummary(null)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(STATUS_SUMMARY_URL)
    expect(result.notModified).toBe(false)
    expect(result.etag).toBe('W/"abc"')
    expect(result.feed?.regions.length).toBeGreaterThan(0)
  })

  it('sends If-None-Match when it has an etag, and takes 304 for an answer', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({ ok: false, status: 304, headers: new Headers() }) as unknown as Response
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchSummary('W/"abc"')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'If-None-Match': 'W/"abc"' })
    expect(result).toEqual({ feed: null, notModified: true, etag: 'W/"abc"' })
  })

  it('reports a bad status rather than parsing the body as a board', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        ({
          ok: false,
          status: 503,
          headers: new Headers(),
          text: async () => 'upstream unavailable'
        }) as unknown as Response
    )

    await expect(fetchSummary(null)).rejects.toThrow(GfnApiError)
  })

  it('turns a timeout into something a person can read', async () => {
    vi.stubGlobal('fetch', async () => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    })

    await expect(fetchSummary(null)).rejects.toThrow(/did not respond in time/)
  })

  it('reports a network failure as one', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })

    await expect(fetchSummary(null)).rejects.toThrow(/ENOTFOUND/)
  })
})
