import { describe, expect, it } from 'vitest'
import {
  HANDBACK_START,
  stepHandback,
  type HandbackEffect,
  type HandbackEvent,
  type HandbackPhase,
  type HandbackState
} from './handback'

/**
 * The rule for getting the screen back. Pure, so all of it is assertable
 * without a filesystem, a child process or an Electron window — the same reason
 * `buildPowerArgv` and `buildLaunchArgv` are pure, and with rather more at
 * stake: the failure this guards against is raising the launcher on top of a
 * game somebody is playing.
 */

const gone: HandbackEvent = { type: 'clientProbe', running: false }
const up: HandbackEvent = { type: 'clientProbe', running: true }

/** Feeds a sequence and returns every effect it produced, in order. */
function run(
  events: readonly HandbackEvent[],
  from: HandbackState = HANDBACK_START
): { state: HandbackState; effects: HandbackEffect[] } {
  let state = from
  const effects: HandbackEffect[] = []
  for (const event of events) {
    const transition = stepHandback(state, event)
    state = transition.next
    effects.push(...transition.effects)
  }
  return { state, effects }
}

describe('stepHandback', () => {
  it('kills the client when the stream ends, then goes to check', () => {
    const { state, effects } = run([{ type: 'streamEnded' }])
    expect(effects).toEqual(['killClient', 'probeSoon'])
    expect(state.phase).toBe('verifying')
  })

  it('never kills the client on a child exit, only checks', () => {
    // The re-exec guard, stated as a test. A `flatpak run` that exited is not
    // proof the client did: `flatpak-spawn` can lose its D-Bus connection, and
    // the client can re-exec itself under the same app id. Killing there would
    // end an instance the client had just started for itself.
    const { state, effects } = run([{ type: 'childExited' }])
    expect(effects).toEqual(['probeSoon'])
    expect(state.phase).toBe('verifying')
  })

  it('does not conclude a re-exec is a disappearance', () => {
    // The other half of that guard, and the one that decides the outcome.
    // `flatpak run` exits on a re-exec, and the client is measured back in
    // `flatpak ps` a second or two later — so two eager probes are exactly the
    // wrong number, and acting on them would raise the launcher over a game.
    const { effects } = run([{ type: 'childExited' }, gone, gone])
    expect(effects).not.toContain('handBack')

    // The sighting that arrives on the next probe clears it entirely.
    const reappeared = run([{ type: 'childExited' }, gone, gone, up])
    expect(reappeared.state.goneReadings).toBe(0)
    expect(reappeared.state.seenRunning).toBe(true)
  })

  it('still recovers when the client is quit by hand rather than by us', () => {
    // No stream marker is emitted when the client is killed mid-session, so the
    // child exit is the only signal there is. It has to work — it just has to
    // be sure first.
    const { state, effects } = run([
      { type: 'childExited' },
      ...(Array(6).fill(gone) as HandbackEvent[])
    ])
    expect(effects).toContain('handBack')
    expect(state.phase).toBe('done')
  })

  it('needs no extra convincing about a client it just killed', () => {
    // `streamEnded` is followed by `killGfn()`, so "not running" is the answer
    // that was asked for. Making the ordinary end of every game wait six seconds
    // to be believed would be a regression paid on the common path.
    expect(run([{ type: 'streamEnded' }, gone, gone]).effects).toContain('handBack')
  })

  it('needs two consecutive gone readings before handing the screen back', () => {
    // `isGfnRunning()` swallows every failure and answers `false`. One reading
    // is not evidence; a transient `flatpak ps` failure must not pop the
    // launcher over a running game.
    const one = run([{ type: 'streamEnded' }, gone])
    expect(one.effects).not.toContain('handBack')

    const two = run([{ type: 'streamEnded' }, gone, gone])
    expect(two.effects).toContain('handBack')
    expect(two.state.phase).toBe('done')
  })

  it('means consecutive, not cumulative', () => {
    expect(run([{ type: 'streamEnded' }, gone, up, gone]).effects).not.toContain('handBack')
  })

  it('gives up on the eager probe and warns once, rather than spinning', () => {
    const events: HandbackEvent[] = [{ type: 'streamEnded' }, ...Array(40).fill(up)]
    const { state, effects } = run(events)

    expect(state.phase).toBe('lingering')
    expect(effects.filter((effect) => effect === 'warnStillRunning')).toHaveLength(1)
    expect(effects.at(-1)).toBe('probeLazily')
  })

  it('still hands back from lingering, which is what covers a re-exec', () => {
    const lingering = run([{ type: 'streamEnded' }, ...Array(40).fill(up)]).state
    expect(run([gone, gone], lingering).effects).toContain('handBack')
  })

  it('hands back at most once, and ignores everything after', () => {
    const events: HandbackEvent[] = [
      { type: 'streamEnded' },
      gone,
      gone,
      gone,
      { type: 'childExited' },
      { type: 'streamEnded' },
      up
    ]
    const { state, effects } = run(events)

    expect(effects.filter((effect) => effect === 'handBack')).toHaveLength(1)
    expect(state.phase).toBe('done')
  })

  it('waits for the client to appear before calling it gone', () => {
    // Only `gfn:open` probes while still streaming, and there the first probes
    // race the client's own start-up. Reading "not up yet" as "gone" would
    // yank the launcher back over the window the user just asked for.
    const { state, effects } = run([gone, gone, gone])
    expect(effects).toEqual(['probeLazily', 'probeLazily', 'probeLazily'])
    expect(state.phase).toBe('streaming')

    // Once it has been seen, the same two readings mean what they say.
    expect(run([up, gone, gone]).effects).toContain('handBack')
  })

  it('is total, and `done` absorbs', () => {
    const phases: HandbackPhase[] = ['streaming', 'verifying', 'lingering', 'done']
    const events: HandbackEvent[] = [{ type: 'streamEnded' }, { type: 'childExited' }, gone, up]

    for (const phase of phases) {
      for (const event of events) {
        const state: HandbackState = { ...HANDBACK_START, phase }
        const { next, effects } = stepHandback(state, event)
        expect(next.phase).toBeDefined()
        if (phase === 'done') {
          expect(next).toBe(state)
          expect(effects).toEqual([])
        }
      }
    }
  })

  it('does not mutate the state it is given', () => {
    const frozen = Object.freeze({ ...HANDBACK_START })
    stepHandback(frozen, { type: 'streamEnded' })
    expect(frozen).toEqual(HANDBACK_START)
  })
})
