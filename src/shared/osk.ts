import { PAD_BUTTON_NAMES, type PadFamily } from './padFamily'
import type { Direction } from './pointer'

/**
 * The on-screen keyboard pointer mode types with.
 *
 * ── Why there is a second one ───────────────────────────────────────────────
 *
 * `SearchOverlay` already has a keyboard, and it is deliberately not reused.
 * That one exists to filter a catalog: twenty-six letters and ten digits, and
 * every key it does not have is a key it does not need. This one has to be able
 * to enter an email address and a password into somebody else's login form, so
 * it needs the whole of printable ASCII — and it has to run inside a preload
 * with no React, no `SpatialFocus` and no access to `@/`.
 *
 * What *is* reused is the reasoning, which is the part that took the thinking:
 * **alphabetical, not QWERTY.** On a pad you scan for a letter rather than reach
 * for it from muscle memory, and A–Z in a grid is the only layout where the next
 * letter's position is predictable without hunting for it.
 *
 * Everything here is pure. The preload owns the DOM, this owns what the DOM says.
 */

export type OskKind = 'char' | 'shift' | 'space' | 'backspace' | 'enter' | 'close'

export interface OskKey {
  /** Stable, and unique across the whole layout. Used as a DOM id. */
  readonly id: string
  readonly kind: OskKind
  /** What the key types unshifted. Absent on the function keys. */
  readonly lower?: string
  /** What it types with shift on. */
  readonly upper?: string
  /** What a function key is called. Character keys draw `lower`/`upper`. */
  readonly label?: string
}

export interface OskCursor {
  readonly row: number
  readonly col: number
}

/** Pairs a row of characters with its shifted twin, which is how a key works. */
function charRow(lower: string, upper: string): OskKey[] {
  const keys: OskKey[] = []
  for (let index = 0; index < lower.length; index += 1) {
    const low = lower[index]!
    keys.push({ id: `key-${low.charCodeAt(0)}`, kind: 'char', lower: low, upper: upper[index]! })
  }
  return keys
}

/**
 * The layout.
 *
 * Six rows of eight, then the function row. The pairing on the last three rows
 * is the US one — the arrangement a user has seen on every keyboard they own —
 * and between them the shifted and unshifted halves cover **every printable
 * ASCII character**. That completeness is not decoration: a password with a
 * backslash in it that cannot be typed is an account that cannot be reached,
 * and there is nowhere else to go from a sofa.
 *
 * `oskCoversPrintableAscii` in the suite is what keeps it true, so a row edited
 * for looks cannot quietly drop a character.
 */
export const OSK_ROWS: readonly (readonly OskKey[])[] = [
  charRow('abcdefgh', 'ABCDEFGH'),
  charRow('ijklmnop', 'IJKLMNOP'),
  charRow('qrstuvwx', 'QRSTUVWX'),
  charRow('yz012345', 'YZ)!@#$%'),
  charRow('6789-=[]', '^&*(_+{}'),
  charRow(";'`\\,./", ':"~|<>?'),
  [
    // Sticky rather than one-shot. A lock is predictable and the labels redraw
    // to say which half of the layout is live; a shift that silently expires
    // after one character is a password typed wrong with no way to see why.
    { id: 'fn-shift', kind: 'shift', label: 'SHIFT' },
    { id: 'fn-space', kind: 'space', label: 'SPACE' },
    { id: 'fn-backspace', kind: 'backspace', label: 'DEL' },
    { id: 'fn-enter', kind: 'enter', label: 'ENTER' },
    { id: 'fn-close', kind: 'close', label: 'CLOSE' }
  ]
]

/**
 * The pad button that reaches a key without walking to it, printed on the key.
 *
 * Only the four keys that have one — every other key is "move the selection,
 * press A", and stamping that on fifty-six keycaps would say nothing while
 * making the legends unreadable.
 *
 * `close` carries the chord rather than a button, and that is the honest label:
 * ☰ here does not close the keyboard, it ends pointer mode outright and takes
 * the cursor with it. The twin of `composeShortcuts` in
 * `@shared/keyboardLayout`, which differs on exactly that key and for exactly
 * that reason.
 *
 * **A function of the pad rather than a table**, because it used to be a table
 * and the table was an Xbox one: a DualSense was told to press X for a space
 * and Y to send, and it has neither. `PAD_BUTTON_NAMES` is the one place those
 * letters are decided now, and it is positional — `west` is the left-hand face
 * button, which is X on an Xbox pad, □ on a Sony one and Y on a Switch one.
 */
