import { type ComponentType, type ReactNode } from 'react'
import {
  Bluetooth,
  BluetoothOff,
  BluetoothSearching,
  Computer,
  Gamepad2,
  Headphones,
  Keyboard,
  Loader2,
  Monitor,
  Mouse,
  Smartphone,
  Speaker
} from 'lucide-react'
import type { BluetoothDevice, BluetoothKind, BluetoothSnapshot } from '@shared/types'
import { signalBars, type BluetoothAction } from '@shared/bluetooth'
import type { PadFamily } from '@shared/padFamily'
import type { PadTransport } from '@shared/padLayout'
import type { PadInfo, PadNumbering } from '@/gamepad/translate'
import { useFocusable } from '@/focus/SpatialFocus'
import { SectionRule } from '@/components/SectionRule'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Pairing the hardware in the room.
 *
 * ── What this screen is ─────────────────────────────────────────────────────
 *
 * Two lists: what is already yours, and what is in the room. The second is
 * ordered by signal strength, and the four-tick meter beside each row is the
 * only quantitative mark on the page — which makes "the device in your hand is
 * at the top" true by construction rather than something the copy has to say.
 * It is the answer to the question this screen actually raises, which is which
 * of the three rows called *Wireless Controller* is the one you are holding.
 *
 * Battery is the other figure, and the two together are the whole of this
 * screen's personality; everything else is deliberately the same furniture as
 * Settings and Status. Both are set in the mono face and neither takes a hue —
 * the `--status-*` tokens belong to the status board and the accent belongs to
 * focus, so difference here is weight and fill.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 *
 * Any pairing of its own. BlueZ does all of it, over the same D-Bus API the
 * desktop's own panel uses, and what happens here shows up there and survives a
 * reboot. Presentational, like `SettingsScreen` and `StatusScreen`: no
 * `window.launcher` calls, every async state arrives as a prop.
 */

/** The scan control, and where the cursor lands on arrival. */
export const DEVICES_SCAN_ID = 'bt:scan'
/** The confirm button on the pairing band, so the parent can land focus on it. */
export const DEVICES_CONFIRM_ID = 'bt:confirm'

const DEVICE_PREFIX = 'bt:dev:'

/** Focus ids are global across scopes, so device rows carry their own prefix. */
export function deviceFocusId(address: string): string {
  return `${DEVICE_PREFIX}${address}`
}

/**
 * What A does on this row.
 *
 * Exported because the footer legend has to say the same word the press will
 * do, and a legend that reads "Pair" while A disconnects is worse than no
 * legend. One rule, read from two places, rather than two rules.
 */
export function primaryAction(device: BluetoothDevice): BluetoothAction {
  if (!device.paired) return 'pair'
  return device.connected ? 'disconnect' : 'connect'
}

export const ACTION_LABELS: Record<BluetoothAction, string> = {
  pair: 'Pair',
  connect: 'Connect',
  disconnect: 'Disconnect',
  forget: 'Forget'
}

/** The device the cursor is standing on, or null anywhere else on the screen. */
export function deviceFor(
  snapshot: BluetoothSnapshot | null,
  focusedId: string | null
): BluetoothDevice | null {
  if (!snapshot || !focusedId?.startsWith(DEVICE_PREFIX)) return null
  const address = focusedId.slice(DEVICE_PREFIX.length)
  return (
    [...snapshot.paired, ...snapshot.nearby].find((device) => device.address === address) ?? null
  )
}

const KIND_ICONS: Record<BluetoothKind, ComponentType<{ className?: string }>> = {
  gamepad: Gamepad2,
  headset: Headphones,
  headphones: Headphones,
  speaker: Speaker,
  keyboard: Keyboard,
  mouse: Mouse,
  phone: Smartphone,
  computer: Computer,
  display: Monitor,
  unknown: Bluetooth
}

