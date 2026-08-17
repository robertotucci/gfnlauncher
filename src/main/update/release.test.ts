import { describe, expect, it } from 'vitest'
import { parseRelease, pickAsset, summariseNotes, type ReleaseAsset } from './release'

/**
 * Trimmed from the real `/releases/latest` payload for v0.1.0 — the field names,
 * the `sha256:` digest prefix and the dotted AppImage filename are all as GitHub
 * actually sends them.
 */
const payload = {
  tag_name: 'v0.1.0',
  html_url: 'https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.0',
  published_at: '2026-08-16T22:46:17Z',
  created_at: '2026-08-17T10:21:05Z',
  draft: false,
  prerelease: false,
  body: '### Added\n\n- **A thing happened.** And here is the reasoning behind it, at length.\n',
  assets: [
    {
      name: 'gfn-launcher_0.1.0_amd64.deb',
      size: 100257824,
      digest: 'sha256:4437e14917d0b21c29c79851b567a5160151cc981507acdd6e8191a975ee1daa',
      browser_download_url:
        'https://github.com/robertotucci/gfnlauncher/releases/download/v0.1.0/gfn-launcher_0.1.0_amd64.deb'
    },
    {
      name: 'GFN.Launcher-0.1.0.AppImage',
      size: 128544775,
      digest: 'sha256:6768204cc3efe6d985bd74fe2f086b2d75d5cb498861eddd4ac3382bfc23166c',
      browser_download_url:
        'https://github.com/robertotucci/gfnlauncher/releases/download/v0.1.0/GFN.Launcher-0.1.0.AppImage'
    },
    {
      name: 'GfnLauncher-0.1.0.flatpak',
      size: 91750736,
      digest: 'sha256:0f7053c918aae81f1252a77b936adf4db66ec2dd5b8af03008df62443f8c6d4e',
      browser_download_url:
        'https://github.com/robertotucci/gfnlauncher/releases/download/v0.1.0/GfnLauncher-0.1.0.flatpak'
    }
  ]
}

describe('parseRelease', () => {
  it('normalises the tag into a version', () => {
    expect(parseRelease(payload)?.version).toBe('0.1.0')
    expect(parseRelease(payload)?.tag).toBe('v0.1.0')
  })

  it('reads the three assets with their sizes', () => {
    const assets = parseRelease(payload)?.assets ?? []
    expect(assets).toHaveLength(3)
    expect(assets[1]?.name).toBe('GFN.Launcher-0.1.0.AppImage')
    expect(assets[1]?.bytes).toBe(128544775)
  })

  it('strips the sha256: prefix off each digest', () => {
    expect(parseRelease(payload)?.assets[1]?.sha256).toBe(
      '6768204cc3efe6d985bd74fe2f086b2d75d5cb498861eddd4ac3382bfc23166c'
    )
  })

  it('refuses a digest that is not 64 hex characters', () => {
    // Nothing is installed unverified, and a digest that is merely *present*
    // proves nothing — only one of the right shape is worth comparing against.
    const raw = {
      ...payload,
      assets: [{ ...payload.assets[1], digest: 'md5:abc123' }]
    }
    expect(parseRelease(raw)?.assets[0]?.sha256).toBeNull()
  })

  it('is null for a draft or a pre-release', () => {
    expect(parseRelease({ ...payload, draft: true })).toBeNull()
    expect(parseRelease({ ...payload, prerelease: true })).toBeNull()
  })

  it('is null when the tag is not a version', () => {
    expect(parseRelease({ ...payload, tag_name: 'nightly' })).toBeNull()
    expect(parseRelease({ ...payload, tag_name: undefined })).toBeNull()
  })

  it('is null for anything that is not an object', () => {
    for (const value of [null, undefined, 'v1.0.0', 42, []]) {
      expect(parseRelease(value)).toBeNull()
    }
  })

  it('falls back to created_at when there is no published_at', () => {
    expect(parseRelease({ ...payload, published_at: null })?.publishedAt).toBe(
      '2026-08-17T10:21:05Z'
    )
  })
})

