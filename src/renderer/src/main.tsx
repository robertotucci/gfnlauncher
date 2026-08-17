import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/CrashScreen'
import { GamepadProvider } from './gamepad/GamepadProvider'
import { SpatialFocusProvider } from './focus/SpatialFocus'
import './styles/globals.css'

/**
 * Everything that escapes a component, on its way to the log file.
 *
 * The main process tees this window's `console` into `gfn-launcher.log`, so a
 * `console.error` here is the renderer's only route into the file a bug report
 * carries — and these two events are how the failures that never reach an
 * `await` get there. An unhandled rejection in particular is the ordinary shape
 * of a bug in this codebase: nearly every control ends in a `void somePromise`.
 */
window.addEventListener('error', (event) => {
  console.error('Uncaught error in the interface:', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection in the interface:', event.reason)
})

const container = document.getElementById('root')
if (!container) throw new Error('Root element is missing from index.html')

createRoot(container).render(
  <StrictMode>
    {/*
      Outside the providers, not inside: `GamepadProvider` and
      `SpatialFocusProvider` are both things that can throw, and a boundary
      below them would be unmounted along with the tree it was meant to
      replace. `CrashScreen` depends on neither for exactly this reason.
    */}
    <ErrorBoundary>
      <GamepadProvider>
        <SpatialFocusProvider>
          <App />
        </SpatialFocusProvider>
      </GamepadProvider>
    </ErrorBoundary>
  </StrictMode>
)
