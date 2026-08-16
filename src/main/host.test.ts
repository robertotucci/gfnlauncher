import { describe, expect, it } from 'vitest'
import { classifyHostFailure, hostCommand, printableCommand } from './host'

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
