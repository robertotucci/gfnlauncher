import { describe, expect, it } from 'vitest'
import {
  buildFlatpakCommitArgv,
  buildFlatpakRelaunchArgv,
  buildFlatpakUpdateArgv,
  isFlatpakAppId,
  OWN_APP_ID,
  resolveUpdateChannel,
  type InstallEnvironment
} from './channel'

const base: InstallEnvironment = {
  sandboxed: false,
  flatpakId: null,
  appImage: null,
  packaged: true
}

describe('resolveUpdateChannel', () => {
  it('is flatpak inside a sandbox', () => {
    expect(resolveUpdateChannel({ ...base, sandboxed: true, flatpakId: OWN_APP_ID })).toBe(
      'flatpak'
    )
  })

  it('is appimage when APPIMAGE names the file we came from', () => {
    expect(resolveUpdateChannel({ ...base, appImage: '/home/me/Apps/GFN.AppImage' })).toBe(
      'appimage'
    )
  })

  it('is system for a packaged build that is neither', () => {
    expect(resolveUpdateChannel(base)).toBe('system')
  })

  it('is unknown when unpackaged, whatever else is set', () => {
    // `npm run dev` must never be offered a release to download over itself,
    // and it inherits neither marker — so without this branch it would read as
    // a .deb install and be told to use its package manager.
    expect(resolveUpdateChannel({ ...base, packaged: false })).toBe('unknown')
    expect(
      resolveUpdateChannel({ ...base, packaged: false, appImage: '/tmp/x.AppImage' })
    ).toBe('unknown')
  })

  it('prefers flatpak over an inherited APPIMAGE', () => {
    // A Flatpak started from a terminal that itself came from an AppImage
    // inherits APPIMAGE in its environment. /.flatpak-info cannot be inherited,
    // so the sandbox marker is the one to trust.
    expect(
      resolveUpdateChannel({ ...base, sandboxed: true, appImage: '/home/me/Other.AppImage' })
    ).toBe('flatpak')
  })
})

describe('buildFlatpakUpdateArgv', () => {
  it('is the exact command that replaces this application', () => {
    expect(buildFlatpakUpdateArgv(OWN_APP_ID)).toEqual([
      'flatpak',
      'update',
      '--assumeyes',
      'io.github.robertotucci.GfnLauncher'
    ])
  })

  it('does not use --noninteractive, which prints no progress', () => {
    // Measured on flatpak 1.18.1: --noninteractive selects the quiet
    // transaction, whose whole output for a 19 MB pull is one line. Switching
    // back would leave the progress bar frozen with nothing to read.
    expect(buildFlatpakUpdateArgv(OWN_APP_ID)).not.toContain('--noninteractive')
  })

  it('names no installation scope', () => {
    // `--user` or `--system` would turn "already up to date" into "not
    // installed" for whichever half of the users are in the other one.
    const argv = buildFlatpakUpdateArgv(OWN_APP_ID)
    expect(argv).not.toContain('--user')
    expect(argv).not.toContain('--system')
  })
})

describe('buildFlatpakCommitArgv', () => {
  it('asks for the deployed commit, which is the same in every locale', () => {
    expect(buildFlatpakCommitArgv(OWN_APP_ID)).toEqual([
      'flatpak',
      'info',
      '--show-commit',
      'io.github.robertotucci.GfnLauncher'
    ])
  })
})

describe('isFlatpakAppId', () => {
  it('accepts a real application id', () => {
    expect(isFlatpakAppId('io.github.robertotucci.GfnLauncher')).toBe(true)
    expect(isFlatpakAppId('com.nvidia.geforcenow')).toBe(true)
  })

  it('rejects anything that could break out of a shell word', () => {
    // FLATPAK_ID is an environment variable, and it is the only value on the
    // relaunch path that is not a literal in this repository.
    for (const value of ['', 'a b', 'a;rm -rf ~', '$(id)', '`id`', 'a|b', "a'b", '.leading']) {
      expect(isFlatpakAppId(value)).toBe(false)
    }
  })
})

describe('buildFlatpakRelaunchArgv', () => {
  const [command, flag, ...rest] = buildFlatpakRelaunchArgv(OWN_APP_ID)
  const script = rest[0] ?? ''

  it('runs through sh, because it has to wait before it runs', () => {
    expect(command).toBe('sh')
    expect(flag).toBe('-c')
  })

  it('waits for this instance to leave flatpak ps rather than sleeping a guess', () => {
    // Guessing short is the worst failure this feature has: the new instance
    // finds the old single-instance lock still held, quits, and a television is
    // left with no launcher at all.
    expect(script).toContain('flatpak ps --columns=application')
    expect(script).toContain('grep -qF io.github.robertotucci.GfnLauncher')
  })

  it('bounds the wait, so a cancelled quit cannot leave a shell polling forever', () => {
    expect(script).toContain('-lt 30')
  })

  it('backgrounds the whole thing, so flatpak-spawn does not pin the sandbox open', () => {
    // Without this the client waits for its host child, our sandbox cannot tear
    // down, the instance never leaves `flatpak ps`, and the loop waits for
    // itself until it times out.
    expect(script.endsWith('&')).toBe(true)
    expect(script).toContain('</dev/null')
  })

  it('execs, so no shell lingers behind the new launcher', () => {
    expect(script).toContain('exec flatpak run io.github.robertotucci.GfnLauncher')
  })

  it('falls back to our own id rather than interpolating a rejected one', () => {
    const [, , unsafe] = buildFlatpakRelaunchArgv('evil; rm -rf ~')
    expect(unsafe).not.toContain('rm -rf')
    expect(unsafe).toContain('exec flatpak run io.github.robertotucci.GfnLauncher')
  })
})
