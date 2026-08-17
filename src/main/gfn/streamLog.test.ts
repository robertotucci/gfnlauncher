import { describe, expect, it } from 'vitest'
import { readStreamPhase, STREAM_PHASE_START } from './streamLog'

/**
 * The fold over GeForce NOW's stream-agent log. This is the part a client update
 * breaks first, and the part whose failure is invisible: a marker that stops
 * matching does not throw, it just means the launcher never closes the client.
 *
 * The fixtures are real lines with every identifier replaced by an obvious fake
 * — the *inverse* of `status/zone.test.ts`, which deliberately keeps
 * real-shaped secrets. There the point is proving they cannot escape a narrow
 * return type; here the fixture goes into a public repository, and a real
 * NVIDIA user id has no business in git.
 */

const STARTED = '[2026-01-01 00:00:00,000]=00:00:00=    INFO [StreamAgent] {AAAA0000} - streaming started'
const MODE_EXIT =
  '[2026-01-01 00:10:00,000]=00:10:00=    INFO [StreamAgent] {AAAA0000} - handleIpcMessage : IPC_STREAMING_MODE_EXIT_EVENT'
const UI_EXIT =
  '[2026-01-01 00:11:00,000]=00:11:00=    INFO [StreamAgent] {AAAA0000} - GFN UI exited streaming mode'
const TERMINATED =
  '[2026-01-01 00:09:59,000]=00:09:59=   DEBUG [MessageBusIPC] {AAAA0000} - IPCMessage: CrimsonNative:BackgroundAgent GameStream:ClientAgent IPC_STREAMING_TERMINATED_EVENT {"event":"STREAMING_TERMINATED","isResumable":true}'
const BOOT =
  '[2026-01-01 00:00:00,000]=00:00:00=    INFO [StreamAgent] {AAAA0000} - Creating StreamingMonitor'

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`

describe('readStreamPhase', () => {
  it('reads a whole session out of one chunk', () => {
    expect(readStreamPhase(STREAM_PHASE_START, lines(BOOT, STARTED, MODE_EXIT))).toEqual({
      started: true,
      ended: true,
      partial: ''
    })
  })

  it('does not end a session that is still running', () => {
    expect(readStreamPhase(STREAM_PHASE_START, lines(BOOT, STARTED)).ended).toBe(false)
  })

  it('ignores an exit marker with no start before it', () => {
    // The stale-file guard. A read that begins anywhere but the start of a
    // brand-new file re-reads history, and the last thing in a completed run is
    // exactly this line.
    expect(readStreamPhase(STREAM_PHASE_START, lines(MODE_EXIT, UI_EXIT))).toEqual({
      started: false,
      ended: false,
      partial: ''
    })
  })

  it('does not treat a terminated stream as the end of the session', () => {
    // The most valuable case here. `IPC_STREAMING_TERMINATED_EVENT` is the
    // *stream* stopping, and its payload says `isResumable`: a network blip
    // terminates a stream and the client reconnects on its own. Acting on it
    // would kill a game the user had not finished.
    expect(readStreamPhase(STREAM_PHASE_START, lines(STARTED, TERMINATED)).ended).toBe(false)
  })

  it('carries an incomplete final line into the next chunk', () => {
    const split = MODE_EXIT.indexOf('IPC_STREAMING') + 6
    const first = readStreamPhase(STREAM_PHASE_START, `${lines(STARTED)}${MODE_EXIT.slice(0, split)}`)

    expect(first.ended).toBe(false)
    expect(first.partial).toBe(MODE_EXIT.slice(0, split))
    expect(readStreamPhase(first, `${MODE_EXIT.slice(split)}\n`).ended).toBe(true)
  })

  it('matches complete lines only', () => {
    // A line without its newline has not been written yet as far as this is
    // concerned — the writer may be mid-`write(2)`.
    const pending = readStreamPhase(STREAM_PHASE_START, `${lines(STARTED)}${MODE_EXIT}`)
    expect(pending.ended).toBe(false)
    expect(readStreamPhase(pending, '\n').ended).toBe(true)
  })

  it('latches, because the client emits the marker more than once', () => {
    const once = readStreamPhase(STREAM_PHASE_START, lines(STARTED, MODE_EXIT))
    expect(readStreamPhase(once, lines(UI_EXIT, MODE_EXIT))).toEqual(once)
  })

  it('stays ended across a second start in the same chunk', () => {
    expect(readStreamPhase(STREAM_PHASE_START, lines(STARTED, MODE_EXIT, STARTED)).ended).toBe(true)
  })

  it('tolerates CRLF', () => {
    expect(readStreamPhase(STREAM_PHASE_START, `${STARTED}\r\n${MODE_EXIT}\r\n`).ended).toBe(true)
  })

  it('is a no-op on an empty chunk, and never mutates its input', () => {
    const frozen = Object.freeze({ started: true, ended: false, partial: 'x' })
    expect(readStreamPhase(frozen, '')).toBe(frozen)
    readStreamPhase(frozen, lines(MODE_EXIT))
    expect(frozen).toEqual({ started: true, ended: false, partial: 'x' })
  })

  it('caps the carried fragment, and still finds a marker that follows it', () => {
    const huge = 'x'.repeat(5_000)
    const carried = readStreamPhase(STREAM_PHASE_START, `${lines(STARTED)}${huge}`)

    expect(carried.partial.length).toBeLessThanOrEqual(512)
    expect(readStreamPhase(carried, `\n${lines(MODE_EXIT)}`).ended).toBe(true)
  })

  it('carries nothing out of the log but two booleans and that fragment', () => {
    // The `zone.test.ts` guarantee, applied to a different file in the same
    // directory. This log holds no bearer token, but it does hold the machine's
    // LAN IP, session ids and the account's opaque user id — none of which has
    // any business leaving this module.
    const sensitive = lines(
      STARTED,
      '[2026-01-01 00:00:01,000]=00:00:01=   DEBUG [GsTelemetry] {AAAA0000} - updateUserInfo: userId=fake-user-id, externalUserId=fake-external',
      '[2026-01-01 00:00:02,000]=00:00:02=   DEBUG [OSInfo] {AAAA0000} - Active interface IP address is 10.0.0.99',
      MODE_EXIT
    )
    const phase = readStreamPhase(STREAM_PHASE_START, sensitive)

    expect(Object.keys(phase).sort()).toEqual(['ended', 'partial', 'started'])
    expect(JSON.stringify(phase)).not.toContain('fake-user-id')
    expect(JSON.stringify(phase)).not.toContain('10.0.0.99')
  })
})
