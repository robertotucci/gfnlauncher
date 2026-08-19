import type { PointerKeyName } from './pointer'

/**
 * Turning a character the on-screen keyboard produced into something the
 * RemoteDesktop portal will accept.
 *
 * ── Two ways to say it, and they are not equally good ───────────────────────
 *
 * `org.freedesktop.portal.RemoteDesktop` offers both:
 *
 *  - **`NotifyKeyboardKeysym`** takes an X11 keysym — *the character itself*.
 *    Layout-independent, because the compositor is being told what was typed
 *    rather than which key was hit.
 *  - **`NotifyKeyboardKeycode`** takes a Linux evdev keycode — *a position on a
 *    keyboard*. What that position produces depends entirely on the layout the
 *    session is configured with.
 *
 * The difference is not academic. `KEY_2` with shift is `@` on a US layout and
 * `"` on an Italian one, and this launcher is used on Italian machines. So
 * **keysyms are the primary path** and the keycode table below exists only as a
 * fallback for a compositor whose portal has not implemented the keysym call —
 * with the caveat that on such a session the wrong character may be typed, and
 * saying so beats silently entering the wrong password.
 *
 * ── Why the keysym side is almost free ──────────────────────────────────────
 *
 * For every printable ASCII character an X11 keysym *is* the code point. There
 * is no table to get wrong, which is the other reason to prefer it.
 */

/** Printable ASCII, which is exactly what `OSK_ROWS` covers. */
const FIRST_PRINTABLE = 0x20
const LAST_PRINTABLE = 0x7e

/** The named keys, which are not characters and so are not code points. */
const NAMED_KEYSYMS: Readonly<Record<PointerKeyName, number>> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b
}

/**
 * The X11 keysym for a single character, or null if it is not one we send.
 *
 * Latin-1 keysyms are the code point, and printable ASCII is a subset of
 * Latin-1 — so this is an identity with a range check rather than a mapping.
 * The range check is the part that matters: it is what stops an unexpected
 * string reaching the compositor as an arbitrary keysym.
 */
export function keysymForChar(char: string): number | null {
  if (char.length !== 1) return null
  const code = char.codePointAt(0)
  if (code === undefined || code < FIRST_PRINTABLE || code > LAST_PRINTABLE) return null
  return code
}

/** The X11 keysym for one of the named keys. */
export function keysymForKey(key: PointerKeyName): number {
  return NAMED_KEYSYMS[key]
}

// ── The fallback ────────────────────────────────────────────────────────────

/**
 * Linux evdev keycodes, from `input-event-codes.h`.
 *
 * Only the ones the on-screen keyboard can reach. `KEY_LEFTSHIFT` is here
 * because the fallback has to press it itself — a keycode carries no case.
 */
export const KEY_LEFTSHIFT = 42
const KEY_SPACE = 57

const NAMED_KEYCODES: Readonly<Record<PointerKeyName, number>> = {
  Backspace: 14,
  Tab: 15,
  Enter: 28,
  Escape: 1
}

/**
 * Character → the key you would press on a **US layout**, and whether shifted.
 *
 * Written out in rows rather than computed, because that is how a keyboard is
 * laid out and it is the only form in which a missing entry is visible. The
 * order follows `input-event-codes.h`, so it can be checked against the header
 * line by line.
 */
const US_LAYOUT: Readonly<Record<string, readonly [number, boolean]>> = {
  // Digit row: KEY_1 … KEY_0, then KEY_MINUS and KEY_EQUAL.
  '1': [2, false], '!': [2, true],
  '2': [3, false], '@': [3, true],
  '3': [4, false], '#': [4, true],
  '4': [5, false], $: [5, true],
  '5': [6, false], '%': [6, true],
  '6': [7, false], '^': [7, true],
  '7': [8, false], '&': [8, true],
  '8': [9, false], '*': [9, true],
  '9': [10, false], '(': [10, true],
  '0': [11, false], ')': [11, true],
  '-': [12, false], _: [12, true],
  '=': [13, false], '+': [13, true],

  // KEY_Q … KEY_P, then the braces.
  q: [16, false], w: [17, false], e: [18, false], r: [19, false], t: [20, false],
  y: [21, false], u: [22, false], i: [23, false], o: [24, false], p: [25, false],
  '[': [26, false], '{': [26, true],
  ']': [27, false], '}': [27, true],

  // KEY_A … KEY_L, then semicolon, apostrophe, grave and backslash.
  a: [30, false], s: [31, false], d: [32, false], f: [33, false], g: [34, false],
  h: [35, false], j: [36, false], k: [37, false], l: [38, false],
  ';': [39, false], ':': [39, true],
  "'": [40, false], '"': [40, true],
  '`': [41, false], '~': [41, true],
  '\\': [43, false], '|': [43, true],

  // KEY_Z … KEY_M, then comma, dot and slash.
  z: [44, false], x: [45, false], c: [46, false], v: [47, false], b: [48, false],
  n: [49, false], m: [50, false],
  ',': [51, false], '<': [51, true],
  '.': [52, false], '>': [52, true],
  '/': [53, false], '?': [53, true],

  ' ': [KEY_SPACE, false]
}

export interface KeyStroke {
  readonly keycode: number
  readonly shift: boolean
}

/**
 * The keycode fallback for a character, or null if there is none.
 *
 * Uppercase letters are the shifted form of their own key rather than separate
 * entries — twenty-six duplicated rows would be twenty-six chances to mistype
 * one, and the relationship is exact.
 */
export function keycodeForChar(char: string): KeyStroke | null {
  if (char.length !== 1) return null

  const lower = char.toLowerCase()
  const entry = US_LAYOUT[lower]
  if (!entry) return null

  // A letter differs from its own lower case only by shift; every other key
  // carries its shifted meaning in the table.
  const shifted = char !== lower || entry[1]
  return { keycode: entry[0], shift: shifted }
}

/** The keycode for one of the named keys. Never shifted. */
export function keycodeForKey(key: PointerKeyName): KeyStroke {
  return { keycode: NAMED_KEYCODES[key], shift: false }
}
