import { type ReactNode } from 'react'
import { useFocusable } from '@/focus/SpatialFocus'
import { cn } from '@/lib/utils'

export const SHOTS_SCOPE = 'shots'

/**
 * One screenshot, filling the screen.
 *
 * The only layer where artwork is allowed to be the brightest thing present.
 * Everywhere else the accent ring has to outrank the art, because it is the only
 * cursor in the room — but here there is nothing else to point at, so scrimming
 * the image would be dimming the entire subject. The stage still registers as
 * focusable so the scope has somewhere to land; paging is handled by App, since
 * a single element has no spatial neighbours.
 */
export function ScreenshotViewer({
  shots,
  index,
  title,
  closing,
  onClose
}: {
  shots: string[]
  index: number
  title: string
  closing: boolean
  onClose: () => void
}): ReactNode {
  const { ref } = useFocusable<HTMLDivElement>('shot:stage', {
    scope: SHOTS_SCOPE,
    onConfirm: onClose
  })

  const current = shots[index]

  return (
    <div
      ref={ref}
      className={cn(
        'bg-background absolute inset-0 z-40 flex flex-col',
        closing ? 'animate-out fade-out duration-150' : 'animate-in fade-in duration-200'
      )}
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-8">
        {current && (
          <img
            // Keyed so a step swaps the element rather than mutating one src,
            // which would otherwise hold the previous frame while the next
            // decodes and read as a stutter.
            key={current}
            src={current}
            alt=""
            decoding="async"
            className="animate-in fade-in max-h-full max-w-full object-contain duration-200"
          />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-5 px-10 pb-6">
        <p className="text-muted-foreground font-mono text-xs tabular-nums">
          {index + 1} / {shots.length}
        </p>

        {/* Position as a row of marks rather than a scrollbar: at three metres
            a count is read, but a shape is seen. */}
        <div className="flex items-center gap-1.5">
          {shots.map((shot, dot) => (
            <span
              key={shot}
              className={cn(
                'h-[3px] rounded-full transition-all duration-200',
                dot === index ? 'bg-primary w-6' : 'bg-muted-foreground/30 w-3'
              )}
            />
          ))}
        </div>

        <p className="text-muted-foreground ml-auto truncate text-sm">{title}</p>
      </div>
    </div>
  )
}
