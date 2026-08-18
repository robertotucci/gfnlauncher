import type { ChildProcess } from 'node:child_process'
import { isGfnRunning, killGfn } from './flatpak'
import { createStreamLogTail, type StreamLogTail } from './streamLog'

/**
 * Getting the screen back after a game.
 *
 * The GeForce NOW client does not exit when a stream ends. It returns to its own
 * mall, fullscreen, holding the focus — which on a machine with no mouse means
 * holding the launcher hostage: there is nothing a pad can do to raise a window
 * the compositor is not showing. So the launcher closes the client for the user
 * and takes the screen back.
 *
 * The watch has a second consumer now. `onEnded` releases the input gate in
 * `main/screen.ts` — the renderer refuses to act on the pad while the client has
 * the screen — so the *end* of this watch has to be observable however it comes,
 * not only through `onClientGone`.
 *
 * ── Two jobs, deliberately not one ──────────────────────────────────────────
 *
 *   A — "the game ended"   → a marker in the client's log  → `killGfn()`
 *   B — "the client is gone" → `isGfnRunning()`            → hand the screen back
 *
 * B does not depend on A. If NVIDIA renames a log line in the next client, A
 * quietly stops being useful and B still brings the launcher back when the user
 * quits the client by hand. That *is* the failure policy, and it comes from the
 * decomposition rather than from error handling sprinkled through a monolith.
 *
 * ── Why the child process is a hint and never the decision ──────────────────
 *
 * `hostSpawn` hands back a live `flatpak run` handle and its `exit` event looks
 * like the obvious answer. It is not, for three reasons:
 *
 * - Sandboxed, the chain is `flatpak-spawn --host -- flatpak run …`, and
 *   `flatpak-spawn` is waiting on a D-Bus signal. A dropped connection makes it
 *   exit while the client lives on — a false positive with nothing to
 *   distinguish it from a real one.
 * - The client can re-exec itself. A new process under the same app id leaves
 *   our handle exited and the client running.
 * - `launchGame` exists because a `flatpak run` carrying a deep link into an app
 *   that already holds the lock exits 0 within a millisecond. If `KILL_SETTLE_MS`
 *   were ever not enough, that exit would arrive two seconds after the spawn and
 *   raise the launcher over the client it had just started.
 *
 * `isGfnRunning()` asks `flatpak ps` which *applications* are up, so it survives
 * all three. It has its own flaw — it swallows every failure and answers
 * `false` (right for the launch path, wrong here) — which is what
 * `GONE_CONFIRMATIONS` is for. So: the cheap signals nominate, and the probe
 * decides.
 */

/** Consecutive "gone" readings before the launcher is raised. See above. */
const GONE_CONFIRMATIONS = 2

/**
 * …and how many when the disappearance was inferred rather than caused.
 *
 * `streamEnded` is followed by `killGfn()`, so a client that then vanishes is
 * doing exactly what it was told and two readings a second apart are plenty.
 * `childExited` is a different claim: the handle belongs to `flatpak run`, and
 * that command also exits when the client **re-execs itself** — which is a
 * client starting, not one that is gone. Measured, a re-exec is back in
 * `flatpak ps` inside a second or two, so two eager probes are exactly the wrong
 * number: enough to miss it, and enough to conclude from missing it. Six is
 * about six seconds, several times the gap, and it costs nothing where it is
 * spent — on the launch path the launcher is not minimised, so those seconds are
 * a raise arriving slightly later rather than a black screen lasting longer.
 */
const UNSEEN_GONE_CONFIRMATIONS = 6

/** The user is looking at a screen with nothing on it, waiting for us. */
const PROBE_EAGER_MS = 1_000

/**
 * Only reached once the cheap signals are spent, and it runs for the rest of
 * the session — so it is the one interval that has to be affordable rather than
 * responsive.
 */
const PROBE_LAZY_MS = 10_000

/** Eager probes before admitting the client outlived whatever nominated it. */
const VERIFY_MAX_PROBES = 30

export type HandbackPhase =
  /** The session is live. Nothing is polled; both signals are event-driven. */
  | 'streaming'
  /** Something says it is over. Probing `flatpak ps` to be sure. */
  | 'verifying'
  /** The cheap signals are spent and the client is still up. Slow probe. */
  | 'lingering'
  /** The screen has been handed back. Terminal. */
  | 'done'

