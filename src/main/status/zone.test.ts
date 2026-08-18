import { describe, expect, it } from 'vitest'
import type { StatusRegion } from '@shared/types'
import { parseZoneAssignment, resolveZone, sameZone } from './zone'

const FINGERPRINT = 'c847d04d0e8c3424284f8e9b0b680d3f42b050c0'

/**
 * A `sharedstorage.json` shaped like the real one — **including the secrets**.
 *
 * The token blob and the network hardware details are not padding. They are
 * there so `does not carry anything else across` below is a real regression
 * guard: this file holds a live bearer token, a JWT with the user's email and
 * the machine's MAC address, and the whole point of `parseZoneAssignment` is
 * that none of it can leave.
 */
function storage(overrides: Record<string, unknown> = {}): unknown {
  return {
    starfleetSession: {
      data: 'eyJhY2Nlc3NUb2tlbiI6ICJzZWNyZXQiLCAiaWRUb2tlbiI6ICJqd3Qud2l0aC5lbWFpbCJ9'
    },
    userConsentInfo: { userId: '1234', externalUserId: 'abcd' },
    appSettingsConfig: {
      customProfile: { networkInfo: { macAddress: 'aa:bb:cc:dd:ee:ff', lanIp: '192.168.1.20' } }
    },
    gfnTelemetry: { clientVersion: '2.0.87.130' },
    networkConfig: {
      currentFingerPrint: FINGERPRINT,
      routingOverride: {
        address: 'eu-germany.cloudmatchbeta.nvidiagrid.net',
        defaultZone: 'prod.cloudmatchbeta.nvidiagrid.net',
        isInternal: false,
        name: 'Germany',
        runNetworkTest: false
      },
      networks: {
        [FINGERPRINT]: {
          zonesLatencies: {
            'latency@eu-germany.cloudmatchbeta.nvidiagrid.net': '12',
            'latency@eu-france-1.cloudmatchbeta.nvidiagrid.net': '36'
          }
        },
        // The sibling entry, which carries a single test result and no latency
        // table. Reading the first key rather than the fingerprint lands here.
        [`${FINGERPRINT}_eu-germany.cloudmatchbeta.nvidiagrid.net`]: {
          networkTestReturn: { testResult: { zoneName: 'NP-FRK-06', latency: 12 } }
        }
      }
    },
    remoteOverrides: {
      metaData: { regionName: 'eu-germany', zoneName: 'NP-FRK-08', lastFetchedAt: 1786830901735 }
    },
    ...overrides
  }
}

const REGIONS: StatusRegion[] = [
  {
    id: 'de',
    name: 'Germany',
    tier: 'RTX 5080',
    partner: false,
    health: 'operational',
    components: [
      { id: 'frk-6', name: 'NP-FRK-06', health: 'operational' },
      { id: 'frk-8', name: 'NP-FRK-08', health: 'degraded_performance' },
      { id: 'de-storage', name: 'Cloud Storage', health: 'operational' }
    ]
  },
  {
    id: 'fr1',
    name: 'France 1',
    tier: 'RTX 5080',
    partner: false,
    health: 'operational',
    components: [{ id: 'par-5', name: 'NP-PAR-05', health: 'operational' }]
  }
]

describe('parseZoneAssignment', () => {
  it('reads a pinned region, its zone and its latency', () => {
    expect(parseZoneAssignment(storage())).toEqual({
      routing: 'pinned',
      regionName: 'Germany',
      zoneCode: 'NP-FRK-08',
      zoneCurrent: true,
      latencyMs: 12,
      error: null
    })
  })

  it('does not carry anything else across', () => {
    // The guard that matters: a fixture full of tokens in, four facts out.
    expect(Object.keys(parseZoneAssignment(storage())).sort()).toEqual([
      'error',
      'latencyMs',
      'regionName',
      'routing',
      'zoneCode',
      'zoneCurrent'
    ])
    expect(JSON.stringify(parseZoneAssignment(storage()))).not.toContain('eyJ')
  })

  it('reads a missing routingOverride as Auto, which is what the client means by it', () => {
    const raw = storage() as { networkConfig: Record<string, unknown> }
    delete raw.networkConfig.routingOverride

    const assignment = parseZoneAssignment(raw)
    expect(assignment.routing).toBe('auto')
    expect(assignment.regionName).toBeNull()
    // Auto still knows where it last streamed from, and the latency table is
    // keyed on that slug rather than on a pin.
    expect(assignment.zoneCode).toBe('NP-FRK-08')
    expect(assignment.zoneCurrent).toBe(true)
    expect(assignment.latencyMs).toBe(12)
  })

  it('marks the zone stale when the pin moved after the last session', () => {
    const raw = storage() as { networkConfig: { routingOverride: Record<string, unknown> } }
    raw.networkConfig.routingOverride.address = 'eu-france-1.cloudmatchbeta.nvidiagrid.net'
    raw.networkConfig.routingOverride.name = 'France 1'

    const assignment = parseZoneAssignment(raw)
    expect(assignment.zoneCurrent).toBe(false)
    // The latency follows the new pin, not the old session.
    expect(assignment.latencyMs).toBe(36)
  })

  it('takes the latency table from the current fingerprint, not the first network', () => {
    const raw = storage() as { networkConfig: { currentFingerPrint: string } }
    raw.networkConfig.currentFingerPrint = 'a-fingerprint-with-no-entry'
    expect(parseZoneAssignment(raw).latencyMs).toBeNull()
  })

  it('reports no latency rather than NaN when the region was never tested', () => {
    const raw = storage() as {
      networkConfig: { networks: Record<string, { zonesLatencies?: unknown }> }
    }
    raw.networkConfig.networks[FINGERPRINT] = { zonesLatencies: {} }
    expect(parseZoneAssignment(raw).latencyMs).toBeNull()
  })

  it('returns nulls rather than throwing on something that is not the file', () => {
    for (const raw of [null, 'a string', 42, {}, { networkConfig: 'nope' }]) {
      expect(parseZoneAssignment(raw)).toEqual({
        routing: 'auto',
        regionName: null,
        zoneCode: null,
        zoneCurrent: false,
        latencyMs: null,
        error: null
      })
    }
  })
})

