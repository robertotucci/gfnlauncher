import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import type { StatusIncident, StatusRegion, StatusSnapshot, ZoneStatus } from '@shared/types'
import {
  formatWindow,
  healthRank,
  INDICATOR_LABELS,
  isNotable,
  relativeTime
} from '@shared/status'
import { useFocusable } from '@/focus/SpatialFocus'
import { HealthMark, HEALTH_TEXT, type Health } from '@/components/HealthMark'
import { SectionRule } from '@/components/SectionRule'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Which datacenter GeForce NOW will stream from, and whether it is well.
 *
 * NVIDIA's own status page is a board of 113 components across 36 regions and
 * answers "is GeForce NOW up?". The question someone on a sofa is actually
 * asking is "is *my* box up?", and only the launcher can answer it, because
 * only the launcher can read the client's routing configuration off this disk.
 * So the nameplate is the page and the fleet is context around it — not the
 * other way round.
 *
 * Presentational, like `SettingsScreen`: no `window.launcher` calls, every
 * async state arrives as a prop. The one piece of state it does own is which
 * regions are expanded, which has no meaning outside this screen.
 */
export function StatusScreen({
  snapshot,
  loading,
  refreshing,
  scope,
  locale,
  onRefresh
}: {
  snapshot: StatusSnapshot | null
  loading: boolean
  refreshing: boolean
  scope: string
  locale: string
  onRefresh: () => void
}): ReactNode {
  const ownRegionId = snapshot?.zone.region?.id

  /**
   * Expansion, as overrides over a computed default rather than a seeded set.
   *
   * The default is "open if it is yours or if something is wrong with it", and
   * because it is recomputed rather than stored, a refresh that turns a region
   * red opens it on its own. An explicit collapse still wins, and survives the
   * refresh, because region ids are stable between fetches.
   */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const toggle = useCallback((id: string, fallback: boolean) => {
    setOverrides((current) => ({ ...current, [id]: !(current[id] ?? fallback) }))
  }, [])

  const { primary, partners } = useMemo(() => {
    const regions = snapshot?.regions ?? []
    return {
      primary: order(
        regions.filter((region) => !region.partner),
        ownRegionId
      ),
      partners: order(
        regions.filter((region) => region.partner),
        ownRegionId
      )
    }
  }, [snapshot?.regions, ownRegionId])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-end justify-between gap-8 px-10 pt-8 pb-6">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
            GeForce NOW
          </p>
          <h1 className="mt-3 text-[clamp(1.9rem,3.4vw,2.75rem)] leading-none font-semibold tracking-tight">
            Server status
          </h1>
        </div>
        <RefreshButton scope={scope} busy={refreshing} onRefresh={onRefresh} />
      </header>

      {/*
        Padding plus a matching `scroll-p-*`: the focus ring is drawn outside the
        element, and `scrollIntoView({ block: 'nearest' })` would otherwise park a
        focused row flush against the edge and shear the ring off.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-py-6 px-10 pt-1 pb-10">
        {/* Wider than the settings column: that one is a list of rows and reads
            better narrow, this is a board and a datacenter row carries four
            things across it. */}
        <div className="flex max-w-6xl flex-col gap-8">
          {loading && !snapshot ? (
            <>
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-32 w-full" />
            </>
          ) : (
            <>
              <Nameplate zone={snapshot?.zone ?? null} />

              <Overall snapshot={snapshot} />

              <Incidents
                heading="Open incidents"
                empty="No open incidents."
                incidents={snapshot?.incidents ?? []}
                regions={snapshot?.regions ?? []}
                idPrefix="status:incident"
                scope={scope}
                locale={locale}
                overrides={overrides}
                onToggle={toggle}
              />

              <Incidents
                heading="Scheduled maintenance"
                empty="Nothing scheduled."
                incidents={snapshot?.maintenance ?? []}
                regions={snapshot?.regions ?? []}
                idPrefix="status:maint"
                scope={scope}
                locale={locale}
                overrides={overrides}
                onToggle={toggle}
              />

              <section className="flex flex-col gap-2">
                <SectionRule label="Fleet" count={countLabel(primary.length, 'region')} />
                {primary.length === 0 ? (
                  <Notice>
                    {snapshot?.error ??
                      'The fleet list is unavailable. Press A on Refresh to try again.'}
                  </Notice>
                ) : (
                  primary.map((region) => (
                    <RegionRow
                      key={region.id}
                      region={region}
                      scope={scope}
                      own={region.id === ownRegionId}
                      open={overrides[region.id] ?? defaultOpen(region, ownRegionId)}
                      onToggle={() =>
                        toggle(region.id, defaultOpen(region, ownRegionId))
                      }
                    />
                  ))
                )}
              </section>

              {partners.length > 0 && (
                <section className="flex flex-col gap-2">
                  <SectionRule
                    label="Partner regions"
                    count={countLabel(partners.length, 'region')}
                  />
                  <p className="text-muted-foreground px-4 pb-1 text-xs">
                    Run by NVIDIA&apos;s partners and offered only in their territories.
                  </p>
                  {partners.map((region) => (
                    <RegionRow
                      key={region.id}
                      region={region}
                      scope={scope}
                      own={region.id === ownRegionId}
                      open={overrides[region.id] ?? defaultOpen(region, ownRegionId)}
                      onToggle={() => toggle(region.id, defaultOpen(region, ownRegionId))}
                    />
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The signature of the screen: the label on the machine your stream comes out of.
 *
 * The zone code is set larger than the view's own heading, in the mono face,
 * because it is the one fact this screen exists to deliver — and because the
 * codes are monospace artifacts to begin with. `NP-FRK-08` is an airport code
 * with a rack number on it; setting it in the body face would be dressing it up
 * as something it is not.
 */
function Nameplate({ zone }: { zone: ZoneStatus | null }): ReactNode {
  const assignment = zone?.assignment
  const health: Health = zone?.component?.health ?? zone?.region?.health ?? 'unknown'
  const code = assignment?.zoneCode ?? null
  const regionName = zone?.region?.name ?? assignment?.regionName ?? null

  return (
    <section className="border-border bg-card rounded-xl border px-8 py-7">
      <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
        Your datacenter
      </p>

      {code || regionName ? (
        <>
          <p className="mt-4 font-mono text-[clamp(2.2rem,5vw,3.6rem)] leading-none font-semibold tracking-tight">
            {code ?? regionName}
          </p>
          <HealthMark health={health} size="lg" label className="mt-4" />

          <Separator className="my-6" />

          <dl className="flex flex-col gap-3">
            <Fact label="Region">{regionName ?? 'Not resolved'}</Fact>
            <Fact label="Tier">{zone?.region?.tier ?? 'Not published'}</Fact>
            <Fact label="Routing">
              {assignment?.routing === 'pinned'
                ? `Pinned to ${assignment.regionName ?? 'a region'} in the GeForce NOW app`
                : 'Automatic — GeForce NOW picks the nearest region'}
            </Fact>
            <Fact label="Latency">
              {assignment?.latencyMs === null || assignment?.latencyMs === undefined ? (
                'Not measured yet'
              ) : (
                <span className="font-mono tabular-nums">{assignment.latencyMs} ms</span>
              )}
            </Fact>
          </dl>

          {/* Both of these are cases where the headline is true but incomplete,
              and saying nothing would let the user read it as more current than
              it is. */}
          {assignment?.zoneCurrent === false && code && (
            <Notice className="mt-5">
              You changed your server location after this session, so this
              datacenter is from the region you moved away from.
            </Notice>
          )}
          {!zone?.region && (
            <Notice className="mt-5">
              NVIDIA&apos;s status page does not list this region, so there is no
              health to report for it.
            </Notice>
          )}
        </>
      ) : (
        <>
          <p className="text-muted-foreground mt-4 text-[clamp(1.6rem,3vw,2.2rem)] leading-none font-semibold tracking-tight">
            No datacenter yet
          </p>
          <p className="text-muted-foreground mt-4 max-w-lg text-sm">
            {assignment?.error ??
              'Start a game once and GeForce NOW will record which datacenter it used.'}
          </p>
        </>
      )}
    </section>
  )
}

/** The page-level rollup, and when it was last checked. */
function Overall({ snapshot }: { snapshot: StatusSnapshot | null }): ReactNode {
  const indicator = snapshot?.indicator ?? 'unknown'
  const health = INDICATOR_HEALTH[indicator]

  return (
    <section className="flex items-center justify-between gap-6 px-4">
      <span className={cn('flex items-center gap-3', HEALTH_TEXT[health])}>
        <HealthMark health={health} size="md" />
        <span className="text-sm font-medium">
          {snapshot?.summary ?? INDICATOR_LABELS[indicator]}
        </span>
      </span>

      <span
        className={cn(
          'shrink-0 font-mono text-xs tabular-nums',
          snapshot?.error ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {/* Never hide the data, always date it: a board with a timestamp on it
            can be judged, one without cannot. */}
        {snapshot?.error
          ? snapshot.fetchedAt
            ? `Unreachable · last checked ${relativeTime(snapshot.fetchedAt, Date.now())}`
            : 'Could not reach status.geforcenow.com'
          : snapshot?.fetchedAt
            ? `Checked ${relativeTime(snapshot.fetchedAt, Date.now())}`
            : 'Not checked yet'}
      </span>
    </section>
  )
}

function Incidents({
  heading,
  empty,
  incidents,
  regions,
  idPrefix,
  scope,
  locale,
  overrides,
  onToggle
}: {
  heading: string
  empty: string
  incidents: StatusIncident[]
  regions: StatusRegion[]
  idPrefix: string
  scope: string
  locale: string
  overrides: Record<string, boolean>
  onToggle: (id: string, fallback: boolean) => void
}): ReactNode {
  return (
    <section className="flex flex-col gap-2">
      <SectionRule label={heading} count={incidents.length} />
      {incidents.length === 0 ? (
        <p className="text-muted-foreground px-4 py-1 text-sm">{empty}</p>
      ) : (
        incidents.map((incident) => {
          const id = `${idPrefix}:${incident.id}`
          return (
            <IncidentRow
              key={incident.id}
              id={id}
              incident={incident}
              regions={regions}
              scope={scope}
              locale={locale}
              open={overrides[id] ?? false}
              onToggle={() => onToggle(id, false)}
            />
          )
        })
      )}
    </section>
  )
}

/**
 * One incident, collapsed to its latest update.
 *
 * Collapsed still carries the newest update body, because that sentence is the
 * whole point of an incident and making the user press A to reach it would be
 * hiding the answer behind the question. Expanding adds the history.
 */
function IncidentRow({
  id,
  incident,
  regions,
  scope,
  locale,
  open,
  onToggle
}: {
  id: string
  incident: StatusIncident
  regions: StatusRegion[]
  scope: string
  locale: string
  open: boolean
  onToggle: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(id, { scope, onConfirm: onToggle })
  const latest = incident.updates[0]
  const affected = regions.filter((region) => incident.regionIds.includes(region.id))

  return (
    <div className="border-border bg-card rounded-lg border">
      <button
        ref={ref}
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          'flex w-full items-start gap-4 rounded-lg px-4 py-3.5 text-left transition-colors duration-150',
          focused ? 'focus-ring bg-accent' : 'bg-transparent'
        )}
      >
        <ChevronRight
          className={cn(
            'text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform duration-150',
            open && 'rotate-90'
          )}
        />

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium">{incident.title}</span>
            <span className="text-muted-foreground font-mono text-[0.65rem] tracking-widest uppercase">
              {incident.status.replace(/_/g, ' ')}
            </span>
          </span>

          {incident.window ? (
            <span className="text-muted-foreground mt-1.5 block font-mono text-xs tabular-nums">
              {formatWindow(incident.window.from, incident.window.until, locale)}
            </span>
          ) : (
            <span className="text-muted-foreground mt-1.5 block font-mono text-xs tabular-nums">
              Started {relativeTime(incident.startedAt, Date.now())}
            </span>
          )}

          {latest && !open && (
            <span className="text-muted-foreground mt-2 line-clamp-2 block text-xs">
              {latest.body}
            </span>
          )}

          {/* The ~80% of GeForce NOW incidents that name no component are about a
              single game, not a datacenter. Marking the ones that *do* touch a
              region is more useful than filtering the rest away. */}
          {affected.length > 0 && (
            <span className="mt-2 flex flex-wrap gap-1.5">
              {affected.map((region) => (
                <Badge key={region.id} variant="outline" className="font-mono text-[0.65rem]">
                  {region.name}
                </Badge>
              ))}
            </span>
          )}
        </span>
      </button>

      {open && incident.updates.length > 0 && (
        <ol className="animate-in fade-in slide-in-from-top-1 flex flex-col gap-4 px-4 pb-4 pl-12 duration-150">
          {incident.updates.map((update) => (
            <li key={update.id}>
              <p className="text-muted-foreground font-mono text-[0.65rem] tracking-widest uppercase">
                {update.status.replace(/_/g, ' ')} · {relativeTime(update.at, Date.now())}
              </p>
              <p className="mt-1.5 text-xs">{update.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function RegionRow({
  region,
  scope,
  own,
  open,
  onToggle
}: {
  region: StatusRegion
  scope: string
  own: boolean
  open: boolean
  onToggle: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(`status:region:${region.id}`, {
    scope,
    onConfirm: onToggle
  })

  return (
    <div>
      <button
        ref={ref}
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          'flex w-full items-center gap-4 rounded-md px-4 py-3 text-left transition-colors duration-150',
          focused ? 'focus-ring bg-accent' : 'bg-transparent'
        )}
      >
        <ChevronRight
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform duration-150',
            open && 'rotate-90'
          )}
        />

        <span className="min-w-0 flex-1 truncate text-sm font-medium">{region.name}</span>

        {/* The accent, on the one row out of thirty-six the user came here for.
            It is the same colour as the focus ring, so it only ever competes
            with the cursor when the cursor is already on this row. */}
        {own && (
          <Badge className="shrink-0 text-[0.65rem] tracking-wide uppercase">Yours</Badge>
        )}

        <span className="text-muted-foreground w-24 shrink-0 text-right font-mono text-xs">
          {region.tier ?? ''}
        </span>
        <span className="text-muted-foreground w-24 shrink-0 text-right font-mono text-xs tabular-nums">
          {countLabel(region.components.length, 'system')}
        </span>

        <HealthMark health={region.health} size="md" />
      </button>

      {open && (
        <div className="animate-in fade-in slide-in-from-top-1 flex flex-wrap gap-x-6 gap-y-2 px-4 pt-0.5 pb-3 pl-12 duration-150">
          {region.components.map((component) => (
            <span
              key={component.id}
              className={cn(
                'inline-flex items-center gap-2 font-mono text-xs',
                HEALTH_TEXT[component.health]
              )}
            >
              <HealthMark health={component.health} size="sm" />
              {component.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The one focusable above the fold, and the view's landing target.
 *
 * Arriving on the screen and pressing A re-checks, which is the most useful
 * thing the cursor's first resting place could do here. The nameplate and the
 * summary line below are deliberately not focusable: they are the answer, not
 * controls.
 */
function RefreshButton({
  scope,
  busy,
  onRefresh
}: {
  scope: string
  busy: boolean
  onRefresh: () => void
}): ReactNode {
  const confirm = (): void => {
    if (!busy) onRefresh()
  }
  const { ref, focused } = useFocusable<HTMLButtonElement>('status:refresh', {
    scope,
    onConfirm: confirm
  })

  return (
    <button
      ref={ref}
      type="button"
      onClick={confirm}
      aria-disabled={busy || undefined}
      className={cn(
        'flex shrink-0 items-center gap-2.5 rounded-md border px-4 py-2.5 text-sm font-medium transition-colors duration-150',
        focused
          ? 'focus-ring border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-muted-foreground'
      )}
    >
      <RefreshCw className={cn('size-4', busy && 'animate-spin')} />
      {busy ? 'Checking…' : 'Refresh'}
    </button>
  )
}

/** The label/value row from the details panel — a spec sheet is what this is. */
function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex gap-6">
      <dt className="text-muted-foreground w-28 shrink-0 text-xs tracking-widest uppercase">
        {label}
      </dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  )
}

function Notice({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <p className={cn('text-muted-foreground max-w-xl px-4 text-xs', className)}>{children}</p>
  )
}

/** Page indicators onto the same visual scale the components use. */
const INDICATOR_HEALTH: Record<StatusSnapshot['indicator'], Health> = {
  none: 'operational',
  minor: 'degraded_performance',
  major: 'partial_outage',
  critical: 'major_outage',
  maintenance: 'under_maintenance',
  unknown: 'unknown'
}

/** Yours first, then whatever is wrong, worst first, then the quiet majority. */
function order(regions: StatusRegion[], ownId: string | undefined): StatusRegion[] {
  const own = regions.filter((region) => region.id === ownId)
  const rest = regions.filter((region) => region.id !== ownId)
  return [
    ...own,
    ...rest
      .filter((region) => isNotable(region.health))
      .sort((a, b) => healthRank(b.health) - healthRank(a.health)),
    ...rest.filter((region) => !isNotable(region.health))
  ]
}

function defaultOpen(region: StatusRegion, ownId: string | undefined): boolean {
  return region.id === ownId || isNotable(region.health)
}

function countLabel(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}
