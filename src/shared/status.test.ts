import { describe, expect, it } from 'vitest'
import { formatWindow, healthRank, isNotable, relativeTime } from './status'

describe('healthRank', () => {
  it('sorts worst first', () => {
    const sorted = [
      'operational',
      'major_outage',
      'degraded_performance',
      'partial_outage'
    ] as const
    expect([...sorted].sort((a, b) => healthRank(b) - healthRank(a))).toEqual([
      'major_outage',
      'partial_outage',
      'degraded_performance',
      'operational'
    ])
  })

  it('puts planned work below operational, so it never buries a real outage', () => {
    expect(healthRank('under_maintenance')).toBeLessThan(healthRank('operational'))
  })
})

describe('isNotable', () => {
  it('is quiet only about the state that needs no attention', () => {
    expect(isNotable('operational')).toBe(false)
    expect(isNotable('under_maintenance')).toBe(true)
    expect(isNotable('unknown')).toBe(true)
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z')
  const ago = (ms: number): string => relativeTime(new Date(now - ms).toISOString(), now)

  it('collapses the last few seconds', () => {
    expect(ago(3_000)).toBe('just now')
  })

  it('counts seconds, then minutes, then hours, then days', () => {
    expect(ago(40_000)).toBe('40 seconds ago')
    expect(ago(5 * 60_000)).toBe('5 minutes ago')
    expect(ago(3 * 3_600_000)).toBe('3 hours ago')
    expect(ago(3 * 86_400_000)).toBe('3 days ago')
  })

  it('drops the plural for one', () => {
    expect(ago(60_000)).toBe('1 minute ago')
    expect(ago(3_600_000)).toBe('1 hour ago')
    expect(ago(86_400_000)).toBe('1 day ago')
  })

  it('reads a clock that is ahead of us as now rather than negative', () => {
    expect(relativeTime(new Date(now + 60_000).toISOString(), now)).toBe('just now')
  })

  it('says so rather than printing NaN', () => {
    expect(relativeTime('not a date', now)).toBe('unknown')
  })
})

// Both windows are anchored at midday and either an hour or two whole days
// apart, so the assertions hold whatever timezone the suite runs in. Statuspage
// sends offsets, and the launcher renders in local time.
describe('formatWindow', () => {
  it('drops the repeated date on a same-day window', () => {
    const line = formatWindow('2026-08-20T12:00:00.000Z', '2026-08-20T13:00:00.000Z', 'en-GB')
    // One date, two times.
    expect(line.match(/Aug/g)).toHaveLength(1)
    expect(line).toContain('–')
  })

  it('keeps both dates when the window spans more than a day', () => {
    const line = formatWindow('2026-08-20T12:00:00.000Z', '2026-08-22T12:00:00.000Z', 'en-GB')
    expect(line.match(/Aug/g)).toHaveLength(2)
  })

  it('returns nothing rather than "Invalid Date" on junk', () => {
    expect(formatWindow('nope', 'also nope', 'en-GB')).toBe('')
  })
})
