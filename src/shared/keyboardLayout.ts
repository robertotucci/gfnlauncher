import { PAD_BUTTON_NAMES, type PadFamily } from './padFamily'
import type { Direction } from './pointer'

/**
 * The layout the compose keyboard draws, in `simple-keyboard`'s own format.
 *
 * ── Why it follows the system's ─────────────────────────────────────────────
 *
 * This keyboard types into windows the launcher does not own — a login box, an
 * installer, a game — so what it is *for* is entering somebody's email address
 * and their password. Both of those are muscle memory attached to the keyboard
 * they already have, which is why this is QWERTY in the arrangement their
 * session is configured with rather than the alphabetical grid the launcher's
 * own search uses. Scanning for a letter is the right answer when the thing
 * being typed is a game title; recognising your own keyboard is the right
 * answer when it is a password with a `£` in it.
 *
 * The layout id comes from the compositor (`org.kde.KeyboardLayouts` reports
 * `it` on an Italian session) and falls back to the locale. `us` is what an
 * unknown one gets.
 *
 * ── Why an extra row is generated rather than written ───────────────────────
 *
 * A faithful national layout hides characters behind AltGr: on `it` there is no
 * `@`, no `#`, no bracket and no backtick at levels 1 and 2, and an email
 * address cannot be typed without the first of those. Rather than reproduce a
 * third level — whose *positions* nobody remembers, and which on a d-pad buys
 * nothing, since every key is the same number of presses away — the missing
 * printable ASCII is collected into one extra row, in a fixed order, and
 * appended to both layers. So coverage is a property of the construction
 * instead of something a test has to catch after the fact: whatever a national
 * layout leaves out, this row puts back.
 */

export interface ComposeLayoutDefinition {
  /** The xkb name, which is what the compositor reports. */
  readonly id: string
  /** For the log line that says which one was picked. */
  readonly name: string
  /** Levels one and two, faithful to the physical layout, ragged rows allowed. */
  readonly rows: {
    readonly default: readonly string[]
    readonly shift: readonly string[]
  }
}

/**
 * The layouts that ship.
 *
 * Six, and adding a seventh is adding an entry: the rows are the physical
 * keyboard's first two levels, and everything else — the missing characters,
 * the function row, the shape checks — is worked out from them.
 *
 * **They are transcribed from the compiled keymap, not from the symbols file.**
 * `/usr/share/X11/xkb/symbols/<id>` is a set of *overrides* on top of an
 * include chain, so reading it gives the keys a layout changed and not the
 * keyboard anybody has; `xkbcli compile-keymap --layout <id>` resolves the
 * chain and is what these came out of. Note the row split that follows from
 * that: `BKSL` is the key left of Enter on an ISO keyboard and above it on an
 * ANSI one, so it ends row *three* on every layout here except `us`.
 *
 * **A dead key is drawn as the character it produces on its own.** German's
 * `´`, French's `^` and `¨`, Spanish's `` ` `` and `´` are all dead keys on the
 * real keyboard — press one and then a letter and they compose. This keyboard
 * has no dead-key state and does not want one: it types a character straight at
 * the compositor, so the key is drawn with, and produces, the spacing form,
 * which is what pressing that key and then space gives on the physical board.
 * The accented letters those keys would have composed are not lost — a layout
 * that has them at levels one and two has them here too, and the rest are
 * outside printable ASCII and so outside what a password field wants.
 */
