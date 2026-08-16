import { describe, expect, it } from 'vitest'
import type { LaunchResult } from '@shared/types'
import { launchFailureReason } from './LaunchNotice'

function result(patch: Partial<LaunchResult> = {}): LaunchResult {
  return { ok: false, command: null, error: null, mode: 'native', ...patch }
}

describe('launchFailureReason', () => {
  it('explains a missing flatpak instead of quoting the spawn error', () => {
    // "spawn flatpak ENOENT" names the fault exactly and explains nothing, and
    // the person reading it is on a sofa without a keyboard.
    expect(launchFailureReason(result({ error: 'spawn flatpak ENOENT' }))).toBe(
      'Flatpak is not installed, or not on PATH.'
    )
  })

  it('names a rejected payload as a catalog problem, not a system one', () => {
    expect(launchFailureReason(result({ error: 'Malformed launch request' }))).toBe(
      'This title has no launchable id.'
    )
  })

  it('says which client failed on the web path', () => {
    expect(launchFailureReason(result({ mode: 'web', error: 'ERR_CONNECTION_REFUSED' }))).toBe(
      'The GeForce NOW web client would not open.'
    )
  })

  it('passes an unrecognised error through rather than swallowing it', () => {
    // An unhelpful message still beats a generic one: it is the only thread
    // back to the real fault.
    expect(launchFailureReason(result({ error: 'bwrap: Permission denied' }))).toBe(
      'bwrap: Permission denied'
    )
  })

  it('always has something to say, even with no error at all', () => {
    expect(launchFailureReason(result())).toBe('GeForce NOW did not start.')
  })
})