describe('resolveZone', () => {
  it('matches the zone code onto the exact datacenter', () => {
    const resolved = resolveZone(parseZoneAssignment(storage()), REGIONS)
    expect(resolved.region?.id).toBe('de')
    expect(resolved.component?.id).toBe('frk-8')
  })

  it('falls back to the region name when the zone is from the old pin', () => {
    const raw = storage() as { networkConfig: { routingOverride: Record<string, unknown> } }
    raw.networkConfig.routingOverride.address = 'eu-france-1.cloudmatchbeta.nvidiagrid.net'
    raw.networkConfig.routingOverride.name = 'France 1'

    const resolved = resolveZone(parseZoneAssignment(raw), REGIONS)
    expect(resolved.region?.id).toBe('fr1')
    // No leaf: the code on disk belongs to the region the user left.
    expect(resolved.component).toBeNull()
  })

  it('matches a region name regardless of case and spacing', () => {
    const resolved = resolveZone(
      {
        routing: 'pinned',
        regionName: '  germany ',
        zoneCode: null,
        zoneCurrent: false,
        latencyMs: null,
        error: null
      },
      REGIONS
    )
    expect(resolved.region?.id).toBe('de')
  })

  it('resolves nothing rather than guessing when the fleet does not list the region', () => {
    const resolved = resolveZone(
      {
        routing: 'pinned',
        regionName: 'Somewhere Else',
        zoneCode: 'NP-XXX-99',
        zoneCurrent: true,
        latencyMs: null,
        error: null
      },
      REGIONS
    )
    expect(resolved.region).toBeNull()
    expect(resolved.component).toBeNull()
    // The assignment still comes back: the nameplate has facts to show even
    // when the status page has no opinion about them.
    expect(resolved.assignment.zoneCode).toBe('NP-XXX-99')
  })

  it('resolves nothing when the fleet could not be fetched at all', () => {
    expect(resolveZone(parseZoneAssignment(storage()), []).region).toBeNull()
  })
})

describe('sameZone', () => {
  const resolved = (raw: unknown, regions = REGIONS): ReturnType<typeof resolveZone> =>
    resolveZone(parseZoneAssignment(raw), regions)

  it('reads a rewrite that did not touch the routing as no change at all', () => {
    // The guard the watcher exists on. The client rewrites this file to rotate
    // a token, bump a telemetry counter or record a consent — several times an
    // hour, none of it about the datacenter. Without this, every one of those
    // is a push to the renderer.
    const rotated = storage({
      starfleetSession: { data: 'ZXlKaFkyTmxjM05VYjJ0bGJpSTZJQ0p1WlhjaWZR' },
      gfnTelemetry: { clientVersion: '2.0.88.129' }
    })
    expect(sameZone(resolved(storage()), resolved(rotated))).toBe(true)
  })

  it('always pushes the first reading', () => {
    expect(sameZone(null, resolved(storage()))).toBe(false)
  })

  it('reads a re-pin as a change', () => {
    const raw = storage() as { networkConfig: { routingOverride: Record<string, unknown> } }
    raw.networkConfig.routingOverride.address = 'eu-france-1.cloudmatchbeta.nvidiagrid.net'
    raw.networkConfig.routingOverride.name = 'France 1'
    expect(sameZone(resolved(storage()), resolved(raw))).toBe(false)
  })

  it('reads a new zone code as a change', () => {
    const raw = storage() as { remoteOverrides: { metaData: Record<string, unknown> } }
    raw.remoteOverrides.metaData.zoneName = 'NP-FRK-06'
    expect(sameZone(resolved(storage()), resolved(raw))).toBe(false)
  })

  it('reads a re-measured latency as a change', () => {
    const raw = storage() as {
      networkConfig: { networks: Record<string, { zonesLatencies: Record<string, string> }> }
    }
    raw.networkConfig.networks[FINGERPRINT] = {
      zonesLatencies: { 'latency@eu-germany.cloudmatchbeta.nvidiagrid.net': '48' }
    }
    expect(sameZone(resolved(storage()), resolved(raw))).toBe(false)
  })

  it('reads the file becoming unreadable as a change', () => {
    const good = resolved(storage())
    const unreadable = {
      ...good,
      assignment: { ...good.assignment, error: 'The client config could not be read.' }
    }
    expect(sameZone(good, unreadable)).toBe(false)
  })

  it('reads the fleet arriving as a change, though the assignment never moved', () => {
    // Why the signature takes a `ZoneStatus` and not a `ZoneAssignment`: the
    // same six fields name no datacenter before the status feed lands and a
    // named one after, and that is a different nameplate.
    expect(sameZone(resolved(storage(), []), resolved(storage()))).toBe(false)
  })
})
