import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Notice } from '@shared/notify'
import { NoticeStack } from './components/NoticeStack'
import './styles/globals.css'

/**
 * The notice overlay's page.
 *
 * The second React entry, and the smallest thing it could be: no
 * `GamepadProvider`, no `SpatialFocusProvider`, no error boundary worth the
 * name. This window has no input, no focus model and no state of its own —
 * main pushes the whole list and this draws it, which is the same arrangement
 * `compose.html` has and for the same reason.
 *
 * It renders the launcher's own `NoticeStack`, not a copy of it. That is the
 * point of reusing `preload/index.cjs` here rather than growing a fourth
 * preload: both surfaces subscribe through one bridge method and draw one
 * component, so a card cannot come to look different depending on whether a
 * game happened to be running when it appeared.
 */

// The main process tees this window's console into `gfn-launcher.log`, and for
// a window that is only ever on screen for three seconds at a time that file is
// the only witness there is.
window.addEventListener('error', (event) => {
  console.error('Uncaught error in the notice overlay:', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection in the notice overlay:', event.reason)
})

function NoticeOverlay(): React.ReactNode {
  const [notices, setNotices] = useState<readonly Notice[]>([])

  // Optional-chained like every other bridge call in this project: a preload
  // that failed to load throws on property access during commit, and the crash
  // would be invisible in a transparent window nobody is looking at.
  useEffect(() => window.launcher?.app.onNotice(setNotices), [])

  return <NoticeStack notices={notices} />
}

const container = document.getElementById('root')
if (!container) throw new Error('Root element is missing from notify.html')

createRoot(container).render(
  <StrictMode>
    <NoticeOverlay />
  </StrictMode>
)
