import { describe, expect, it } from 'vitest'
import {
  layoutSources,
  nextKeyboardAction,
  parseGnomeInputSources,
  parseXkbLayoutList,
  readVariant,
  systemKeyboardReason
} from './systemKeyboard'

/**
 * The `gsettings` output shapes below are transcribed from real runs on the
 * machine this was written on, host and sandbox, rather than invented — an
 * empty list prints its type and a populated one does not, and only one of
 * those two facts is guessable.
 */

describe('nextKeyboardAction', () => {
  it('raises the keyboard when there is one and it is down', () => {
    expect(nextKeyboardAction({ available: true, visible: false })).toBe('show')
  })

  it('puts it away again, because LB + RB is a toggle everywhere else', () => {
    // A keyboard that cannot be dismissed with the pad would sit over the game
    // for the rest of the session, and out here there is no other way to close
    // it — that is the whole reason our own cursor cannot reach it.
    expect(nextKeyboardAction({ available: true, visible: true })).toBe('hide')
  })

  it('does nothing at all when KDE has no keyboard installed', () => {
    // The default on a fresh Plasma. Reported rather than attempted: a
    // `forceActivate` against an absent input method succeeds and shows
    // nothing, which is the one outcome nobody can diagnose from a sofa.
    expect(nextKeyboardAction({ available: false, visible: false })).toBe('unavailable')
    expect(nextKeyboardAction({ available: false, visible: true })).toBe('unavailable')
  })
})

describe('systemKeyboardReason', () => {
  it('lets KDE be asked, and only KDE', () => {
    // The one desktop with a D-Bus member that means "show the keyboard".
    expect(systemKeyboardReason('kde')).toBeNull()
  })

  it('names the desktop the user is actually on', () => {
    // The bug this replaced: every desktop was told to install
    // `plasma-keyboard` and to look under System Settings → Keyboard, and the
    // whole cost of it was a GNOME user hunting for a KDE package.
    const gnome = systemKeyboardReason('gnome')
    expect(gnome).toContain('GNOME')
    expect(gnome).not.toContain('plasma-keyboard')
    expect(systemKeyboardReason('xfce')).toContain('Xfce')
    expect(systemKeyboardReason('mate')).toContain('MATE')
  })

  it('says the launcher will draw one, because it will', () => {
    // Not an error message. Composing is the ordinary path on all of these and
    // it works; the sentence exists to say which keyboard is about to appear.
    for (const desktop of ['gnome', 'xfce', 'sway', 'hyprland', 'unknown'] as const) {
      expect(systemKeyboardReason(desktop)).toContain('draws its own')
    }
  })

  it('has a sentence for a desktop nobody here has heard of', () => {
    expect(systemKeyboardReason('unknown')).toBeTruthy()
  })
})

describe('readVariant', () => {
  it('unwraps the shape dbus-native hands a variant over in', () => {
    expect(readVariant([[{ type: 'b', child: [] }], [true]])).toBe(true)
    expect(readVariant(['b', [false]])).toBe(false)
  })

  it('takes a bare value when there is no array around it', () => {
    expect(readVariant(['b', 1])).toBe(1)
  })

  it('is undefined rather than false for anything it cannot read', () => {
    // The distinction this module is built on: `available: false` is a sentence
    // the launcher says to the user, naming a package to install. A property it
    // failed to read must never become that sentence.
    expect(readVariant(undefined)).toBeUndefined()
    expect(readVariant(null)).toBeUndefined()
    expect(readVariant([])).toBeUndefined()
    expect(readVariant(['b'])).toBeUndefined()
    expect(readVariant('true')).toBeUndefined()
  })
})

