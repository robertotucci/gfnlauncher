import { describe, expect, it, vi } from 'vitest'

// The module reads userData at call time, not at import time, but the import
// still pulls in electron. Same stub as recent.test.ts.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/gfn-launcher-test' } }))

const { formatArgs, formatLogLine, redactSecrets } = await import('./log')

/**
 * The log file is the one artefact the README asks people to attach to a public
 * issue, so `redactSecrets` is the function that decides whether that request is
 * safe to make. It gets the same treatment as `zone.test.ts`: the fixtures are
 * shaped like the real thing, and both directions are asserted — what must be
 * taken out, and what must survive, because a redaction that eats the
 * diagnostics leaves a file nobody can read.
 */
describe('redactSecrets', () => {
  it('takes out a JWT, which is what the client stores an idToken as', () => {
    const line = redactSecrets(
      'capture: token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    )
    expect(line).not.toContain('eyJ')
    expect(line).toContain('<')
  })

  it('takes out a bearer credential but keeps the scheme, which is a real diagnostic', () => {
    // `webAuth.ts` logs `authScheme=GFNJWT` on purpose: "was this a bearer at
    // all" is half of what a failed capture needs answering.
    const line = redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')
    expect(line).toBe('Authorization: Bearer <redacted>')
  })

  it('takes out a credential named in a JSON body or a query string', () => {
    expect(redactSecrets('{"accessToken":"s3cr3t-value-here"}')).toBe(
      '{"accessToken":"<redacted>"}'
    )
    expect(redactSecrets('?id_token=abc123def456')).toBe('?id_token=<redacted>')
  })

  it('takes out the account email and the machine MAC, both of which sit in sharedstorage.json', () => {
    expect(redactSecrets('idToken email someone@example.com')).toContain('<email>')
    expect(redactSecrets('mac 3c:7c:3f:1a:2b:0d')).toContain('<mac>')
  })

  it('leaves a reverse-DNS application id alone', () => {
    // The obvious three-dotted-segments pattern would have eaten this, and the
    // app id is in nearly every interesting line in the file.
    const ids = 'io.github.robertotucci.GfnLauncher com.nvidia.geforcenow'
    expect(redactSecrets(ids)).toBe(ids)
  })

  it('leaves hostnames, paths and an asset digest alone', () => {
    const line =
      'GET apps.gxn.nvidia.com/graphql · /home/user/.var/app/com.nvidia.geforcenow/x.log · ' +
      'sha256 4437e1497eaa1fdb0d1b1f2a7e9e3e6cf5e2b0e5a5d9b7c1f4a2e6d8c0b3a591'
    expect(redactSecrets(line)).toBe(line)
  })

  it('leaves an ordinary sentence untouched', () => {
    const line = 'GeForce NOW is still running after the session ended'
    expect(redactSecrets(line)).toBe(line)
  })
})

describe('formatArgs', () => {
  it('keeps an error’s stack, which is the reason the file exists', () => {
    const error = new Error('boom')
    expect(formatArgs(['Catalog refresh failed:', error])).toContain('boom')
    expect(formatArgs([error])).toContain('Error')
  })

  it('serialises an object rather than printing [object Object]', () => {
    expect(formatArgs([{ phase: 'verifying', probes: 3 }])).toBe('{"phase":"verifying","probes":3}')
  })

  it('survives a value that cannot be serialised', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatArgs([circular])).toContain('unserialisable')
  })

  it('distinguishes null from undefined, which String() does not do usefully', () => {
    expect(formatArgs([null, undefined])).toBe('null undefined')
  })
})

describe('formatLogLine', () => {
  const at = new Date('2026-08-17T21:52:03.123Z')

  it('puts the timestamp, level and source in fixed columns', () => {
    expect(formatLogLine({ at, level: 'warn', source: 'main', message: 'hello' })).toBe(
      '2026-08-17T21:52:03.123Z  WARN  main  hello\n'
    )
  })

  it('marks the renderer apart from the main process', () => {
    // "the grid threw" and "the catalog walk threw" read identically without it.
    expect(formatLogLine({ at, level: 'error', source: 'gui', message: 'x' })).toContain('gui')
  })

  it('indents a stack so one entry reads as one entry', () => {
    const line = formatLogLine({ at, level: 'error', source: 'main', message: 'a\nb' })
    expect(line).toContain('\n    b')
    expect(line.endsWith('\n')).toBe(true)
  })

  it('truncates a line long enough to turn the log over on its own, and says so', () => {
    const line = formatLogLine({
      at,
      level: 'error',
      source: 'main',
      message: 'x'.repeat(20_000)
    })
    expect(line.length).toBeLessThan(4_200)
    expect(line).toContain('truncated')
  })
})
