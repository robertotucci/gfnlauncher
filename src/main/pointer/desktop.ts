import {
  CHORD_BUTTONS_JOYDEV,
  CHORD_START,
  KEYBOARD_CHORD_BUTTONS,
  KEYBOARD_CHORD_HOLD_MS,
  POINTER_ACTIONS_JOYDEV,
  chordHeld,
  heldActions,
  pointerSpeed,
  scrollDelta,
  stepChord,
  stepPointerButtons,
  type ChordState,
  type PointerActionName
} from '@shared/pointer'
import { JOYDEV_AXES, openPadReader, type PadReader, type PadSample } from './evdev'
import { openRemotePointer, type RemotePointer } from './portal'

/**
 * Pointer mode everywhere that is not one of our own windows.
 *
 * The desktop behind a minimised launcher, the GeForce NOW client, and — the
 * case this was actually asked for — a Steam EULA or updater *inside* a running
 * stream, where the game is remote, the pad reaches it and the pointer does
 * not, so the dialog cannot be dismissed and the session is stuck.
 *
 * Three pieces, each in its own file and each dull on its own:
 *
 *  - `evdev.ts` reads the pad from main, because in both of those situations no
 *    renderer can (suspended intents in one, throttled `requestAnimationFrame`
 *    in the other).
 *  - `portal.ts` injects at the compositor, because the GeForce NOW client is
 *    not ours and no Electron API can reach inside it.
 *  - this file is the loop between them.
 *
 * ── The one thing it must not do ────────────────────────────────────────────
 *
 * Nothing here may reach the launcher's UI. The pad is being read while a game
 * is on screen, which is exactly the situation the launcher spent a release
 * learning not to act in — see `shouldAcceptInput` in `@shared/input`. The only
 * outputs are the portal's `Notify*` calls and one boolean pushed to the
 * renderer so it knows to stop treating the stick as navigation. There is no
 * path from here to an intent, and none to `gfn:launch`.
 *
 * ── The timer, and why it is not always running ─────────────────────────────
 *
 * joydev is event-driven: a stick held still emits nothing. But both the chord
 * (a 600 ms hold) and the cursor (motion integrated over time) need a clock. So
 * a 60 Hz tick is started when one of them needs it and stopped the moment
 * neither does — which for the overwhelming majority of a gaming session is
 * immediately. A timer ticking through a two-hour stream to watch for a chord
 * nobody is pressing is exactly the kind of cost this launcher should not add
 * to a machine that is also decoding 4K.
 */

/** 60 Hz while something is being timed. Matches the renderer's rAF cadence. */
const TICK_MS = 16

/**
 * Wheel steps are discrete, so fractions are accumulated until one is due.
 *
 * `NotifyPointerAxisDiscrete` counts notches, not pixels. Rounding each frame
 * independently would either scroll in lurches or, below one notch per frame,
 * never scroll at all.
 */
const PIXELS_PER_NOTCH = 53

export interface DesktopPointerDeps {
  /** The user's setting. Read at each toggle, not captured once. */
  readonly enabled: () => boolean
  readonly restoreToken: () => string | null
  readonly saveRestoreToken: (token: string) => void
  /**
   * Whether one of our own windows already has a cursor up.
   *
   * The two backends must never both be live: the sign-in window drives its own
   * pointer from its preload, and a second cursor injected at the compositor on
   * top of it would fight it.
   */
  readonly ownWindowActive: () => boolean
  /** Told to the renderer, so the stick stops driving the grid as well. */
  readonly onMode: (active: boolean) => void
}

export interface DesktopPointer {
  active(): boolean
  /** Ends the mode if it is on. Safe to call at any time. */
  stop(reason: string): void
  /**
   * Opens or closes the pad devices to match `enabled()`.
   *
   * Called at arm time and again whenever the setting changes. The reader is
   * **not** opened for a user who has the feature switched off — which is the
   * default — because that would be a handful of open file descriptors, an
   * inotify watch on /dev/input and a wakeup per pad event, all in service of a
   * chord that would be refused anyway.
   */
  syncEnabled(): void
  dispose(): void
}