export interface HandbackState {
  readonly phase: HandbackPhase
  /** Consecutive probes that said the client is gone. */
  readonly goneReadings: number
  /** Probes spent in `verifying`, so it cannot spin forever. */
  readonly probes: number
  /**
   * A probe has seen the client up at least once.
   *
   * Only consulted while still `streaming`, and only the `gfn:open` path probes
   * there — that path has no stream to end, so a poll is its only signal. The
   * flag is what stops the poll from reading "the client has not finished
   * starting yet" as "the client is gone" and raising the launcher back over a
   * window the user just asked for.
   */
  readonly seenRunning: boolean
  /**
   * The stream ended and the client has been asked to close.
   *
   * It separates a disappearance the launcher *caused* from one it merely
   * inferred, which is what `UNSEEN_GONE_CONFIRMATIONS` turns on: after a kill,
   * "not in `flatpak ps`" is the expected answer and two readings settle it;
   * after a bare child exit it may just as well mean the client is part-way
   * through re-execing.
   */
  readonly closing: boolean
}

export const HANDBACK_START: HandbackState = {
  phase: 'streaming',
  goneReadings: 0,
  probes: 0,
  seenRunning: false,
  closing: false
}

export type HandbackEvent =
  | { readonly type: 'streamEnded' }
  | { readonly type: 'childExited' }
  | { readonly type: 'clientProbe'; readonly running: boolean }

export type HandbackEffect =
  | 'killClient'
  | 'probeSoon'
  | 'probeLazily'
  | 'handBack'
  | 'warnStillRunning'

export interface HandbackTransition {
  readonly next: HandbackState
  /** In order. Nothing is performed here; the shell does it. */
  readonly effects: readonly HandbackEffect[]
}

/**
 * Pure and total: every event is legal in every phase, and `done` absorbs.
 *
 * The asymmetry between the two nominating events is the whole design and is
 * easy to "simplify" back into a bug — `streamEnded` kills the client,
 * `childExited` only probes. If the child exited because the client re-execed
 * itself, killing would end an instance the client had just started for itself.
 */
export function stepHandback(state: HandbackState, event: HandbackEvent): HandbackTransition {
  if (state.phase === 'done') return { next: state, effects: [] }

  if (event.type === 'streamEnded') {
    if (state.phase === 'verifying') return { next: state, effects: [] }
    return {
      // `closing`, because what follows is a kill we asked for: the client is
      // *meant* to disappear, so the probes below need no extra convincing.
      next: { ...state, phase: 'verifying', goneReadings: 0, probes: 0, closing: true },
      effects: ['killClient', 'probeSoon']
    }
  }

  if (event.type === 'childExited') {
    if (state.phase !== 'streaming') return { next: state, effects: [] }
    return {
      next: { ...state, phase: 'verifying', goneReadings: 0, probes: 0 },
      effects: ['probeSoon']
    }
  }

  if (event.running) {
    // Any single "gone" before this was noise, which is what makes
    // GONE_CONFIRMATIONS mean *consecutive*.
    const seen = { ...state, goneReadings: 0, seenRunning: true }

    if (state.phase === 'streaming') return { next: seen, effects: ['probeLazily'] }
    if (state.phase === 'lingering') return { next: seen, effects: ['probeLazily'] }

    const probes = state.probes + 1
    if (probes >= VERIFY_MAX_PROBES) {
      return {
        next: { ...seen, phase: 'lingering', probes },
        effects: ['warnStillRunning', 'probeLazily']
      }
    }
    return { next: { ...seen, probes }, effects: ['probeSoon'] }
  }

  // Gone — but the client may simply not be up yet. Only the `gfn:open` path
  // ever probes while streaming, and there the first probes race the client's
  // own start-up.
  if (state.phase === 'streaming' && !state.seenRunning) {
    return { next: state, effects: ['probeLazily'] }
  }

  // A disappearance we caused, or one confirmed by a sighting first, is settled
  // by two readings. One inferred from a bare child exit has to clear the far
  // higher bar — see `UNSEEN_GONE_CONFIRMATIONS`, and the re-exec it is for.
  const needed =
    state.seenRunning || state.closing ? GONE_CONFIRMATIONS : UNSEEN_GONE_CONFIRMATIONS

  const goneReadings = state.goneReadings + 1
  if (goneReadings >= needed) {
    return { next: { ...state, phase: 'done', goneReadings }, effects: ['handBack'] }
  }
  return {
    next: { ...state, phase: state.phase === 'streaming' ? 'verifying' : state.phase, goneReadings },
    effects: [state.phase === 'lingering' ? 'probeLazily' : 'probeSoon']
  }
}

