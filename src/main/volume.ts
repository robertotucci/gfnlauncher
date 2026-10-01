import { classifyHostFailure, hostExecFile, type HostFailureKind } from './host'
import { notify } from './notify'

/**
 * The volume of whatever the game is playing on, from the pad.
 *
 * Asked for as "the Bluetooth headphones, in game", and built as **the default
 * output** — which is the same thing in the case that was asked about and the
 * right thing in every other. The GeForce NOW client plays to the default sink,
 * PipeWire makes a headset the default when it connects, and somebody playing
 * through the television's speakers has the same problem from the same sofa.
 * The notice names the output, so which one moved is never a guess.
 *
 * Reached from D-pad up and down while the desktop cursor is up — see
 * `pointer/desktop.ts`, which is still the only thing reading the pad while a
 * game is on screen. This module never sees the pad; it is handed a number.
 *
 * ── pactl, through `host.ts` ────────────────────────────────────────────────
 *
 * `pactl` rather than `wpctl`, because it speaks to PulseAudio and to
 * PipeWire's Pulse server alike, and `--format=json` (pactl 16, 2022) means
 * nothing here parses text meant for a person. It goes out through
 * `hostExecFile` for the reason `gsettings` does in `systemKeyboard.ts`: one
 * call that works unsandboxed and inside the Flatpak, on the host permission
 * the launcher already holds, with no new `finish-args`. `LC_ALL=C` is passed
 * for the error text; the JSON keys are not translated.
 *
 * ── The sink's name never leaves this file ──────────────────────────────────
 *
 * A Bluetooth sink is called `bluez_output.AA_BB_CC_DD_EE_FF.1` — the device's
 * address with underscores, which `redactSecrets` does not recognise. So every
 * write is addressed to `@DEFAULT_SINK@`, never to the name: `hostExecFile`
 * prints the whole argv on a failure, and the log is the file the README asks
 * people to attach to a public issue. The name is read to find the output's
 * description in the list and is never logged, sent or put in an argv.
 *
 * ── One round at a time ─────────────────────────────────────────────────────
 *
 * A step is three host calls — two reads and a write — and through
 * `flatpak-spawn` each costs tens of milliseconds, while a held D-pad repeats
 * every 90. Firing a round per repeat would queue writes behind each other and
 * read volumes that a write still in flight was about to change. So steps that
 * arrive during a round are added up and applied together by the next one:
 * the level lands where the presses say, however slow the host is.
 */

/** Percentage points per press. Twenty presses from silence to full. */
export const VOLUME_STEP = 5

/** pactl's 100%, in its own units. */
const PA_VOLUME_NORM = 65_536

const PACTL_ENV = { LC_ALL: 'C' }

export function pactlInfoArgs(): string[] {
  return ['--format=json', 'info']
}

export function pactlListSinksArgs(): string[] {
  return ['--format=json', 'list', 'sinks']
}

/** Absolute rather than `+5%`, so the cap below is ours rather than pactl's — it has none. */
export function pactlSetVolumeArgs(percent: number): string[] {
  return ['set-sink-volume', '@DEFAULT_SINK@', `${percent}%`]
}

export function pactlSetMuteArgs(muted: boolean): string[] {
  return ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']
}

/** The default sink's name out of `pactl --format=json info`, or null. */
export function parseDefaultSink(json: string): string | null {
  const info = parseJson(json)
  const name = (info as { default_sink_name?: unknown } | null)?.default_sink_name
  return typeof name === 'string' && name.length > 0 ? name : null
}

export interface SinkState {
  /** What the sound server calls it — the headphones' own name, for a headset. */
  readonly description: string
  readonly percent: number
  readonly muted: boolean
}

/**
 * One sink out of `pactl --format=json list sinks`, or null.
 *
 * **The loudest channel is the level.** A sink carries a volume per channel,
 * and a balance off centre makes them differ; the highest is the number a
 * desktop's own slider shows, and the one that has to stop at 100.
 */