/** What a row says about itself when it is not saying whether it is connected. */
const KIND_LABELS: Record<BluetoothKind, string> = {
  gamepad: 'Gamepad',
  headset: 'Headset',
  headphones: 'Headphones',
  speaker: 'Speaker',
  keyboard: 'Keyboard',
  mouse: 'Mouse',
  phone: 'Phone',
  computer: 'Computer',
  display: 'Display',
  unknown: 'Bluetooth device'
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Signal strength, in weight rather than in colour.
 *
 * Four ticks of rising height, filled from the left. An empty meter is a device
 * the adapter is not currently hearing — a paired headset that is switched off,
 * or something the scan found a minute ago and has lost since — which is a
 * different statement from one tick, and `signalBars` reserves zero for it.
 */
const TICK_HEIGHTS = ['h-1.5', 'h-2', 'h-2.5', 'h-3'] as const

function SignalMeter({ rssi }: { rssi: number | null }): ReactNode {
  const bars = signalBars(rssi)
  return (
    <span aria-hidden className="flex shrink-0 items-end gap-[2px]">
      {TICK_HEIGHTS.map((height, index) => (
        <span
          key={height}
          className={cn(
            'w-[3px] rounded-[1px]',
            height,
            index < bars ? 'bg-foreground/80' : 'bg-foreground/15'
          )}
        />
      ))}
    </span>
  )
}

/**
 * One device.
 *
 * A single focusable, and the whole row is the control — the same shape as a
 * Settings row, and for the same reason: a second interactive element nested
 * inside a `<button>` is invalid HTML that React complains about into the log
 * file people are asked to attach.
 *
 * The second line answers the question the row raises rather than repeating the
 * first. A paired device raises "is it on?", so it says whether it is
 * connected; a nearby one raises "what is it?", so it names the kind — which is
 * the only thing separating two unnamed rows from each other.
 */
function DeviceRow({
  device,
  scope,
  onActivate
}: {
  device: BluetoothDevice
  scope: string
  onActivate: () => void
}): ReactNode {
  const Icon = KIND_ICONS[device.kind]
  const confirm = (): void => {
    if (!device.busy) onActivate()
  }
  const { ref, focused } = useFocusable<HTMLButtonElement>(deviceFocusId(device.address), {
    scope,
    onConfirm: confirm
  })

  return (
    <button
      ref={ref}
      type="button"
      onClick={confirm}
      aria-disabled={device.busy || undefined}
      className={cn(
        'flex w-full items-center gap-4 rounded-md px-4 py-3.5 text-left transition-colors duration-150',
        focused ? 'focus-ring bg-accent' : 'bg-transparent',
        device.busy && 'opacity-60'
      )}
    >
      <Icon className="text-muted-foreground size-5 shrink-0" />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{device.name}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {device.paired
            ? device.connected
              ? 'Connected'
              : 'Paired, not connected'
            : KIND_LABELS[device.kind]}
        </span>
      </span>

      {device.battery !== null && (
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          {device.battery}%
        </span>
      )}

      {device.busy ? (
        <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
      ) : (
        <SignalMeter rssi={device.rssi} />
      )}
    </button>
  )
}

const FAMILY_LABELS: Record<PadFamily, string> = {
  xbox: 'Xbox',
  playstation: 'PlayStation',
  nintendo: 'Nintendo'
}

const TRANSPORT_LABELS: Record<PadTransport, string> = {
  usb: 'USB',
  bluetooth: 'Bluetooth',
  other: ''
}

/**
 * How the pad is being read, in the two cases where that is worth saying.
 *
 * Not four sentences: `standard` is the ordinary case and printing "normal" on
 * every row would bury the one row that is not. `assumed` is the whole reason
 * this section exists on a screen rather than only in the log — it is the fact
 * that explains a controller behaving oddly, and it was previously only
 * findable by someone who knew to grep for it.
 */
const NUMBERING_NOTES: Record<PadNumbering, string | null> = {
  standard: null,
  kernel: 'read with this pad’s own button numbering',
  assumed: 'button layout guessed, so some buttons may be wrong',
  ignored: 'not a controller, so the launcher does not read it'
}

/**
 * One connected controller.
 *
 * **Not focusable, and that is the design.** There is nothing to press: this is
 * the answer to "is the launcher seeing my pad, and how", which is a question
 * with no action attached. Registering it would put four unpressable stops in
 * the cursor's path on the way to the rows that do something.
 */
function PadRow({ pad }: { pad: PadInfo }): ReactNode {
  const note = NUMBERING_NOTES[pad.numbering]
  const transport = TRANSPORT_LABELS[pad.transport]

  return (
    <div className="flex w-full items-center gap-4 rounded-md px-4 py-3.5 text-left">
      <Gamepad2 className="text-muted-foreground size-5 shrink-0" />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{pad.name}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {pad.numbering === 'ignored'
            ? note
            : [`${FAMILY_LABELS[pad.family]} buttons`, note].filter(Boolean).join(' · ')}
        </span>
      </span>

      {transport && (
        <span className="text-muted-foreground shrink-0 font-mono text-xs">{transport}</span>
      )}
    </div>
  )
}

/** A row that is a control rather than a device — "Turn Bluetooth on". */
function ActionRow({
  id,
  scope,
  label,
  description,
  Icon,
  onConfirm
}: {
  id: string
  scope: string
  label: string
  description: string
  Icon: ComponentType<{ className?: string }>
  onConfirm: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(id, { scope, onConfirm })

  return (
    <button
      ref={ref}
      type="button"
      onClick={onConfirm}
      className={cn(
        'border-border flex w-full items-center gap-4 rounded-md border px-4 py-3 text-left transition-colors duration-150',
        focused ? 'focus-ring bg-accent' : 'bg-card'
      )}
    >
      <Icon className="text-muted-foreground size-5 shrink-0" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs">{description}</span>
      </span>
    </button>
  )
}

function ScanButton({
  scope,
  scanning,
  disabled,
  onScan
}: {
  scope: string
  scanning: boolean
  disabled: boolean
  onScan: (on: boolean) => void
}): ReactNode {
  const confirm = (): void => {
    if (!disabled) onScan(!scanning)
  }
  const { ref, focused } = useFocusable<HTMLButtonElement>(DEVICES_SCAN_ID, {
    scope,
    onConfirm: confirm
  })

  return (
    <button
      ref={ref}
      type="button"
      onClick={confirm}
      aria-disabled={disabled || undefined}
      className={cn(
        'flex shrink-0 items-center gap-2.5 rounded-md border px-4 py-2.5 text-sm font-medium transition-colors duration-150',
        focused
          ? 'focus-ring border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-muted-foreground',
        disabled && 'opacity-50'
      )}
    >
      {scanning ? (
        <BluetoothSearching className="size-4 animate-pulse" />
      ) : (
        <Bluetooth className="size-4" />
      )}
      {scanning ? 'Stop scanning' : 'Scan'}
    </button>
  )
}

/**
 * The confirmation BlueZ is holding a pairing open for.
 *
 * A band rather than a modal, which is a departure from how the launcher
 * handles Power and Update — and deliberate. Those two interrupt whatever was
 * on screen; this appears on a screen whose only subject it already is, lives
 * for a few seconds, and would otherwise cost a fourth focus scope and its own
 * open/close choreography to say the same thing in the same place.
 *
 * The code is set large and in the mono face for the reason the datacenter
 * nameplate is: it is the one fact the band exists to deliver, and six digits
 * have to be readable from the sofa against whatever is printed on a headset.
 */
function PairingBand({
  request,
  scope,
  onRespond
}: {
  request: NonNullable<BluetoothSnapshot['request']>
  scope: string
  onRespond: (accept: boolean) => void
}): ReactNode {
  return (
    <section className="border-border bg-card rounded-xl border px-8 py-7">
      <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
        {request.kind === 'confirm' ? 'Confirm the code' : 'Type this on the device'}
      </p>

      <p className="mt-4 font-mono text-[clamp(2rem,4.5vw,3.2rem)] leading-none font-semibold tracking-[0.2em] tabular-nums">
        {request.passkey}
      </p>

      <p className="text-muted-foreground mt-5 max-w-lg text-sm">
        {request.kind === 'confirm'
          ? `Check that ${request.name} is showing the same code, then confirm.`
          : `${request.name} is waiting for this code. Pairing finishes on its own once it is entered.`}
      </p>

      {request.kind === 'confirm' && (
        <div className="mt-5 flex gap-2">
          <ActionRow
            id={DEVICES_CONFIRM_ID}
            scope={scope}
            label="Codes match"
            description="Finishes the pairing."
            Icon={Bluetooth}
            onConfirm={() => onRespond(true)}
          />
          <ActionRow
            id="bt:cancel"
            scope={scope}
            label="They do not"
            description="Stops the pairing."
            Icon={BluetoothOff}
            onConfirm={() => onRespond(false)}
          />
        </div>
      )}
    </section>
  )
}

function Notice({ children }: { children: ReactNode }): ReactNode {
  return <p className="text-muted-foreground max-w-xl px-4 text-xs">{children}</p>
}

export function DevicesScreen({
  snapshot,
  pads,
  loading,
  scope,
  notice,
  onScan,
  onPower,
  onAct,
  onRespond
}: {
  snapshot: BluetoothSnapshot | null
  /**
   * The controllers connected right now, however they are attached.
   *
   * Not Bluetooth, and that is why it is a separate prop: a pad on a cable is
   * every bit as much "a device on this machine" as a paired headset, and the
   * question this section answers — is the launcher seeing it, and is it
   * reading it properly — is the same question for both.
   */
  pads: readonly PadInfo[]
  /** True until the first answer arrives; after that the screen never blanks. */
  loading: boolean
  scope: string
  /** What the last action had to say, or null. Not a fact about the adapter. */
  notice: string | null
  onScan: (on: boolean) => void
  onPower: (on: boolean) => void
  onAct: (action: BluetoothAction, address: string) => void
  onRespond: (accept: boolean) => void
}): ReactNode {
  const available = snapshot?.available === true
  const powered = snapshot?.powered === true

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-end justify-between gap-8 px-10 pt-8 pb-6">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
            Controllers and Bluetooth
          </p>
          <h1 className="mt-3 text-[clamp(1.9rem,3.4vw,2.75rem)] leading-none font-semibold tracking-tight">
            Devices
          </h1>
        </div>
        {/* Registered even when there is nothing to scan for: dropping it would
            leave the screen with no focusable at all on a machine with no
            radio, and a screen the cursor cannot enter is one B is the only way
            out of. Its own description says why it is inert. */}
        <ScanButton
          scope={scope}
          scanning={snapshot?.scanning === true}
          disabled={!available || !powered}
          onScan={onScan}
        />
      </header>

      {/* Padding plus a matching `scroll-p-*`: the focus ring is drawn outside
          the element, and `scrollIntoView({ block: 'nearest' })` would park a
          focused row flush against the edge and shear it off. */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-py-6 px-10 pt-1 pb-10">
        <div className="flex max-w-4xl flex-col gap-6">
          {/* The same shape as the two nameplates in Settings: a mono line
              naming a piece of infrastructure and the state it is in. */}
          <p className="text-muted-foreground px-4 font-mono text-xs">
            {!snapshot
              ? 'Looking for a Bluetooth adapter…'
              : !available
                ? 'No Bluetooth adapter'
                : `${powered ? 'Bluetooth on' : 'Bluetooth off'} · ${snapshot.adapterName ?? 'adapter'}`}
          </p>

          {/* A failed action, under the nameplate rather than in it: this is a
              fact about one press, not about the adapter. */}
          {notice && <p className="text-destructive px-4 text-xs">{notice}</p>}

          {/* Above everything Bluetooth, and outside the branches below it: a
              pad on a cable has nothing to do with the adapter, and on a
              machine with no radio at all this is the only section there is.
              Absent when there is none — an empty controller list on a screen
              about pairing says nothing anybody needed to read. */}
          {pads.length > 0 && (
            <section className="flex flex-col gap-2">
              <SectionRule label="Controllers" count={countLabel(pads.length, 'pad')} />
              {pads.map((pad) => (
                <PadRow key={pad.id} pad={pad} />
              ))}
            </section>
          )}

          {loading && !snapshot ? (
            <>
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </>
          ) : !available ? (
            <Notice>
              {snapshot?.error ??
                'This machine has no Bluetooth adapter, so there is nothing to pair from here.'}
            </Notice>
          ) : !powered ? (
            <>
              <ActionRow
                id="bt:power"
                scope={scope}
                label="Turn Bluetooth on"
                description="Switches the adapter on. Everything you have paired before reconnects on its own."
                Icon={Bluetooth}
                onConfirm={() => onPower(true)}
              />
              {snapshot?.error && <Notice>{snapshot.error}</Notice>}
            </>
          ) : (
            <>
              {snapshot?.request && (
                <PairingBand request={snapshot.request} scope={scope} onRespond={onRespond} />
              )}

              <section className="flex flex-col gap-2">
                <SectionRule
                  label="Paired"
                  count={countLabel(snapshot?.paired.length ?? 0, 'device')}
                />
                {snapshot && snapshot.paired.length > 0 ? (
                  snapshot.paired.map((device) => (
                    <DeviceRow
                      key={device.address}
                      device={device}
                      scope={scope}
                      onActivate={() => onAct(primaryAction(device), device.address)}
                    />
                  ))
                ) : (
                  <Notice>
                    Nothing paired yet. Anything you pair here is remembered by the system, so it
                    comes back on its own after a restart.
                  </Notice>
                )}
              </section>

              <section className="flex flex-col gap-2">
                <SectionRule label="Nearby" count={`${snapshot?.nearby.length ?? 0} found`} />
                {snapshot && snapshot.nearby.length > 0 ? (
                  snapshot.nearby.map((device) => (
                    <DeviceRow
                      key={device.address}
                      device={device}
                      scope={scope}
                      onActivate={() => onAct('pair', device.address)}
                    />
                  ))
                ) : (
                  <Notice>
                    {snapshot?.scanning
                      ? 'Searching. Put the device into pairing mode — usually a button held down until its light flashes.'
                      : 'Press A on Scan, then put the device into pairing mode — usually a button held down until its light flashes.'}
                  </Notice>
                )}
              </section>

              {/* Last, and quiet: it is the one thing on this screen that
                  cannot be worked out by pressing something. */}
              <Notice>
                Turning the launcher off does not unpair anything. Forgetting a device removes it
                from this computer entirely, and pairing it again starts from the beginning.
              </Notice>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
