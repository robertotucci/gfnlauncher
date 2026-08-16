import { describe, expect, it } from 'vitest'
import { buildPowerArgv, isPowerAction } from './power'

// Argv only, never execution: a test that actually ran one of these would
// suspend or reboot the machine running the suite.
describe('buildPowerArgv', () => {
  it('maps each action onto its systemctl verb', () => {
    expect(buildPowerArgv('suspend')).toEqual(['systemctl', 'suspend'])
    expect(buildPowerArgv('reboot')).toEqual(['systemctl', 'reboot'])
    expect(buildPowerArgv('poweroff')).toEqual(['systemctl', 'poweroff'])
  })

  it('passes the verb as an argument rather than building a shell string', () => {
    // execFile with an argv array, so nothing here is ever parsed by a shell.
    expect(buildPowerArgv('poweroff')).toHaveLength(2)
  })
})

describe('isPowerAction', () => {
  it('accepts the three supported actions', () => {
    expect(isPowerAction('suspend')).toBe(true)
    expect(isPowerAction('reboot')).toBe(true)
    expect(isPowerAction('poweroff')).toBe(true)
  })

  it('rejects anything else the bridge might be handed', () => {
    // The renderer is trusted, but the channel is the boundary: whatever
    // arrives here becomes an argument to systemctl.
    expect(isPowerAction('halt')).toBe(false)
    // "Back to desktop" shares the dialog with these three and nothing else:
    // it minimises the window, it has no logind verb, and it must never reach
    // an argv builder that hands whatever it is given to systemctl.
    expect(isPowerAction('desktop')).toBe(false)
    expect(isPowerAction('minimize')).toBe(false)
    expect(isPowerAction('suspend; rm -rf /')).toBe(false)
    expect(isPowerAction('')).toBe(false)
    expect(isPowerAction(undefined)).toBe(false)
    expect(isPowerAction(null)).toBe(false)
    expect(isPowerAction(0)).toBe(false)
  })
})
