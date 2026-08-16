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
import {
  BUTTON_ACTIONS,
  KEY_BINDINGS,
  REPEAT_DELAY_MS,
  REPEAT_INTERVAL_MS,
  readDirection,
  type Intent,
  type IntentHandler
} from './intents'
import { detectPadScheme, type InputScheme } from './scheme'

interface GamepadContextValue {
  /** Subscribe to input intents. Returns an unsubscribe function. */
  subscribe(handler: IntentHandler): () => void
  /** True while at least one pad is connected. */
  connected: boolean
  /** False when the window has lost focus — the Gamepad API goes silent then. */
  windowFocused: boolean
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
  const [scheme, setScheme] = useState<InputScheme>('keyboard')
  /**
   * Which device the legend is currently following. Only a *press* moves it, so
   * plugging a pad in mid-sentence does not relabel the footer under someone
   * who is still typing; 'key' sticks until the pad is actually touched.
   */
  const lastSource = useRef<'pad' | 'key' | null>(null)

  const emit = useCallback((intent: Intent) => {
    for (const handler of handlers.current) handler(intent)
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
    let heldDirection: string | null = null
    let repeatAt = 0
    const pressed = new Set<string>()

    const applyScheme = (next: InputScheme): void => {
      setScheme((current) => (current === next ? current : next))
    }

    const tick = (): void => {
      const pads = navigator.getGamepads?.() ?? []
      let anyConnected = false
      let direction: ReturnType<typeof readDirection> = null
      const nowPressed = new Set<string>()
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

      // Buttons fire once per press, never on hold.
      for (const action of nowPressed) {
        if (!pressed.has(action)) {
          emit({ kind: 'action', action: action as never })
        }
      }
      pressed.clear()
      for (const action of nowPressed) pressed.add(action)

      const now = performance.now()
      if (direction === null) {
        heldDirection = null
      } else if (direction !== heldDirection) {
        heldDirection = direction
        repeatAt = now + REPEAT_DELAY_MS
        emit({ kind: 'move', direction })
      } else if (now >= repeatAt) {
        repeatAt = now + REPEAT_INTERVAL_MS
        emit({ kind: 'move', direction })
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [emit])

  // Keyboard mirror.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
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

  // The Gamepad API only reports to a focused window, so a blurred launcher is
  // an unresponsive launcher. Surface it rather than letting input die silently.
  useEffect(() => {
    const onFocus = (): void => setWindowFocused(true)
    const onBlur = (): void => setWindowFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const value = useMemo<GamepadContextValue>(
    () => ({ subscribe, connected, windowFocused, scheme }),
    [subscribe, connected, windowFocused, scheme]
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
