import { describe, expect, it } from 'vitest'
import type { GfnClientInfo } from '@shared/types'
import { parseRunningApps, parseVersion, sameClient } from './flatpak'

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

describe('sameClient', () => {
  const DEPLOY = '/home/u/.local/share/flatpak/app/com.nvidia.geforcenow/x86_64/master'

  function info(overrides: Partial<GfnClientInfo> = {}): GfnClientInfo {
    return {
      installed: true,
      version: '2.0.88.129',
      installPath: `${DEPLOY}/a6efb689`,
      error: null,
      ...overrides
    }
  }

  it('treats a moved install path as a change even when the version has not moved', () => {
    // The one that is easy to get wrong. Re-deploying the same version still
    // lands it in a new commit directory and prunes the old one, and
    // `appConfig.ts` reads the client's service configuration out of that path
    // — so "same version" is not "same install".
    expect(sameClient(info(), info({ installPath: `${DEPLOY}/1f0c4b22` }))).toBe(false)
  })

  it('treats a new version as a change', () => {
    expect(sameClient(info(), info({ version: '2.0.89.100' }))).toBe(false)
  })

  it('treats the client appearing or disappearing as a change', () => {
    const absent = info({ installed: false, version: null, installPath: null })
    expect(sameClient(info(), absent)).toBe(false)
    expect(sameClient(absent, info())).toBe(false)
  })

  it('treats a probe that could not ask as a change', () => {
    // The `blocked` and `timeout` messages out of `classifyHostFailure`: the
    // Settings screen shows them, so they have to reach it.
    expect(sameClient(info(), info({ error: 'The host did not answer in time.' }))).toBe(false)
  })

  it('has nothing to compare against on the first probe', () => {
    expect(sameClient(null, info())).toBe(false)
  })

  it('reports an unchanged install as unchanged', () => {
    expect(sameClient(info(), info())).toBe(true)
  })
})
