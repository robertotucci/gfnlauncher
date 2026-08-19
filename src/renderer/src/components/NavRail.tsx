import { type ComponentType, type ReactNode } from 'react'
import {
  Activity,
  Gamepad2,
  HandHeart,
  History,
  LayoutGrid,
  Power,
  Settings as SettingsIcon
} from 'lucide-react'
import { useFocusable } from '@/focus/SpatialFocus'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

/**
 * `devices` is a view with no rail item, and the only one.
 *
 * It is reached from a Settings row and B goes back there, so it behaves like a
 * page of Settings rather than a destination of its own — which is also why the
 * rail keeps Settings marked while it is up. A seventh button was the obvious
 * alternative and does not fit: this rail has no overflow handling, and at 175%
 * interface scale the seven controls already here are taller than a 1080p
 * screen. Pairing a headset is a thing you do twice a year; it must not cost a
 * permanent slot in the one piece of chrome that is always on screen.
 */
export type View =
  | 'recent'
  | 'library'
  | 'catalog'
  | 'status'
  | 'settings'
  | 'devices'
  | 'support'

// Recent goes first because it is the shortest path back to what the user was
// already playing, which is the most likely reason the launcher is open at all.
// Navigation is geometric, not DOM-ordered, so the position is purely editorial.
/** Only the views that have a button. `devices` deliberately has none. */
type RailView = Exclude<View, 'devices'>

const ITEMS: { id: RailView; label: string; Icon: typeof LayoutGrid; tint?: string }[] = [
  { id: 'recent', label: 'Recent', Icon: History },
  { id: 'library', label: 'Library', Icon: Gamepad2 },
  { id: 'catalog', label: 'Catalog', Icon: LayoutGrid },
  // Status sits between the games and the preferences because it is neither:
  // it is the thing you check when a stream misbehaves, on the way to deciding
  // whether the fault is yours.
  { id: 'status', label: 'Status', Icon: Activity },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
  // Last, because it is the only destination that asks the user for something
  // rather than offering them something, and it should never be on the way to
  // anywhere. A hand rather than a bare heart: in a rail that sits beside a
  // games library, a heart reads as "favourites".
  //
  // The one item in the rail that carries a hue, and a deep red rather than the
  // bright `--destructive` one so it never reads as a fault. It is the single
  // thing here the launcher is asking *for*, and the colour is what separates it
  // from six grey destinations without a word of copy.
  { id: 'support', label: 'Support', Icon: HandHeart, tint: 'text-support' }
]

function NavButton({
  id,
  label,
  Icon,
  active,
  tint,
  scope,
  onSelect
}: {
  id: string
  label: string
  Icon: ComponentType<{ className?: string; strokeWidth?: number }>
  active: boolean
  /** A text colour the icon keeps in every state, or undefined for the grey. */
  tint?: string
  scope: string
  onSelect: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(id, { scope, onConfirm: onSelect })

  return (
    <button
      ref={ref}
      type="button"
      aria-current={active || undefined}
      onClick={onSelect}
      className={cn(
        'relative flex w-full flex-col items-center gap-1.5 rounded-md py-3.5 transition-colors duration-150',
        focused ? 'focus-ring bg-accent' : active && 'bg-accent/50'
      )}
    >
      {active && <span className="bg-primary absolute left-0 h-7 w-[3px] rounded-full" />}
      {/* A tinted icon holds its colour through focus and selection: the hue is
          what the item *is*, not a state it is in. The ring, the fill and the
          label brightening below still say where the cursor is. */}
      <Icon
        className={cn(
          'size-6 transition-colors',
          tint ?? (focused || active ? 'text-foreground' : 'text-muted-foreground')
        )}
        strokeWidth={1.75}
      />
      <span
        className={cn(
          'text-[0.6rem] font-medium tracking-widest uppercase',
          focused || active ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {label}
      </span>
    </button>
  )
}

/**
 * The rail holds the views, and — pinned to the bottom behind a rule —
 * the way out of the session.
 *
 * Power lives here rather than in Settings for the reason it does on a console:
 * turning the machine off is not a preference, it is the last thing you do
 * before putting the pad down. Bottom-anchored so it is never on the way to
 * anything else.
 */
export function NavRail({
  view,
  scope,
  onSelect,
  onPower
}: {
  view: View
  scope: string
  onSelect: (view: RailView) => void
  onPower: () => void
}): ReactNode {
  // Devices is a page of Settings that happens to fill the screen, so the rail
  // keeps naming where the user came from and where B will put them back.
  const marked: RailView = view === 'devices' ? 'settings' : view

  return (
    <nav className="border-border/60 flex w-24 shrink-0 flex-col gap-1.5 border-r px-2 py-6">
      {ITEMS.map((item) => (
        <NavButton
          key={item.id}
          id={`nav:${item.id}`}
          label={item.label}
          Icon={item.Icon}
          active={marked === item.id}
          tint={item.tint}
          scope={scope}
          onSelect={() => onSelect(item.id)}
        />
      ))}

      <Separator className="mt-auto mb-1.5" />

      <NavButton
        id="nav:power"
        label="Power"
        Icon={Power}
        active={false}
        scope={scope}
        onSelect={onPower}
      />
    </nav>
  )
}
