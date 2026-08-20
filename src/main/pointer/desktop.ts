import {
  CHORD_START,
  KEYBOARD_CHORD_HOLD_MS,
  chordHeld,
  heldActions,
  pointerSpeed,
  scrollDelta,
  stepChord,
  stepPointerButtons,
  type ChordState,
  type ComposeActionName,
  type PointerActionName
} from '@shared/pointer'
import {
  CHORD_BUTTONS_EVDEV,
  COMPOSE_ACTIONS_EVDEV,
  KEYBOARD_CHORD_BUTTONS_EVDEV,
  PAD_READING_EMPTY,
  POINTER_ACTIONS_EVDEV,
  openPadReader,
  type PadReader,
  type PadReading
} from './evdev'
import { composeDirection, openComposer, type Composer, type ComposeLook } from './compose'
import { openRemotePointer, type RemotePointer } from './portal'
import { readSystemLayout, toggleSystemKeyboard } from './systemKeyboard'

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
  /**
   * The accent and the keyboard size, read at each open like `enabled()`.
   *
   * A thunk rather than a value for the same reason: this is armed once at
   * start and the settings change under it, and a snapshot captured at arm time
   * would leave the keyboard wearing whatever accent was set at boot.
   */
  readonly composeLook: () => ComposeLook
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
  /**
   * X and Y, tracked separately and *every* frame rather than only while the
   * keyboard is up.
   *
   * Kept apart from `held` because the two maps answer different questions and
   * must not disarm each other; kept running while the keyboard is closed
   * because that is the adoption rule — a thumb already on X as the window
   * opens produces no down edge, and so no space nobody asked for.
   */
  let heldCompose: readonly ComposeActionName[] = []
  let scrollCarry = 0
  let ticker: NodeJS.Timeout | null = null
  let lastTick = 0
  let disposed = false
  /** Said once per session, not once per press. */
  let saidNoKeyboard = false
  /** Whether the compositor's keyboard is up because *we* asked for it. */
  let keyboardShown = false
  /** One request at a time: a D-Bus round trip is slower than the shoulders. */
  let keyboardPending = false
  /** Our own keyboard, open only when the compositor refused to show its one. */
  let composer: Composer | null = null

  const sample = (): PadReading => reader?.sample() ?? PAD_READING_EMPTY

  /**
   * Whether anything still needs a clock.
   *
   * Both halves matter. Without the chord half, holding the two sticks produces
   * no further joydev events and the 600 ms threshold is never sampled, so the
   * mode could never be entered. Without the pointer half, a stick held steady
   * would move the cursor once and stop.
   */
  const needsTicking = (): boolean =>
    remote !== null || chordHeld(sample().buttons, CHORD_BUTTONS_EVDEV)

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
        // The other half of the race `pointer/index.ts` settles: a window of
        // ours can take the pointer during the few hundred milliseconds the
        // portal spends opening, and `stop()` cannot undo a session that did
        // not exist yet when it ran. Asked again here, where the answer is
        // finally about the same instant the session becomes usable.
        if (deps.ownWindowActive()) {
          pointer.close()
          console.info(
            'Desktop pointer dropped as it opened: a window of ours has the cursor instead'
          )
          return
        }
        remote = pointer
        // Adopt whatever is held right now, so the buttons that were down
        // during the chord are not read as a click the instant it opens.
        held = heldActions(sample().buttons, POINTER_ACTIONS_EVDEV)
        heldCompose = heldActions(sample().buttons, COMPOSE_ACTIONS_EVDEV)
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
    heldCompose = []

    // Before the session goes: both keyboards were raised as part of this mode.
    // KWin's would sit over somebody's screen for the rest of the session, and
    // ours would be a window with a dead pad in it — the loop that drives it is
    // the one ending here.
    hideKeyboard()
    composer?.dispose()
    composer = null

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
   * LB + RB asks for a keyboard, and out here there are two answers.
   *
   * **The compositor's, if it will.** Ours is drawn by a preload into a page we
   * own and cannot follow the cursor out here: an Electron window created the
   * only way an overlay could be — `focusable: false`, `alwaysOnTop`,
   * `showInactive()` — takes the focus, and the focus is what decides where a
   * keystroke lands. KWin's keyboard is a layer-shell surface and has no such
   * problem, so it is asked first and the pad types on it with the cursor it
   * already has.
   *
   * **Ours, composed, if it will not.** KWin declines more often than not: it
   * raises its keyboard for touch, so `willShowOnActive` is false on any machine
   * without a touchscreen however loudly `forceActivate` is called. Then the
   * launcher stops trying to draw and type at the same time — `compose.ts` takes
   * the focus deliberately, collects the whole string, gets out of the way and
   * only then sends it. Same chord, same keyboard layout, one fewer promise.
   *
   * Fire and forget, because this is called from inside a 60 Hz tick and nothing
   * there may await. `toggleSystemKeyboard` never rejects.
   */
  const askForKeyboard = (): void => {
    if (keyboardPending) return

    // Already composing: the chord that opened it closes it, which is what it
    // does in every other layer of this mode.
    if (composer) {
      composer.cancel()
      return
    }

    keyboardPending = true

    void toggleSystemKeyboard().then((result) => {
      if (result.kind !== 'unavailable') {
        keyboardPending = false
        keyboardShown = result.kind === 'shown'
        console.info(`On-screen keyboard ${keyboardShown ? 'shown' : 'hidden'} by KWin`)
        return
      }

      keyboardShown = false
      // Once per session: the same sentence every press, and the log is a file
      // somebody has to be able to skim. Said at all because the fallback is
      // not the thing that was asked for and the difference is worth recording.
      if (!saidNoKeyboard) {
        saidNoKeyboard = true
        console.info(`KWin will not show its keyboard, composing instead. ${result.reason}`)
      }

      // The layout first, because it decides what the keyboard *is*. One D-Bus
      // round trip, and a failure resolves to null rather than throwing, so the
      // keyboard opens either way.
      //
      // `keyboardPending` deliberately stays set across *this* round trip too,
      // and it used to be cleared above. There are two awaits between the chord
      // and the window, and clearing after the first one left a gap in which a
      // second chord opened a second keyboard — losing the first one's window
      // handle, and with it any way to close it.
      void readSystemLayout().then(openCompose)
    })
  }

  /**
   * The fallback, and the only one that works with no help from the desktop.
   *
   * While it is up the pad belongs to it: the cursor stops moving, the wheel
   * stops scrolling, and A, B, X, Y and ☰ mean press, backspace, space, send
   * and cancel. That is not a mode within a mode for its own sake — a cursor
   * drifting behind a keyboard the user is reading is how a text field loses its
   * focus, and with it everything typed so far.
   */
  const openCompose = (layoutId: string | null): void => {
    // Cleared here rather than after the first round trip, and *before* the
    // guard below, so a mode that ended mid-flight releases the chord instead of
    // wedging it for the rest of the session.
    keyboardPending = false

    // Re-checked after the round trip that fetched the layout: a chord released
    // and pressed again, or ☰, could have ended the mode in the meantime.
    if (composer || !remote) return

    composer = openComposer({
      layoutId,
      look: deps.composeLook(),
      onFinished: (result) => {
        composer = null

        if (!result) {
          console.info('Composed text cancelled')
          return
        }
        if (!remote) {
          // The mode ended while the window was up — quitting, or ☰ from
          // another path. Typing into whatever is in front now would be input
          // nobody asked for.
          console.info('Composed text dropped: the pointer session had already ended')
          return
        }

        // Length only. This is a password field as often as not, and the log is
        // the file the README asks people to attach to a public issue.
        console.info(`Typing ${result.text.length} composed characters into the focused window`)
        for (const char of result.text) remote.typeChar(char)
        if (result.enter) remote.pressKey('Enter')
      }
    })
  }

  /**
   * Takes the compositor's keyboard away with the cursor that summoned it.
   *
   * Nothing else would: it is KWin's window, so it outlives our mode and would
   * sit over whatever is on screen for the rest of the session. Only sent when
   * we know we put it there, so this can never close a keyboard the user raised
   * some other way.
   */
  const hideKeyboard = (): void => {
    if (!keyboardShown) return
    keyboardShown = false
    void toggleSystemKeyboard().then((result) => {
      if (result.kind === 'unavailable') {
        console.info(`Could not put the on-screen keyboard away: ${result.reason}`)
      }
    })
  }

  /**
   * One sample of the chord, and it **acts on the toggle**.
   *
   * The whole of it is here rather than inline in `tick` because two things
   * sample it — the tick, and every joydev event that arrives between two ticks
   * — and the second one used to keep the `next` state and drop the `toggle`.
   * That is a silent swallow: the state it kept says `fired`, so the tick that
   * followed would not fire either, and a hold that crossed 600 ms a
   * millisecond before an axis event did nothing at all. With a thumb resting
   * on a stick that is most of them.
   */
  const stepTheChord = (current: PadReading, now: number): void => {
    const step = stepChord(chord, chordHeld(current.buttons, CHORD_BUTTONS_EVDEV), now)
    chord = step.next
    if (!step.toggle) return
    if (remote) stop('L3 + R3')
    else start()
  }

  const tick = (): void => {
    const now = Date.now()
    const dt = Math.max(0, now - lastTick)
    lastTick = now

    const current = sample()
    stepTheChord(current, now)

    if (remote) {
      const actions = heldActions(current.buttons, POINTER_ACTIONS_EVDEV)
      const edges = stepPointerButtons(held, actions)
      held = actions

      // Folded every frame, acted on only while the keyboard is up — see
      // `heldCompose`. Outside it X and Y are unmapped and stay that way: with a
      // bare cursor on screen the face buttons are a mouse.
      const composeActions = heldActions(current.buttons, COMPOSE_ACTIONS_EVDEV)
      const composeEdges = stepPointerButtons(heldCompose, composeActions)
      heldCompose = composeActions

      // The same shoulder pair as in our own windows, so the chord means one
      // thing everywhere even though what answers it differs.
      const keyboardStep = stepChord(
        keyboardChord,
        chordHeld(current.buttons, KEYBOARD_CHORD_BUTTONS_EVDEV),
        now,
        KEYBOARD_CHORD_HOLD_MS
      )
      keyboardChord = keyboardStep.next
      if (keyboardStep.toggle) askForKeyboard()

      if (composer) {
        // The pad belongs to the keyboard while it is up. Presses on the *down*
        // edge only, as everywhere else, so holding A does not fill the field.
        for (const action of edges.down) {
          if (action === 'leftClick') composer.press()
          if (action === 'rightClick') composer.backspace()
          if (action === 'exit') composer.cancel()
        }
        // The two keys the keycaps advertise. Same edge rule, same reason.
        for (const action of composeEdges.down) {
          if (action === 'space') composer.space()
          if (action === 'send') composer.send()
        }
        composer.step(composeDirection(current.axes), now)
      } else {
        for (const action of edges.up) onAction(action, false)
        for (const action of edges.down) onAction(action, true)

        moveCursor(current, dt)
        scrollWheel(current, dt)
      }
    }

    if (!needsTicking()) stopTicking()
  }

  const moveCursor = (current: PadReading, dt: number): void => {
    if (!remote) return
    const { leftX: x, leftY: y } = current.axes
    const magnitude = Math.hypot(x, y)
    const speed = pointerSpeed(magnitude)
    if (speed === 0) return

    // Relative motion, and normalised so a diagonal is not √2 faster — the same
    // arithmetic `stepPointer` does, except the compositor owns the position so
    // there is nothing here to clamp.
    const step = (speed * Math.min(dt, 100)) / 1_000 / magnitude
    remote.moveBy(x * step, y * step)
  }

  const scrollWheel = (current: PadReading, dt: number): void => {
    if (!remote) return
    scrollCarry += scrollDelta(current.axes.rightY, dt)

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
      // rather than at the next tick — the timer may already have stopped. It
      // goes through the same call the tick does, toggle included: half a step
      // here is what used to eat the toggle when an axis event landed on the
      // same millisecond the hold came due.
      if (!remote) stepTheChord(sample(), Date.now())
    })

    // How many devices were opened, not what they are reporting: joydev sends
    // its state dump asynchronously, so a pad that is plugged in has an empty
    // reading for another millisecond yet and "waiting for a pad" would be a
    // lie on every start.
    const pads = reader.connected()
    console.info(
      `Desktop pointer armed: ${
        pads === 0
          ? 'waiting for a pad'
          : pads === 1
            ? 'a pad is already connected'
            : `${pads} pads are already connected`
      }`
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
      // `stop` takes it with the session, and this is for the case where there
      // was no session to stop: a window of ours outliving `will-quit` is the
      // one way this feature could keep the application from closing.
      composer?.dispose()
      composer = null
      stopTicking()
      reader?.close()
      reader = null
    }
  }
}
