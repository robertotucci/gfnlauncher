import { describe, expect, it } from 'vitest'
import { bluezOwnerChange } from './bluez'

describe('bluezOwnerChange', () => {
  it('reads a new owner as BlueZ being there', () => {
    expect(bluezOwnerChange(['org.bluez', '', ':1.212'])).toBe(true)
  })

  it('reads an empty new owner as BlueZ having gone', () => {
    expect(bluezOwnerChange(['org.bluez', ':1.7', ''])).toBe(false)
  })

  it('ignores every other name', () => {
    expect(bluezOwnerChange(['org.freedesktop.locale1', '', ':1.40'])).toBeNull()
  })

  it('treats a malformed owner as nobody rather than throwing', () => {
    expect(bluezOwnerChange(['org.bluez'])).toBe(false)
  })
})
