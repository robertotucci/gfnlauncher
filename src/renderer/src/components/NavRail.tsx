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

export type View = 'recent' | 'library' | 'catalog' | 'status' | 'settings' | 'support'

// Recent goes first because it is the shortest path back to what the user was
// already playing, which is the most likely reason the launcher is open at all.
// Navigation is geometric, not DOM-ordered, so the position is purely editorial.
const ITEMS: { id: View; label: string; Icon: typeof LayoutGrid }[] = [
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
  { id: 'support', label: 'Support', Icon: HandHeart }
]

function NavButton({
  id,
  label,
  Icon,
  active,
  scope,
  onSelect
}: {
  id: string
  label: string
  Icon: ComponentType<{ className?: string; strokeWidth?: number }>
  active: boolean
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
      <Icon
        className={cn(
          'size-6 transition-colors',
          focused || active ? 'text-foreground' : 'text-muted-foreground'
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
  onSelect: (view: View) => void
  onPower: () => void
}): ReactNode {
  return (
    <nav className="border-border/60 flex w-24 shrink-0 flex-col gap-1.5 border-r px-2 py-6">
      {ITEMS.map((item) => (
        <NavButton
          key={item.id}
          id={`nav:${item.id}`}
          label={item.label}
          Icon={item.Icon}
          active={view === item.id}
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
