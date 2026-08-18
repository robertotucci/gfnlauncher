import { type ComponentType, type ReactNode } from 'react'
import { Monitor, Moon, Power, RotateCcw, X } from 'lucide-react'
import type { PowerAction } from '@shared/types'
import { useFocusable } from '@/focus/SpatialFocus'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

export const POWER_SCOPE = 'power'

/** Focus id of the row the dialog should land on. */
export const POWER_FIRST_ID = 'power:suspend'

/**
 * Every entry here becomes an argument to `systemctl`, which is why "Back to
 * desktop" is rendered separately instead of joining the list: it ends nothing,
 * it has no logind verb, and a row that is not a `PowerAction` must not be able
 * to reach a table that is.
 */
const CHOICES: {
  action: PowerAction
  label: string
  description: string
  Icon: ComponentType<{ className?: string }>
}[] = [
  {
    action: 'suspend',
    label: 'Sleep',
    description: 'Stops the machine but keeps the session. Wakes in a couple of seconds.',
    Icon: Moon
  },
  {
    action: 'reboot',
    label: 'Restart',
    description: 'Closes everything and starts the desktop again.',
    Icon: RotateCcw
  },
  {
    action: 'poweroff',
    label: 'Turn off',
    description: 'Shuts the machine down completely.',
    Icon: Power
  }
]

function Choice({
  id,
  label,
  description,
  Icon,
  disabled,
  onRun
}: {
  id: string
  label: string
  description: string
  Icon: ComponentType<{ className?: string }>
  disabled: boolean
  onRun: () => void
}): ReactNode {
  const { ref, focused } = useFocusable<HTMLButtonElement>(id, {
    scope: POWER_SCOPE,
    onConfirm: () => {
      if (!disabled) onRun()
    }
  })

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onRun}
      className={cn(
        'border-border flex w-full items-center gap-4 rounded-md border px-4 py-3 text-left transition-colors duration-150 disabled:opacity-50',
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

/**
 * The way out of the session.
 *
 * A shadcn `Dialog`, but with everything Radix does about focus turned off:
 * `SpatialFocus` never gives an element real DOM focus, so an autofocus here
 * would move the browser's cursor somewhere the gamepad cursor is not. Escape
 * is left to the `back` intent for the same reason — B and Escape have to close
 * this the same way, through one code path.
 */
export function PowerDialog({
  closing,
  busy,
  error,
  onRun,
  onDesktop,
  onClose
}: {
  /** True while the exit animation plays; the parent unmounts after EXIT_MS. */
  closing: boolean
  busy: boolean
  error: string | null
  onRun: (action: PowerAction) => void
  /** Minimises the launcher. Not a `PowerAction` — see `CHOICES`. */
  onDesktop: () => void
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
        className="gap-5 duration-150 sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Power</DialogTitle>
          <DialogDescription>Leave the launcher, or end the session.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Choice
            id="power:desktop"
            label="Back to desktop"
            // The one thing the user cannot find out by trying: the launcher
            // stops acting on the pad the moment it is minimised, and there is
            // nothing a pad can do to un-minimise a window anyway.
            description="Hides the launcher without closing it. Comes back with a mouse or keyboard, not the pad."
            Icon={Monitor}
            disabled={busy}
            onRun={onDesktop}
          />

          {/* Above the rule: the launcher steps aside. Below it: the session
              ends. Worth a line between them at three metres. */}
          <Separator className="my-1" />

          {CHOICES.map((choice) => (
            <Choice
              key={choice.action}
              id={`power:${choice.action}`}
              label={choice.label}
              description={choice.description}
              Icon={choice.Icon}
              disabled={busy}
              onRun={() => onRun(choice.action)}
            />
          ))}

          <Choice
            id="power:cancel"
            label="Cancel"
            description="Go back to the library."
            Icon={X}
            disabled={false}
            onRun={onClose}
          />
        </div>

        {/* A refusal has to be readable: with no keyboard in the room, a button
            that silently does nothing is the one failure nobody can diagnose. */}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