const LAYOUTS: readonly ComposeLayoutDefinition[] = [
  {
    id: 'us',
    name: 'US',
    rows: {
      default: [
        '` 1 2 3 4 5 6 7 8 9 0 - =',
        'q w e r t y u i o p [ ] \\',
        "a s d f g h j k l ; '",
        'z x c v b n m , . /'
      ],
      shift: [
        '~ ! @ # $ % ^ & * ( ) _ +',
        'Q W E R T Y U I O P { } |',
        'A S D F G H J K L : "',
        'Z X C V B N M < > ?'
      ]
    }
  },
  {
    id: 'it',
    name: 'Italiana',
    rows: {
      // `\` and `<` are the two keys a pc105 has and a pc104 does not; they are
      // where an Italian keyboard puts them, left of `1` and left of `z`.
      default: [
        "\\ 1 2 3 4 5 6 7 8 9 0 ' ì",
        'q w e r t y u i o p è +',
        'a s d f g h j k l ò à ù',
        '< z x c v b n m , . -'
      ],
      shift: [
        '| ! " £ $ % & / ( ) = ? ^',
        'Q W E R T Y U I O P é *',
        'A S D F G H J K L ç ° §',
        '> Z X C V B N M ; : _'
      ]
    }
  },
  {
    id: 'de',
    name: 'Deutsch',
    rows: {
      // QWERTZ: Y and Z are swapped, which is on its own the reason a German
      // user cannot be handed the US board and told to manage.
      default: [
        '^ 1 2 3 4 5 6 7 8 9 0 ß ´',
        'q w e r t z u i o p ü +',
        'a s d f g h j k l ö ä #',
        '< y x c v b n m , . -'
      ],
      shift: [
        '° ! " § $ % & / ( ) = ? `',
        'Q W E R T Z U I O P Ü *',
        "A S D F G H J K L Ö Ä '",
        '> Y X C V B N M ; : _'
      ]
    }
  },
  {
    id: 'fr',
    name: 'Français',
    rows: {
      // AZERTY, and the digits are on **shift** — the one thing about this
      // layout that surprises everybody who has not used one, and the reason
      // drawing it faithfully matters more here than anywhere else.
      default: [
        '² & é " \' ( - è _ ç à ) =',
        'a z e r t y u i o p ^ $',
        'q s d f g h j k l m ù *',
        '< w x c v b n , ; : !'
      ],
      shift: [
        '~ 1 2 3 4 5 6 7 8 9 0 ° +',
        'A Z E R T Y U I O P ¨ £',
        'Q S D F G H J K L M % µ',
        '> W X C V B N ? . / §'
      ]
    }
  },
  {
    id: 'es',
    name: 'Español',
    rows: {
      default: [
        "º 1 2 3 4 5 6 7 8 9 0 ' ¡",
        'q w e r t y u i o p ` +',
        'a s d f g h j k l ñ ´ ç',
        '< z x c v b n m , . -'
      ],
      shift: [
        'ª ! " · $ % & / ( ) = ? ¿',
        'Q W E R T Y U I O P ^ *',
        'A S D F G H J K L Ñ ¨ Ç',
        '> Z X C V B N M ; : _'
      ]
    }
  },
  {
    id: 'gb',
    name: 'UK',
    rows: {
      // The only one of these besides US that needs no generated row: a UK
      // keyboard reaches every printable ASCII character at levels one and two.
      // It is still not the US layout — `"` and `@` are swapped, `#` is its own
      // key and `\` is left of Z — and those three are exactly the characters
      // an email address and a password are made of.
      default: [
        '` 1 2 3 4 5 6 7 8 9 0 - =',
        'q w e r t y u i o p [ ]',
        "a s d f g h j k l ; ' #",
        '\\ z x c v b n m , . /'
      ],
      shift: [
        '¬ ! " £ $ % ^ & * ( ) _ +',
        'Q W E R T Y U I O P { }',
        'A S D F G H J K L : @ ~',
        '| Z X C V B N M < > ?'
      ]
    }
  }
]

export const DEFAULT_LAYOUT_ID = 'us'

/**
 * Locales whose *language* is the wrong guess at their keyboard.
 *
 * Only consulted on the last leg — `readSystemLayout` asks the session four
 * ways first, and this is what happens when every one of them said nothing. The
 * rule the rest of the time is "the language is the layout", which holds for
 * `it_IT`, `de_DE`, `fr_FR`, `es_ES` and most of the rest; these are the places
 * it does not, and every one of them is a country that types on a keyboard
 * belonging to a different language.
 *
 * `en_GB` is the one that would actually bite: xkb calls the UK layout `gb`, so
 * the language reduction produces `en`, which matches nothing and lands on US —
 * where `"` and `@` are swapped, which is half of an email address.
 */
const LOCALE_LAYOUTS: Readonly<Record<string, string>> = {
  // Ireland ships the UK layout.
  en_gb: 'gb',
  en_ie: 'gb',
  // Canadian French is QWERTY. Handing it AZERTY because the language is `fr`
  // would move every letter on the board, which is far worse than US
  // punctuation in the wrong place.
  fr_ca: 'us',
  // The three Swiss locales all type on the same QWERTZ keyboard, so German is
  // the closest of the six — and for `fr_CH` it is the difference between
  // QWERTZ and AZERTY, which is again every letter.
  de_ch: 'de',
  fr_ch: 'de',
  it_ch: 'de'
}

/**
 * The layout for an xkb name or a locale, and never null.
 *
 * A keyboard is not the place to fail closed: an unrecognised session gets US
 * QWERTY, which is wrong in a way somebody can work around, rather than nothing
 * at all, which is not.
 */
