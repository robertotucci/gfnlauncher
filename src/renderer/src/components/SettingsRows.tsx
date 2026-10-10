import { type ComponentType, type ReactNode } from 'react'
import { useFocusable } from '@/focus/SpatialFocus'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The furniture of a settings screen: rows, switches, chips and the card they
 * sit in.
 *
 * Shared by `SettingsScreen` and `StreamSettingsScreen` — the second is a page
 * of the first, and a page that looked or moved differently from the screen it
 * opens from would read as somebody else's. Moved here unchanged from
 * `SettingsScreen.tsx`, in the spirit of `SectionRule.tsx`.
 */

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
export function Row({
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
export type RowShell = Omit<Parameters<typeof Row>[0], 'children' | 'role' | 'checked'>

export function ActionRow({
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
export function SwitchIndicator({ checked }: { checked: boolean }): ReactNode {
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

export function ToggleRow({
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
 * One option in a row of mutually exclusive ones.
 *
 * Takes a whole focus id rather than building one from a prefix: ids are global
 * across scopes, so every row that uses this has to namespace its own.
 */
export function ChoiceChip({
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

export function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
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