export interface HandbackOptions {
  /**
   * The `flatpak run` handle from `hostSpawn`, when there is one.
   *
   * Held for the length of the watch on purpose. `spawnFlatpak` drops every
   * reference to it once its promise resolves, and an unref'd `ChildProcess`
   * nobody is holding is collectable — the `exit` event this uses as a hint is
   * not delivered from a collected handle. (`detached` and `stdio: 'ignore'` do
   * not suppress it; being unreachable does.)
   */
  child: ChildProcess | null
  /**
   * Whether to close the client when the game ends.
   *
   * False for `gfn:open`: the user went to the real client on purpose, so
   * nothing here ends it — but the way back still matters, and that path
   * minimises the launcher unconditionally.
   */
  autoClose: boolean
  /** Raise and focus the launcher. Called at most once, and never on disarm. */
  onClientGone: () => void
  /**
   * The watch is over, whatever ended it. Called at most once, including on
   * disarm — which is what makes it different from `onClientGone`.
   *
   * It exists because something outside this module now depends on the session
   * being live: `setHandedOff` tells the renderer to stop answering the pad
   * while the client has the screen, and a flag released only by `onClientGone`
   * would stay set for every ending that is not "the client went away" — a
   * launch that never spawned, a disarm from the next launch, a quit. The
   * failure mode of getting that wrong is a launcher that ignores the pad, so
   * the release hangs off the end of the watch rather than off one of its
   * outcomes.
   */
  onEnded?: () => void
}

/**
 * One watch at a time, module-level — the same shape as `streamWindow` in
 * `webStream.ts`, and for the same reason: there is one launcher and one screen.
 */
let active: { stop: () => void } | null = null

/** Idempotent, and safe when nothing is armed. */
export function disarmHandback(): void {
  active?.stop()
  active = null
}

export function armHandback(options: HandbackOptions): void {
  disarmHandback()

  console.info(
    `Session watch armed: autoClose=${options.autoClose} child=${options.child ? 'yes' : 'none'}`
  )

  let state = HANDBACK_START
  let timer: NodeJS.Timeout | null = null
  let tail: StreamLogTail | null = null
  let stopped = false

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    tail?.stop()
    tail = null
    options.child?.off('exit', onChildExit)
    // Last, and inside the `stopped` guard, so it fires exactly once however
    // the watch ended — `handBack`, a disarm from the next launch, or a quit.
    options.onEnded?.()
  }

  const handle = { stop }
  active = handle

  const schedule = (ms: number): void => {
    if (timer) clearTimeout(timer)
    // `unref` so a launcher on its way out is never held open by a timer whose
    // only job is to ask a question — the `displaySleep.ts` precedent.
    timer = setTimeout(probe, ms)
    timer.unref()
  }

  const probe = (): void => {
    void isGfnRunning().then((running) => {
      if (!stopped) dispatch({ type: 'clientProbe', running })
    })
  }

  const dispatch = (event: HandbackEvent): void => {
    if (stopped) return
    const { next, effects } = stepHandback(state, event)
    const previous = state
    state = next

    // Only when the phase actually moves. The reducer is fed a probe every one
    // to ten seconds for the whole length of a session, and logging each one
    // would fill the file with `clientProbe running=true` — whereas the four
    // transitions between them are the entire account of why the launcher did
    // or did not come back, which is the most-reported behaviour here.
    if (previous.phase !== next.phase) {
      console.info(
        `Session watch: ${previous.phase} → ${next.phase} ` +
          `(on ${event.type}${event.type === 'clientProbe' ? `=${event.running}` : ''}, ` +
          `probes=${next.probes})`
      )
    }

    for (const effect of effects) {
      switch (effect) {
        case 'killClient':
          // Dropped rather than branched on in the reducer: keeping the mode out
          // of the state machine is what keeps its table small enough to read.
          if (options.autoClose) {
            console.info('Stream ended; closing the GeForce NOW client.')
            void killGfn()
          }
          break
        case 'probeSoon':
          schedule(PROBE_EAGER_MS)
          break
        case 'probeLazily':
          schedule(PROBE_LAZY_MS)
          break
        case 'warnStillRunning':
          console.warn(
            'GeForce NOW is still running after the session ended; ' +
              'watching for it to exit instead of raising the launcher over it.'
          )
          break
        case 'handBack':
          console.info('GeForce NOW is gone; taking the screen back.')
          stop()
          if (active === handle) active = null
          options.onClientGone()
          break
      }
    }
  }

  function onChildExit(): void {
    dispatch({ type: 'childExited' })
  }

  options.child?.once('exit', onChildExit)

  if (options.autoClose) {
    tail = createStreamLogTail({
      onStreamEnded: () => dispatch({ type: 'streamEnded' }),
      onUnavailable: (reason) => console.warn(reason)
    })
  } else {
    // No log tail, and therefore no cheap signal at all on this path. Probe
    // lazily from the start so quitting the client by hand still brings the
    // launcher back.
    schedule(PROBE_LAZY_MS)
  }
}
