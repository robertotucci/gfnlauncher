import { describe, expect, it } from 'vitest'
import { LATEST_RELEASE_API_URL, LATEST_RELEASE_PAGE_URL } from './update'

/**
 * These two URLs decide where a binary that replaces the launcher comes from,
 * and one of them is encoded into a QR code nobody can proofread by eye. Same
 * reasoning as `donate.test.ts`: a typo or a bad merge would repoint them
 * silently, and the only symptom would be an update that came from somewhere
 * else.
 */
describe('release URLs', () => {
  it('are https, so no update can arrive over plaintext', () => {
    expect(new URL(LATEST_RELEASE_API_URL).protocol).toBe('https:')
    expect(new URL(LATEST_RELEASE_PAGE_URL).protocol).toBe('https:')
  })

  it('point at GitHub itself, not at a mirror or a lookalike host', () => {
    expect(new URL(LATEST_RELEASE_API_URL).hostname).toBe('api.github.com')
    expect(new URL(LATEST_RELEASE_PAGE_URL).hostname).toBe('github.com')
  })

  it('name this repository', () => {
    expect(new URL(LATEST_RELEASE_API_URL).pathname).toBe(
      '/repos/robertotucci/gfnlauncher/releases/latest'
    )
    expect(new URL(LATEST_RELEASE_PAGE_URL).pathname).toBe(
      '/robertotucci/gfnlauncher/releases/latest'
    )
  })

  it('ask for the latest *release*, which excludes drafts and pre-releases', () => {
    // `/releases` would return them; `/releases/latest` does not. A beta tag
    // pushed for testing must not reach every television.
    expect(LATEST_RELEASE_API_URL.endsWith('/releases/latest')).toBe(true)
  })
})
