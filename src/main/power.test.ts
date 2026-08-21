import { describe, expect, it } from 'vitest'
import { POWER_TOOLS, buildPowerArgv, isPowerAction } from './power'

// Argv only, never execution: a test that actually ran one of these would
// suspend or reboot the machine running the suite.
describe('buildPowerArgv', () => {
  it('maps each action onto its systemctl verb', () => {
    expect(buildPowerArgv('suspend')).toEqual(['systemctl', 'suspend'])
    expect(buildPowerArgv('reboot')).toEqual(['systemctl', 'reboot'])
    expect(buildPowerArgv('poweroff')).toEqual(['systemctl', 'poweroff'])
  })

  it('defaults to systemctl, which is the one every desktop menu runs', () => {
    // The fallback exists for elogind machines and must never be what a systemd
    // one reaches for first.
    expect(buildPowerArgv('poweroff')[0]).toBe('systemctl')
    expect(POWER_TOOLS[0]).toBe('systemctl')
  })

  it('spells the verb the same for loginctl, which is why one word is enough', () => {
    // elogind ships `loginctl` and no `systemctl`, and it takes these three
    // verbs identically. If that ever stopped being true the fallback would
    // need a per-tool verb table rather than a per-tool binary name.
    expect(buildPowerArgv('suspend', 'loginctl')).toEqual(['loginctl', 'suspend'])
    expect(buildPowerArgv('reboot', 'loginctl')).toEqual(['loginctl', 'reboot'])
    expect(buildPowerArgv('poweroff', 'loginctl')).toEqual(['loginctl', 'poweroff'])
  })

  it('passes the verb as an argument rather than building a shell string', () => {
    // execFile with an argv array, so nothing here is ever parsed by a shell.
    expect(buildPowerArgv('poweroff')).toHaveLength(2)
    expect(buildPowerArgv('poweroff', 'loginctl')).toHaveLength(2)
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
