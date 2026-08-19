import { describe, expect, it } from 'vitest'
import { padEnumerationWarning, UDEV_DATABASE_DIR, UDEV_GRANT } from './padAccess'

describe('padEnumerationWarning', () => {
  it('says nothing outside a sandbox', () => {
    // The AppImage and the .deb read the host's own /run/udev. Warning there
    // would be a line in every log file that means nothing.
    expect(padEnumerationWarning(false, true)).toBeNull()
    expect(padEnumerationWarning(false, false)).toBeNull()
  })

  it('says nothing when the sandbox can read the database', () => {
    expect(padEnumerationWarning(true, true)).toBeNull()
  })

  it('names the override that fixes it, and the symptom it fixes', () => {
    const warning = padEnumerationWarning(true, false)

    // The symptom, because that is what the person reading the log searched
    // for: a pad that was on before the launcher and answers nothing.
    expect(warning).toContain('switched off and on again')
    // And the exact command, for the same reason `classifyHostFailure` spells
    // out its own: "grant the permission" is not something a user can act on.
    expect(warning).toContain(
      `flatpak override --user ${UDEV_GRANT} io.github.robertotucci.GfnLauncher`
    )
  })
})

describe('the paths this depends on', () => {
  it('asks for exactly what the Flatpak manifest grants', () => {
    // Pinned rather than derived: the manifest is not importable from here, and
    // a drift between the two sends a user to fix something else. Change this
    // and flatpak/io.github.robertotucci.GfnLauncher.yml together, or the
    // launcher tells people to type a permission it does not ship with.
    expect(UDEV_GRANT).toBe('--filesystem=/run/udev:ro')
    // The probe is the database directory, which is what carries
    // ID_INPUT_JOYSTICK — the grant above is its parent.
    expect(UDEV_DATABASE_DIR).toBe('/run/udev/data')
  })
})
