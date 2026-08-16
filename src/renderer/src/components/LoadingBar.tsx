import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Indeterminate progress, sitting on top of the status footer so every piece of
 * machine state — what is loading, whether the client is there, which pad is in
 * hand — lives in the same strip along the bottom.
 *
 * The track is always in the layout: showing and hiding a 2px element would
 * nudge the whole page each time a refresh starts.
 */
export function LoadingBar({ active }: { active: boolean }): ReactNode {
  return (
    <div
      className={cn(
        'relative h-[2px] shrink-0 overflow-hidden transition-colors duration-300',
        active ? 'bg-muted' : 'bg-transparent'
      )}
      role="progressbar"
      aria-busy={active}
    >
      {active && <div className="animate-sweep bg-primary absolute inset-y-0 left-0 w-[22%]" />}
    </div>
  )
}
