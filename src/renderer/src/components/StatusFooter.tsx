import { type ReactNode } from 'react'
import { GlyphBadge, glyphFor } from '@/components/glyphs'
import type { GamepadAction } from '@/gamepad/intents'
import type { InputScheme } from '@/gamepad/scheme'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

/** Whether the local GFN client is there, and whether a handoff is in flight. */
export type SignalState = 'ready' | 'absent' | 'handoff' | 'failed'

const SIGNAL_LABELS: Record<SignalState, string> = {
  ready: 'GFN CLIENT READY',
  absent: 'GFN CLIENT NOT FOUND',
  handoff: 'HANDING OFF',
  failed: 'LAUNCH FAILED'
}

/**
 * Entries name an *action*, never a glyph: the same row reads A, ✕ or ENTER
 * depending on what the user is holding.
 */
export interface LegendEntry {
  action: GamepadAction
  label: string
}

/**
 * The launcher's only permanent chrome.
 *
 * There is no top bar: above this strip the screen belongs entirely to cover
 * art, which is the one thing a TV renders better than anything else. So the
 * footer carries both halves of the interface's own state — what the buttons do
 * on the left, what the machine is doing on the right.
 */
export function StatusFooter({
  entries,
  scheme,
  signal,
  version,
  status
}: {
  entries: LegendEntry[]
  /** Which device the footer should describe — see `useGamepad().scheme`. */
  scheme: InputScheme
  signal: SignalState
  /** GFN client version, or null when the Flatpak is not installed. */
  version: string | null
  /** Input-state notice, kept here so it never covers artwork. */
  status?: string | null
}): ReactNode {
  return (
    <footer className="border-border/60 flex shrink-0 items-center gap-6 border-t px-10 py-3.5">
      {entries.map((entry) => {
        const glyph = glyphFor(entry.action, scheme)
        if (!glyph) return null

        return (
          <div key={entry.action} className="flex items-center gap-2">
            <GlyphBadge glyph={glyph} />
            <span className="text-muted-foreground text-sm">{entry.label}</span>
          </div>
        )
      })}

      <div className="text-muted-foreground ml-auto flex items-center gap-3 font-mono text-xs tabular-nums">
        {/* Informational, not an error: "no pad connected" is a fact about the
            room, and painting it destructive would make an idle keyboard look
            like a fault. */}
        {status && (
          <>
            <span>{status}</span>
            <Separator orientation="vertical" className="h-3.5" />
          </>
        )}

        <span className={cn('flex items-center gap-2', signal === 'failed' && 'text-foreground')}>
          {/* No hue, even for a fault: the accent belongs to focus and the
              status palette is confined to the server-status screen. A failure
              is told apart by a hollow dot and heavier text — the same "weight,
              a border, or an icon" the design rules ask for. */}
          <span
            className={cn(
              'size-1.5 rounded-full',
              signal === 'failed'
                ? 'border-foreground border'
                : signal === 'absent'
                  ? 'bg-muted-foreground/40'
                  : 'bg-primary',
              signal === 'handoff' && 'animate-pulse'
            )}
          />
          {SIGNAL_LABELS[signal]}
        </span>

        {version && (
          <>
            <Separator orientation="vertical" className="h-3.5" />
            <span>v{version}</span>
          </>
        )}
      </div>
    </footer>
  )
}
