import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight, RefreshCw } from 'lucide-react'
import type {
  ChoiceRow,
  ClientSettingChange,
  ClientSettingsSnapshot,
  FieldId,
  SettingOption,
  SettingSection,
  StreamSummary
} from '@shared/clientSettings'
import type { LaunchMode } from '@shared/types'
import { useFocusable } from '@/focus/SpatialFocus'
import { SectionRule } from '@/components/SectionRule'
import { isBadge } from '@/components/SettingPicker'
import { ToggleRow } from '@/components/SettingsRows'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * GeForce NOW's own settings — the official app's Settings page — drawn so a
 * pad can reach it.
 *
 * ── What this screen is ─────────────────────────────────────────────────────
 *
 * A mirror, not a copy: every value is read from the client's own file and
 * every change is written straight into it. Main computes the whole page —
 * rows, options, and the reason for every one that is off — and this component
 * draws it without deciding anything, the bargain `StatusScreen` makes.
 * Presentational like `DevicesScreen`: no `window.launcher` calls, every async
 * state arrives as a prop, and the picker is `App.tsx`'s to open.
 *
 * ── Its shape, and where it comes from ──────────────────────────────────────
 *
 * The same kind of page as Status: a nameplate that is the answer, then the
 * lists that are context. Here the answer is what the next game will stream
 * at — a resolution, a frame rate, a bit rate — set the way the datacenter
 * code is, in the mono face and larger than the page's own heading, because it
 * is the one thing somebody opening this page wants to know, and because it
 * changes on its own when the official app changes it, which is the whole
 * claim of the page made visible.
 *
 * Under it, the mode — five tiles, because it is the first decision and the one
 * that decides whether anything else applies — and then the settings in the
 * groups someone thinks about a stream in, under the same `SectionRule` heads
 * Status and Devices use. Each setting is one row with its value on the right:
 * A opens a list (`SettingPicker`) or flips a switch. That keeps a page of
 * twenty-odd settings readable at three metres, where the chips it used to be
 * were walls of seventy.
 */

/** The landing target: always mounted, even before the first answer. See `App.tsx`. */
export const STREAM_LANDING_ID = 'stream:refresh'

/** Focus ids are global across scopes, so this page's carry their own prefix. */
export function streamFocusId(field: FieldId, part?: string): string {
  return part === undefined ? `stream:${field}` : `stream:${field}:${part}`
}

function asOf(iso: string | null, locale: string): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** `ULTIMATE` → `Ultimate`. An enum on the wire and a word on screen. */
function tierLabel(tier: string | null): string | null {
  if (!tier) return null
  return tier.charAt(0) + tier.slice(1).toLowerCase().replace(/_/g, ' ')
}

/**
 * The refresh control, in the header beside the title — the Status screen's,
 * and the landing target for the reason that one is: it is always there, and
 * asking NVIDIA again is a sensible first press.
 */
