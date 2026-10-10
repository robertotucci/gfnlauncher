import { Fragment, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { ChoiceRow, SettingOption } from '@shared/clientSettings'
import { useFocusable } from '@/focus/SpatialFocus'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/**
 * One setting's values, as a list to choose from.
 *
 * ── Why a list, and not chips on the row ────────────────────────────────────
 *
 * A row of chips works for the three-step choices on the Settings screen. It
 * stops working at the length GeForce NOW's own lists run to — twenty-four
 * resolutions, seventy languages, twenty bit rates — where a wall of chips is
 * something to walk across rather than read. A row that shows its value and
 * opens a list on A is what every console's settings do, and it gives each
 * value room for the second fact that decides it: what a bit rate costs per
 * hour, which badge a resolution goes by, and — for one the account cannot
 * have — why not.
 *
 * Same dialog, same rules as `PowerDialog`: Radix's focus handling is off,
 * because `SpatialFocus` never gives an element real DOM focus, and Escape is
 * left to the `back` intent so B and Escape close it through one code path.
 * `App.tsx` owns opening and closing, and hands focus back to the row.
 */

export const STREAM_PICKER_SCOPE = 'stream-picker'

/** Focus ids are global across scopes. */
export function pickerOptionId(field: string, optionId: string): string {
  return `picker:${field}:${optionId}`
}

/**
 * Where the cursor lands: the value in effect, or the first one that can be
 * chosen when the one in effect is not in the list at all.
 */
export function pickerLanding(row: ChoiceRow): string | null {
  const target =
    row.options.find((o) => o.id === row.selected) ??
    row.options.find((o) => o.enabled) ??
    row.options[0]
  return target ? pickerOptionId(row.field, target.id) : null
}

/** Short enough to be a badge rather than a phrase. Shared with the row's value. */
export function isBadge(detail: string): boolean {
  return detail.length <= 8
}

function OptionRow({
  field,
  option,
  selected,
  figures,
  onPick
}: {
  field: string
  option: SettingOption
  selected: boolean
  figures: boolean
  onPick: () => void
}): ReactNode {
  const confirm = (): void => {
    if (option.enabled) onPick()
  }
  const { ref, focused } = useFocusable<HTMLButtonElement>(pickerOptionId(field, option.id), {
    scope: STREAM_PICKER_SCOPE,
    onConfirm: confirm
  })

  return (
    <button
      ref={ref}
      type="button"
      onClick={confirm}
      aria-selected={selected}
      aria-disabled={!option.enabled || undefined}
      className={cn(
        'flex w-full items-center gap-4 rounded-md px-4 py-2.5 text-left transition-colors duration-150',
        focused ? 'focus-ring bg-accent' : 'bg-transparent'
      )}
    >
      {/* The mark is the state, and it holds its column whether or not it is
          drawn, so the labels line up down the list. */}
      <Check className={cn('size-4 shrink-0', selected ? 'text-foreground' : 'invisible')} />

      <span className={cn('min-w-0 flex-1', !option.enabled && 'opacity-50')}>
        <span
          className={cn(
            'block truncate text-sm',
            figures && 'font-mono tabular-nums',
            selected ? 'font-semibold' : 'font-medium'
          )}
        >
          {option.label}
        </span>
        {option.reason && (
          <span className="text-muted-foreground mt-0.5 block text-xs">{option.reason}</span>
        )}
      </span>

      {option.detail && (
        <span
          className={cn(
            'text-muted-foreground shrink-0 text-right text-xs',
            // A badge — "4K", "UW QHD" — is a figure and wears the mono face;
            // a phrase — what a bit rate costs, what a mode is for — does not.
            isBadge(option.detail) && 'font-mono',
            !option.enabled && 'opacity-50'
          )}
        >
          {option.detail}
        </span>
      )}
    </button>
  )
}

export function SettingPicker({
  row,
  closing,
  onPick,
  onClose
}: {
  row: ChoiceRow
  /** True while the exit animation plays; the parent unmounts after EXIT_MS. */
  closing: boolean
  onPick: (optionId: string) => void
  onClose: () => void
}): ReactNode {
  return (
    <Dialog open={!closing} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="flex max-h-[80vh] flex-col gap-4 duration-150 sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{row.label}</DialogTitle>
          <DialogDescription>{row.description}</DialogDescription>
        </DialogHeader>

        {/* Its own scroll container, with the padding and matching scroll-p the
            focus ring needs — see the Design section of ARCHITECTURE.md. */}
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto scroll-py-3 px-2 py-1">
          {row.options.map((option, index) => {
            const heading =
              option.group !== null && option.group !== row.options[index - 1]?.group
                ? option.group
                : null
            return (
              <Fragment key={option.id}>
                {heading && (
                  <p
                    className={cn(
                      'text-muted-foreground px-4 pb-1 font-mono text-xs tabular-nums',
                      index > 0 ? 'pt-4' : 'pt-1'
                    )}
                  >
                    {heading}
                  </p>
                )}
                <OptionRow
                  field={row.field}
                  option={option}
                  selected={option.id === row.selected}
                  figures={row.figures}
                  onPick={() => onPick(option.id)}
                />
              </Fragment>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
