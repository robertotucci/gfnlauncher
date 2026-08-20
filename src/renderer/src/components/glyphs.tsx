import { Circle, Menu, Plus, Square, Triangle, X, type LucideIcon } from 'lucide-react'
import { type ReactNode } from 'react'
import { ACTION_KEYS, type GamepadAction } from '@/gamepad/intents'
import type { InputScheme } from '@/gamepad/scheme'
import { cn } from '@/lib/utils'

/**
 * What a button looks like on the device currently in the user's hands.
 *
 * `label` is the accessible name and the thing tests assert on; `icon` is set
 * only where the button really is a shape. Xbox faces stay as text because A,
 * B, X and Y are letters printed on the pad — drawing them as icons would be
 * dressing up a character.
 */
export interface Glyph {
  label: string
  icon?: LucideIcon
}

const XBOX: Record<GamepadAction, Glyph> = {
  confirm: { label: 'A' },
  back: { label: 'B' },
  search: { label: 'X' },
  menu: { label: 'Y' },
  start: { label: 'Menu', icon: Menu },
  pageLeft: { label: 'LB' },
  pageRight: { label: 'RB' }
}

const PLAYSTATION: Record<GamepadAction, Glyph> = {
  confirm: { label: 'Cross', icon: X },
  back: { label: 'Circle', icon: Circle },
  search: { label: 'Square', icon: Square },
  menu: { label: 'Triangle', icon: Triangle },
  start: { label: 'Options', icon: Menu },
  pageLeft: { label: 'L1' },
  pageRight: { label: 'R1' }
}

/**
 * A Switch pad, which is the same table with two pairs of letters swapped.
 *
 * **The actions do not move; only the names do.** `confirm` is still the button
 * under the thumb — the kernel's `BTN_SOUTH`, the W3C's index 0 — and on this
 * pad that button is printed **B**. Swapping the action instead would put the
 * launcher's "press to open" somewhere different from every other pad and from
 * the rest of the Linux desktop, and would move the mouse click in pointer mode
 * with it. So the legend is relabelled and the mapping is left alone.
 *
 * `+` is a shape rather than a character on this pad, the way ☰ is on the other
 * two, so it takes an icon for the reason PlayStation's faces do.
 */
const NINTENDO: Record<GamepadAction, Glyph> = {
  confirm: { label: 'B' },
  back: { label: 'A' },
  search: { label: 'Y' },
  menu: { label: 'X' },
  start: { label: 'Plus', icon: Plus },
  pageLeft: { label: 'L' },
  pageRight: { label: 'R' }
}

/** Only the keys whose DOM name is too long to read at three metres. */
const KEY_ALIASES: Record<string, string> = { Escape: 'ESC' }

/**
 * The glyph for one action under the current scheme, or null when that scheme
 * has no way to press it — an unbound action with no pad in hand is a promise
 * the footer cannot keep, so the row is dropped instead.
 */
export function glyphFor(action: GamepadAction, scheme: InputScheme): Glyph | null {
  if (scheme === 'xbox') return XBOX[action]
  if (scheme === 'playstation') return PLAYSTATION[action]
  if (scheme === 'nintendo') return NINTENDO[action]

  const key = ACTION_KEYS[action]
  if (!key) return null
  return { label: KEY_ALIASES[key] ?? key.toUpperCase() }
}

/**
 * Draws a glyph as a badge.
 *
 * Pad buttons are round and keys are caps: the shape alone says which device
 * the interface is talking about, before any letter is read. Everything stays
 * on the neutral palette — the accent belongs to focus, and a footer full of
 * pad colours would be the loudest thing on a screen whose whole point is that
 * only the artwork is coloured.
 */
export function GlyphBadge({
  glyph,
  className
}: {
  glyph: Glyph
  className?: string
}): ReactNode {
  const Icon = glyph.icon

  return (
    <span
      aria-label={glyph.label}
      className={cn(
        'text-muted-foreground border-border grid shrink-0 place-items-center border font-mono text-[0.62rem] font-medium',
        Icon ? 'size-5.5 rounded-full' : 'h-5.5 min-w-5.5 rounded-sm px-1.5',
        className
      )}
    >
      {Icon ? <Icon className="size-3" strokeWidth={2.25} aria-hidden /> : glyph.label}
    </span>
  )
}
