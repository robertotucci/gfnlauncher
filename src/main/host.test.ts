import { describe, expect, it } from 'vitest'
import { classifyHostFailure, hostCommand, hostEnvironment, printableCommand } from './host'

/**
 * The stderr fragments below are transcribed from flatpak 1.18.1, not invented:
 * they were produced by running `flatpak-spawn --host` inside a freedesktop
 * 25.08 runtime with and without `--talk-name=org.freedesktop.Flatpak`. The
 * localised half of the "missing" case is kept in Italian on purpose — it is the
 * regression guard for the whole point of `classifyHostFailure`, which is that
 * the portal's inner message comes back in the host session's language and
 * cannot be matched on.
 */
const BLOCKED_STDERR = [
  'Portal call failed: org.freedesktop.DBus.Error.ServiceUnknown',
  'Hint: --host only works when the Flatpak is allowed to talk to org.freedesktop.Flatpak'
].join('\n')

const MISSING_STDERR =
  'Portal call failed: Failed to start command: Esecuzione del processo figlio ' +
  '«definitelynotacommand» non riuscita (File o directory non esistente)'

const NOT_EXECUTABLE_STDERR =
  'Portal call failed: Failed to start command: Esecuzione del processo figlio ' +
  '«/etc/hostname» non riuscita (Permesso negato)'

describe('hostCommand', () => {
  it('leaves the argv untouched outside a sandbox', () => {
    expect(hostCommand('flatpak', ['ps', '--columns=application'], { sandboxed: false })).toEqual([
      'flatpak',
      ['ps', '--columns=application']
    ])
  })

  it('routes through flatpak-spawn inside a sandbox', () => {
    expect(hostCommand('systemctl', ['suspend'], { sandboxed: true })).toEqual([
      'flatpak-spawn',
      ['--host', '--', 'systemctl', 'suspend']
    ])
  })

  it('separates the child argv with --, so its flags are not read as flatpak-spawn options', () => {
    const [, args] = hostCommand(
      'flatpak',
      ['run', '--command=/app/cef/GeForceNOW', '--cwd=/app/cef', 'com.nvidia.geforcenow'],
      { sandboxed: true }
    )

    expect(args.indexOf('--')).toBeLessThan(args.indexOf('--command=/app/cef/GeForceNOW'))
    expect(args[args.indexOf('--') + 1]).toBe('flatpak')
  })

  it('forwards environment as --env flags, because flatpak-spawn does not inherit ours', () => {
    expect(hostCommand('flatpak', ['info', 'x'], { env: { LC_ALL: 'C' }, sandboxed: true })).toEqual(
      ['flatpak-spawn', ['--host', '--env=LC_ALL=C', '--', 'flatpak', 'info', 'x']]
    )
  })

  it('keeps environment off the argv outside a sandbox, where execFile takes it directly', () => {
    expect(hostCommand('flatpak', ['info', 'x'], { env: { LC_ALL: 'C' }, sandboxed: false })).toEqual(
      ['flatpak', ['info', 'x']]
    )
  })

  it('copies the argv rather than aliasing the caller’s array', () => {
    const args = ['ps']
    const [, produced] = hostCommand('flatpak', args, { sandboxed: false })
    produced.push('--columns=application')
    expect(args).toEqual(['ps'])
  })
})

