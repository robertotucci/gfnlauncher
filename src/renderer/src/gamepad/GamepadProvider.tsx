import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { SCREEN_OURS, shouldAcceptInput, type InputGate } from '@shared/input'
import {
  BUTTON_ACTIONS,
  KEY_BINDINGS,
  readDirection,
  type GamepadAction,
  type Intent,
  type IntentHandler
} from './intents'
import { PAD_START, stepPad } from './pad'
import { detectPadScheme, type InputScheme } from './scheme'

interface GamepadContextValue {
  /** Subscribe to input intents. Returns an unsubscribe function. */
  subscribe(handler: IntentHandler): () => void
  /** True while at least one pad is connected. */
  connected: boolean
  /**
   * False when the window has lost focus.
   *
   * This is a report, not the gate — `shouldAcceptInput` is the gate, and it
   * also accepts a blurred launcher that nothing is standing in front of. The
   * footer shows this one because it is the half a user can act on.
   */
  windowFocused: boolean
  /**
   * `shouldAcceptInput` itself — whether the launcher may act on input at all.
   *
   * Exposed because the pad is not the only way in. A real mouse click, and now
   * a synthetic one from pointer mode's cursor, reach the DOM without passing
   * anything in this file, so `App` uses this to take the whole tree out of the
   * pointer's reach while somebody else has the screen. Fails open with the
   * rest: a focused launcher is always accepted, so this can never make a
   * window the user is looking at unclickable.
   */
  inputAccepted: boolean
  /** Glyph set for the device in hand: the pad's family, or the keyboard. */
  scheme: InputScheme
}

const GamepadContext = createContext<GamepadContextValue | null>(null)

/**
 * One polling loop for the whole app.
 *
 * The Gamepad API has no event stream for button state, so it has to be polled.
 * Polling once here and fanning out to subscribers keeps the cost fixed and, more
 * importantly, keeps repeat timing consistent — per-component loops would each
 * run their own repeat clock and the UI would accelerate unpredictably.
 *
 * Subscribers are held in a ref, so delivering an intent never re-renders this
 * provider.
 */
