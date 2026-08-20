import { describe, expect, it } from 'vitest'
import {
  COMPOSE_CURSOR_START,
  COMPOSE_DISPLAY,
  COMPOSE_SHORTCUTS,
  DEFAULT_LAYOUT_ID,
  buildComposeLayout,
  clampComposeCursor,
  composeButtonAt,
  composeButtons,
  composeLayoutFor,
  composeLayouts,
  composeRows,
  isComposeFunctionKey,
  missingPrintableAscii,
  moveComposeSelection
} from './keyboardLayout'

const american = buildComposeLayout(composeLayoutFor('us'))
// Not named `it`: that is vitest's own function, and shadowing it in a test
// file is a puzzle for whoever reads the failure.
const italian = buildComposeLayout(composeLayoutFor('it'))

/** Everything a layout can type, both layers, function keys excluded. */
function typeable(layout: ReturnType<typeof buildComposeLayout>): Set<string> {
  const characters = new Set<string>([' ']) // {space}, which is in the function row.
  for (const button of composeButtons(layout)) {
    if (!isComposeFunctionKey(button)) characters.add(button)
  }
  return characters
}

describe('choosing a layout', () => {
  it('takes the xkb name the compositor reports', () => {
    expect(composeLayoutFor('it').id).toBe('it')
    expect(composeLayoutFor('us').id).toBe('us')
  })

  it('takes a locale too, because that is the fallback when nothing else knows', () => {
    // `it-IT` from Electron, `it_IT` from the environment, `it` from KWin.
    expect(composeLayoutFor('it-IT').id).toBe('it')
    expect(composeLayoutFor('it_IT.UTF-8').id).toBe('it')
    expect(composeLayoutFor('IT').id).toBe('it')
  })

  it('never returns nothing', () => {
    // A keyboard is not the place to fail closed: US QWERTY is wrong in a way
    // somebody can work around, and no keyboard is not.
    for (const value of [null, undefined, '', '   ', 'kl', 'zz-ZZ']) {
      expect(composeLayoutFor(value).id).toBe(DEFAULT_LAYOUT_ID)
    }
  })
})

describe('every layout that ships', () => {
  for (const definition of composeLayouts()) {
    describe(definition.id, () => {
      const layout = buildComposeLayout(definition)

      it('is QWERTY, in that order, on its second row', () => {
        // The decision this file exists to hold: what gets typed here is an
        // email address and a password, and both are muscle memory attached to
        // the keyboard already on the desk. The launcher's *own* search is
        // alphabetical for the opposite reason — read the header.
        expect(composeRows(layout, 'default')[1]?.slice(0, 6)).toEqual([
          'q',
          'w',
          'e',
          'r',
          't',
          'y'
        ])
      })

      it('can type every printable ASCII character', () => {
        // The reason this matters is a password with a `@` or a `#` in it. On a
        // national layout both are behind AltGr, which this keyboard does not
        // have — the generated row is what puts them back, and this is the
        // assertion that makes that a guarantee rather than an intention.
        const characters = typeable(layout)
        const missing: string[] = []
        for (let code = 0x20; code <= 0x7e; code += 1) {
          const char = String.fromCharCode(code)
          if (!characters.has(char)) missing.push(char)
        }
        expect(missing).toEqual([])
      })

      it('has the two layers in the same shape, key for key', () => {
        // The selection is a row and a column, and shift must not move it: it
        // is the same key with a different face on it.
        const lower = composeRows(layout, 'default')
        const upper = composeRows(layout, 'shift')
        expect(upper.map((row) => row.length)).toEqual(lower.map((row) => row.length))
      })

      it('names every function key it draws, and draws no other', () => {
        for (const button of composeButtons(layout)) {
          if (isComposeFunctionKey(button)) expect(COMPOSE_DISPLAY[button]).toBeTruthy()
        }
        expect(composeButtons(layout).has('{tab}')).toBe(false)
      })

      it('ends with the function row, so SEND and CANCEL are always reachable', () => {
        const rows = composeRows(layout, 'default')
        expect(rows[rows.length - 1]).toEqual([
          '{shift}',
          '{space}',
          '{bksp}',
          '{enter}',
          '{close}'
        ])
      })

      it('starts the cursor on a key that exists', () => {
        expect(
          composeButtonAt(
            composeRows(layout, 'default'),
            COMPOSE_CURSOR_START.row,
            COMPOSE_CURSOR_START.column
          )
        ).toBeTruthy()
      })

      it('has no empty button names, which would draw a key that does nothing', () => {
        for (const button of composeButtons(layout)) expect(button.length).toBeGreaterThan(0)
      })
    })
  }
})