export function composeLayoutFor(id: string | null | undefined): ComposeLayoutDefinition {
  const wanted = (id ?? '').trim().toLowerCase()
  // `it-IT` and `it_IT` both mean `it`; the compositor says `it` and a locale
  // says the other two.
  const language = wanted.split(/[-_]/)[0] ?? ''
  const locale = wanted.replace('-', '_')

  return (
    LAYOUTS.find((layout) => layout.id === wanted) ??
    LAYOUTS.find((layout) => layout.id === LOCALE_LAYOUTS[locale]) ??
    LAYOUTS.find((layout) => layout.id === language) ??
    LAYOUTS.find((layout) => layout.id === DEFAULT_LAYOUT_ID)!
  )
}

/** Every layout that ships, for the tests that hold all of them to the rules. */
export function composeLayouts(): readonly ComposeLayoutDefinition[] {
  return LAYOUTS
}

// ── Building one ────────────────────────────────────────────────────────────

/** Printable ASCII, which is what every layout must be able to produce. */
const FIRST_PRINTABLE = 0x20
const LAST_PRINTABLE = 0x7e

/**
 * The keys that do something rather than typing something, added to every
 * layer so the two can never disagree about their own last row.
 */
const FUNCTION_ROW = '{shift} {space} {bksp} {enter} {close}'

/** What those are called on screen. `simple-keyboard`'s `display` option. */
export const COMPOSE_DISPLAY: Readonly<Record<string, string>> = {
  '{shift}': 'SHIFT',
  '{space}': 'SPACE',
  '{bksp}': 'DEL',
  '{enter}': 'SEND',
  '{close}': 'CANCEL'
}

/**
 * The pad button that reaches a key without walking to it, printed on the key.
 *
 * Only the four keys that have one. Every *other* key is reached the same way —
 * move the selection, press A — and stamping `A` on ninety keycaps would say
 * nothing while making the legends unreadable. `{shift}` is deliberately absent:
 * the shoulders are the chord that closes the keyboard, and the face buttons
 * are spent.
 *
 * Data rather than literals in the stylesheet, and **a function of the pad**
 * rather than data: it was a fixed Xbox table, so a DualSense was told to press
 * X for a space and Y to send, and it has neither of those. `PAD_BUTTON_NAMES`
 * decides the letters now, positionally — `west` is the left-hand face button,
 * X on an Xbox pad, □ on a Sony one, Y on a Switch one — and the same call
 * dresses the preload's keyboard, so the two cannot disagree.
 *
 * `keyboardLayout.test.ts` pins that every key named here is a function key the
 * layout actually draws, on every family, so a badge cannot outlive its key.
 */
export function composeShortcuts(family: PadFamily): Readonly<Record<string, string>> {
  const names = PAD_BUTTON_NAMES[family]
  return {
    '{space}': names.west,
    '{bksp}': names.east,
    '{enter}': names.north,
    '{close}': names.start
  }
}

/**
 * Whether a button *does* something rather than typing itself.
 *
 * The library's own rule, and it has to be exactly the library's own rule:
 * braces **around at least one character**. A bare `{` is an ordinary key that
 * types a brace, and it is in these layouts — the first version of this check
 * asked whether the name started with `{`, which quietly made `{` and `}` the
 * only two printable characters the keyboard could not produce.
 */
const FUNCTION_KEY = /^\{[^{}]+\}$/

export function isComposeFunctionKey(button: string): boolean {
  return FUNCTION_KEY.test(button)
}

export interface ComposeLayout {
  readonly id: string
  readonly name: string
  readonly layers: { readonly default: readonly string[]; readonly shift: readonly string[] }
}

export type ComposeLayer = keyof ComposeLayout['layers']

/**
 * What main pushes to the compose page, and the only thing it pushes.
 *
 * Declared here rather than in any of the three files that use it, because all
 * three consume it and none of them can see the other two: main sends it, the
 * preload re-declares the callback's parameter, and the page reads it. It was
 * three copies once, and the copy in main was a bare object literal — the one
 * side with no contract at all.
 *
 * Every field is a **resolved value, not an id**. The page holds no state and
 * makes no decisions, and an id would put `@shared/theme`'s fallback in two
 * places.
 */
export interface ComposeView {
  readonly text: string
  readonly layer: ComposeLayer
  /** The button the pad is on, as `simple-keyboard` names it. */
  readonly selected: string
  readonly layout: ComposeLayout['layers']
  readonly display: Readonly<Record<string, string>>
  /** `composeShortcuts(family)`, as one CSS custom property per key. */
  readonly shortcuts: Readonly<Record<string, string>>
  /** A CSS colour from `accentValue`, assigned to `--accent`. */
  readonly accent: string
  /** A multiplier from `keyboardScaleValue`, assigned to `--kb-scale`. */
  readonly scale: number
  /**
   * Rows in the layer being drawn, assigned to `--rows`.
   *
   * The stylesheet needs it to cap the key unit against the viewport height,
   * and it varies: `us` draws five rows, `it` six.
   */
  readonly rows: number
  /**
   * CSS pixels at the bottom of the viewport the deck must clear.
   *
   * See `composeSafeBottom` in `main/pointer/compose.ts` — it is not "the height
   * of the panel", it is how much of our own window is unusable, which is the
   * only form of the question a Wayland client can answer.
   */
  readonly safeBottom: number
}

