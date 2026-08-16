import { describe, expect, it, vi } from 'vitest'

// The module reaches for userData at call time, not at import time, but the
// import still pulls in electron. Same stub as details.test.ts.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/gfn-launcher-test' } }))

const { pushRecent } = await import('./recent')

function entry(cmsId: string, playedAt = `2026-08-01T00:00:0${cmsId}Z`): {
  cmsId: string
  playedAt: string
} {
  return { cmsId, playedAt }
}

describe('pushRecent', () => {
  it('puts the newest title first', () => {
    const next = pushRecent([entry('1'), entry('2')], '3', 'now')
    expect(next.map((item) => item.cmsId)).toEqual(['3', '1', '2'])
  })

  it('promotes a replay instead of duplicating it', () => {
    // Otherwise a favourite would fill the whole list on its own.
    const next = pushRecent([entry('1'), entry('2'), entry('3')], '3', 'now')
    expect(next.map((item) => item.cmsId)).toEqual(['3', '1', '2'])
    expect(next[0]).toEqual({ cmsId: '3', playedAt: 'now' })
  })

  it('truncates from the back, so the oldest is what falls off', () => {
    const full = Array.from({ length: 10 }, (_, index) => entry(String(index)))
    const next = pushRecent(full, 'new', 'now', 10)
    expect(next).toHaveLength(10)
    expect(next[0]).toEqual({ cmsId: 'new', playedAt: 'now' })
    expect(next.map((item) => item.cmsId)).not.toContain('9')
  })

  it('does not grow past the limit when a replay is promoted', () => {
    const full = Array.from({ length: 10 }, (_, index) => entry(String(index)))
    const next = pushRecent(full, '5', 'now', 10)
    expect(next).toHaveLength(10)
    expect(next.map((item) => item.cmsId)).toEqual(['5', '0', '1', '2', '3', '4', '6', '7', '8', '9'])
  })

  it('leaves the input alone', () => {
    // The caller holds the memoised list; mutating it in place would have the
    // history change under a write that then fails.
    const before = [entry('1')]
    pushRecent(before, '2', 'now')
    expect(before.map((item) => item.cmsId)).toEqual(['1'])
  })

  it('starts a history from nothing', () => {
    expect(pushRecent([], '1', 'now')).toEqual([{ cmsId: '1', playedAt: 'now' }])
  })
})