function RefreshButton({
  scope,
  busy,
  onRefresh,
  onFocused
}: {
  scope: string
  busy: boolean
  onRefresh: () => void
  /** Told when the cursor arrives. See `scrollToTop` in the screen. */
  onFocused: () => void
}): ReactNode {
  const confirm = (): void => {
    if (!busy) onRefresh()
  }
  const { ref, focused } = useFocusable<HTMLButtonElement>(STREAM_LANDING_ID, {
    scope,
    onConfirm: confirm
  })

  const latestFocused = useRef(onFocused)
  latestFocused.current = onFocused
  useEffect(() => {
    if (focused) latestFocused.current()
  }, [focused])

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

/** The label/value row of the Status nameplate — a spec sheet is what this is. */
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

function Notice({ children, tone }: { children: ReactNode; tone?: 'error' }): ReactNode {
  return (
    <p
      className={cn(
        'max-w-xl text-xs',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {children}
    </p>
  )
}

/**
 * The resolution as the headline figure: the two numbers carry it, and the ×
 * between them steps back. Set tight, without the spaces the label has — in
 * the mono face a space is a full figure wide, and at this size that opened a
 * hole either side of the ×.
 */
function Resolution({ value }: { value: string | null }): ReactNode {
  const [width, height] = (value ?? '').split(' × ')
  return (
    <p className="mt-4 font-mono text-[clamp(2.2rem,5vw,3.6rem)] leading-none font-semibold tracking-tight tabular-nums">
      {width}
      {height && (
        <>
          <span className="text-muted-foreground mx-[0.12em] font-normal">×</span>
          {height}
        </>
      )}
    </p>
  )
}

/**
 * The signature of the screen: what the next game will stream at.
 *
 * In Custom the launcher knows the figures and sets them large. In a preset it
 * does not — GeForce NOW fits the mode to the screen and the connection at
 * launch — so it names the mode and the ceiling the membership gave it, and
 * claims nothing more.
 */
function Nameplate({
  summary,
  tier,
  checked,
  membershipError,
  reset,
  launchMode
}: {
  summary: StreamSummary
  tier: string | null
  checked: string | null
  membershipError: string | null
  reset: string | null
  launchMode: LaunchMode
}): ReactNode {
  const custom = summary.mode === 'custom'

  return (
    <section className="border-border bg-card rounded-xl border px-8 py-7">
      <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
        Your next stream
      </p>

      {custom ? (
        <>
          <Resolution value={summary.resolution} />
          <p className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span>
              <span className="font-mono text-2xl font-semibold tabular-nums">{summary.fps}</span>
              <span className="text-muted-foreground ml-1.5 text-sm">fps</span>
            </span>
            {summary.bitrate === 'Auto' ? (
              <span className="text-2xl font-semibold">
                Auto
                <span className="text-muted-foreground ml-1.5 text-sm font-normal">bit rate</span>
              </span>
            ) : (
              <span>
                <span className="font-mono text-2xl font-semibold tabular-nums">
                  {summary.bitrate?.replace(' Mbps', '')}
                </span>
                <span className="text-muted-foreground ml-1.5 text-sm">Mbps</span>
              </span>
            )}
          </p>
        </>
      ) : (
        <>
          <p className="mt-4 text-[clamp(2.2rem,5vw,3.6rem)] leading-none font-semibold tracking-tight">
            {summary.modeLabel}
          </p>
          <p className="text-muted-foreground mt-3 max-w-xl text-sm">
            {summary.modeDescription}{' '}
            {summary.cap ? (
              <>
                GeForce NOW fits it to your screen and connection, up to{' '}
                <span className="text-foreground font-mono tabular-nums">
                  {summary.cap.resolution}
                </span>{' '}
                at{' '}
                <span className="text-foreground font-mono tabular-nums">
                  {summary.cap.fps} fps
                </span>
                .
              </>
            ) : (
              'GeForce NOW fits it to your screen and connection.'
            )}
          </p>
        </>
      )}

      <Separator className="my-6" />

      <dl className="flex flex-col gap-3">
        {custom && (
          <>
            <Fact label="Codec">{summary.codec}</Fact>
            <Fact label="Colour">{summary.colour}</Fact>
            <Fact label="HDR">{summary.hdr}</Fact>
            <Fact label="Data">
              {summary.dataPerHour === null ? (
                'Depends on the connection'
              ) : (
                <>
                  About <span className="font-mono tabular-nums">{summary.dataPerHour}</span> GB an
                  hour
                </>
              )}
            </Fact>
          </>
        )}
        <Fact label="Membership">
          {tier
            ? checked
              ? `${tier}, checked ${checked}`
              : tier
            : 'Not checked yet — Refresh asks NVIDIA what it allows'}
        </Fact>
      </dl>

      {/* Each of these is a case where the headline is true but incomplete,
          the Status nameplate's rule for when a notice belongs here. */}
      {(membershipError || reset || launchMode === 'web') && (
        <div className="mt-5 flex flex-col gap-2">
          {membershipError && <Notice tone="error">{membershipError}</Notice>}
          {reset && (
            <Notice>
              GeForce NOW reset the Custom settings at {reset}, most likely because one of them
              asked for more than your membership or this computer allows. It streams in Balanced
              until they are set again.
            </Notice>
          )}
          {launchMode === 'web' && (
            <Notice>
              Games start in the web player, which keeps its own settings. These apply when a game
              starts in the installed client.
            </Notice>
          )}
        </div>
      )}
    </section>
  )
}

/** One mode. A tile rather than a chip: it is the decision the rest depends on. */
function ModeTile({
  option,
  selected,
  scope,
  onSelect,
  onFocused
}: {
  option: SettingOption
  selected: boolean
  scope: string
  onSelect: () => void
  onFocused: () => void
}): ReactNode {
  const confirm = (): void => {
    if (option.enabled && !selected) onSelect()
  }
  const { ref, focused } = useFocusable<HTMLButtonElement>(streamFocusId('mode', option.id), {
    scope,
    onConfirm: confirm
  })

  const latestFocused = useRef(onFocused)
  latestFocused.current = onFocused
  useEffect(() => {
    if (focused) latestFocused.current()
  }, [focused])

  return (
    <button
      ref={ref}
      type="button"
      onClick={confirm}
      aria-pressed={selected}
      aria-disabled={!option.enabled || undefined}
      className={cn(
        'flex min-h-24 flex-col items-start rounded-md border px-4 py-3.5 text-left transition-colors duration-150',
        focused
          ? 'focus-ring border-primary bg-accent'
          : selected
            ? 'border-foreground/30 bg-accent'
            : 'border-border bg-card',
        !option.enabled && 'opacity-50'
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-sm font-semibold">{option.label}</span>
        {selected && <Check className="size-4 shrink-0" />}
      </span>
      <span className="text-muted-foreground mt-1.5 text-xs leading-snug">{option.detail}</span>
    </button>
  )
}

function ModeTiles({
  row,
  scope,
  onChange
}: {
  row: ChoiceRow
  scope: string
  onChange: (change: ClientSettingChange) => void
}): ReactNode {
  /** The tile under the cursor, so a dimmed one can say why it is dimmed. */
  const [hovered, setHovered] = useState<string | null>(null)
  const reason = row.options.find((o) => o.id === hovered && !o.enabled)?.reason ?? null

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-5 gap-2">
        {row.options.map((option) => (
          <ModeTile
            key={option.id}
            option={option}
            selected={option.id === row.selected}
            scope={scope}
            onSelect={() => onChange({ field: 'mode', value: option.id })}
            onFocused={() => setHovered(option.id)}
          />
        ))}
      </div>
      {/* Only a reason: the selected mode's own sentence is on the nameplate
          above, and a second copy here would be the page talking twice. */}
      {reason && <p className="text-muted-foreground px-4 text-xs">{reason}</p>}
    </div>
  )
}

/**
 * One setting with a list of values: the label and what it is for on the left,
 * the value in effect on the right, and A opens the list.
 *
 * The whole row is the control, the `Row` rule. A disabled one stays where it
 * is and reachable, and its second line says why instead of what it does —
 * the sentence that matters on a row that does nothing.
 */
function PickerRow({
  row,
  scope,
  quiet,
  onOpen
}: {
  row: ChoiceRow
  scope: string
  /** The group's rule already says why every row in it is off. See `Group`. */
  quiet: boolean
  onOpen: () => void
}): ReactNode {
  const disabled = row.disabledReason !== null
  const confirm = (): void => {
    if (!disabled) onOpen()
  }
  const { ref, focused } = useFocusable<HTMLButtonElement>(streamFocusId(row.field), {
    scope,
    onConfirm: confirm
  })
  const value = row.options.find((o) => o.id === row.selected) ?? null
  // A badge is worth reading beside the value ("4K"); a sentence is the
  // picker's to show.
  const badge = value?.detail && isBadge(value.detail) ? value.detail : null

  return (
    <button
      ref={ref}
      type="button"
      onClick={confirm}
      aria-haspopup="listbox"
      aria-disabled={disabled || undefined}
      className={cn(
        'flex w-full items-center justify-between gap-8 rounded-md px-4 py-3.5 text-left transition-colors duration-150',
        focused ? 'focus-ring bg-accent' : 'bg-transparent'
      )}
    >
      <span className={cn('min-w-0', disabled && 'opacity-60')}>
        <span className="block text-sm font-medium">{row.label}</span>
        <span className="text-muted-foreground mt-1 block text-xs">
          {quiet ? row.description : (row.disabledReason ?? row.description)}
        </span>
      </span>

      <span
        className={cn(
          'flex shrink-0 items-center gap-2',
          disabled ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        <span className={cn('text-sm', row.figures && 'font-mono tabular-nums')}>
          {value?.label ?? 'Not set'}
        </span>
        {badge && <span className="text-muted-foreground font-mono text-xs">{badge}</span>}
        <ChevronRight className={cn('size-4', disabled ? 'opacity-30' : 'text-muted-foreground')} />
      </span>
    </button>
  )
}

function Group({
  section,
  scope,
  busyField,
  fieldError,
  onChange,
  onOpenPicker
}: {
  section: SettingSection
  scope: string
  busyField: FieldId | null
  fieldError: { field: FieldId; message: string } | null
  onChange: (change: ClientSettingChange) => void
  onOpenPicker: (field: FieldId) => void
}): ReactNode {
  /**
   * In a preset, every row of a custom group is off for the same reason, and
   * the rule says it once — "used by Custom". Sixteen copies of the sentence
   * underneath would be the rule restated as noise, so the rows keep saying
   * what they are, dimmed, and the reason is where the group starts.
   */
  const quiet = section.note !== null
  return (
    <section className="flex flex-col gap-2">
      <SectionRule label={section.title} count={section.note ?? undefined} />
      <div className="flex flex-col">
        {section.rows.map((row) => (
          <div key={row.field}>
            {row.kind === 'choice' ? (
              <PickerRow
                row={row}
                scope={scope}
                quiet={quiet}
                onOpen={() => onOpenPicker(row.field)}
              />
            ) : (
              <ToggleRow
                id={streamFocusId(row.field)}
                scope={scope}
                label={row.label}
                description={quiet ? row.description : (row.disabledReason ?? row.description)}
                value={row.value}
                disabled={row.disabledReason !== null}
                onConfirm={() => onChange({ field: row.field, value: !row.value })}
              />
            )}
            {busyField === row.field && (
              <p className="text-muted-foreground px-4 pb-2 text-xs">Saving…</p>
            )}
            {fieldError?.field === row.field && (
              <p className="text-destructive px-4 pb-2 text-xs">{fieldError.message}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

export function StreamSettingsScreen({
  snapshot,
  scope,
  locale,
  launchMode,
  refreshing,
  busyField,
  fieldError,
  onChange,
  onOpenPicker,
  onRefresh
}: {
  /** Null until the first answer. */
  snapshot: ClientSettingsSnapshot | null
  scope: string
  /** BCP 47, for the "checked" date. */
  locale: string
  launchMode: LaunchMode
  refreshing: boolean
  /** A change in flight, so its row can say so. */
  busyField: FieldId | null
  /** The last change that did not land, and why. Shown under its row. */
  fieldError: { field: FieldId; message: string } | null
  onChange: (change: ClientSettingChange) => void
  onOpenPicker: (field: FieldId) => void
  onRefresh: () => void
}): ReactNode {
  const sections = snapshot?.sections ?? null
  const modeRow = sections?.find((s) => s.id === 'mode')?.rows[0]
  const scroller = useRef<HTMLDivElement>(null)

  /**
   * Arriving on Refresh takes the page back to the top.
   *
   * Refresh lives in the fixed header, so the cursor can reach it with the
   * list still scrolled — and the spatial model then sees the mode tiles,
   * scrolled away under the header, as further off than Refresh is, so Up from
   * the first setting skips them and nothing scrolls them back. Resetting the
   * list when the top control takes the cursor is what makes Down from there
   * land on the tiles again. Instant when the user asks for less motion.
   */
  const scrollToTop = (): void => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scroller.current?.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
  }
  const groups = sections?.filter((s) => s.id !== 'mode') ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* As wide as the column below, so Refresh sits over the right edge of
          the page it refreshes rather than out at the edge of the screen. */}
      <header className="shrink-0 px-10 pt-8 pb-6">
        <div className="flex max-w-3xl items-end justify-between gap-8">
          <div>
            <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
              GeForce NOW
            </p>
            <h1 className="mt-3 text-[clamp(1.9rem,3.4vw,2.75rem)] leading-none font-semibold tracking-tight">
              Streaming quality
            </h1>
          </div>
          <RefreshButton
            scope={scope}
            busy={refreshing}
            onRefresh={onRefresh}
            onFocused={scrollToTop}
          />
        </div>
      </header>

      {/* Padding plus a matching scroll-p: the focus ring is drawn outside the
          element, and scrolling into view would otherwise shear it off. */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto scroll-py-6 px-10 pt-1 pb-10">
        <div className="flex max-w-3xl flex-col gap-8">
          {!snapshot ? (
            <>
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-28 w-full" />
            </>
          ) : !snapshot.summary || !sections ? (
            <section className="border-border bg-card rounded-xl border px-8 py-7">
              <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
                Your next stream
              </p>
              <p className="text-muted-foreground mt-4 text-[clamp(1.6rem,3vw,2.2rem)] leading-none font-semibold tracking-tight">
                No settings to show
              </p>
              <p className="text-muted-foreground mt-4 max-w-lg text-sm">{snapshot.error}</p>
            </section>
          ) : (
            <>
              <Nameplate
                summary={snapshot.summary}
                tier={tierLabel(snapshot.tier)}
                checked={asOf(snapshot.entitlementsAsOf, locale)}
                membershipError={snapshot.entitlementsError}
                reset={asOf(snapshot.lastReset, locale)}
                launchMode={launchMode}
              />

              {modeRow?.kind === 'choice' && (
                <section className="flex flex-col gap-3">
                  <SectionRule label="Mode" />
                  <ModeTiles row={modeRow} scope={scope} onChange={onChange} />
                  {fieldError?.field === 'mode' && (
                    <p className="text-destructive px-4 text-xs">{fieldError.message}</p>
                  )}
                </section>
              )}

              {groups.map((section) => (
                <Group
                  key={section.id}
                  section={section}
                  scope={scope}
                  busyField={busyField}
                  fieldError={fieldError}
                  onChange={onChange}
                  onOpenPicker={onOpenPicker}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