export function parseSink(json: string, name: string): SinkState | null {
  const sinks = parseJson(json)
  if (!Array.isArray(sinks)) return null

  for (const entry of sinks as unknown[]) {
    const sink = entry as {
      name?: unknown
      description?: unknown
      mute?: unknown
      volume?: unknown
    } | null
    if (sink?.name !== name) continue

    const values = Object.values((sink.volume ?? {}) as Record<string, { value?: unknown }>)
      .map((channel) => channel?.value)
      .filter((value): value is number => typeof value === 'number')
    if (values.length === 0) return null

    return {
      description:
        typeof sink.description === 'string' && sink.description.length > 0
          ? sink.description
          : 'Audio output',
      percent: Math.round((Math.max(...values) / PA_VOLUME_NORM) * 100),
      muted: sink.mute === true
    }
  }
  return null
}

/**
 * Where a step lands, held inside 0–100.
 *
 * **100 is a ceiling on purpose.** pactl will happily go past it, and what is
 * past it is software gain: distortion, delivered straight into somebody's ears
 * by a button they were holding.
 */
export function nextVolume(current: number, delta: number): number {
  return Math.min(100, Math.max(0, current + delta))
}

/** What a card can say about a failure in one short line. */
export function volumeFailureReason(kind: HostFailureKind): string {
  switch (kind) {
    case 'missing':
      return 'pactl is not installed'
    case 'blocked':
      return 'The sandbox cannot reach the host'
    case 'timeout':
      return 'The sound server did not answer'
    case 'failed':
      return 'The sound server refused the change'
  }
}

const NO_OUTPUT = 'No audio output found'

let pending = 0
let running = false

/**
 * Moves the default output's volume by `delta` percentage points.
 *
 * Fire and forget: the caller is a 60 Hz tick that may not await. Never
 * rejects — every failure is logged and becomes a notice, because a button
 * that silently does nothing is the one failure nobody on a sofa can diagnose.
 */
export function adjustVolume(delta: number): void {
  pending += delta
  if (!running) void drain()
}

async function drain(): Promise<void> {
  running = true
  let last: SinkState | null = null

  try {
    while (pending !== 0) {
      const delta = pending
      pending = 0

      const outcome = await stepVolume(delta)
      if (typeof outcome === 'string') {
        // Presses made while a failing round was running would only fail the
        // same way a moment later and repeat the card.
        pending = 0
        last = null
        notify({ kind: 'volume-unavailable', reason: outcome })
        break
      }

      last = outcome
      notify({
        kind: 'volume',
        percent: outcome.percent,
        muted: outcome.muted,
        output: outcome.description
      })
    }
  } catch (error) {
    // `stepVolume` turns every expected failure into a reason, so this is the
    // unexpected kind — and it still gets a card rather than nothing.
    pending = 0
    last = null
    console.error('Volume change failed:', error instanceof Error ? error.message : error)
    notify({ kind: 'volume-unavailable', reason: 'Could not change the volume' })
  } finally {
    running = false
  }

  // One line per burst rather than per press: a held D-pad is ten a second.
  // The description and the level only — see the header on the sink's name.
  if (last) {
    console.info(`Volume ${last.muted ? 'muted' : `${last.percent}%`} on ${last.description}`)
  }
}

/** One round: read the default sink, write the new level. A string is a failure, for the card. */
async function stepVolume(delta: number): Promise<SinkState | string> {
  try {
    const info = await hostExecFile('pactl', pactlInfoArgs(), { env: PACTL_ENV })
    const name = parseDefaultSink(info.stdout)
    if (!name) {
      console.warn('Volume: the sound server reports no default output')
      return NO_OUTPUT
    }

    const list = await hostExecFile('pactl', pactlListSinksArgs(), { env: PACTL_ENV })
    const sink = parseSink(list.stdout, name)
    if (!sink) {
      // An older pactl prints text for `--format=json` and lands here too.
      console.warn('Volume: the default output is not in the list of sinks, or the list is not JSON')
      return NO_OUTPUT
    }

    const percent = nextVolume(sink.percent, delta)
    if (percent !== sink.percent) {
      await hostExecFile('pactl', pactlSetVolumeArgs(percent), { env: PACTL_ENV })
    }

    // Turning it up is asking to hear it. Turning it down leaves a mute alone.
    let muted = sink.muted
    if (muted && delta > 0) {
      await hostExecFile('pactl', pactlSetMuteArgs(false), { env: PACTL_ENV })
      muted = false
    }

    return { description: sink.description, percent, muted }
  } catch (error) {
    // `hostExecFile` has already logged the command and the classified failure.
    return volumeFailureReason(classifyHostFailure(error).kind)
  }
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}