/**
 * Turns a definition into the two layers the keyboard draws.
 *
 * Both get the same extra row and the same function row, so they stay the same
 * shape and shift cannot move the selection out from under a thumb.
 */
export function buildComposeLayout(definition: ComposeLayoutDefinition): ComposeLayout {
  const extras = missingPrintableAscii(definition)
  const tail = extras.length > 0 ? [extras.join(' '), FUNCTION_ROW] : [FUNCTION_ROW]

  return {
    id: definition.id,
    name: definition.name,
    layers: {
      default: [...definition.rows.default, ...tail],
      shift: [...definition.rows.shift, ...tail]
    }
  }
}

/**
 * Printable ASCII the two levels do not already reach, in code-point order.
 *
 * Space is excluded because `{space}` is in the function row. On `us` this is
 * empty and no extra row is drawn at all.
 */
export function missingPrintableAscii(definition: ComposeLayoutDefinition): string[] {
  const present = new Set<string>([' '])
  for (const row of [...definition.rows.default, ...definition.rows.shift]) {
    for (const button of row.split(' ')) {
      if (button.length > 0) present.add(button)
    }
  }

  const missing: string[] = []
  for (let code = FIRST_PRINTABLE; code <= LAST_PRINTABLE; code += 1) {
    const char = String.fromCharCode(code)
    if (!present.has(char)) missing.push(char)
  }
  return missing
}

/** One layer as a grid, which is what walking it needs. */
export function composeRows(
  layout: ComposeLayout,
  layer: ComposeLayer
): readonly (readonly string[])[] {
  return layout.layers[layer].map((row) => row.split(' '))
}

/** The button at a position, or null when the position is outside the grid. */
export function composeButtonAt(
  rows: readonly (readonly string[])[],
  row: number,
  column: number
): string | null {
  return rows[row]?.[column] ?? null
}

/** Every button name in a layout, both layers. The allow-list for a click. */
export function composeButtons(layout: ComposeLayout): Set<string> {
  const buttons = new Set<string>()
  for (const layer of ['default', 'shift'] as const) {
    for (const row of composeRows(layout, layer)) {
      for (const button of row) buttons.add(button)
    }
  }
  return buttons
}

// ── Walking it ──────────────────────────────────────────────────────────────

export interface ComposeCursor {
  readonly row: number
  readonly column: number
}

export const COMPOSE_CURSOR_START: ComposeCursor = { row: 0, column: 0 }

/**
 * Moves the selection one step, clamping at every edge.
 *
 * `moveOskSelection`'s twin, and deliberately a separate function rather than a
 * shared one: that grid is made of `OskKey` objects for a keyboard drawn by a
 * preload, this one is made of strings for a keyboard drawn by a library, and
 * folding them together would mean one of the two carrying a shape it does not
 * need. What they must keep in common is the *behaviour* — **clamp, never
 * wrap**, to agree with `SpatialFocus`, and clamp the column into the row a
 * vertical move lands in, so coming up from CANCEL lands under it rather than
 * jumping to the left edge.
 */
export function moveComposeSelection(
  rows: readonly (readonly string[])[],
  at: ComposeCursor,
  direction: Direction
): ComposeCursor {
  const row = clampIndex(at.row, rows.length)
  const width = rows[row]?.length ?? 0
  const column = clampIndex(at.column, width)

  switch (direction) {
    case 'left':
      return { row, column: Math.max(0, column - 1) }
    case 'right':
      return { row, column: Math.min(width - 1, column + 1) }
    case 'up': {
      const next = clampIndex(row - 1, rows.length)
      return { row: next, column: clampIndex(column, rows[next]?.length ?? 0) }
    }
    case 'down': {
      // `clampIndex` rather than `Math.min(rows.length - 1, …)`, which is minus
      // one on an empty grid and hands back a row that cannot exist.
      const next = clampIndex(row + 1, rows.length)
      return { row: next, column: clampIndex(column, rows[next]?.length ?? 0) }
    }
  }
}

/** Puts a cursor back inside a grid, for when the grid changed under it. */
export function clampComposeCursor(
  rows: readonly (readonly string[])[],
  at: ComposeCursor
): ComposeCursor {
  const row = clampIndex(at.row, rows.length)
  return { row, column: clampIndex(at.column, rows[row]?.length ?? 0) }
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(0, Math.trunc(value)), length - 1)
}