export function armDesktopPointer(deps: DesktopPointerDeps): DesktopPointer {
  let reader: PadReader | null = null
  let remote: RemotePointer | null = null
  /** Set while `openRemotePointer` is in flight, so a second chord cannot race. */
  let opening = false
  let chord: ChordState = CHORD_START
  /** The shoulder pair, kept apart from the stick one so neither disarms the other. */
  let keyboardChord: ChordState = CHORD_START
  let held: readonly PointerActionName[] = []
  let scrollCarry = 0
  let ticker: NodeJS.Timeout | null = null
  let lastTick = 0
  let disposed = false
  /** Said once per session, not once per press. */
  let saidNoKeyboard = false

  const sample = (): PadSample => reader?.sample() ?? { buttons: new Set(), axes: [] }

  /**
   * Whether anything still needs a clock.
   *
   * Both halves matter. Without the chord half, holding the two sticks produces
   * no further joydev events and the 600 ms threshold is never sampled, so the
   * mode could never be entered. Without the pointer half, a stick held steady
   * would move the cursor once and stop.
   */
  const needsTicking = (): boolean =>
    remote !== null || chordHeld(sample().buttons, CHORD_BUTTONS_JOYDEV)

  const ensureTicking = (): void => {
    if (ticker !== null || disposed || !needsTicking()) return
    lastTick = Date.now()
    ticker = setInterval(tick, TICK_MS)
    ticker.unref()
  }

  const stopTicking = (): void => {
    if (ticker === null) return
    clearInterval(ticker)
    ticker = null
  }

  const start = (): void => {
    if (remote || opening) return
    if (!deps.enabled()) {
      console.info('Pointer mode was asked for on the desktop but is switched off in settings')
      return
    }
    if (deps.ownWindowActive()) {
      // One of our own windows is already driving a cursor from its preload.
      // A second one injected at the compositor would fight it.
      return
    }

    opening = true
    openRemotePointer({
      restoreToken: deps.restoreToken(),
      onRestoreToken: deps.saveRestoreToken
    })
      .then((pointer) => {
        opening = false
        if (disposed) {
          pointer.close()
          return
        }
        remote = pointer
        // Adopt whatever is held right now, so the buttons that were down
        // during the chord are not read as a click the instant it opens.
        held = heldActions(sample().buttons, POINTER_ACTIONS_JOYDEV)
        // Unarmed, so the adoption rule applies again: a shoulder already down
        // as the cursor appears must not count as asking for the keyboard.
        keyboardChord = CHORD_START
        scrollCarry = 0
        lastTick = Date.now()
        deps.onMode(true)
        ensureTicking()
      })
      .catch((error: unknown) => {
        opening = false
        // Surfaced, never swallowed: on a television a control that silently
        // does nothing is the one failure nobody can diagnose. The likely cause
        // is the one-time permission dialog being declined or unavailable, and
        // the message from `portal.ts` says so.
        console.error(
          'Could not start the desktop pointer:',
          error instanceof Error ? error.message : error
        )
      })
  }

  const stop = (reason: string): void => {
    if (!remote) return

    // Never leave a button down at the compositor. A left button stuck after
    // the mode ends is a desktop-wide drag the user cannot clear with the pad.
    for (const action of held) {
      if (action === 'leftClick') remote.button('left', false)
      if (action === 'rightClick') remote.button('right', false)
    }
    held = []

    remote.close()
    remote = null
    deps.onMode(false)
    console.info(`Desktop pointer mode off (${reason})`)
    if (!needsTicking()) stopTicking()
  }

  const onAction = (action: PointerActionName, down: boolean): void => {
    if (!remote) return

    switch (action) {
      case 'leftClick':
        remote.button('left', down)
        return
      case 'rightClick':
        remote.button('right', down)
        return
      case 'exit':
        if (down) stop('☰')
        return
    }
  }

  /**
   * LB + RB asks for the keyboard, and out here there is not one.
   *
   * Deliberately absent rather than half-built, and measured rather than
   * assumed: an Electron window created with `focusable: false`,
   * `alwaysOnTop` and `showInactive()` was tried on this compositor and the
   * focused window lost its focus anyway. The focus is precisely what decides
   * where `NotifyKeyboardKeysym` lands, so a keyboard drawn that way types into
   * itself. It therefore lives only in the windows we own — which is also where
   * the typing actually has to happen, the sign-in form.
   *
   * Said once per session rather than per press: this runs off a pad, and the
   * log is a file somebody has to be able to skim.
   */
  const askedForKeyboard = (): void => {
    if (saidNoKeyboard) return
    saidNoKeyboard = true
    console.info(
      'LB + RB asked for the on-screen keyboard, which exists only inside the ' +
        'launcher’s own windows — the sign-in page and the web player. Out here ' +
        'the pad drives the cursor only.'
    )
  }

  const tick = (): void => {
    const now = Date.now()
    const dt = Math.max(0, now - lastTick)
    lastTick = now

    const current = sample()

    const step = stepChord(chord, chordHeld(current.buttons, CHORD_BUTTONS_JOYDEV), now)
    chord = step.next
    if (step.toggle) {
      if (remote) stop('L3 + R3')
      else start()
    }

    if (remote) {
      const actions = heldActions(current.buttons, POINTER_ACTIONS_JOYDEV)
      const edges = stepPointerButtons(held, actions)
      held = actions
      for (const action of edges.up) onAction(action, false)
      for (const action of edges.down) onAction(action, true)

      // Same shoulder pair as in our own windows — LB and RB are 4 and 5 on
      // joydev too — so the answer is at least consistent, even though out here
      // the answer is "there is no keyboard".
      const keyboardStep = stepChord(
        keyboardChord,
        chordHeld(current.buttons, KEYBOARD_CHORD_BUTTONS),
        now,
        KEYBOARD_CHORD_HOLD_MS
      )
      keyboardChord = keyboardStep.next
      if (keyboardStep.toggle) askedForKeyboard()

      moveCursor(current, dt)
      scrollWheel(current, dt)
    }

    if (!needsTicking()) stopTicking()
  }

  const moveCursor = (current: PadSample, dt: number): void => {
    if (!remote) return
    const x = current.axes[JOYDEV_AXES.leftX] ?? 0
    const y = current.axes[JOYDEV_AXES.leftY] ?? 0
    const magnitude = Math.hypot(x, y)
    const speed = pointerSpeed(magnitude)
    if (speed === 0) return

    // Relative motion, and normalised so a diagonal is not √2 faster — the same
    // arithmetic `stepPointer` does, except the compositor owns the position so
    // there is nothing here to clamp.
    const step = (speed * Math.min(dt, 100)) / 1_000 / magnitude
    remote.moveBy(x * step, y * step)
  }

  const scrollWheel = (current: PadSample, dt: number): void => {
    if (!remote) return
    scrollCarry += scrollDelta(current.axes[JOYDEV_AXES.rightY] ?? 0, dt)

    const notches = Math.trunc(scrollCarry / PIXELS_PER_NOTCH)
    if (notches === 0) return
    scrollCarry -= notches * PIXELS_PER_NOTCH
    remote.scroll(notches)
  }

  const syncEnabled = (): void => {
    if (disposed) return
    const wanted = deps.enabled()

    if (!wanted) {
      if (!reader) return
      stop('the setting was switched off')
      stopTicking()
      reader.close()
      reader = null
      // The chord state goes with the devices. Re-arming later must start from
      // the adoption rule again, or a pair of sticks held across the change
      // would be a hold nobody made.
      chord = CHORD_START
      console.info('Desktop pointer disarmed; the pad devices are closed')
      return
    }

    if (reader) return

    // Every joydev event wakes this; the ticker covers the stretches between.
    reader = openPadReader(() => {
      if (disposed) return
      ensureTicking()
      // Sampled straight away too, so a chord *released* is noticed at once
      // rather than at the next tick — the timer may already have stopped.
      if (!remote) {
        chord = stepChord(chord, chordHeld(sample().buttons, CHORD_BUTTONS_JOYDEV), Date.now()).next
      }
    })

    const pads = reader.sample()
    console.info(
      `Desktop pointer armed: ${pads.axes.length > 0 ? 'a pad is already connected' : 'waiting for a pad'}`
    )
  }

  syncEnabled()

  return {
    active: () => remote !== null,
    stop,
    syncEnabled,
    dispose() {
      disposed = true
      stop('the launcher is quitting')
      stopTicking()
      reader?.close()
      reader = null
    }
  }
}
