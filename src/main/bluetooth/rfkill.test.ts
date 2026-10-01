import { describe, expect, it } from 'vitest'
import { rfkillUnblockEvent } from './rfkill'

describe('rfkillUnblockEvent', () => {
  it('is the eight bytes `rfkill unblock bluetooth` writes', () => {
    // idx 0, RFKILL_TYPE_BLUETOOTH, RFKILL_OP_CHANGE_ALL, soft 0, hard 0.
    expect([...rfkillUnblockEvent()]).toEqual([0, 0, 0, 0, 2, 3, 0, 0])
  })

  it('never carries a block', () => {
    const event = rfkillUnblockEvent()
    expect(event[6]).toBe(0)
    expect(event[7]).toBe(0)
  })
})
