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
import type { Direction } from '@/gamepad/intents'

interface Focusable {
  id: string
  scope: string
  element: HTMLElement
  onConfirm?: (() => void) | undefined
}

interface SpatialFocusContextValue {
  focusedId: string | null
  activeScope: string
  setActiveScope(scope: string): void
  focus(id: string): void
  move(direction: Direction): void
  confirm(): void
  register(entry: Focusable): () => void
}

const SpatialFocusContext = createContext<SpatialFocusContextValue | null>(null)

/** How strongly drifting off-axis is penalised when picking a target. */
const ORTHOGONAL_PENALTY = 2.5

/** Rects that differ by less than this are treated as aligned. */
const EPSILON = 4

/**
 * How far apart two ranges are on the cross axis — zero when they overlap.
 *
 * Measured edge to edge rather than centre to centre, which matters wherever a
 * wide element sits above a narrow one. A full-width settings row and a 28px
 * colour swatch inside it have centres hundreds of pixels apart, so a
 * centre-based penalty made the swatches unreachable in either direction: down
 * from the row always preferred the next full-width row, and up from that row
 * preferred the first. Overlap is the honest measure of "these are lined up".
 */
function rangeGap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (bStart > aEnd) return bStart - aEnd
  if (aStart > bEnd) return aStart - bEnd
  return 0
}

/**
 * Scores a candidate for a directional move, or returns null when the candidate
 * does not lie in that direction at all.
 *
 * Grid UIs need spatial navigation rather than DOM-order traversal: pressing
 * "down" in a tile grid has to land in the same column, which document order
 * cannot express.
 */
export function scoreCandidate(
  current: DOMRect,
  candidate: DOMRect,
  direction: Direction
): number | null {
  const acrossX = (): number =>
    rangeGap(current.left, current.right, candidate.left, candidate.right)
  const acrossY = (): number =>
    rangeGap(current.top, current.bottom, candidate.top, candidate.bottom)

  let primary: number
  let orthogonal: number

  switch (direction) {
    case 'right':
      if (candidate.left < current.right - EPSILON) return null
      primary = candidate.left - current.right
      orthogonal = acrossY()
      break
    case 'left':
      if (candidate.right > current.left + EPSILON) return null
      primary = current.left - candidate.right
      orthogonal = acrossY()
      break
    case 'down':
      if (candidate.top < current.bottom - EPSILON) return null
      primary = candidate.top - current.bottom
      orthogonal = acrossX()
      break
    case 'up':
      if (candidate.bottom > current.top + EPSILON) return null
      primary = current.top - candidate.bottom
      orthogonal = acrossX()
      break
  }

  // Ties are left to the caller, which keeps the first candidate it saw —
  // registration order, i.e. DOM order. That is what makes a row of equally
  // aligned swatches land on the leftmost rather than an arbitrary one.
  return primary + orthogonal * ORTHOGONAL_PENALTY
}

