import { describe, expect, it, vi } from 'vitest'

// The module reaches for Electron at call time, but importing it still pulls
// the package in. Same stub as details.test.ts and recent.test.ts.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) }
}))

const { buildClientHints, buildStreamerUrl, buildUserAgent } = await import('./webStream')

describe('buildStreamerUrl', () => {
  it('routes through the web build, not the desktop deep link', () => {
    // These are two different Angular bundles. The Flatpak's has a `deeplink`
    // route and no `streamer`; the web build is the other way round. Sending
    // either form to the wrong target opens the home screen at best.
    expect(buildStreamerUrl({ cmsId: '100', gameId: '100' })).toBe(
      'https://play.geforcenow.com/mall/#/streamer?launchSource=External&cmsId=100&shortName=100'
    )
  })

  it('pins the store here too, which this route was long thought unable to do', () => {
    // The two routes differ in shape, not in vocabulary — the same parser reads
    // shortName off either one — and without it a multi-store title gets the
    // picker on this path exactly as it did on the deep link.
    expect(buildStreamerUrl({ cmsId: '100', gameId: '100', shortName: 'witcher3' })).toContain(
      '&shortName=witcher3'
    )
    for (const shortName of [null, undefined, '']) {
      expect(buildStreamerUrl({ cmsId: '100', gameId: '100', shortName })).toContain(
        '&shortName=100'
      )
    }
  })

  it('keeps the query inside the fragment', () => {
    // Everything after `#` is the route. A `?` before it would send these to
    // the server as a real query string and lose them.
    const url = buildStreamerUrl({ cmsId: '100', gameId: '100' })
    expect(url.indexOf('#')).toBeLessThan(url.indexOf('?'))
  })

  it('tags the launch source as External, like the native path', () => {
    // A real member of the client's enum, mapped straight onto a telemetry
    // dimension. gfn-electron sends GeForceNOW because it *is* the mall.
    expect(buildStreamerUrl({ cmsId: '1', gameId: '1' })).toContain('launchSource=External')
  })

  it('encodes values that would otherwise break the query string', () => {
    expect(buildStreamerUrl({ cmsId: 'a&b=c', gameId: 'a&b=c' })).toContain('cmsId=a%26b%3Dc')
  })

  it('never sends gameId', () => {
    // Same rule as the deep link: it is ours, for play history, and the client
    // would not know what to do with it.
    expect(buildStreamerUrl({ cmsId: '100', gameId: '999' })).not.toContain('999')
  })
})

describe('buildUserAgent', () => {
  it('claims Edge on Linux rather than Electron', () => {
    const ua = buildUserAgent('120.0.6099.109')
    expect(ua).toContain('X11; Linux x86_64')
    expect(ua).toContain('Edg/120.0.6099.109')
    expect(ua).not.toMatch(/Electron/i)
  })
})

describe('buildClientHints', () => {
  it('agrees with the user agent on the major version', () => {
    // A user agent claiming Edge alongside hints claiming something else is a
    // stronger bot signal than either would be alone.
    const hints = buildClientHints('120.0.6099.109')
    expect(hints['sec-ch-ua']).toContain('"Microsoft Edge";v="120"')
    expect(hints['sec-ch-ua']).toContain('"Chromium";v="120"')
    expect(hints['sec-ch-ua-platform']).toBe('"Linux"')
    expect(hints['sec-ch-ua-mobile']).toBe('?0')
  })
})
