import { describe, expect, it } from 'vitest'
import { buildLaunchArgv, buildOpenArgv, buildUrlRoute, isLaunchRequest } from './launch'

describe('buildUrlRoute', () => {
  it('puts cmsId first and always tags the launch source', () => {
    expect(buildUrlRoute({ cmsId: '100', gameId: '100' })).toBe(
      '#?cmsId=100&launchSource=External&shortName=100'
    )
  })

  it('emits the parameter order the client itself uses', () => {
    // The CEF binary's own string table holds this template contiguously —
    // ` --url-route="#?`, `cmsId=`, `&launchSource=`, `&shortName=`,
    // `&parentGameId=` — because that is how it relaunches itself. Matching it
    // costs nothing and removes a variable if a deep link ever stops arriving.
    expect(buildUrlRoute({ cmsId: '1', gameId: '1', shortName: 's', parentGameId: 'p' })).toBe(
      '#?cmsId=1&launchSource=External&shortName=s&parentGameId=p'
    )
  })

  it('always carries a shortName, because its absence hands the store choice back', () => {
    // Not cosmetic. Without the parameter the client discards the variant we
    // named and resolves one itself, through a query that cannot see which
    // store the account picked — so every multi-store title opens the picker.
    // The feed leaves the slug empty on 4.504 of 6.917 variants, so this is
    // the common case, not the edge one.
    for (const shortName of [null, undefined, '']) {
      expect(buildUrlRoute({ cmsId: '100', gameId: '100', shortName })).toContain(
        '&shortName=100'
      )
    }
  })

  it('prefers the feed slug over the id when there is one', () => {
    expect(buildUrlRoute({ cmsId: '100', gameId: '100', shortName: 'witcher3' })).toContain(
      '&shortName=witcher3'
    )
  })

  it('still omits parentGameId rather than sending an empty one', () => {
    // The one optional where omission is right: the app normalises a missing
    // parameter to `""`, so sending nothing and sending empty are the same.
    const route = buildUrlRoute({
      cmsId: '100',
      gameId: '100',
      shortName: null,
      parentGameId: null
    })
    expect(route).not.toContain('parentGameId')
  })

  it('includes optional parameters when present', () => {
    const route = buildUrlRoute({
      cmsId: '100',
      gameId: '100',
      shortName: 'witcher3',
      parentGameId: '55'
    })
    expect(route).toBe('#?cmsId=100&launchSource=External&shortName=witcher3&parentGameId=55')
  })

  it('encodes values that would otherwise break the query string', () => {
    expect(buildUrlRoute({ cmsId: 'a&b=c', gameId: 'a&b=c' })).toContain('cmsId=a%26b%3Dc')
  })

  it('never sends gameId to the client', () => {
    // It exists for play history on our side; the deep link takes the variant
    // and would not know what to do with the game it came from.
    expect(buildUrlRoute({ cmsId: '100', gameId: '999' })).not.toContain('999')
  })
})

describe('buildLaunchArgv', () => {
  const argv = buildLaunchArgv({ cmsId: '42', gameId: '42' })

  it('targets the CEF binary directly', () => {
    // The /app/bin/GeForceNOW wrapper drops argv, so routing through the app's
    // default command would silently discard the deep link.
    expect(argv).toContain('--command=/app/cef/GeForceNOW')
  })

  it('reproduces the working directory the wrapper would have set', () => {
    expect(argv).toContain('--cwd=/app/cef')
  })

  it('passes the app id before the application arguments', () => {
    expect(argv.indexOf('com.nvidia.geforcenow')).toBeLessThan(
      argv.findIndex((arg) => arg.startsWith('--url-route='))
    )
  })
})

describe('isLaunchRequest', () => {
  it('accepts the shape resolveLaunchTarget produces', () => {
    expect(isLaunchRequest({ cmsId: '1', gameId: '2' })).toBe(true)
    expect(
      isLaunchRequest({ cmsId: '1', gameId: '2', shortName: null, parentGameId: null })
    ).toBe(true)
    expect(isLaunchRequest({ cmsId: '1', gameId: '2', shortName: 'x', parentGameId: 'y' })).toBe(
      true
    )
  })

  it('rejects payloads that are not objects at all', () => {
    // The bridge hands through whatever the renderer passed, so `undefined` and
    // a bare string are both reachable from a devtools console.
    for (const value of [null, undefined, 'x', 42, []]) {
      expect(isLaunchRequest(value)).toBe(false)
    }
  })

  it('rejects an empty id, which would open the home screen instead', () => {
    expect(isLaunchRequest({ cmsId: '', gameId: '2' })).toBe(false)
  })

  it('requires gameId, because play history has nothing to key on without it', () => {
    expect(isLaunchRequest({ cmsId: '1' })).toBe(false)
    expect(isLaunchRequest({ cmsId: '1', gameId: '' })).toBe(false)
  })

  it('rejects optionals of the wrong type rather than stringifying them', () => {
    expect(isLaunchRequest({ cmsId: '1', gameId: '2', shortName: 7 })).toBe(false)
    expect(isLaunchRequest({ cmsId: '1', gameId: '2', parentGameId: {} })).toBe(false)
  })

  it('rejects a field long enough to be an argv problem rather than an id', () => {
    // These four strings are the only renderer-supplied values that become
    // argv. A forged megabyte comes back from `spawn` as a bare E2BIG, which
    // names nothing; refusing it here produces the notice that does.
    const huge = 'x'.repeat(1_000)
    expect(isLaunchRequest({ cmsId: huge, gameId: '2' })).toBe(false)
    expect(isLaunchRequest({ cmsId: '1', gameId: huge })).toBe(false)
    expect(isLaunchRequest({ cmsId: '1', gameId: '2', shortName: huge })).toBe(false)
    expect(isLaunchRequest({ cmsId: '1', gameId: '2', parentGameId: huge })).toBe(false)
  })

  it('still accepts an id far longer than any the catalog produces', () => {
    // The bound is headroom, not a rule about the shape of a real id.
    expect(isLaunchRequest({ cmsId: 'x'.repeat(200), gameId: '2' })).toBe(true)
  })
})

describe('buildOpenArgv', () => {
  it('runs the app plainly, with no deep link', () => {
    expect(buildOpenArgv()).toEqual(['run', 'com.nvidia.geforcenow'])
  })

  it('goes through the wrapper rather than the CEF binary', () => {
    // The inverse of the launch path, and on purpose: the wrapper runs the
    // downloader and the self-update check, which is exactly what someone
    // opening the real client wants and what the deep-link path skips.
    const argv = buildOpenArgv()
    expect(argv.some((arg) => arg.startsWith('--command='))).toBe(false)
    expect(argv.some((arg) => arg.startsWith('--cwd='))).toBe(false)
  })
})