export function SpatialFocusProvider({ children }: { children: ReactNode }): ReactNode {
  const registry = useRef(new Map<string, Focusable>())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [activeScope, setActiveScopeState] = useState('root')
  const focusedIdRef = useRef<string | null>(null)
  const activeScopeRef = useRef('root')

  focusedIdRef.current = focusedId
  activeScopeRef.current = activeScope

  const entriesInScope = useCallback((): Focusable[] => {
    const scope = activeScopeRef.current
    return [...registry.current.values()].filter(
      (entry) => entry.scope === scope && entry.element.isConnected
    )
  }, [])

  /**
   * A `focus(id)` for something that has not mounted yet.
   *
   * Callers routinely ask for an element in the same tick it is created — "land
   * on the first tile when the catalog arrives", "land on Play when the panel
   * opens". Whether the ref callback has run by then is a race, and losing it
   * used to strand the cursor on the nav rail. Holding the intent and honouring
   * it at registration makes the outcome the same either way.
   */
  const pendingFocus = useRef<string | null>(null)

  const focus = useCallback((id: string) => {
    const entry = registry.current.get(id)
    if (!entry) {
      pendingFocus.current = id
      return
    }

    pendingFocus.current = null
    // The ref is written here rather than only on the next render: the recovery
    // microtasks below run before React commits, and a ref that lagged state
    // would make them think focus was still on an element that has just been
    // moved away from.
    focusedIdRef.current = id
    setFocusedId(id)
    entry.element.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [])

  /** Focuses the first entry in reading order — used when a scope opens. */
  const focusFirst = useCallback(() => {
    const entries = entriesInScope()
    if (entries.length === 0) return
    const first = entries.reduce((best, entry) => {
      const bestRect = best.element.getBoundingClientRect()
      const rect = entry.element.getBoundingClientRect()
      if (rect.top < bestRect.top - EPSILON) return entry
      if (Math.abs(rect.top - bestRect.top) <= EPSILON && rect.left < bestRect.left) return entry
      return best
    })
    focus(first.id)
  }, [entriesInScope, focus])

  /**
   * Puts the cursor somewhere sane, but only if it has actually been lost.
   *
   * Both recovery paths below go through this. The guard is the important part:
   * a scope changing over means dozens of elements register and unregister in
   * one commit, and every one of them queues a recovery. Without the check the
   * last one to run wins, which is whatever happens to be top-left — the nav
   * rail — rather than wherever the caller deliberately sent focus.
   */
  const focusFirstIfLost = useCallback(() => {
    // An outstanding request outranks recovery: the caller knows where the
    // cursor belongs, this only knows where it can legally go.
    if (pendingFocus.current) return
    const current = focusedIdRef.current
    const currentEntry = current ? registry.current.get(current) : undefined
    if (currentEntry && currentEntry.scope === activeScopeRef.current) return
    focusFirst()
  }, [focusFirst])

  const register = useCallback(
    (entry: Focusable) => {
      registry.current.set(entry.id, entry)

      // The element somebody already asked for has just arrived.
      if (pendingFocus.current === entry.id) {
        focus(entry.id)
      } else {
        // First thing to appear in a scope takes focus, so the user is never
        // left without a cursor.
        queueMicrotask(focusFirstIfLost)
      }

      return () => {
        registry.current.delete(entry.id)
        // An element that has gone away cannot be the thing we are waiting for.
        // Leaving the request standing would gag recovery for good.
        if (pendingFocus.current === entry.id) pendingFocus.current = null
        if (focusedIdRef.current === entry.id) {
          queueMicrotask(focusFirstIfLost)
        }
      }
    },
    [focus, focusFirstIfLost]
  )

  const move = useCallback(
    (direction: Direction) => {
      const entries = entriesInScope()
      const current = focusedIdRef.current ? registry.current.get(focusedIdRef.current) : undefined

      if (!current || current.scope !== activeScopeRef.current) {
        focusFirst()
        return
      }

      const currentRect = current.element.getBoundingClientRect()
      let best: { id: string; score: number } | null = null

      for (const entry of entries) {
        if (entry.id === current.id) continue
        const score = scoreCandidate(currentRect, entry.element.getBoundingClientRect(), direction)
        if (score === null) continue
        if (!best || score < best.score) best = { id: entry.id, score }
      }

      if (best) focus(best.id)
    },
    [entriesInScope, focus, focusFirst]
  )

  const confirm = useCallback(() => {
    const current = focusedIdRef.current ? registry.current.get(focusedIdRef.current) : undefined
    current?.onConfirm?.()
  }, [])

  const setActiveScope = useCallback(
    (scope: string) => {
      activeScopeRef.current = scope
      setActiveScopeState(scope)
      // Whatever the last layer was waiting for is not this layer's business.
      // Callers that want a specific landing ask for it after this returns.
      pendingFocus.current = null
      queueMicrotask(focusFirst)
    },
    [focusFirst]
  )

  const value = useMemo<SpatialFocusContextValue>(
    () => ({ focusedId, activeScope, setActiveScope, focus, move, confirm, register }),
    [focusedId, activeScope, setActiveScope, focus, move, confirm, register]
  )

  return <SpatialFocusContext.Provider value={value}>{children}</SpatialFocusContext.Provider>
}

export function useSpatialFocus(): SpatialFocusContextValue {
  const context = useContext(SpatialFocusContext)
  if (!context) throw new Error('useSpatialFocus must be used inside a SpatialFocusProvider')
  return context
}

interface UseFocusableOptions {
  scope?: string
  onConfirm?: (() => void) | undefined
}

/** Registers an element as a focus target. Returns a ref and its focus state. */
export function useFocusable<T extends HTMLElement>(
  id: string,
  options: UseFocusableOptions = {}
): { ref: (node: T | null) => void; focused: boolean } {
  const { register, focusedId } = useSpatialFocus()
  const scope = options.scope ?? 'root'
  const onConfirm = options.onConfirm
  const cleanup = useRef<(() => void) | null>(null)

  const latestConfirm = useRef(onConfirm)
  latestConfirm.current = onConfirm

  const ref = useCallback(
    (node: T | null) => {
      cleanup.current?.()
      cleanup.current = null
      if (!node) return
      cleanup.current = register({
        id,
        scope,
        element: node,
        onConfirm: () => latestConfirm.current?.()
      })
    },
    [id, scope, register]
  )

  useEffect(() => () => cleanup.current?.(), [])

  return { ref, focused: focusedId === id }
}
