/**
 * Which datacenter the installed GeForce NOW client is set to stream from.
 *
 * This is the one thing the launcher can tell the user that NVIDIA's status
 * page cannot, and it needs no network and no account: the client persists its
 * own routing configuration to disk, and that file is readable from here.
 *
 *   ~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/sharedstorage.json
 *
 * The path looks incidental and is not: the Flatpak manifest declares
 * `persistent=.local/state` and unsets `XDG_STATE_HOME`, so the container's
 * state directory is bound there. (Note this is *not* the host-side
 * `~/.local/state/NVIDIA/GeForceNOW/`, which only holds the wrapper's log.)
 *
 * ── The reason this file is handled with tongs ──────────────────────────────
 *
 * `sharedstorage.json` also contains a live `accessToken`, a `clientToken`, an
 * `idToken` JWT carrying the user's email address, their NVIDIA user id, and
 * the machine's MAC address, LAN IP and router MAC. None of that has any
 * business leaving this module.
 *
 * So `parseZoneAssignment` reads exactly three subtrees and returns a narrow,
 * declared shape; the parsed root is never logged, never returned, and never
 * spread into anything. `zone.test.ts` asserts the returned object's keys
 * against a fixture that carries a session blob, which is the regression guard.
 * If you add a `console.log` here, log a field, never the object.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { StatusRegion, ZoneAssignment, ZoneStatus } from '@shared/types'

/**
 * Resolved as a function, not a module const: `homedir()` is cheap and this is
 * testable by monkeypatching neither.
 *
 * Exported for `clientWatch.ts`, which watches this exact path, in the same
 * spirit as `streamLogPath()` — one definition, so a watch cannot end up
 * pointed somewhere the reader is not.
 */
export function zoneStoragePath(): string {
  return join(
    homedir(),
    '.var',
    'app',
    'com.nvidia.geforcenow',
    '.local',
    'state',
    'NVIDIA',
    'GeForceNOW',
    'sharedstorage.json'
  )
}

/** The host every region's cloudmatch address sits under, and the suffix latency keys carry. */
const CLOUDMATCH_SUFFIX = '.cloudmatchbeta.nvidiagrid.net'

/** Nothing was readable, so say so rather than implying the user is on Auto by choice. */
const UNKNOWN: ZoneAssignment = {
  routing: 'auto',
  regionName: null,
  zoneCode: null,
  zoneCurrent: false,
  latencyMs: null,
  error: null
}

/**
 * Pulls the routing configuration out of the client's storage blob.
 *
 * Pure and deliberately tolerant: this is a third-party file that changes shape
 * between client releases, and a wrong guess must yield nulls rather than throw
 * or — worse — hand a half-read value to the UI as fact.
 *
 * The one semantic worth knowing: **`routingOverride` present means the user
 * pinned a region; absent means Auto.** That is not inferred from the data, it
 * is what NVIDIA's own code does — `selectAuto()` in
 * `server-location-info.service.ts` deletes the key outright. Their unminified
 * TypeScript ships in the sourcemaps at `<installPath>/files/mall/*.js.map`.
 */
export function parseZoneAssignment(raw: unknown): ZoneAssignment {
  const root = asRecord(raw)
  if (!root) return { ...UNKNOWN }

  const network = asRecord(root.networkConfig)
  const override = asRecord(network?.routingOverride)
  const metaData = asRecord(asRecord(root.remoteOverrides)?.metaData)

  const pinned = override !== null
  const zoneCode = asString(metaData?.zoneName)
  const lastRegionSlug = asString(metaData?.regionName)

  // "eu-germany.cloudmatchbeta.nvidiagrid.net" -> "eu-germany". The slug is what
  // the latency table is keyed on, and what tells us whether the pin has moved
  // since the last session.
  const pinnedSlug = asString(override?.address)?.split('.')[0] ?? null
  const activeSlug = pinnedSlug ?? lastRegionSlug

  return {
    routing: pinned ? 'pinned' : 'auto',
    // On Auto the client stores only a slug; the display name is resolved from
    // the matched region instead, which avoids inventing a slug→name table.
    regionName: asString(override?.name),
    zoneCode,
    // Re-pinning does not clear the last session's zone, so a pin that no longer
    // agrees with it leaves `zoneCode` pointing at the region the user just left.
    zoneCurrent: zoneCode !== null && (!pinned || pinnedSlug === lastRegionSlug),
    latencyMs: readLatency(network, activeSlug),
    error: null
  }
}

/**
 * GFN's own measured round-trip for a region, in ms.
 *
 * `networks` holds two entries per fingerprint — the bare `<fp>` carries
 * `zonesLatencies`, a sibling `<fp>_<host>` carries a single network-test
 * result — so it has to be read through `currentFingerPrint`. Taking the first
 * entry picks the wrong one about half the time.
 */
