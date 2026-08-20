import { describe, expect, it } from 'vitest'
import { PAD_FAMILIES } from './padFamily'
import {
  OSK_NAV_START,
  OSK_REPEAT_DELAY_MS,
  OSK_REPEAT_INTERVAL_MS,
  OSK_ROWS,
  OSK_START,
  moveOskSelection,
  oskChar,
  oskKeyAt,
  oskLabel,
  oskShortcuts,
  stepOskNav,
  type OskCursor,
  type OskKey
} from './osk'

/** Walks a path of directions from a starting cursor. */
function walk(from: OskCursor, path: readonly Parameters<typeof moveOskSelection>[2][]): OskCursor {
  return path.reduce((at, direction) => moveOskSelection(OSK_ROWS, at, direction), from)
}

/** Every character the layout can produce, in both halves. */
function everyCharacter(): Set<string> {
  const found = new Set<string>()
  for (const row of OSK_ROWS) {
    for (const key of row) {
      for (const shift of [false, true]) {
        const char = oskChar(key, shift)
        if (char !== null) found.add(char)
      }
    }
  }
  return found
}

describe('OSK_ROWS', () => {
  it('covers every printable ASCII character', () => {
    // The reason this is asserted rather than eyeballed: a password with a
    // backslash in it that cannot be typed is an account that cannot be
    // reached, and there is no keyboard in the room to fall back on.
    const found = everyCharacter()
    const missing: string[] = []
    for (let code = 0x20; code <= 0x7e; code += 1) {
      const char = String.fromCharCode(code)
      if (!found.has(char)) missing.push(char)
    }
    expect(missing).toEqual([])
  })

  it('never types the same character from two different keys', () => {
    // A duplicate is not harmful, it is a symptom: it means a row was edited
    // for looks and something else fell off the layout to make room.
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const row of OSK_ROWS) {
      for (const key of row) {
        for (const shift of [false, true]) {
          const char = oskChar(key, shift)
          if (char === null || key.kind !== 'char') continue
          const where = `${key.id}${shift ? ':shift' : ''}`
          if (seen.has(char)) duplicates.push(`${char} (${seen.get(char)} and ${where})`)
          else seen.set(char, where)
        }
      }
    }
    expect(duplicates).toEqual([])
  })

  it('gives every key a unique id, since the preload uses them as DOM ids', () => {
    const ids = OSK_ROWS.flat().map((key) => key.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has exactly one of each function key', () => {
    const kinds = OSK_ROWS.flat().map((key) => key.kind)
    for (const kind of ['shift', 'space', 'backspace', 'enter', 'close']) {
      expect(kinds.filter((k) => k === kind)).toHaveLength(1)
    }
  })

  it('starts on a letter, not on a function key', () => {
    expect(oskKeyAt(OSK_ROWS, OSK_START)?.lower).toBe('a')
  })

  it('is alphabetical, the way the search overlay is', () => {
    const letters = OSK_ROWS.flat()
      .map((key) => key.lower)
      .filter((char): char is string => char !== undefined && /[a-z]/.test(char))
    expect(letters.join('')).toBe('abcdefghijklmnopqrstuvwxyz')
  })
})

