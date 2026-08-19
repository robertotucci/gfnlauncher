import { describe, expect, it } from 'vitest'
import {
  BLUETOOTH_ACTIONS,
  isBluetoothAction,
  isBluetoothAddress,
  signalBars
} from './bluetooth'

describe('isBluetoothAction', () => {
  it('accepts every member of the union', () => {
    for (const action of BLUETOOTH_ACTIONS) expect(isBluetoothAction(action)).toBe(true)
  })

  it('refuses anything else, since the value becomes a D-Bus method call', () => {
    for (const value of ['Pair', 'remove', '', 'pair ', null, 42, {}, ['pair']]) {
      expect(isBluetoothAction(value)).toBe(false)
    }
  })
})

describe('isBluetoothAddress', () => {
  it('accepts the uppercase colon-separated form BlueZ publishes', () => {
    expect(isBluetoothAddress('00:1A:7D:DA:71:13')).toBe(true)
    expect(isBluetoothAddress('FF:FF:FF:FF:FF:FF')).toBe(true)
  })

  it('refuses lowercase, so the string can be compared without folding', () => {
    expect(isBluetoothAddress('00:1a:7d:da:71:13')).toBe(false)
  })

  it('refuses anything that is not exactly six octets', () => {
    for (const value of [
      '00:1A:7D:DA:71',
      '00:1A:7D:DA:71:13:99',
      '001A7DDA7113',
      '00-1A-7D-DA-71-13',
      // The shapes that would matter if this were ever interpolated into an
      // object path rather than looked up.
      '00:1A:7D:DA:71:13/../../org/bluez',
      '',
      null,
      undefined,
      12345
    ]) {
      expect(isBluetoothAddress(value)).toBe(false)
    }
  })
})

describe('signalBars', () => {
  it('reserves zero for "no reading at all"', () => {
    expect(signalBars(null)).toBe(0)
    expect(signalBars(Number.NaN)).toBe(0)
  })

  it('never returns zero for a device the adapter can actually hear', () => {
    for (const rssi of [-55, -70, -90, -110, -127]) {
      expect(signalBars(rssi)).toBeGreaterThan(0)
    }
  })

  it('rises with the signal', () => {
    expect(signalBars(-30)).toBe(4)
    expect(signalBars(-55)).toBe(4)
    expect(signalBars(-56)).toBe(3)
    expect(signalBars(-67)).toBe(3)
    expect(signalBars(-68)).toBe(2)
    expect(signalBars(-78)).toBe(2)
    expect(signalBars(-79)).toBe(1)
  })

  it('is monotonic, so a closer device never draws fewer ticks', () => {
    let previous = 0
    for (let rssi = -120; rssi <= 0; rssi += 1) {
      const bars = signalBars(rssi)
      expect(bars).toBeGreaterThanOrEqual(previous)
      previous = bars
    }
  })
})
