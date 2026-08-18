/**
 * Knowing when the game the launcher started has finished.
 *
 * There is no API for this. The deep link goes to somebody else's process, and
 * that process does not exit when the stream ends — it drops back to its own
 * mall and keeps the screen. The one place the fact is recorded is the client's
 * own stream-agent log:
 *
 *   ~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/logs/gameStreamClientAgent.log
 *
 * Same directory, and the same `--filesystem=~/.var/app/com.nvidia.geforcenow:ro`
 * grant, as the `sharedstorage.json` that `status/zone.ts` reads.
 *
 * ── The reason this file is handled with tongs too ──────────────────────────
 *
 * Unlike `console.log` and `sharedstorage.json` beside it, this log carries no
 * bearer token — which is the only reason it is usable at all. It is not
 * anonymous, though: it contains the machine's LAN IP and active interface, GFN
 * session and sub-session ids, a traceroute address, and an
 * `updateUserInfo: userId=…` line holding the NVIDIA account's opaque user id.
 *
 * So `readStreamPhase` returns two booleans and a bounded fragment, and nothing
 * else. Every diagnostic in this module names the *path* and the *errno* and
 * quotes no content. There is no debug mode that prints a line. If you add a
 * `console.log` here, log the offset, never the chunk.
 *
 * ── What was actually observed ──────────────────────────────────────────────
 *
 * Read off two real runs on client v2.0.87.x — a completed session and a
 * rotated `.bak` from the day before. Four facts, none of them guessable:
 *
 * - **`Creating StreamingMonitor` is not a stream marker.** It is line 1 of both
 *   files: the agent writing it down when it boots. In the older run the monitor
 *   was created eighteen seconds before the stream began.
 * - **The end marker is emitted more than once** — three times for the one IPC
 *   message, and `GFN UI exited streaming mode` again at teardown. So the parser
 *   latches rather than counting.
 * - **It may never be emitted at all.** The older run simply stops mid-stream,
 *   because the client was killed while streaming. Whatever consumes this must
 *   have a second way to notice the client is gone; `handback.ts` does.
 * - **The file is rotated to `.bak`, by rename, at client start** — and the
 *   launcher restarts the client on every launch, so rotation is the normal
 *   case rather than an edge case. It is why the tail below watches a path.
 */