describe('moveOskSelection', () => {
  it('walks along a row', () => {
    expect(walk(OSK_START, ['right', 'right'])).toEqual({ row: 0, col: 2 })
    expect(oskKeyAt(OSK_ROWS, walk(OSK_START, ['right', 'right']))?.lower).toBe('c')
  })

  it('clamps at the left edge rather than wrapping to the previous row', () => {
    expect(walk({ row: 2, col: 0 }, ['left'])).toEqual({ row: 2, col: 0 })
  })

  it('clamps at the right edge rather than wrapping to the next row', () => {
    const width = OSK_ROWS[0]!.length
    expect(walk({ row: 0, col: width - 1 }, ['right'])).toEqual({ row: 0, col: width - 1 })
  })

  it('clamps at the top and the bottom', () => {
    expect(walk({ row: 0, col: 3 }, ['up'])).toEqual({ row: 0, col: 3 })
    const last = OSK_ROWS.length - 1
    expect(walk({ row: last, col: 1 }, ['down'])).toEqual({ row: last, col: 1 })
  })

  it('clamps the column into a shorter row, so the function row is reachable', () => {
    const functionRow = OSK_ROWS.length - 1
    const wide = OSK_ROWS[functionRow - 1]!.length
    const narrow = OSK_ROWS[functionRow]!.length
    expect(narrow).toBeLessThan(wide)

    const landed = moveOskSelection(OSK_ROWS, { row: functionRow - 1, col: wide - 1 }, 'down')
    expect(landed).toEqual({ row: functionRow, col: narrow - 1 })
    expect(oskKeyAt(OSK_ROWS, landed)?.kind).toBe('close')
  })

  it('comes back up underneath where it landed, not at the left edge', () => {
    const functionRow = OSK_ROWS.length - 1
    const narrow = OSK_ROWS[functionRow]!.length
    const back = moveOskSelection(OSK_ROWS, { row: functionRow, col: narrow - 1 }, 'up')
    expect(back).toEqual({ row: functionRow - 1, col: narrow - 1 })
  })

  it('recovers from a cursor that is outside the layout', () => {
    // A layout edited between renders, or a state restored from nowhere.
    expect(moveOskSelection(OSK_ROWS, { row: 99, col: 99 }, 'left')).toEqual({
      row: OSK_ROWS.length - 1,
      col: OSK_ROWS[OSK_ROWS.length - 1]!.length - 2
    })
    expect(moveOskSelection(OSK_ROWS, { row: -5, col: -5 }, 'right')).toEqual({ row: 0, col: 1 })
    expect(moveOskSelection(OSK_ROWS, { row: Number.NaN, col: 0 }, 'down')).toEqual({
      row: 1,
      col: 0
    })
  })

  it('reaches every key from the start with only directions', () => {
    // The guarantee that matters: there is no key the pad cannot get to.
    const reached = new Set<string>()
    const queue: OskCursor[] = [OSK_START]
    while (queue.length > 0) {
      const at = queue.shift()!
      const key = oskKeyAt(OSK_ROWS, at)
      if (!key || reached.has(key.id)) continue
      reached.add(key.id)
      for (const direction of ['up', 'down', 'left', 'right'] as const) {
        queue.push(moveOskSelection(OSK_ROWS, at, direction))
      }
    }
    expect(reached.size).toBe(OSK_ROWS.flat().length)
  })
})

describe('oskChar', () => {
  const letter = OSK_ROWS[0]![0]!

  it('types the lower half unshifted and the upper half shifted', () => {
    expect(oskChar(letter, false)).toBe('a')
    expect(oskChar(letter, true)).toBe('A')
  })

  it('types a space from the space key, shift or not', () => {
    const space = OSK_ROWS.flat().find((key) => key.kind === 'space')!
    expect(oskChar(space, false)).toBe(' ')
    expect(oskChar(space, true)).toBe(' ')
  })

  it('types nothing from a key that does something', () => {
    for (const kind of ['shift', 'backspace', 'enter', 'close'] as const) {
      const key = OSK_ROWS.flat().find((k) => k.kind === kind)!
      expect(oskChar(key, false)).toBeNull()
      expect(oskChar(key, true)).toBeNull()
    }
  })

  it('returns null rather than undefined for a malformed key', () => {
    const broken: OskKey = { id: 'x', kind: 'char' }
    expect(oskChar(broken, false)).toBeNull()
    expect(oskChar(broken, true)).toBeNull()
  })
})

describe('oskLabel', () => {
  it('shows the character a key would type right now', () => {
    const digit = OSK_ROWS.flat().find((key) => key.lower === '1')!
    expect(oskLabel(digit, false)).toBe('1')
    expect(oskLabel(digit, true)).toBe('!')
  })

  it('shows the name of a function key', () => {
    const enter = OSK_ROWS.flat().find((key) => key.kind === 'enter')!
    expect(oskLabel(enter, false)).toBe('ENTER')
    expect(oskLabel(enter, true)).toBe('ENTER')
  })
})

