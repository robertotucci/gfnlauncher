import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'

/**
 * What the launcher shows when the launcher is what broke.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * React unmounts the whole tree when a render throws and nothing catches it.
 * On a desktop that is a white page and a devtools console; here it is a black
 * rectangle on a television, with no menu bar, no keyboard, and a gamepad
 * talking to a document that no longer draws anything. It is the only failure
 * in this codebase that is worse than the ones `LaunchNotice` and the power
 * dialog exist to avoid, because there is nothing left on screen to be honest
 * *with*.
 *
 * ── Why it depends on almost nothing ────────────────────────────────────────
 *
 * The boundary sits outside `GamepadProvider` and `SpatialFocusProvider` in
 * `main.tsx`, so either of them may be the thing that threw. That rules out
 * using them here: `useSpatialFocus` throws outside its provider by design, and
 * a crash screen that crashes leaves the black rectangle after all. So the
 * input handling below is fifteen lines of its own rather than the launcher's —
 * one `keydown` listener and one `requestAnimationFrame` poll for any button on
 * any pad, which between them cover every device this runs on.
 *
 * ── Why reloading is the offer ──────────────────────────────────────────────
 *
 * `location.reload()` rebuilds the renderer against a main process that never
 * stopped, so settings, the catalog cache and the GFN session all survive it.
 * It is the only recovery a person three metres away can perform, and it fixes
 * the ordinary case — a transient fault in one screen's data.
 *
 * It is offered rather than performed. An automatic reload on a fault that
 * happens every time is a launcher that flickers forever and can never be
 * photographed, and the photograph is the bug report.
 */

interface CrashState {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, CrashState> {
  override state: CrashState = { error: null }

  static getDerivedStateFromError(error: unknown): CrashState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Through `console.error` on purpose: the main process tees the renderer's
    // console into the log file, so this is what puts a component stack in the
    // file the README asks people to attach. There is no other route — the
    // preload surface is an explicit allow-list and a diagnostic is not a good
    // enough reason to widen it.
    console.error('The interface crashed:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <CrashScreen error={this.state.error} />
  }
}

function CrashScreen({ error }: { error: Error }): ReactNode {
  const [logPath, setLogPath] = useState<string | null>(null)

  // Optional chaining all the way down, because a preload that failed to load
  // is one of the things that gets us here, and an exception thrown from this
  // screen has nowhere left to be caught.
  useEffect(() => {
    void window.launcher?.app
      ?.diagnostics?.()
      .then((diagnostics) => setLogPath(diagnostics.logPath))
      .catch(() => setLogPath(null))
  }, [])

  useAnyInput(() => window.location.reload())

  return (
    <div className="bg-background text-foreground flex h-full flex-col items-center justify-center gap-6 px-16 text-center">
      <div>
        <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          GFN Launcher
        </p>
        <h1 className="mt-3 text-[clamp(1.9rem,3.4vw,2.75rem)] leading-none font-semibold tracking-tight">
          The interface stopped
        </h1>
      </div>

      <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
        Something in the launcher failed while drawing the screen. Nothing on this machine has
        been changed, and your settings, catalogue and sign-in are all still there.
      </p>

      {/* The message verbatim, in mono, for the same reason `LaunchNotice`
          carries the argv and the power dialog quotes polkit: it is the only
          account of the fault anyone in the room will get. */}
      <p className="border-border bg-card text-muted-foreground max-w-2xl truncate rounded-md border px-4 py-2 font-mono text-xs">
        {error.message || error.name}
      </p>

      <p className="text-sm">
        Press any button on the pad — or any key — to reload the interface.
      </p>

      {logPath && (
        <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">
          If it keeps happening, please open an issue and attach this file:
          <br />
          <span className="text-foreground font-mono">{logPath}</span>
        </p>
      )}
    </div>
  )
}

/**
 * Fires once, on any key or any gamepad button.
 *
 * Self-contained rather than routed through `intents.ts`, because the mapping
 * there is about *meaning* — confirm, back, search — and this screen has one
 * action and no cursor. It is also the module least entitled to assume the
 * launcher's own input stack is working.
 *
 * The initial button state is captured on the first frame rather than assumed
 * to be "nothing held": whatever press led here may still be down, and reading
 * it as a fresh one would reload the moment this screen appeared.
 */
function useAnyInput(onInput: () => void): void {
  useEffect(() => {
    let frame = 0
    let baseline: boolean[] | null = null
    let done = false

    const fire = (): void => {
      if (done) return
      done = true
      onInput()
    }

    const onKeyDown = (): void => fire()
    window.addEventListener('keydown', onKeyDown)

    const tick = (): void => {
      try {
        const pressed: boolean[] = []
        for (const pad of navigator.getGamepads?.() ?? []) {
          if (!pad) continue
          for (const button of pad.buttons) pressed.push(button.pressed)
        }

        if (baseline === null || baseline.length !== pressed.length) {
          baseline = pressed
        } else if (pressed.some((down, index) => down && !baseline?.[index])) {
          fire()
          return
        }
      } catch {
        // A pad the browser cannot read is not a reason to lose the keyboard.
      }
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)

    return () => {
      done = true
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onInput])
}