describe('hostEnvironment', () => {
  /**
   * The regression this file exists for most: `EGL_PLATFORM=wayland` is set by
   * Electron for its own GPU process, and a GeForce NOW client that inherits it
   * dies with SIGTRAP three seconds after being started. Measured on Electron 43
   * under KDE Wayland; see `CHROMIUM_INJECTED_ENV`.
   */
  it('drops the variable that kills the GeForce NOW client', () => {
    const env = hostEnvironment({ PATH: '/usr/bin', EGL_PLATFORM: 'wayland' })

    expect(env.EGL_PLATFORM).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('drops the rest of what Chromium sets for itself', () => {
    const env = hostEnvironment({
      GDK_BACKEND: 'wayland',
      FC_FONTATIONS: '1',
      NO_AT_BRIDGE: '1',
      CHROME_DESKTOP: 'io.github.robertotucci.GfnLauncher.desktop'
    })

    expect(Object.keys(env)).toEqual([])
  })

  it('keeps everything that came from the session', () => {
    const session = {
      HOME: '/home/someone',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_CURRENT_DESKTOP: 'KDE',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
    }

    expect(hostEnvironment(session)).toEqual(session)
  })

  it('applies overrides, which is how a caller asks for a locale', () => {
    expect(hostEnvironment({ PATH: '/usr/bin' }, { LC_ALL: 'C' })).toEqual({
      PATH: '/usr/bin',
      LC_ALL: 'C'
    })
  })

  it('lets a caller set one of the stripped variables on purpose', () => {
    // Stripping is about not *leaking* ours. A value the caller named is a
    // decision about the child, and must survive.
    expect(hostEnvironment({ EGL_PLATFORM: 'wayland' }, { EGL_PLATFORM: 'x11' })).toEqual({
      EGL_PLATFORM: 'x11'
    })
  })

  it('does not mutate the environment it was handed', () => {
    const base = { EGL_PLATFORM: 'wayland', PATH: '/usr/bin' }
    hostEnvironment(base)
    expect(base.EGL_PLATFORM).toBe('wayland')
  })
})

describe('printableCommand', () => {
  it('reads as the line a user would have to type', () => {
    expect(printableCommand('flatpak', ['run', 'com.nvidia.geforcenow'])).toBe(
      'flatpak run com.nvidia.geforcenow'
    )
  })
})

describe('classifyHostFailure', () => {
  it('names a revoked host permission, and how to restore it', () => {
    const failure = classifyHostFailure({ stderr: BLOCKED_STDERR }, true)

    expect(failure.kind).toBe('blocked')
    expect(failure.message).toContain('org.freedesktop.Flatpak')
    expect(failure.message).toContain('flatpak override')
  })

  it('reads a command the host cannot start as missing, not as a permission problem', () => {
    expect(classifyHostFailure({ stderr: MISSING_STDERR }, true).kind).toBe('missing')
  })

  it('reads a non-executable host binary as missing, though its message says "permission"', () => {
    // The inner text is the portal's, and translated: matching "permission
    // denied" would classify a file mode as a sandbox refusal, and send the user
    // to Flatseal to fix something Flatseal cannot fix.
    expect(classifyHostFailure({ stderr: NOT_EXECUTABLE_STDERR }, true).kind).toBe('missing')
  })

  it('does not decide on the "Portal call failed" prefix, which both failures share', () => {
    expect(MISSING_STDERR.startsWith('Portal call failed')).toBe(true)
    expect(BLOCKED_STDERR.startsWith('Portal call failed')).toBe(true)
    expect(classifyHostFailure({ stderr: MISSING_STDERR }, true).kind).not.toBe(
      classifyHostFailure({ stderr: BLOCKED_STDERR }, true).kind
    )
  })

  it('reports a non-zero child as failed, and prefers its stderr', () => {
    const failure = classifyHostFailure(
      Object.assign(new Error('Command failed with exit code 1'), {
        stderr: 'Call to Suspend failed: Interactive authentication required.\n'
      }),
      true
    )

    expect(failure.kind).toBe('failed')
    expect(failure.message).toBe('Call to Suspend failed: Interactive authentication required.')
  })

  it('falls back to the error message when the command said nothing', () => {
    expect(classifyHostFailure(new Error('Command failed with exit code 4'), true)).toEqual({
      kind: 'failed',
      message: 'Command failed with exit code 4'
    })
  })

  it('reads a killed command as a timeout, not as the command having failed', () => {
    // `execFile`'s own timeout kills the child, and what comes back is an error
    // whose only distinguishing mark is `killed`. Reading it as `failed` would
    // report "GeForce NOW could not be started" for a portal that had stopped
    // answering — pointing the user at the wrong program entirely.
    const failure = classifyHostFailure(
      Object.assign(new Error('Command failed: flatpak ps'), {
        killed: true,
        signal: 'SIGTERM',
        stderr: ''
      }),
      true
    )

    expect(failure.kind).toBe('timeout')
    expect(failure.message).toContain('portal')
  })

  it('decides the timeout before reading stderr, which a killed command may have dirtied', () => {
    expect(
      classifyHostFailure({ killed: true, stderr: BLOCKED_STDERR }, true).kind
    ).toBe('timeout')
  })

  it('does not read an over-long answer as no answer', () => {
    // `maxBuffer` overflow sets `killed` too, and means the opposite of a
    // timeout: the command replied, at length.
    expect(
      classifyHostFailure(
        Object.assign(new Error('stdout maxBuffer length exceeded'), {
          killed: true,
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        }),
        true
      ).kind
    ).toBe('failed')
  })

  it('reports a missing binary outside a sandbox with the error node gave', () => {
    const failure = classifyHostFailure(
      Object.assign(new Error('spawn flatpak ENOENT'), { code: 'ENOENT' }),
      false
    )

    expect(failure).toEqual({ kind: 'missing', message: 'spawn flatpak ENOENT' })
  })

  it('blames the runtime, not the user, when flatpak-spawn itself is absent', () => {
    const failure = classifyHostFailure(
      Object.assign(new Error('spawn flatpak-spawn ENOENT'), { code: 'ENOENT' }),
      true
    )

    expect(failure.kind).toBe('missing')
    expect(failure.message).toContain('flatpak-spawn is missing from the runtime')
  })

  it('never reads sandbox diagnostics out of a host-side error', () => {
    // Unsandboxed, the portal text cannot occur — and if something echoes it
    // back at us anyway, it must not become advice to edit Flatseal.
    expect(classifyHostFailure({ stderr: BLOCKED_STDERR }, false).kind).toBe('failed')
  })
})