describe('the generated row', () => {
  it('is empty for US, which already has everything', () => {
    expect(missingPrintableAscii(composeLayoutFor('us'))).toEqual([])
    // And so no row is drawn: five rows of keys plus the function row.
    expect(composeRows(american, 'default')).toHaveLength(5)
  })

  it('puts back exactly what an Italian keyboard hides behind AltGr', () => {
    // `@` is the one that matters — an email address cannot be typed without
    // it — and the rest come along for the same reason.
    expect(missingPrintableAscii(composeLayoutFor('it'))).toEqual([
      '#',
      '@',
      '[',
      ']',
      '`',
      '{',
      '}',
      '~'
    ])
    expect(composeRows(italian, 'default')).toHaveLength(6)
  })

  it('is the same on both layers, so shift cannot change the shape', () => {
    const lower = composeRows(italian, 'default')
    const upper = composeRows(italian, 'shift')
    expect(upper[4]).toEqual(lower[4])
  })
})

describe('the Italian layout in particular', () => {
  it('keeps its own accented letters, which is the point of following the system', () => {
    const characters = typeable(italian)
    for (const char of ['è', 'é', 'à', 'ò', 'ù', 'ì', 'ç', '°', '§', '£']) {
      expect(characters.has(char)).toBe(true)
    }
  })

  it('is not the US layout wearing a different name', () => {
    expect(composeRows(italian, 'shift')[0]).not.toEqual(composeRows(american, 'shift')[0])
  })
})

describe('moveComposeSelection', () => {
  const rows = composeRows(american, 'default')

  it('moves within a row and clamps at both ends', () => {
    expect(moveComposeSelection(rows, { row: 0, column: 0 }, 'right')).toEqual({
      row: 0,
      column: 1
    })
    expect(moveComposeSelection(rows, { row: 0, column: 0 }, 'left')).toEqual({
      row: 0,
      column: 0
    })
    const last = (rows[0]?.length ?? 1) - 1
    expect(moveComposeSelection(rows, { row: 0, column: last }, 'right')).toEqual({
      row: 0,
      column: last
    })
  })

  it('clamps rather than wraps at the top and the bottom', () => {
    // To agree with SpatialFocus: nothing else in this launcher teleports the
    // cursor to the far side of a list.
    expect(moveComposeSelection(rows, { row: 0, column: 2 }, 'up')).toEqual({ row: 0, column: 2 })
    const bottom = rows.length - 1
    expect(moveComposeSelection(rows, { row: bottom, column: 0 }, 'down')).toEqual({
      row: bottom,
      column: 0
    })
  })

  it('clamps the column into the shorter row it arrives in', () => {
    // The function row is five keys under thirteen. Coming down onto it from
    // the right-hand edge must land on its last key, not off the end of it.
    const bottom = rows.length - 1
    const width = rows[bottom]?.length ?? 0
    expect(moveComposeSelection(rows, { row: bottom - 1, column: 9 }, 'down')).toEqual({
      row: bottom,
      column: width - 1
    })
  })

  it('survives a cursor that is already outside the grid', () => {
    expect(moveComposeSelection(rows, { row: 99, column: 99 }, 'up').row).toBeLessThan(rows.length)
    expect(moveComposeSelection(rows, { row: -3, column: Number.NaN }, 'right')).toEqual({
      row: 0,
      column: 1
    })
  })

  it('is a no-op on an empty grid rather than a crash', () => {
    expect(moveComposeSelection([], { row: 0, column: 0 }, 'down')).toEqual({ row: 0, column: 0 })
  })
})

describe('clampComposeCursor', () => {
  it('puts a cursor back inside a grid that changed under it', () => {
    expect(clampComposeCursor(composeRows(american, 'default'), { row: 40, column: 40 })).toEqual({
      row: 4,
      column: 4
    })
  })

  it('leaves one that is already inside alone', () => {
    expect(clampComposeCursor(composeRows(american, 'default'), { row: 1, column: 3 })).toEqual({
      row: 1,
      column: 3
    })
  })
})

describe('COMPOSE_SHORTCUTS', () => {
  it('names only keys the layout actually draws', () => {
    // The glyph is printed on the keycap, so a badge that outlives its key is a
    // pad button advertised on nothing — or, worse, silently gone from a
    // keyboard whose user has learnt it.
    for (const layout of [american, italian]) {
      const buttons = composeButtons(layout)
      for (const button of Object.keys(COMPOSE_SHORTCUTS)) {
        expect(buttons.has(button), `${button} on ${layout.id}`).toBe(true)
      }
    }
  })

  it('names only function keys', () => {
    // A shortcut onto a character key would be a second way to type one letter
    // and no way to type the rest, which is not a shortcut, it is a surprise.
    for (const button of Object.keys(COMPOSE_SHORTCUTS)) {
      expect(isComposeFunctionKey(button), button).toBe(true)
    }
  })

  it('leaves the keys that have no dedicated button unbadged', () => {
    // Every key is reachable by moving the selection and pressing A, and
    // stamping that on ninety keycaps would say nothing while making the
    // legends unreadable. Shift is here because the shoulders are the chord
    // that closes the keyboard and the face buttons are spent.
    expect(COMPOSE_SHORTCUTS['{shift}']).toBeUndefined()
    expect(COMPOSE_SHORTCUTS['a']).toBeUndefined()
  })

  it('badges a key that has a label to sit beside', () => {
    for (const button of Object.keys(COMPOSE_SHORTCUTS)) {
      expect(COMPOSE_DISPLAY[button], button).toBeDefined()
    }
  })
})