import { watchFile, unwatchFile, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/**
 * The line that means the game is over and the client's UI is back on the mall,
 * which is precisely the state this module exists to end.
 *
 * **Not `IPC_STREAMING_TERMINATED_EVENT`.** That one is the *stream* stopping,
 * and its payload carries `isResumable`: a network blip terminates a stream and
 * the client reconnects on its own. Acting on it would end a session the user
 * had not finished. Mode-exit fires about a second later and is the one that
 * means "went back to the mall".
 */
const ENDED_MARKER = 'IPC_STREAMING_MODE_EXIT_EVENT'

/**
 * Gate, not a trigger. Observed exactly once per stream in both sample runs,
 * whereas the mode-exit marker above appears three times for a single event.
 *
 * `ended` is only honoured once this has been seen, for two reasons, and the
 * second is the real one: a read that begins anywhere other than the start of a
 * brand-new file re-reads history, and the last thing in a *completed* run is
 * that end marker. Requiring a start in the same phase makes a stale marker
 * unreachable.
 */
const STARTED_MARKER = 'streaming started'

/**
 * How much of an unterminated final line is carried into the next chunk.
 *
 * Two reasons, and the second decides the number. A marker line is about ninety
 * characters, so nothing longer than this can be one — whereas the terminated
 * event's line is nine hundred characters of session ids, a traceroute address
 * and hardware capabilities, and holding that in the launcher's memory for a
 * poll interval buys nothing. Keeping the *tail* rather than the head cannot
 * lose a marker that straddles a boundary: a fragment long enough to be
 * truncated is, by length alone, not one.
 */
const MAX_PARTIAL = 512

/** Immutable fold state over the appended tail of the agent log. */
export interface StreamPhase {
  /** A stream has begun since this phase was started. */
  readonly started: boolean
  /** The client has left streaming mode. Latches — never goes back to false. */
  readonly ended: boolean
  /** Trailing bytes of an incomplete final line, carried into the next chunk. */
  readonly partial: string
}

export const STREAM_PHASE_START: StreamPhase = { started: false, ended: false, partial: '' }

/**
 * Folds one appended chunk into the phase. Pure, and the only part of this
 * module a client update can break — which is why it is the part with tests.
 *
 * Complete lines only: a marker split across a read boundary is carried in
 * `partial` and matched once the rest of it arrives.
 */
export function readStreamPhase(phase: StreamPhase, chunk: string): StreamPhase {
  if (chunk === '') return phase

  const lines = (phase.partial + chunk).split('\n')
  // The last element is whatever followed the final newline — an incomplete
  // line, or '' when the chunk ended cleanly.
  const partial = lines.pop() ?? ''

  let started = phase.started
  let ended = phase.ended

  for (const line of lines) {
    // Defensive: the client is a cross-platform CEF build, and this costs one
    // call per line.
    const text = line.endsWith('\r') ? line.slice(0, -1) : line
    if (text.includes(STARTED_MARKER)) started = true
    if (started && text.includes(ENDED_MARKER)) ended = true
  }

  return { started, ended, partial: partial.slice(-MAX_PARTIAL) }
}

/**
 * Where the client writes it.
 *
 * A function rather than a module constant for the same reason as
 * `status/zone.ts`'s `zoneStoragePath`: `homedir()` is cheap, and a constant
 * evaluated at import time is a constant no test can move.
 */
export function streamLogPath(): string {
  return join(
    homedir(),
    '.var',
    'app',
    'com.nvidia.geforcenow',
    '.local',
    'state',
    'NVIDIA',
    'GeForceNOW',
    'logs',
    'gameStreamClientAgent.log'
  )
}

/** How often the path is stat'd while a session is live. */
const POLL_INTERVAL_MS = 1_000

/**
 * Ceiling on a single read. A whole run's log is about twelve kilobytes, so
 * this is a guard against a client bug rather than a budget: buffering an
 * unbounded third-party log into the main process is a worse failure than
 * losing lines from a run that has clearly gone wrong.
 */
const MAX_READ_BYTES = 256 * 1024

export interface StreamLogTail {
  /** Idempotent. */
  stop(): void
}

export interface StreamLogTailOptions {
  /** Called at most once, when the client leaves streaming mode. */
  onStreamEnded: () => void
  /**
   * Called at most once, when the log will not be readable at all. The reason
   * names the path and the errno and quotes no content.
   */
  onUnavailable: (reason: string) => void
  /** Injectable for tests. Defaults to `streamLogPath()`. */
  path?: string
}

/**
 * Watches the log for the end of a streaming session.
 *
 * **`watchFile`, not `watch`**, and it is not a close call:
 *
 * - **Rotation decides it.** `fs.watch` is inotify and inotify watches the
 *   *inode*, so after the client's rename our watch is attached to `.bak` and
 *   never sees another byte of the live file. Recovering from the `rename`
 *   event means tearing down and re-arming into a race. `watchFile` stats the
 *   *path*, so the new inode arrives on its own and rotation is a comparison of
 *   `curr.ino`.
 * - **The Flatpak bind mount.** `stat(2)` behaves identically on every mount
 *   type. inotify across a bubblewrap bind mount is the one thing here that
 *   could behave differently packaged than it does under `npm run dev`, which
 *   is exactly the class of bug this codebase keeps a record of.
 * - **"Not there yet" is free.** Node calls the listener once with every stat
 *   field zeroed when the path does not exist, and again when it appears — so
 *   arming before the client has written anything needs no existence poll and
 *   no retry loop. That is the normal state for the first seconds of every
 *   launch.
 *
 * The cost is one `stat(2)` a second while a session is live, for an event that
 * is a human standing up. `persistent: false` so a live watch never holds the
 * app open at quit, the same reasoning as the `unref()` in `displaySleep.ts`.
 */
export function createStreamLogTail(options: StreamLogTailOptions): StreamLogTail {
  const path = options.path ?? streamLogPath()

  let offset: number | null = null
  let ino: number | null = null
  let phase = STREAM_PHASE_START
  let decoder = new StringDecoder('utf8')
  let reading = false
  let stopped = false

  const stop = (): void => {
    if (stopped) return
    stopped = true
    unwatchFile(path, listener)
  }

  /**
   * Restarts the fold at `position`. Used for a rotation, for a truncation, and
   * for skipping a backlog — all three cases where what follows is not a
   * continuation of what came before.
   *
   * It resets the *phase*, not just the offset. Splicing new bytes onto a
   * fragment carried from a different run produces a line that never existed,
   * and is the only remaining way a stale end marker could reach a fresh start.
   */
  const rewindTo = (position: number): void => {
    offset = position
    phase = STREAM_PHASE_START
    decoder = new StringDecoder('utf8')
  }

  const consume = async (size: number): Promise<void> => {
    const from = offset ?? 0
    // On a backlog bigger than the ceiling, skip forward rather than buffer.
    const start = Math.max(from, size - MAX_READ_BYTES)
    if (start !== from) rewindTo(start)
    const length = size - start
    if (length <= 0) return

    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      offset = start + bytesRead
      phase = readStreamPhase(phase, decoder.write(buffer.subarray(0, bytesRead)))
    } finally {
      await handle.close()
    }

    if (phase.ended) {
      stop()
      options.onStreamEnded()
    }
  }

  function listener(curr: Stats, _prev: Stats): void {
    if (stopped || reading) return

    // Every field zeroed is Node's documented "the path does not exist". The
    // client has not started writing yet; it will.
    if (curr.mtimeMs === 0) return

    if (offset === null) {
      // First sight of the file. Baseline at its current size rather than at 0:
      // this may still be the *previous* run's log, a second before the client
      // rotates it, and its last line is an end marker.
      offset = curr.size
      ino = curr.ino
      return
    }

    if (ino !== curr.ino) {
      // Rotated: the client renames the previous run's log to `.bak` on start,
      // which is every launch, because every launch restarts the client.
      ino = curr.ino
      rewindTo(0)
    } else if (curr.size < offset) {
      // Truncated in place rather than renamed. Same conclusion.
      rewindTo(0)
    } else if (curr.size === offset) {
      return
    }

    reading = true
    void consume(curr.size)
      .catch((error: NodeJS.ErrnoException) => {
        // The file was rotated between the stat and the open. Nothing is wrong;
        // the next tick picks up the replacement.
        if (error.code === 'ENOENT') {
          rewindTo(0)
          return
        }
        stop()
        // Named, not swallowed — but a warning, not a `LaunchNotice`. The game
        // launched; what is lost is the launcher closing the client afterwards,
        // and a banner about a convenience nobody asked for is noise on a screen
        // with no keyboard to dismiss it.
        options.onUnavailable(
          `GeForce NOW's stream log could not be read (${error.code ?? 'unknown error'} at ${path}). ` +
            'Games will still launch; the launcher just will not close the client for you when ' +
            'you finish. Grant read access with: flatpak override --user ' +
            '--filesystem=~/.var/app/com.nvidia.geforcenow:ro io.github.robertotucci.GfnLauncher'
        )
      })
      .finally(() => {
        reading = false
      })
  }

  watchFile(path, { interval: POLL_INTERVAL_MS, persistent: false }, listener)

  return { stop }
}