describe('summariseNotes', () => {
  it('takes the bold lead of a changelog bullet, not the whole paragraph', () => {
    // The lead is the three-metre version of the entry, written by hand. Using
    // it beats truncating the paragraph at a character count.
    const body =
      '- **Starting a game no longer minimises the launcher**, and the setting is gone with it. GeForce NOW raises itself, so the minimise bought nothing.'
    expect(summariseNotes(body)).toEqual([
      'Starting a game no longer minimises the launcher'
    ])
  })

  it('keeps the whole line when the bold part is a label rather than a headline', () => {
    // The bug this pins. Both shapes occur in this project's changelog, and
    // taking the lead unconditionally rendered the v0.1.0 notes as a list of
    // nouns — "Recent", "Details panel" — which is a table of contents, not
    // news about a release.
    expect(summariseNotes('- **Recent**, a chronology of what you played.')).toEqual([
      'Recent, a chronology of what you played.'
    ])
  })

  it('keeps a bullet that has no bold lead', () => {
    expect(summariseNotes('- Fixed the thing that was broken.')).toEqual([
      'Fixed the thing that was broken.'
    ])
  })

  it('stops at the install section CI appends', () => {
    const body = [
      '- **The launcher now does the thing it did not do before.** Detail.',
      '',
      '## Install',
      '',
      '- Not a release note.'
    ].join('\n')
    expect(summariseNotes(body)).toEqual([
      'The launcher now does the thing it did not do before.'
    ])
  })

  it('drops the ### category headings but keeps what is under them', () => {
    const body = ['### Added', '', '- **New.** Detail.', '', '### Fixed', '', '- **Old.** Detail.'].join(
      '\n'
    )
    expect(summariseNotes(body)).toEqual(['New. Detail.', 'Old. Detail.'])
  })

  it('caps the list, so a big release does not fill the screen', () => {
    const body = Array.from({ length: 12 }, (_, index) => `- Entry ${index}`).join('\n')
    expect(summariseNotes(body)).toHaveLength(4)
  })

  it('cuts a long note at a word boundary when there is no sentence to end on', () => {
    const note = summariseNotes(`- ${'word '.repeat(80)}`)[0] ?? ''
    expect(note.endsWith('…')).toBe(true)
    expect(note.length).toBeLessThanOrEqual(161)
    expect(note).not.toMatch(/wor…$/)
  })

  it('prefers ending on a full stop, and then needs no ellipsis', () => {
    // Nothing was interrupted, so nothing should say it was. Four stacked
    // ellipses read as a launcher that could not finish a thought.
    const body = `- ${'a'.repeat(100)}. ${'b'.repeat(100)}.`
    const note = summariseNotes(body)[0] ?? ''
    expect(note).toBe(`${'a'.repeat(100)}.`)
    expect(note.endsWith('…')).toBe(false)
  })

  it('does not cut back to a full stop that sits near the start', () => {
    // Otherwise "Recent. Everything else worth saying about it…" collapses to
    // one word because that is where the only period happened to be.
    const body = `- Short. ${'c'.repeat(200)}`
    const note = summariseNotes(body)[0] ?? ''
    expect(note.startsWith('Short. ccc')).toBe(true)
    expect(note.endsWith('…')).toBe(true)
  })

  it('strips links and code spans down to their text', () => {
    expect(summariseNotes('- See [the docs](https://example.com) and `--flag`.')).toEqual([
      'See the docs and --flag.'
    ])
  })

  it('falls back to prose when a release has no bullets', () => {
    expect(summariseNotes('# Title\n\nJust a sentence.\n\nAnd another.')).toEqual([
      'Just a sentence.',
      'And another.'
    ])
  })

  it('is empty for anything that is not a string', () => {
    expect(summariseNotes(null)).toEqual([])
    expect(summariseNotes(undefined)).toEqual([])
  })
})

describe('pickAsset', () => {
  const assets = parseRelease(payload)?.assets ?? []

  it('matches on the extension, not on the filename', () => {
    // electron-builder names the AppImage after `productName`, so the name
    // changes with the product and only the extension is a contract.
    expect(pickAsset(assets, 'appimage')?.name).toBe('GFN.Launcher-0.1.0.AppImage')
    expect(pickAsset(assets, 'system')?.name).toBe('gfn-launcher_0.1.0_amd64.deb')
  })

  it('is null for flatpak, which downloads nothing of its own', () => {
    // The bundle in the release is for a first install; an upgrade goes through
    // `flatpak update` against a remote.
    expect(pickAsset(assets, 'flatpak')).toBeNull()
  })

  it('is null for unknown', () => {
    expect(pickAsset(assets, 'unknown')).toBeNull()
  })

  it('is null when the release carries no matching artefact', () => {
    const only: ReleaseAsset[] = [
      { name: 'notes.txt', url: 'https://example.com/notes.txt', bytes: 10, sha256: null }
    ]
    expect(pickAsset(only, 'appimage')).toBeNull()
  })
})