function readLatency(network: Record<string, unknown> | null, slug: string | null): number | null {
  if (!network || !slug) return null

  const fingerprint = asString(network.currentFingerPrint)
  if (!fingerprint) return null

  const latencies = asRecord(asRecord(asRecord(network.networks)?.[fingerprint])?.zonesLatencies)
  // Stored as strings: "12", not 12. Guarded before the cast because
  // `Number(null)` is 0, and a missing measurement rendering as "0 ms" would be
  // a lie that looks like a very good connection.
  const raw = asString(latencies?.[`latency@${slug}${CLOUDMATCH_SUFFIX}`])
  if (raw === null) return null

  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Reads the client's routing configuration off disk.
 *
 * Not memoised, unlike `readAlsServerUrl`: the user can change their server
 * location in the GFN app while the launcher is running, and a status screen
 * that keeps reporting the region they just moved away from is worse than one
 * that costs a 13 KB file read per refresh.
 */
export async function readZoneAssignment(): Promise<ZoneAssignment> {
  let raw: string
  try {
    raw = await readFile(zoneStoragePath(), 'utf8')
  } catch {
    return {
      ...UNKNOWN,
      error: 'GeForce NOW has not been set up on this machine yet.'
    }
  }

  try {
    return parseZoneAssignment(JSON.parse(raw))
  } catch {
    // Deliberately does not include the parse error: the message would quote
    // the file, and the file has tokens in it.
    return { ...UNKNOWN, error: 'The GeForce NOW client configuration could not be read.' }
  }
}

/**
 * Matches the client's zone onto the fleet.
 *
 * Network-free by design. `zoneName` from the client is *already* the
 * Statuspage leaf name — the client says `NP-FRK-08` and the status page calls
 * that component `NP-FRK-08 [RTX 5080]` — so the primary match is exact string
 * work rather than a name-normalisation guess or a second API call.
 *
 * (`prod/v2/serverInfo` would resolve an Auto region authoritatively and needs
 * no auth. It is not on this path: it only earns a request when there is no
 * `zoneName` at all, and in that case the honest answer is "stream once and
 * we'll know" rather than a region guess. See docs/gfn-api.md.)
 */
export function resolveZone(assignment: ZoneAssignment, regions: StatusRegion[]): ZoneStatus {
  // A zone code from before the user re-pinned describes the old region, so
  // matching on it would confidently show the wrong datacenter.
  if (assignment.zoneCurrent && assignment.zoneCode) {
    const code = assignment.zoneCode
    for (const region of regions) {
      // Datacenter codes are globally unique, and the only thing that ever
      // follows one is the tier suffix — which `stripTier` has already removed,
      // leaving an exact compare. ("Cloud Storage", the one repeated leaf name,
      // is never a zone code.)
      const component = region.components.find((entry) => entry.name === code)
      if (component) return { assignment, region, component }
    }
  }

  // Falling back to the region name: pinned users always have one, and it
  // matches a group name once both sides are normalised.
  if (assignment.regionName) {
    const needle = normaliseRegion(assignment.regionName)
    const region = regions.find((entry) => normaliseRegion(entry.name) === needle)
    if (region) return { assignment, region, component: null }
  }

  return { assignment, region: null, component: null }
}

/**
 * Whether two resolutions describe the same thing.
 *
 * Load-bearing rather than cosmetic, and the reason is what else lives in
 * `sharedstorage.json`: the client rewrites that file to rotate a token, bump a
 * telemetry counter or record a consent, none of which is a routing change. A
 * watcher that pushed on every write would push several times an hour and say
 * nothing. This is the comparison that turns "the file moved" into "the
 * datacenter moved".
 *
 * Not deep equality. `region` and `component` are references *into* the cached
 * status feed, so their identity is `id` and `name` — stringifying a
 * `StatusRegion` with its component array on every stat tick would cost more
 * than the read that produced it.
 */
export function sameZone(previous: ZoneStatus | null, next: ZoneStatus): boolean {
  if (previous === null) return false

  const before = previous.assignment
  const after = next.assignment

  return (
    before.routing === after.routing &&
    before.regionName === after.regionName &&
    before.zoneCode === after.zoneCode &&
    before.zoneCurrent === after.zoneCurrent &&
    before.latencyMs === after.latencyMs &&
    before.error === after.error &&
    // The match itself can move without the assignment moving: an unchanged
    // zone code resolves to nothing until the fleet arrives, and to a region
    // afterwards. That is a different nameplate, so it is a different value.
    (previous.region?.id ?? null) === (next.region?.id ?? null) &&
    (previous.component?.name ?? null) === (next.component?.name ?? null)
  )
}

/** Casefold and collapse, so spacing and case cannot decide a match. */
function normaliseRegion(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
