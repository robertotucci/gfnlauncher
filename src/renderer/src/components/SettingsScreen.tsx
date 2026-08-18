import { type ComponentType, type ReactNode } from 'react'
import { ArrowUpCircle, ExternalLink, LogIn, LogOut, RefreshCw } from 'lucide-react'
import type { LaunchMode, LinkedProvider, Settings, UpdateStatus } from '@shared/types'
import {
  ACCENT_PRESETS,
  accentPreset,
  DEFAULT_ACCENT,
  DEFAULT_UI_SCALE,
  UI_SCALE_PRESETS
} from '@shared/theme'
import { useFocusable } from '@/focus/SpatialFocus'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * The shared shell for a settings row.
 *
 * Every row is a single focusable, and the whole row is the control. Nesting a
 * second interactive element inside would give the row two competing focus
 * models — which is why the Switch below is rendered inert.
 *
 * A `disabled` row stays registered and stays reachable. Dropping it would make
 * the geometry of the screen depend on state — the cursor would jump somewhere
 * different depending on whether the user happens to be signed in — and that is
 * worse than an inert row. What makes it diagnosable is the description, which
 * must say *why* it is off: on a screen with no keyboard, a control that
 * silently does nothing is the one failure nobody can explain.
 */
function Row({
  id,
  scope,
  label,
  description,
  onConfirm,
  disabled,
  role,
  checked,
  children
}: {
  id: string
  scope: string
  label: string
  description: string
  onConfirm: () => void
  disabled?: boolean
  role?: 'switch' | 'button'
  checked?: boolean
  children: ReactNode
}): ReactNode {
  const confirm = (): void => {
    if (!disabled) onConfirm()
  }
  const { ref, focused } = useFocusable<HTMLButtonElement>(id, { scope, onConfirm: confirm })

  return (
    <button
      ref={ref}
      type="button"
      role={role}
      aria-checked={role === 'switch' ? checked : undefined}
      aria-disabled={disabled || undefined}
      onClick={confirm}
      className={cn(
        'flex w-full items-center justify-between gap-8 rounded-md px-4 py-3.5 text-left transition-colors duration-150',
        focused ? 'focus-ring bg-accent' : 'bg-transparent',
        disabled && 'opacity-50'
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="text-muted-foreground mt-1 block text-xs">{description}</span>
      </span>
      <span className="flex shrink-0 items-center">{children}</span>
    </button>
  )
}

/** A settings row minus the parts each kind of row fills in for itself. */
type RowShell = Omit<Parameters<typeof Row>[0], 'children' | 'role' | 'checked'>

function ActionRow({
  icon: Icon,
  busy,
  ...row
}: RowShell & {
  icon: ComponentType<{ className?: string }>
  busy?: boolean
}): ReactNode {
  return (
    <Row {...row} role="button">
      <Icon className={cn('text-muted-foreground size-4', busy && 'animate-spin')} />
    </Row>
  )
}

/**
 * The switch, drawn rather than instantiated.
 *
 * It used to be the real shadcn `Switch`, rendered inert — which reads well
 * until you notice what it is: Radix's `Switch` is a `<button>`, and `Row` is a
 * `<button>`. Interactive content nested inside a button is invalid HTML, and
 * React says so out loud: two `console.error`s and a twenty-line component
 * stack, on every visit to this screen. Since `log.ts` tees the renderer's
 * console into the file the README asks people to attach to a bug report, the
 * cost was not a warning nobody sees — it was the launcher filling its own
 * one-megabyte log with a complaint about itself.
 *
 * So the indicator is spans, with the same geometry, the same tokens and the
 * same 150 ms transition as the component it replaces. Nothing is lost: the row
 * already carries `role="switch"` and `aria-checked`, the confirm is the row's,
 * and nothing in this interface ever takes real DOM focus.
 */
function SwitchIndicator({ checked }: { checked: boolean }): ReactNode {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-colors duration-150',
        checked ? 'bg-primary' : 'bg-input/80'
      )}
    >
      <span
        className={cn(
          'block size-4 rounded-full transition-transform duration-150',
          checked ? 'bg-primary-foreground translate-x-[calc(100%-2px)]' : 'bg-foreground translate-x-0'
        )}
      />
    </span>
  )
}

function ToggleRow({
  value,
  ...row
}: RowShell & {
  value: boolean
}): ReactNode {
  return (
    <Row {...row} role="switch" checked={value}>
      <SwitchIndicator checked={value} />
    </Row>
  )
}