export function GamepadProvider({ children }: { children: ReactNode }): ReactNode {
  const handlers = useRef(new Set<IntentHandler>())
  const [connected, setConnected] = useState(false)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  /**
   * Starts true, like `SCREEN_OURS` does, and for the same reason: a push that
   * never arrives has to cost correctness rather than control.
   */
  const [inputAccepted, setInputAccepted] = useState(true)
  const [scheme, setScheme] = useState<InputScheme>('keyboard')
  /**
   * Everything `shouldAcceptInput` needs, in a ref rather than in state.
   *
   * **The poll loop must not be re-created when any of this changes.** Its
   * effect has `[emit]` deps for that reason: tearing it down and rebuilding it
   * would reset the edge baseline `stepPad` carries, which is precisely the
   * thing that stops the button you quit a game with from firing when the
   * launcher comes back. So the gate reaches the loop by reference and the
   * React state beside it exists only for the footer.
   *
   * `focused` is re-read from `document.hasFocus()` on every frame; only
   * `minimised` and `handedOff` are pushed in from outside.
   */
  const gate = useRef<InputGate>({ focused: document.hasFocus(), ...SCREEN_OURS })
  /**
   * Which device the legend is currently following. Only a *press* moves it, so
   * plugging a pad in mid-sentence does not relabel the footer under someone
   * who is still typing; 'key' sticks until the pad is actually touched.
   */
  const lastSource = useRef<'pad' | 'key' | null>(null)
  /**
   * True while main is driving a desktop cursor with the same pad.
   *
   * In a ref beside the gate and for the same reason: the poll loop must not be
   * rebuilt when it changes, or the edge baseline `stepPad` carries would reset
   * — which is the thing that stops the button you left a mode with from firing
   * as you come back to the grid.
   */
  const pointerMode = useRef(false)

  /**
   * Delivers one intent to every subscriber, and lets none of them stop the
   * loop.
   *
   * **This try/catch is the difference between a bug and a brick.** `emit` is
   * called from inside the `requestAnimationFrame` tick below, so an exception
   * thrown by a handler propagates out of `tick` — past the
   * `requestAnimationFrame(tick)` that would have scheduled the next frame.
   * The loop simply stops, and on a gamepad-only launcher that is every input
   * dead for the rest of the session, with no keyboard in the room to recover
   * with and nothing on screen to say why.
   *
   * There is exactly one subscriber and it is `App`'s intent handler, which
   * touches most of the state in the application. Isolating each handler costs
   * one frame's worth of nothing and turns "the launcher stopped responding"
   * into "one press did nothing, and the log says which".
   */
  const emit = useCallback((intent: Intent) => {
    for (const handler of handlers.current) {
      try {
        handler(intent)
      } catch (error) {
        console.error('A gamepad intent handler threw; input continues.', intent, error)
      }
    }
  }, [])

  const subscribe = useCallback((handler: IntentHandler) => {
    handlers.current.add(handler)
    return () => {
      handlers.current.delete(handler)
    }
  }, [])

  // Pad polling.
  useEffect(() => {
    let frame = 0
    let padState = PAD_START
    /** What the log last said, so only transitions are written down. */
    let announced = true
    let suspendedAt = 0
    /** Frames on which the pad reported something while suspended. See below. */
    let suspendedFrames = 0

    const applyScheme = (next: InputScheme): void => {
      setScheme((current) => (current === next ? current : next))
    }

    /**
     * One poll.
     *
     * The whole body is wrapped and the next frame is scheduled in `finally`,
     * for the reason `emit` above documents: this loop is the only path input
     * takes, so anything that escapes it ends input for the session. `emit`
     * already guards the handlers; this covers the rest — a `navigator.getGamepads`
     * that throws behind a driver fault, a `setConnected` during teardown.
     */
    const tick = (): void => {
      try {
        poll()
      } catch (error) {
        console.error('The gamepad poll threw; continuing.', error)
      } finally {
        frame = requestAnimationFrame(tick)
      }
    }

    const poll = (): void => {
      const pads = navigator.getGamepads?.() ?? []
      let anyConnected = false
      let direction: ReturnType<typeof readDirection> = null
      const nowPressed = new Set<GamepadAction>()
      /** The pad the legend describes: the one being used, else the first one. */
      let firstPadId: string | null = null
      let activePadId: string | null = null

      for (const pad of pads) {
        if (!pad) continue
        anyConnected = true
        firstPadId ??= pad.id

        const padDirection = readDirection(pad)
        direction ??= padDirection
        let padActive = padDirection !== null

        for (const [index, action] of Object.entries(BUTTON_ACTIONS)) {
          if (pad.buttons[Number(index)]?.pressed) {
            nowPressed.add(action)
            padActive = true
          }
        }

        if (padActive) activePadId ??= pad.id
      }

      setConnected((current) => (current === anyConnected ? current : anyConnected))

      // No pad means the keyboard is the only way in, whatever was used before.
      if (!anyConnected) {
        lastSource.current = null
        applyScheme('keyboard')
      } else if (activePadId) {
        lastSource.current = 'pad'
        applyScheme(detectPadScheme(activePadId))
      } else if (firstPadId && lastSource.current !== 'key') {
        applyScheme(detectPadScheme(firstPadId))
      }

      // Everything above runs whether or not the launcher may act on any of it,
      // so `connected` and the legend are already correct the instant it comes
      // back — the footer is the one thing that must not go stale while the
      // screen belongs to somebody else.
      const now = performance.now()

      // Read rather than remembered. `focus` and `blur` are notifications and
      // can be missed: the window is created hidden and shown later, so the
      // launcher's *first* activation happens before any listener in the
      // renderer could see it — which left the footer reading
      // "WINDOW NOT FOCUSED" for the whole of a session that was focused
      // throughout, and would have left the gate running on `handedOff` alone.
      // `document.hasFocus()` is the state itself, and this loop is already
      // asking the browser questions sixty times a second.
      const focused = document.hasFocus()
      if (focused !== gate.current.focused) {
        gate.current = { ...gate.current, focused }
        setWindowFocused(focused)
      }

      const allowed = shouldAcceptInput(gate.current)

      /**
       * The pad gate, which is the screen gate plus one more thing.
       *
       * While main is driving a desktop cursor with this same pad, the stick
       * must move the cursor and not also walk the grid under it. Folding it in
       * here rather than skipping `stepPad` is deliberate: the fold's adoption
       * rule then covers the exit for free, so the ☰ that ended pointer mode is
       * not read as a fresh press by the grid the instant it comes back.
       */
      const accepted = allowed && !pointerMode.current

      // Mirrored into state on a transition, never per frame. `App` reads it to
      // decide whether the DOM may be clicked — and that is the *screen* gate,
      // not this one: with a cursor over the launcher, clicking is the point.
      setInputAccepted((current) => (current === allowed ? current : allowed))

      if (accepted !== announced) {
        announced = accepted
        if (accepted) {
          console.info(
            `Pad input resumed after ${Math.round((now - suspendedAt) / 1000)}s; ` +
              `the pad reported input on ${suspendedFrames} frames while it was suspended.`
          )
        } else {
          suspendedAt = now
          suspendedFrames = 0
          const { focused, minimised, handedOff } = gate.current
          console.info(
            `Pad input suspended: focused=${focused} minimised=${minimised} ` +
              `handedOff=${handedOff} pointerMode=${pointerMode.current}`
          )
        }
      }

      // The count is the evidence, and it is the whole reason this is logged at
      // all: a large number says Chromium went on feeding a blurred window,
      // which is the fault this gate exists for. A zero across a session the
      // user knows they mashed the pad through says something else changed and
      // the gate is doing nothing.
      if (!accepted && (nowPressed.size > 0 || direction !== null)) suspendedFrames += 1

      const step = stepPad(padState, {
        pressed: [...nowPressed],
        direction,
        accepted,
        now
      })
      padState = step.next
      for (const intent of step.intents) emit(intent)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [emit])

  // Keyboard mirror.
  //
  // **This used to be deliberately ungated, and the argument for that is now
  // false.** It ran: a window that is not focused receives no `keydown` at all,
  // so the operating system has already applied a stricter rule than
  // `shouldAcceptInput` would — which is why the original bug was a pad bug and
  // never a keyboard one, and why `npm run dev` could not reproduce it.
  //
  // That holds for a keyboard somebody is typing on. It stopped holding the
  // moment this launcher grew one of its own: pointer mode's on-screen keyboard
  // injects real keycodes through the compositor, and on Wayland the compositor
  // may perfectly well have left the focus on the launcher while a stream is in
  // front of it. A `/` typed into a remote Steam field would then open our
  // search, and `Enter` would confirm whatever the cursor was sitting on.
  //
  // So it is gated like everything else, and the gate still fails open — a
  // focused launcher accepts unconditionally.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!shouldAcceptInput(gate.current)) return

      // Let text fields keep their own keys.
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') {
        if (event.key !== 'Escape' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
          return
        }
      }

      const intent = KEY_BINDINGS[event.key]
      if (!intent) return
      event.preventDefault()
      // Only a bound key counts as "using the keyboard" — an unrelated keypress
      // should not pull the legend away from a pad that is still in hand.
      lastSource.current = 'key'
      setScheme((current) => (current === 'keyboard' ? current : 'keyboard'))
      emit(intent)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [emit])

  /**
   * The other half, which only main can answer: whether anything is standing in
   * front of us.
   *
   * Optional, like `padActivity`'s call: a preload that failed to load leaves
   * `window.launcher` undefined, and the correct behaviour then is the
   * permissive default this started with rather than a launcher that has also
   * lost its pad.
   */
  useEffect(() => {
    return window.launcher?.app.onScreen((screen) => {
      gate.current = { ...gate.current, ...screen }
    })
  }, [])

  /**
   * The other thing only main can answer: whether it is driving a cursor with
   * this pad. Optional for the same reason as the call above — a preload that
   * failed to load leaves the permissive default, which here is "the grid still
   * answers the pad".
   */
  useEffect(() => {
    return window.launcher?.app.onPointerMode((active) => {
      pointerMode.current = active
    })
  }, [])

  const value = useMemo<GamepadContextValue>(
    () => ({ subscribe, connected, windowFocused, inputAccepted, scheme }),
    [subscribe, connected, windowFocused, inputAccepted, scheme]
  )

  return <GamepadContext.Provider value={value}>{children}</GamepadContext.Provider>
}

export function useGamepad(): GamepadContextValue {
  const context = useContext(GamepadContext)
  if (!context) throw new Error('useGamepad must be used inside a GamepadProvider')
  return context
}

/** Runs `handler` for every intent. The handler may change between renders. */
export function useIntent(handler: IntentHandler): void {
  const { subscribe } = useGamepad()
  const latest = useRef(handler)
  latest.current = handler

  useEffect(() => subscribe((intent) => latest.current(intent)), [subscribe])
}