export function oskShortcuts(family: PadFamily): Readonly<Partial<Record<OskKind, string>>> {
  const names = PAD_BUTTON_NAMES[family]
  return {
    space: names.west,
    enter: names.north,
    backspace: names.east,
    close: `${names.lb}+${names.rb}`
  }
}

/** Where the cursor sits when the keyboard opens: the first letter. */
export const OSK_START: OskCursor = { row: 0, col: 0 }

/** The key under a cursor, or null if the cursor is out of the layout. */
export function oskKeyAt(
  rows: readonly (readonly OskKey[])[],
  at: OskCursor
): OskKey | null {
  return rows[at.row]?.[at.col] ?? null
}

/**
 * Moves the selection one step, clamping at every edge.
 *
 * **Clamps rather than wraps**, to agree with `SpatialFocus`: nothing else in
 * this launcher teleports the cursor to the far side of a list, and a keyboard
 * that did would be the one place where holding a direction does not do the
 * obvious thing.
 *
 * Rows are allowed to be ragged — the function row is five keys under eight —
 * so a vertical move clamps the column into the row it arrives at. Coming back
 * up from `CLOSE` therefore lands under it rather than jumping to the left
 * edge, which is what a grid of buttons looks like it should do.
 */
export function moveOskSelection(
  rows: readonly (readonly OskKey[])[],
  at: OskCursor,
  direction: Direction
): OskCursor {
  const row = clampIndex(at.row, rows.length)
  const width = rows[row]?.length ?? 0
  const col = clampIndex(at.col, width)

  switch (direction) {
    case 'left':
      return { row, col: Math.max(0, col - 1) }
    case 'right':
      return { row, col: Math.min(width - 1, col + 1) }
    case 'up': {
      const next = Math.max(0, row - 1)
      return { row: next, col: clampIndex(col, rows[next]?.length ?? 0) }
    }
    case 'down': {
      const next = Math.min(rows.length - 1, row + 1)
      return { row: next, col: clampIndex(col, rows[next]?.length ?? 0) }
    }
  }
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(0, Math.trunc(value)), length - 1)
}

/**
 * What a key types, or null when it does something instead of typing.
 *
 * Space is a character like any other as far as the caller is concerned; it is
 * a function key only because it needs a wider label than " ".
 */
export function oskChar(key: OskKey, shift: boolean): string | null {
  if (key.kind === 'space') return ' '
  if (key.kind !== 'char') return null
  return (shift ? key.upper : key.lower) ?? null
}

/** What a key shows, which is the character it would type right now. */
export function oskLabel(key: OskKey, shift: boolean): string {
  if (key.kind === 'char') return (shift ? key.upper : key.lower) ?? ''
  return key.label ?? ''
}

// ── Holding a direction ─────────────────────────────────────────────────────

/**
 * The same timings the grid uses, and deliberately the same numbers.
 *
 * They live here rather than being imported from `intents.ts` for the reason
 * the layout does: the preload cannot see the renderer. Copied values that must
 * agree are a hazard, so the reason they must agree is written down — a
 * keyboard that repeats at a different rate to the grid feels like a different
 * application, and the whole point of this launcher is that it does not.
 */
export const OSK_REPEAT_DELAY_MS = 420
export const OSK_REPEAT_INTERVAL_MS = 90

export interface OskNavState {
  readonly direction: Direction | null
  /** When the next repeat is due, or null for "held, but disowned". */
  readonly repeatAt: number | null
}

export const OSK_NAV_START: OskNavState = { direction: null, repeatAt: null }

/**
 * Whether a held direction should move the selection this sample.
 *
 * `stepPad`'s direction branch, lifted out so the keyboard behaves like the
 * grid: one move on the press, a pause, then a steady repeat. Pure, and the
 * clock is an argument.
 */
export function stepOskNav(
  state: OskNavState,
  direction: Direction | null,
  now: number
): { readonly next: OskNavState; readonly move: boolean } {
  if (direction === null) return { next: OSK_NAV_START, move: false }

  if (direction !== state.direction) {
    return { next: { direction, repeatAt: now + OSK_REPEAT_DELAY_MS }, move: true }
  }

  if (state.repeatAt !== null && now >= state.repeatAt) {
    return { next: { direction, repeatAt: now + OSK_REPEAT_INTERVAL_MS }, move: true }
  }

  return { next: { direction, repeatAt: state.repeatAt }, move: false }
}