/**
 * The accent swatches.
 *
 * Each is its own focusable, so left and right walk the row through the same
 * spatial model as everything else — no slider, no picker, no second input
 * idiom to learn.
 */
function AccentRow({ scope, value, onSelect }: {
  scope: string
  value: string
  onSelect: (id: string) => void
}): ReactNode {
  const active = accentPreset(value)

  return (
    <div className="px-4 py-3.5">
      <p className="text-sm font-medium">Accent colour</p>
      <p className="text-muted-foreground mt-1 text-xs">
        The only colour in the interface. It paints the focus ring, so pick one you can find from
        the sofa.
      </p>

      <div className="mt-3 flex items-center gap-2">
        {ACCENT_PRESETS.map((preset) => (
          <Swatch
            key={preset.id}
            scope={scope}
            preset={preset}
            selected={preset.id === value}
            onSelect={() => onSelect(preset.id)}
          />
        ))}
        <span className="text-muted-foreground ml-2 font-mono text-xs">{active.label}</span>
      </div>
    </div>
  )
}

function Swatch({
  scope,
  preset,
  selected,
  onSelect
}: {
  scope: string
  preset: (typeof ACCENT_PRESETS)[number]
  selected: boolean
  onSelect: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(`setting:accent:${preset.id}`, {
    scope,
    onConfirm: onSelect
  })

  return (
    <button
      ref={ref}
      type="button"
      aria-label={preset.label}
      aria-pressed={selected}
      onClick={onSelect}
      style={{ backgroundColor: preset.value }}
      className={cn(
        'size-7 rounded-full transition-transform duration-150',
        focused && 'focus-ring scale-110',
        // The selected swatch is marked even when the cursor is elsewhere,
        // otherwise leaving the row loses which one is actually on.
        !focused && selected && 'ring-foreground/60 ring-2 ring-offset-2 ring-offset-card'
      )}
    />
  )
}

/**
 * How large the interface is drawn.
 *
 * Same shape as the accent row for the same reason: one focusable per choice,
 * walked with left and right. The scale takes effect the moment a step is
 * confirmed, so the row is its own preview — which is also why it is a short
 * list of steps rather than a continuous control the user would have to nudge
 * repeatedly and watch reflow.
 */
function ScaleRow({ scope, value, onSelect }: {
  scope: string
  value: string
  onSelect: (id: string) => void
}): ReactNode {
  return (
    <div className="px-4 py-3.5">
      <p className="text-sm font-medium">Interface size</p>
      <p className="text-muted-foreground mt-1 text-xs">
        Zooms the whole launcher. Larger reads better from further away and shows fewer covers per
        row; it does not change the screen&rsquo;s resolution.
      </p>

      <div className="mt-3 flex items-center gap-2">
        {UI_SCALE_PRESETS.map((preset) => (
          <ChoiceChip
            key={preset.id}
            scope={scope}
            focusId={`setting:scale:${preset.id}`}
            label={preset.label}
            selected={preset.id === value}
            onSelect={() => onSelect(preset.id)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * One option in a row of mutually exclusive ones.
 *
 * Takes a whole focus id rather than building one from a prefix: ids are global
 * across scopes, so every row that uses this has to namespace its own.
 */
function ChoiceChip({
  scope,
  focusId,
  label,
  selected,
  onSelect
}: {
  scope: string
  focusId: string
  label: string
  selected: boolean
  onSelect: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(focusId, {
    scope,
    onConfirm: onSelect
  })

  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'shrink-0 rounded-md border px-3 py-1.5 font-mono text-xs tabular-nums transition-all duration-150',
        // Same three states as the genre chips: the cursor outranks a step that
        // merely happens to be the current one.
        focused
          ? 'focus-ring border-primary bg-primary text-primary-foreground scale-[1.04]'
          : selected
            ? 'border-foreground/25 bg-accent text-foreground'
            : 'border-border bg-card text-muted-foreground'
      )}
    >
      {label}
    </button>
  )
}

/** Labels and the one-line case for each launch mode. */
/**
 * Ordered with the default first and `auto` last: the two explicit modes always
 * do the one thing they name, and the convenience one is the only that can
 * surprise you.
 */
const LAUNCH_MODE_CHOICES: readonly { id: LaunchMode; label: string; hint: string }[] = [
  {
    id: 'native',
    label: 'Installed client',
    hint: 'Always uses the GeForce NOW Flatpak. A client already running is closed first — it ignores anything sent to it while it is up.'
  },
  {
    id: 'web',
    label: 'Web player',
    hint: 'Always streams in a launcher window, signed in with the account you linked here. A title sold on several stores will ask which one.'
  },
  {
    id: 'auto',
    label: 'Whichever is available',
    hint: 'Uses the installed client, and the web player when none is detected. Convenient, but a failed detection quietly moves you to the web player.'
  }
]

function LaunchModeRow({
  scope,
  value,
  gfnInstalled,
  gfnProbeError,
  onSelect
}: {
  scope: string
  value: LaunchMode
  gfnInstalled: boolean
  gfnProbeError: string | null
  onSelect: (mode: LaunchMode) => void
}): ReactNode {
  const active = LAUNCH_MODE_CHOICES.find((choice) => choice.id === value)

  return (
    <div className="px-4 py-3.5">
      <p className="text-sm font-medium">How games start</p>
      <p className="text-muted-foreground mt-1 text-xs">
        {active?.hint}
        {value === 'native' &&
          !gfnInstalled &&
          (gfnProbeError
            ? ' The sandbox cannot reach the client, so this will fail.'
            : ' The Flatpak is not installed, so this will fail.')}
      </p>

      <div className="mt-3 flex items-center gap-2">
        {LAUNCH_MODE_CHOICES.map((choice) => (
          <ChoiceChip
            key={choice.id}
            scope={scope}
            focusId={`setting:launchMode:${choice.id}`}
            label={choice.label}
            selected={choice.id === value}
            onSelect={() => onSelect(choice.id)}
          />
        ))}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-1.5">{children}</CardContent>
    </Card>
  )
}

export function SettingsScreen({
  settings,
  providers,
  scope,
  gfnInstalled,
  gfnVersion,
  gfnProbeError,
  gfnOpenError,
  refreshing,
  syncing,
  syncNotice,
  syncFailed,
  authenticated,
  signingIn,
  authError,
  update,
  updateChecking,
  appVersion,
  logPath,
  onUpdate,
  onRefreshCatalog,
  onSyncAll,
  onOpenGfn,
  onSignIn,
  onSignOut,
  onCheckUpdate,
  onShowUpdate
}: {
  settings: Settings | null
  providers: LinkedProvider[]
  scope: string
  gfnInstalled: boolean
  gfnVersion: string | null
  /**
   * Set only when the launcher was *stopped* from looking for the client rather
   * than finding none — a sandboxed build with the host permission revoked. It
   * is the difference between "GeForce NOW is not installed" and "I was not
   * allowed to check", and only one of those is something the user can act on.
   */
  gfnProbeError: string | null
  gfnOpenError: string | null
  refreshing: boolean
  syncing: boolean
  /** Outcome of the last sync, shown under the row. Null before the first one. */
  syncNotice: string | null
  syncFailed: boolean
  authenticated: boolean
  signingIn: boolean
  authError: string | null
  /** What the last update check found. Null before one has run. */
  update: UpdateStatus | null
  updateChecking: boolean
  /** This build's version, for the nameplate. Comes from the check. */
  appVersion: string | null
  /**
   * Absolute path of the launcher's log file, or null before main has answered.
   *
   * Printed rather than acted on. It is here because a bug report that opens
   * with "which file do I attach?" is one most people do not open at all, and
   * the path differs between the Flatpak and every other install form — so
   * telling someone to "look in the usual place" is not an answer either.
   */
  logPath: string | null
  onUpdate: (patch: Partial<Settings>) => void
  onRefreshCatalog: () => void
  onSyncAll: () => void
  onOpenGfn: () => void
  onSignIn: () => void
  onSignOut: () => void
  onCheckUpdate: () => void
  /** Re-opens the notice for an update already found — what "Not now" undoes. */
  onShowUpdate: () => void
}): ReactNode {
  if (!settings) {
    return (
      <div className="flex max-w-3xl flex-col gap-3 px-10 pt-2 pb-10">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const canSync = authenticated && providers.length > 0
  const hasUpdate = update?.available === true
  /** A check that ran, succeeded, and found nothing — not merely "no update yet". */
  const upToDate = update !== null && !update.available && update.error === null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-py-4 px-10 pt-3 pb-10">
      <div className="flex max-w-3xl flex-col gap-4">
        <Section title="Account">
          <ActionRow
            id="setting:auth"
            scope={scope}
            label={authenticated ? 'Sign out of GeForce NOW' : 'Sign in to GeForce NOW'}
            description={
              authenticated
                ? 'Your catalog and library come from this account.'
                : 'Opens the NVIDIA sign-in page. Leave it open after signing in — it closes by itself once the session is read.'
            }
            icon={authenticated ? LogOut : LogIn}
            busy={signingIn}
            onConfirm={authenticated ? onSignOut : onSignIn}
          />

          {authError && <p className="text-destructive px-4 pb-2 text-xs">{authError}</p>}

          <Separator className="my-1" />

          {providers.length === 0 ? (
            <p className="text-muted-foreground px-4 py-2 text-xs">
              {authenticated
                ? 'No stores connected yet. Link Steam, Epic, Ubisoft, EA, GOG or Xbox inside the GeForce NOW app — everything you own there that reaches the GFN catalog shows up in your library on its own.'
                : 'Sign in to see your connected stores.'}
            </p>
          ) : (
            <div className="flex flex-col">
              {providers.map((provider) => (
                <div
                  key={provider.id}
                  className="flex items-center justify-between px-4 py-2.5 text-sm"
                >
                  <span>{provider.label}</span>
                  <Badge variant="secondary" className="font-mono text-xs tabular-nums">
                    {/* "0 synced" on a store that never syncs reads as a fault
                        that never clears. Epic is the one people hit. */}
                    {provider.canSync ? `${provider.gamesSynced ?? 0} synced` : 'no sync'}
                  </Badge>
                </div>
              ))}
            </div>
          )}

          <Separator className="my-1" />

          <ActionRow
            id="setting:syncAll"
            scope={scope}
            label="Refresh every store library"
            description={
              canSync
                ? 'Asks each connected store to resync now instead of waiting for the periodic one, then reloads the catalog. Takes about half a minute.'
                : authenticated
                  ? 'Nothing to sync: no store is connected to this account yet.'
                  : 'Sign in first — syncing runs against your GeForce NOW account.'
            }
            icon={RefreshCw}
            busy={syncing}
            disabled={!canSync || syncing}
            onConfirm={onSyncAll}
          />

          {syncNotice && (
            <p
              className={cn(
                'px-4 pb-2 text-xs',
                syncFailed ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {syncNotice}
            </p>
          )}
        </Section>

        <Section title="Appearance">
          <AccentRow
            scope={scope}
            value={settings.accentColor ?? DEFAULT_ACCENT}
            onSelect={(accentColor) => onUpdate({ accentColor })}
          />
          <Separator className="my-1" />
          <ScaleRow
            scope={scope}
            value={settings.uiScale ?? DEFAULT_UI_SCALE}
            onSelect={(uiScale) => onUpdate({ uiScale })}
          />
        </Section>

        <Section title="Startup">
          <ToggleRow
            id="setting:autostart"
            scope={scope}
            label="Start with the desktop"
            description="Opens the launcher when the session begins, so the TV lands here."
            value={settings.autostart}
            onConfirm={() => onUpdate({ autostart: !settings.autostart })}
          />
          <Separator className="my-1" />
          <ToggleRow
            id="setting:fullscreen"
            scope={scope}
            label="Open fullscreen"
            // Not "applies next time": `settings:update` hands this straight to
            // `setFullscreen`, and it has to — there is no F11 on a sofa, so
            // this row is the only way a gamepad can put a launcher that ended
            // up windowed back to full screen. A description that told the user
            // to restart for it would hide the one control that fixes it.
            description="Takes the whole screen, now and on every start."
            value={settings.fullscreen}
            onConfirm={() => onUpdate({ fullscreen: !settings.fullscreen })}
          />
          <Separator className="my-1" />
          <LaunchModeRow
            scope={scope}
            value={settings.launchMode ?? 'native'}
            gfnInstalled={gfnInstalled}
            gfnProbeError={gfnProbeError}
            onSelect={(launchMode) => onUpdate({ launchMode })}
          />
        </Section>

        <Section title="Catalog">
          <ActionRow
            id="setting:refreshCatalog"
            scope={scope}
            // Signed out this really does fetch the whole catalog — it just
            // cannot know what you own. Saying so beats disabling a button that
            // works.
            label={authenticated ? 'Refresh the catalog' : 'Refresh the public catalog'}
            description={
              authenticated
                ? 'Pulls the current GeForce NOW title list, along with your library and what you own.'
                : 'Pulls the full GeForce NOW title list. Every title launches, but ownership and your library need a signed-in account.'
            }
            icon={RefreshCw}
            busy={refreshing}
            onConfirm={onRefreshCatalog}
          />
        </Section>

        <Section title="GeForce NOW client">
          <ActionRow
            id="setting:openGfn"
            scope={scope}
            label="Open the GeForce NOW app"
            description={
              gfnInstalled
                ? 'For the settings this launcher does not mirror — stream quality, connected accounts, controller mapping. They apply to the sessions started from here. The launcher steps aside, and coming back needs a mouse or keyboard.'
                : gfnProbeError
                  ? // Not "it is not installed": we never got to look. Saying the
                    // former would send the user to reinstall a client that is
                    // sitting right there.
                    'The client could not be reached from inside the Flatpak sandbox, so it cannot be opened from here.'
                  : 'The com.nvidia.geforcenow Flatpak is not installed, so there is nothing to open.'
            }
            icon={ExternalLink}
            disabled={!gfnInstalled}
            onConfirm={onOpenGfn}
          />

          {gfnOpenError && <p className="text-destructive px-4 pb-2 text-xs">{gfnOpenError}</p>}

          {gfnProbeError && <p className="text-destructive px-4 pb-2 text-xs">{gfnProbeError}</p>}

          <p className="text-muted-foreground px-4 pt-1 pb-2 font-mono text-xs">
            {gfnVersion
              ? `com.nvidia.geforcenow · v${gfnVersion}`
              : gfnProbeError
                ? 'GeForce NOW Flatpak not readable'
                : 'GeForce NOW Flatpak not detected'}
          </p>
        </Section>

        {/* Last, and directly under the client's version line: the two
            nameplates answer the same question about two different programs,
            and reading them together is how you tell which one is behind. */}
        <Section title="This launcher">
          <ToggleRow
            id="setting:updateCheck"
            scope={scope}
            label="Look for new versions"
            description="Asks GitHub once each time the launcher starts, and tells you when a release is newer than this one. Nothing is installed without you saying so."
            value={settings.updateCheck}
            onConfirm={() => onUpdate({ updateCheck: !settings.updateCheck })}
          />

          <Separator className="my-1" />

          <ActionRow
            id="setting:update"
            scope={scope}
            label={hasUpdate ? `Version ${update?.latestVersion} is available` : 'Check for updates'}
            description={
              hasUpdate
                ? // The notice carries the release notes and the install
                  // button; this row is the way back to it after "Not now".
                  'Opens the release notes and installs it from here, where this build can.'
                : updateChecking
                  ? 'Asking GitHub…'
                  : upToDate
                    ? 'This is the newest release. Checks again for one now.'
                    : 'Asks GitHub whether a newer launcher has been released.'
            }
            icon={hasUpdate ? ArrowUpCircle : RefreshCw}
            busy={updateChecking}
            disabled={updateChecking}
            onConfirm={hasUpdate ? onShowUpdate : onCheckUpdate}
          />

          {/* A failed check is a fact about the network, not about the version,
              so it goes under the row rather than into the label. */}
          {update?.error && (
            <p className="text-destructive px-4 pb-2 text-xs">{update.error}</p>
          )}

          <p className="text-muted-foreground px-4 pt-1 pb-2 font-mono text-xs">
            {appVersion ? `gfn-launcher · v${appVersion}` : 'gfn-launcher'}
            {update?.channel && update.channel !== 'unknown' && ` · ${update.channel}`}
          </p>

          {/* Directly under the nameplate, because the two are read together:
              the version says which build misbehaved and this says where the
              account of it is. Not focusable and not a control — there is
              nothing here to press, and the path is the whole message. */}
          {logPath && (
            <>
              <Separator className="my-1" />
              <div className="px-4 pt-2 pb-1">
                <p className="text-sm font-medium">Log file</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Attach this file when reporting a problem. Credentials are stripped from it
                  before anything is written, but it does contain file paths from this machine.
                </p>
                <p className="text-muted-foreground mt-2 font-mono text-xs break-all">
                  {logPath}
                </p>
              </div>
            </>
          )}
        </Section>
      </div>
    </div>
  )
}
