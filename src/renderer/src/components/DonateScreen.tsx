import { useMemo, type ReactNode } from 'react'
import { DONATION_URL } from '@shared/donate'
import { useFocusable } from '@/focus/SpatialFocus'
import { qrPath } from '@/lib/qr'
import { cn } from '@/lib/utils'

/** Where the cursor lands when the view opens. `App` needs it by name. */
export const DONATE_FOCUS_ID = 'support:donate'

/**
 * The ask, and the one way to answer it from a sofa.
 *
 * Presentational like `SettingsScreen` and `StatusScreen`: no `window.launcher`
 * calls, every piece of state arrives as a prop. It renders its own header for
 * a different reason than `StatusScreen` does — there is no control on the
 * title row here; rather, the header is the only left-aligned thing on an
 * otherwise centred page, and keeping the two halves of that composition in
 * separate files would mean neither could be read on its own.
 *
 * Every other screen is a tool: content flush to the rail, a list or a grid.
 * This one is not, and the centred plate is how it says so before a word is
 * read.
 */
export function DonateScreen({
  scope,
  error,
  onOpen
}: {
  scope: string
  /** A failed hand-off to the desktop browser, or null. */
  error: string | null
  onOpen: () => void
}): ReactNode {
  const path = useMemo(() => qrPath(DONATION_URL), [])
  const { ref, focused } = useFocusable<HTMLButtonElement>(DONATE_FOCUS_ID, {
    scope,
    onConfirm: onOpen
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-10 pt-8 pb-6">
        <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          Launcher
        </p>
        <h1 className="mt-3 text-[clamp(1.9rem,3.4vw,2.75rem)] leading-none font-semibold tracking-tight">
          Support the project
        </h1>
      </header>

      {/*
        `scroll-py-*` to match the padding below: the focus ring is drawn
        outside the element, and `scrollIntoView({ block: 'nearest' })` would
        otherwise park the code flush against the edge and shear the ring off.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-py-6 px-10">
        {/* `justify-center` centres the plate when the screen has room for it,
            `min-h-full` lets it scroll instead of clipping when it does not. */}
        <div className="mx-auto flex min-h-full max-w-[34rem] flex-col items-center justify-center gap-6 py-10 text-center">
          <p className="text-[1.3rem] leading-snug text-balance">
            Thank you for giving this launcher a place on your television.
          </p>

          {/* Two weights of grey rather than two colours: the shell is
              colourless, and only the accent is allowed a hue. */}
          <div className="text-muted-foreground flex flex-col gap-3 text-base leading-relaxed">
            <p>
              It is built on a best effort, in evenings taken from elsewhere and at my own expense.
              It is free, it stays free, and nothing is held back behind a paid tier.
            </p>
            <p>
              A donation covers the time and the running costs, and it is the most direct
              encouragement to keep making this better.
            </p>
          </div>

          {/*
            The code is the only focusable on the page, and at this size it is
            the only bright thing on it. Elsewhere in the launcher the cover art
            is what the eye is meant to land on; here the code is the artwork,
            and it wears the same ring a tile does.
          */}
          <button
            ref={ref}
            type="button"
            onClick={onOpen}
            aria-label="Open the PayPal donation page"
            className={cn(
              // Extra air above: the code is the heaviest thing on the page and
              // the prose should not crowd it.
              'mt-3 rounded-xl border p-3 transition-all duration-150',
              focused ? 'focus-ring border-primary scale-[1.03]' : 'border-border'
            )}
          >
            {/* Dark modules take `currentColor` so even the inside of a QR
                stays on the palette. The quiet zone comes from the viewBox
                padding: without it a scanner will not lock on. */}
            <svg
              viewBox={`-2 -2 ${path.count + 4} ${path.count + 4}`}
              className="text-background size-[15rem] rounded-sm bg-white/90 p-2"
              aria-hidden="true"
              shapeRendering="crispEdges"
            >
              <path d={path.d} fill="currentColor" />
            </svg>
          </button>

          <div className="flex flex-col items-center gap-1.5">
            {/* Where the code points, in plain text. Nobody can proofread a
                matrix of black squares, and a link asking for money is the one
                a user is entitled to read before they follow it. */}
            <p className="text-foreground/90 font-mono text-sm tracking-tight">
              paypal.com/donate
            </p>
            {/* No button glyph in the copy — it would be wrong on a PlayStation
                pad and wrong again on a keyboard. The footer legend names the
                action and draws the right glyph for whatever is plugged in. */}
            <p className="text-muted-foreground text-xs">Point a phone camera at the code.</p>
          </div>

          {/* With no keyboard in the room, a control that silently does nothing
              is the one failure nobody can diagnose. */}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
      </div>
    </div>
  )
}
