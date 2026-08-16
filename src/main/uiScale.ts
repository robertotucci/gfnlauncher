import type { BrowserWindow } from 'electron'
import { scaleValue } from '@shared/theme'

/**
 * Applies the user's interface scale to a window.
 *
 * Zoom rather than a CSS multiplier because it catches everything a rem-based
 * multiplier cannot — border widths, ring offsets, radii — and needs no
 * cooperation from the components.
 *
 * The companion change lives in `globals.css`: the root font-size must not be
 * expressed in `vw`. Zoom shrinks the CSS viewport by exactly the factor it
 * magnifies by, so any `vw` term is invariant under it — a
 * `clamp(16px, 1.05vw, 20px)` root would cancel the user's choice outright
 * between 100% and ~130% and leave the type the only thing that did not grow.
 *
 * Deliberately not persisted by Chromium's own per-origin zoom: that survives
 * across reloads in ways the settings file cannot see, so this is re-applied
 * from `Settings` on every load instead.
 */
export function applyUiScale(window: BrowserWindow | null, uiScale: string): void {
  if (!window || window.isDestroyed()) return
  window.webContents.setZoomFactor(scaleValue(uiScale))
}
