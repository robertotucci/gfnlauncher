import { describe, expect, it } from 'vitest'
import { parseRunningApps, parseVersion } from './flatpak'

describe('parseVersion', () => {
  it('reads the version out of the Subject line', () => {
    const output = [
      '            ID: com.nvidia.geforcenow',
      '        Branch: master',
      '       Subject: Version:2.0.87.130 Severity:recommended',
      '          Date: 2026-07-22 04:41:11 +0000'
    ].join('\n')

    expect(parseVersion(output)).toBe('2.0.87.130')
  })

  it('returns null when no version is present', () => {
    expect(parseVersion('ID: com.nvidia.geforcenow')).toBeNull()
  })
})

describe('parseRunningApps', () => {
  it('reads one app id per line', () => {
    // `flatpak ps --columns=application` prints no header, unlike bare
    // `flatpak ps`, which is the whole reason that flag is passed.
    expect(parseRunningApps('com.nvidia.geforcenow\norg.gnome.Calculator\n')).toEqual([
      'com.nvidia.geforcenow',
      'org.gnome.Calculator'
    ])
  })

  it('reads nothing running as nothing running', () => {
    // Flatpak 1.18 exits 0 with empty output here, so an empty list has to mean
    // "idle" and not "probe failed".
    expect(parseRunningApps('')).toEqual([])
    expect(parseRunningApps('\n  \n')).toEqual([])
  })
})
