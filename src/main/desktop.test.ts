import { describe, expect, it } from 'vitest'
import { detectDesktop } from './desktop'

/**
 * The values here are real ones, not invented: `XDG_CURRENT_DESKTOP=KDE` and
 * `DESKTOP_SESSION=/usr/share/wayland-sessions/plasma.desktop` were read off
 * the Plasma machine this was written on, including from inside our own Flatpak
 * sandbox, which is what settles that the variable survives bwrap at all.
 *
 * The derivative rows — `Budgie:GNOME`, `ubuntu:GNOME` — are the ones worth
 * having, because both contain `GNOME` and only one of them is GNOME.
 */

describe('detectDesktop', () => {
  it('reads the plain names every desktop sets', () => {
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'KDE' }).id).toBe('kde')
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'GNOME' }).id).toBe('gnome')
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'XFCE' }).id).toBe('xfce')
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'MATE' }).id).toBe('mate')
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'LXQt' }).id).toBe('lxqt')
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'sway' }).id).toBe('sway')
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'Hyprland' }).id).toBe('hyprland')
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'Pantheon' }).id).toBe('pantheon')
  })

  it('takes both of Cinnamon spellings', () => {
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }).id).toBe('cinnamon')
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'Cinnamon' }).id).toBe('cinnamon')
  })

  it('calls Budgie Budgie, though it also says GNOME', () => {
    // Budgie ships `Budgie:GNOME` so that GNOME-targeting applications behave.
    // Matching GNOME first would offer a Budgie session GNOME's sentence about
    // an on-screen keyboard it does not have.
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'Budgie:GNOME' }).id).toBe('budgie')
  })

  it('calls Ubuntu GNOME, because it is', () => {
    // The other side of the same rule: `ubuntu` is deliberately not a row in
    // the table, so it falls through to GNOME rather than to `unknown`.
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }).id).toBe('gnome')
  })

  it('keeps the raw list, for the log line', () => {
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }).names).toEqual([
      'UBUNTU',
      'GNOME'
    ])
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: '' }).names).toEqual([])
  })

  it('falls back to the marker each compositor sets when the list is empty', () => {
    // A compositor started by hand from a TTY sets no XDG_CURRENT_DESKTOP.
    expect(detectDesktop({ HYPRLAND_INSTANCE_SIGNATURE: 'v0.41.2_17…' }).id).toBe('hyprland')
    expect(detectDesktop({ SWAYSOCK: '/run/user/1000/sway-ipc.sock' }).id).toBe('sway')
    expect(detectDesktop({ KDE_FULL_SESSION: 'true' }).id).toBe('kde')
    expect(detectDesktop({ GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' }).id).toBe('gnome')
  })

  it('reads DESKTOP_SESSION as a path, because that is what it is here', () => {
    // Measured: on this machine the variable is not `plasma` but the whole
    // session file. An equality test against a name would answer `unknown` on
    // the one desktop the launcher was written for.
    expect(
      detectDesktop({ DESKTOP_SESSION: '/usr/share/wayland-sessions/plasma.desktop' }).id
    ).toBe('kde')
    expect(detectDesktop({ DESKTOP_SESSION: 'gnome-xorg' }).id).toBe('gnome')
    expect(detectDesktop({ DESKTOP_SESSION: 'xfce' }).id).toBe('xfce')
  })

  it('prefers the list over the markers, which outlive their sessions', () => {
    // `KDE_FULL_SESSION` is exported into a nested session's environment often
    // enough to matter, and the list is the authoritative statement.
    expect(detectDesktop({ XDG_CURRENT_DESKTOP: 'GNOME', KDE_FULL_SESSION: 'true' }).id).toBe(
      'gnome'
    )
  })

  it('answers unknown rather than throwing on an environment that says nothing', () => {
    // The launcher has to start on a session nobody here has heard of, and
    // `unknown` is a case every caller already handles.
    expect(detectDesktop({})).toEqual({ id: 'unknown', session: 'unknown', names: [] })
  })

  describe('session type', () => {
    it('takes logind at its word', () => {
      expect(detectDesktop({ XDG_SESSION_TYPE: 'wayland' }).session).toBe('wayland')
      expect(detectDesktop({ XDG_SESSION_TYPE: 'x11' }).session).toBe('x11')
    })

    it('is not confused by XWayland', () => {
      // A Wayland session running XWayland sets both, and it is not an X11
      // session. Checking DISPLAY first would call every modern desktop X11.
      expect(detectDesktop({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }).session).toBe(
        'wayland'
      )
    })

    it('falls back to the sockets when logind said nothing', () => {
      expect(detectDesktop({ DISPLAY: ':0' }).session).toBe('x11')
      expect(detectDesktop({ XDG_SESSION_TYPE: 'tty', DISPLAY: ':0' }).session).toBe('x11')
    })
  })
})
