import { beforeEach, describe, expect, it, vi } from 'vitest'

const hostExecFile = vi.fn()
const notify = vi.fn()

vi.mock('./host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./host')>()),
  hostExecFile: (...args: unknown[]) => hostExecFile(...args)
}))
vi.mock('./notify', () => ({ notify: (...args: unknown[]) => notify(...args) }))

const {
  adjustVolume,
  nextVolume,
  pactlInfoArgs,
  pactlListSinksArgs,
  pactlSetMuteArgs,
  pactlSetVolumeArgs,
  parseDefaultSink,
  parseSink,
  volumeFailureReason
} = await import('./volume')

/** The shape `pactl --format=json` prints, trimmed. The address is a placeholder. */
const HEADSET = 'bluez_output.00_11_22_33_44_55.1'

function channel(value: number): { value: number; value_percent: string; db: string } {
  return { value, value_percent: `${Math.round((value / 65_536) * 100)}%`, db: '0.00 dB' }
}

function sinks(headset: { left: number; right: number; mute?: boolean }): string {
  return JSON.stringify([
    {
      index: 45,
      name: 'alsa_output.pci-0000_00_1f.3.analog-stereo',
      description: 'Built-in Audio Analog Stereo',
      mute: false,
      volume: { 'front-left': channel(26_214), 'front-right': channel(26_214) }
    },
    {
      index: 58,
      name: HEADSET,
      description: 'WH-1000XM4',
      mute: headset.mute ?? false,
      volume: { 'front-left': channel(headset.left), 'front-right': channel(headset.right) }
    }
  ])
}

const INFO = JSON.stringify({ server_name: 'PulseAudio (on PipeWire 1.6.8)', default_sink_name: HEADSET })

describe('pactl argv', () => {
  it('reads as JSON', () => {
    expect(pactlInfoArgs()).toEqual(['--format=json', 'info'])
    expect(pactlListSinksArgs()).toEqual(['--format=json', 'list', 'sinks'])
  })

  it('writes to the default sink by alias, never by name', () => {
    // A Bluetooth sink's name is the device address, and `hostExecFile` logs
    // the argv of any command that fails.
    expect(pactlSetVolumeArgs(45)).toEqual(['set-sink-volume', '@DEFAULT_SINK@', '45%'])
    expect(pactlSetMuteArgs(false)).toEqual(['set-sink-mute', '@DEFAULT_SINK@', '0'])
    expect(pactlSetMuteArgs(true)).toEqual(['set-sink-mute', '@DEFAULT_SINK@', '1'])
  })
})

describe('parseDefaultSink', () => {
  it('reads the default sink out of `info`', () => {
    expect(parseDefaultSink(INFO)).toBe(HEADSET)
  })

  it('answers null for no default, an empty one, or text from an older pactl', () => {
    expect(parseDefaultSink('{}')).toBeNull()
    expect(parseDefaultSink(JSON.stringify({ default_sink_name: '' }))).toBeNull()
    expect(parseDefaultSink('Server String: /run/user/1000/pulse/native')).toBeNull()
  })
})

describe('parseSink', () => {
  it('finds the named sink and reports its level and description', () => {
    expect(parseSink(sinks({ left: 29_491, right: 29_491 }), HEADSET)).toEqual({
      description: 'WH-1000XM4',
      percent: 45,
      muted: false
    })
  })

  it('takes the loudest channel as the level, so the ceiling holds off centre', () => {
    expect(parseSink(sinks({ left: 32_768, right: 65_536 }), HEADSET)?.percent).toBe(100)
  })

  it('reports mute', () => {
    expect(parseSink(sinks({ left: 32_768, right: 32_768, mute: true }), HEADSET)?.muted).toBe(true)
  })

  it('answers null for a sink that is not there, or output that is not JSON', () => {
    expect(parseSink(sinks({ left: 1, right: 1 }), 'nope')).toBeNull()
    expect(parseSink('Sink #45', HEADSET)).toBeNull()
  })
})