describe('stepOskNav', () => {
  const FRAME_MS = 16

  /** Holds a direction from `start` to `until` and reports when it moved. */
  function hold(direction: 'up' | 'down' | 'left' | 'right', until: number): number[] {
    let state = OSK_NAV_START
    const moves: number[] = []
    for (let now = 1_000; now <= until; now += FRAME_MS) {
      const step = stepOskNav(state, direction, now)
      state = step.next
      if (step.move) moves.push(now)
    }
    return moves
  }

  it('moves once on the press', () => {
    expect(stepOskNav(OSK_NAV_START, 'right', 1_000).move).toBe(true)
  })

  it('does not move again until the delay has passed', () => {
    const moves = hold('right', 1_000 + OSK_REPEAT_DELAY_MS - 1)
    expect(moves).toEqual([1_000])
  })

  it('then repeats at the shorter interval', () => {
    const moves = hold('right', 1_000 + OSK_REPEAT_DELAY_MS + OSK_REPEAT_INTERVAL_MS * 3)
    expect(moves.length).toBeGreaterThanOrEqual(4)
    // First gap is the delay, the rest are the interval.
    expect(moves[1]! - moves[0]!).toBeGreaterThanOrEqual(OSK_REPEAT_DELAY_MS)
    expect(moves[2]! - moves[1]!).toBeLessThanOrEqual(OSK_REPEAT_INTERVAL_MS + FRAME_MS)
  })

  it('starts over when the direction changes', () => {
    let state = stepOskNav(OSK_NAV_START, 'right', 1_000).next
    const turn = stepOskNav(state, 'down', 1_016)
    expect(turn.move).toBe(true)
    state = turn.next
    // The delay applies again; a turn is a new press, not a continued hold.
    expect(stepOskNav(state, 'down', 1_016 + OSK_REPEAT_DELAY_MS - 1).move).toBe(false)
  })

  it('clears when the stick is recentred', () => {
    const state = stepOskNav(OSK_NAV_START, 'right', 1_000).next
    expect(stepOskNav(state, null, 1_016)).toEqual({ next: OSK_NAV_START, move: false })
  })

  it('matches the timings the grid uses, so the two feel like one application', () => {
    expect(OSK_REPEAT_DELAY_MS).toBe(420)
    expect(OSK_REPEAT_INTERVAL_MS).toBe(90)
  })
})

describe('oskShortcuts', () => {
  it('badges only keys this keyboard actually has, on every pad', () => {
    // The glyph is printed on the keycap, so a badge naming a key that is not
    // drawn is a pad button advertised on nothing.
    const kinds = new Set(OSK_ROWS.flat().map((key) => key.kind))
    for (const family of PAD_FAMILIES) {
      for (const kind of Object.keys(oskShortcuts(family))) {
        expect(kinds.has(kind as (typeof OSK_ROWS)[number][number]['kind']), kind).toBe(true)
      }
    }
  })

  it('leaves the letters and Shift unbadged', () => {
    // Every other key is "move the selection, press A", and stamping that on
    // fifty-six caps would say nothing while making the legends unreadable.
    expect(oskShortcuts('xbox').char).toBeUndefined()
    expect(oskShortcuts('xbox').shift).toBeUndefined()
  })

  it('speaks the language of the pad in hand', () => {
    // The bug: a DualSense was told to press X for a space and Y to send, and
    // it has neither. These are positional — the left-hand face button and the
    // top one — so the letters change and the fingers do not.
    expect(oskShortcuts('xbox').space).toBe('X')
    expect(oskShortcuts('playstation').space).toBe('□')
    expect(oskShortcuts('nintendo').space).toBe('Y')
    expect(oskShortcuts('nintendo').enter).toBe('X')
  })

  it('names the chord rather than a button on close, on every pad', () => {
    // ☰ here does not close the keyboard, it ends pointer mode outright and
    // takes the cursor with it. The honest label is the pair that puts the
    // keyboard away, and it is the pair as *this* pad prints it.
    expect(oskShortcuts('xbox').close).toBe('LB+RB')
    expect(oskShortcuts('playstation').close).toBe('L1+R1')
    expect(oskShortcuts('nintendo').close).toBe('L+R')
  })
})
