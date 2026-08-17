import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion, normaliseVersion, parseSemver } from './version'

describe('parseSemver', () => {
  it('reads a plain version', () => {
    expect(parseSemver('1.2.3')).toEqual({ core: [1, 2, 3], pre: [] })
  })

  it('tolerates the v prefix that tags carry', () => {
    expect(parseSemver('v0.1.0')).toEqual({ core: [0, 1, 0], pre: [] })
  })

  it('fills missing trailing parts with zero', () => {
    expect(parseSemver('2')).toEqual({ core: [2, 0, 0], pre: [] })
    expect(parseSemver('2.1')).toEqual({ core: [2, 1, 0], pre: [] })
  })

  it('splits a pre-release on dots', () => {
    expect(parseSemver('1.0.0-beta.2')).toEqual({ core: [1, 0, 0], pre: ['beta', '2'] })
  })

  it('keeps hyphens inside a pre-release identifier', () => {
    expect(parseSemver('1.0.0-rc-1')).toEqual({ core: [1, 0, 0], pre: ['rc-1'] })
  })

  it('drops build metadata, which is not part of precedence', () => {
    expect(parseSemver('1.0.0+20260817')).toEqual({ core: [1, 0, 0], pre: [] })
  })

  it('refuses anything that is not a version', () => {
    for (const value of ['', 'latest', '1..2', '1.2.x', '1.2.3.4', null, undefined, 42]) {
      expect(parseSemver(value)).toBeNull()
    }
  })
})

describe('normaliseVersion', () => {
  it('strips the tag prefix so the UI never prints "vv0.1.0"', () => {
    expect(normaliseVersion('v0.1.0')).toBe('0.1.0')
  })

  it('pads a short version to three parts', () => {
    expect(normaliseVersion('1.2')).toBe('1.2.0')
  })

  it('keeps the pre-release', () => {
    expect(normaliseVersion('v2.0.0-beta.1')).toBe('2.0.0-beta.1')
  })

  it('is null for junk', () => {
    expect(normaliseVersion('nightly')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1)
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareVersions('1.1.1', '1.1.2')).toBe(-1)
    expect(compareVersions('1.1.1', '1.1.1')).toBe(0)
  })

  it('does not compare version parts as strings', () => {
    // The bug this pins: "0.10.0" < "0.9.0" lexically, and the tenth minor
    // release of a launcher is not older than the ninth.
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
  })

  it('sorts a pre-release before the release it leads to', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1)
  })

  it('orders pre-release identifiers by semver precedence', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1)
    // Numeric identifiers rank below alphanumeric ones.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    // Fewer identifiers sort first when the shared ones tie.
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBe(-1)
  })

  it('sorts an unreadable version first, so it can never win', () => {
    expect(compareVersions('nightly', '0.1.0')).toBe(-1)
    expect(compareVersions('0.1.0', 'nightly')).toBe(1)
  })
})

describe('isNewerVersion', () => {
  it('is true only for a strictly higher version', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false)
  })

  it('never offers a downgrade to a build made after the last release', () => {
    // Between two releases, package.json is ahead of the published tag. The
    // launcher must not then advertise the older published version.
    expect(isNewerVersion('0.1.0', '0.2.0-dev')).toBe(false)
  })

  it('never offers a pre-release over the stable version it precedes', () => {
    expect(isNewerVersion('0.2.0-beta.1', '0.2.0')).toBe(false)
  })

  it('refuses an unreadable candidate rather than guessing', () => {
    expect(isNewerVersion('latest', '0.1.0')).toBe(false)
    expect(isNewerVersion(undefined, '0.1.0')).toBe(false)
  })
})