describe('nextVolume', () => {
  it('steps', () => {
    expect(nextVolume(45, 5)).toBe(50)
    expect(nextVolume(45, -5)).toBe(40)
  })

  it('stops at 100, because past it is distortion', () => {
    expect(nextVolume(98, 5)).toBe(100)
    expect(nextVolume(130, 5)).toBe(100)
  })

  it('stops at 0', () => {
    expect(nextVolume(3, -5)).toBe(0)
  })
})

describe('volumeFailureReason', () => {
  it('says something short for every kind', () => {
    for (const kind of ['missing', 'blocked', 'timeout', 'failed'] as const) {
      expect(volumeFailureReason(kind).length).toBeGreaterThan(0)
    }
  })
})

describe('adjustVolume', () => {
  /** Lets every pending host call and the drain loop run to the end. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  /** A fake sound server: answers reads from `level`, applies writes to it. */
  function soundServer(start: number, mute = false): { calls: string[][] } {
    let level = Math.round((start / 100) * 65_536)
    let muted = mute
    const calls: string[][] = []

    hostExecFile.mockImplementation(async (_command: string, args: string[]) => {
      calls.push(args)
      if (args[1] === 'info') return { stdout: INFO, stderr: '' }
      if (args[1] === 'list') return { stdout: sinks({ left: level, right: level, mute: muted }), stderr: '' }
      if (args[0] === 'set-sink-volume') level = Math.round((parseInt(args[2] ?? '', 10) / 100) * 65_536)
      if (args[0] === 'set-sink-mute') muted = args[2] === '1'
      return { stdout: '', stderr: '' }
    })
    return { calls }
  }

  beforeEach(() => {
    hostExecFile.mockReset()
    notify.mockReset()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('moves the level and names the output on the card', async () => {
    soundServer(45)

    adjustVolume(5)
    await settle()

    expect(notify).toHaveBeenLastCalledWith({
      kind: 'volume',
      percent: 50,
      muted: false,
      output: 'WH-1000XM4'
    })
  })

  it('adds up the presses that arrive during a round instead of queuing rounds', async () => {
    const { calls } = soundServer(45)

    adjustVolume(5)
    adjustVolume(5)
    adjustVolume(5)
    await settle()

    const writes = calls.filter((args) => args[0] === 'set-sink-volume')
    expect(writes).toEqual([pactlSetVolumeArgs(50), pactlSetVolumeArgs(60)])
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ percent: 60 }))
  })

  it('does not write at the ceiling, and still says where it is', async () => {
    const { calls } = soundServer(100)

    adjustVolume(5)
    await settle()

    expect(calls.some((args) => args[0] === 'set-sink-volume')).toBe(false)
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ percent: 100 }))
  })

  it('unmutes on the way up and leaves a mute alone on the way down', async () => {
    const up = soundServer(40, true)
    adjustVolume(5)
    await settle()
    expect(up.calls).toContainEqual(pactlSetMuteArgs(false))
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ muted: false }))

    const down = soundServer(40, true)
    adjustVolume(-5)
    await settle()
    expect(down.calls.some((args) => args[0] === 'set-sink-mute')).toBe(false)
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ muted: true }))
  })

  it('says so when there is no output, rather than doing nothing', async () => {
    hostExecFile.mockResolvedValue({ stdout: '{}', stderr: '' })

    adjustVolume(5)
    await settle()

    expect(notify).toHaveBeenLastCalledWith({
      kind: 'volume-unavailable',
      reason: 'No audio output found'
    })
  })

  it('turns a missing pactl into a card that says so', async () => {
    hostExecFile.mockRejectedValue(Object.assign(new Error('spawn pactl ENOENT'), { code: 'ENOENT' }))

    adjustVolume(5)
    await settle()

    expect(notify).toHaveBeenLastCalledWith({
      kind: 'volume-unavailable',
      reason: volumeFailureReason('missing')
    })
  })

  it('never logs the sink name', async () => {
    soundServer(45)
    const info = vi.mocked(console.info)

    adjustVolume(5)
    await settle()

    const logged = info.mock.calls.flat().join(' ')
    expect(logged).toContain('WH-1000XM4')
    expect(logged).not.toContain('00_11_22')
  })
})
