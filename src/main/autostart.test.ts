import { describe, expect, it } from 'vitest'
import { buildDesktopEntry } from './autostart'

/**
 * The entry this builds runs at every login and fails silently when it is wrong
 * — the file is written, nothing complains, and the launcher simply does not
 * come up. These assertions are the only thing standing in for that feedback.
 */

function fields(entry: string): Record<string, string> {
  return Object.fromEntries(
    entry
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1)]
      })
  )
}

describe('buildDesktopEntry', () => {
  it('is a valid desktop entry', () => {
    const entry = buildDesktopEntry({ exec: '/usr/bin/gfn-launcher', icon: 'gfn-launcher' })

    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true)
    expect(entry.endsWith('\n')).toBe(true)
    expect(fields(entry)).toMatchObject({
      Type: 'Application',
      Name: 'GFN Launcher',
      Terminal: 'false',
      'X-GNOME-Autostart-enabled': 'true'
    })
  })

  it('starts the app, not the sandboxed binary, for a Flatpak install', () => {
    const entry = buildDesktopEntry({
      exec: 'flatpak run io.github.robertotucci.GfnLauncher',
      icon: 'io.github.robertotucci.GfnLauncher',
      flatpakId: 'io.github.robertotucci.GfnLauncher'
    })

    // `/app/...` exists only inside the sandbox, so the session has to be told
    // to start the app rather than the executable.
    expect(fields(entry).Exec).toBe('flatpak run io.github.robertotucci.GfnLauncher')
    expect(fields(entry).Exec).not.toContain('/app/')
    expect(fields(entry)['X-Flatpak']).toBe('io.github.robertotucci.GfnLauncher')
  })

  it('points at the image itself for an AppImage, whose mount path is temporary', () => {
    const entry = buildDesktopEntry({
      exec: '/home/user/Apps/GFN Launcher-0.1.0.AppImage',
      icon: 'gfn-launcher'
    })

    expect(fields(entry).Exec).toBe('/home/user/Apps/GFN Launcher-0.1.0.AppImage')
    expect(entry).not.toContain('X-Flatpak')
  })

  it('names an icon theme entry rather than a path, which neither packaged form can rely on', () => {
    for (const icon of ['gfn-launcher', 'io.github.robertotucci.GfnLauncher']) {
      expect(fields(buildDesktopEntry({ exec: '/bin/true', icon })).Icon).toBe(icon)
      expect(fields(buildDesktopEntry({ exec: '/bin/true', icon })).Icon).not.toContain('/')
    }
  })

  it('omits X-Flatpak rather than writing an empty one when there is no id', () => {
    expect(buildDesktopEntry({ exec: '/bin/true', icon: 'x', flatpakId: null })).not.toContain(
      'X-Flatpak'
    )
  })
})