describe('parseXkbLayoutList', () => {
  it('takes the first layout, which is the one the session comes up in', () => {
    expect(parseXkbLayoutList('it')).toBe('it')
    expect(parseXkbLayoutList('us,it')).toBe('us')
  })

  it('drops the variant, because the compose keyboard has no table for one', () => {
    // Keeping `+nodeadkeys` would turn a layout we do have into one we do not,
    // and `composeLayoutFor` would fall back to US — the exact failure this
    // whole chain exists to end.
    expect(parseXkbLayoutList('de+nodeadkeys')).toBe('de')
    expect(parseXkbLayoutList('fr+oss,us')).toBe('fr')
  })

  it('normalises case and whitespace, since two sources write it two ways', () => {
    expect(parseXkbLayoutList(' IT ')).toBe('it')
  })

  it('is null rather than empty for anything with no layout in it', () => {
    expect(parseXkbLayoutList('')).toBeNull()
    expect(parseXkbLayoutList(undefined)).toBeNull()
    expect(parseXkbLayoutList(null)).toBeNull()
    expect(parseXkbLayoutList(',us')).toBeNull()
  })
})

describe('parseGnomeInputSources', () => {
  it('reads a populated list', () => {
    expect(parseGnomeInputSources("[('xkb', 'it')]")).toBe('it')
    expect(parseGnomeInputSources("[('xkb', 'it'), ('xkb', 'us')]")).toBe('it')
  })

  it('reads the empty list, which prints its type where a full one does not', () => {
    // Measured: `gsettings get org.gnome.desktop.input-sources sources` answers
    // `@a(ss) []` when the list is empty — which is what a KDE session with the
    // GNOME schemas installed answers, and therefore what this must not read as
    // a layout.
    expect(parseGnomeInputSources('@a(ss) []')).toBeNull()
    expect(parseGnomeInputSources('[]')).toBeNull()
  })

  it('skips input methods, which are engines and not layouts', () => {
    // Somebody typing Japanese has an ibus row *and* an xkb row for the
    // physical keyboard under it. Taking entry zero blindly would hand
    // `mozc-jp` to `composeLayoutFor`, which knows no such layout and would
    // draw US — at the users least able to work around it.
    expect(parseGnomeInputSources("[('ibus', 'mozc-jp'), ('xkb', 'jp')]")).toBe('jp')
    expect(parseGnomeInputSources("[('ibus', 'pinyin')]")).toBeNull()
  })

  it('drops the variant here too', () => {
    expect(parseGnomeInputSources("[('xkb', 'de+nodeadkeys')]")).toBe('de')
  })

  it('is null on anything that is not that shape', () => {
    expect(parseGnomeInputSources('')).toBeNull()
    expect(parseGnomeInputSources(undefined)).toBeNull()
    expect(parseGnomeInputSources('No such schema')).toBeNull()
  })
})

describe('layoutSources', () => {
  it('asks the environment first on every desktop, because it is free', () => {
    // And exact: Plasma and every wlroots compositor export it, and it survives
    // into the Flatpak sandbox, so it costs nothing on the path between a pad
    // chord and a keyboard.
    for (const desktop of ['kde', 'gnome', 'xfce', 'sway', 'unknown'] as const) {
      expect(layoutSources(desktop)[0]).toBe('XKB_DEFAULT_LAYOUT')
    }
  })

  it('asks each desktop its own way in the middle', () => {
    expect(layoutSources('kde')).toContain('KDE')
    expect(layoutSources('gnome')).toContain('GNOME input sources')
  })

  it('asks the GNOME setting on the desktops that kept that schema', () => {
    // Cinnamon, Budgie and Pantheon all keep org.gnome.desktop.input-sources.
    for (const desktop of ['cinnamon', 'budgie', 'pantheon'] as const) {
      expect(layoutSources(desktop)).toContain('GNOME input sources')
    }
  })

  it('never asks one desktop the other desktop question', () => {
    expect(layoutSources('gnome')).not.toContain('KDE')
    expect(layoutSources('kde')).not.toContain('GNOME input sources')
    expect(layoutSources('xfce')).not.toContain('KDE')
    expect(layoutSources('xfce')).not.toContain('GNOME input sources')
  })

  it('ends at localed everywhere, including on the desktops that answered', () => {
    // Last rather than absent: it is the *system* configuration, so it is right
    // on Xfce, MATE, LXQt and any X11 session and stale where the user changed
    // their layout in the desktop's own settings. A fallback that is usually
    // right beats the alternative, which is the session language.
    for (const desktop of ['kde', 'gnome', 'xfce', 'lxqt', 'unknown'] as const) {
      expect(layoutSources(desktop).at(-1)).toBe('localed')
    }
  })
})
