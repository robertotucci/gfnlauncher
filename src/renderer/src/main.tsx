import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { GamepadProvider } from './gamepad/GamepadProvider'
import { SpatialFocusProvider } from './focus/SpatialFocus'
import './styles/globals.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root element is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <GamepadProvider>
      <SpatialFocusProvider>
        <App />
      </SpatialFocusProvider>
    </GamepadProvider>
  </StrictMode>
)
