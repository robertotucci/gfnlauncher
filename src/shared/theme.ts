/**
 * The two things about the interface the user gets to choose: its accent and
 * its size.
 *
 * Everything else is stock shadcn `neutral` dark, so the accent is the only
 * chromatic element in the whole shell — it paints the focus ring, the primary
 * button and the "this is alive" markers, and nothing else.
 *
 * Presets rather than a free colour: with no pointer and no keyboard, a picker
 * would be a slider the user has to fight, and an arbitrary colour can land
 * anywhere on the contrast scale. A row of swatches is one press per choice.
 *
 * Shared, so `main` can validate what it persists against the same list the
 * renderer draws. Free of Node and DOM APIs, like everything in `src/shared`.
 */

export interface AccentPreset {
  /** Stored in settings.json. Stable — renaming one resets that user's choice. */
  id: string
  label: string
  /** A CSS colour, assigned to `--brand`. */
  value: string
}

/**
 * All at lightness ≥ 0.80, which is not a stylistic preference but the reason
 * `--primary-foreground` can stay a single dark value: no preset can be picked
 * that leaves text on a primary button unreadable. It also keeps the focus ring
 * the brightest thing on screen, which is what makes it findable across a room.
 */
const WHITE: AccentPreset = { id: 'white', label: 'White', value: 'oklch(0.985 0 0)' }

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  WHITE,
  { id: 'ice', label: 'Ice', value: 'oklch(0.85 0.1 240)' },
  { id: 'mint', label: 'Mint', value: 'oklch(0.86 0.13 165)' },
  { id: 'amber', label: 'Amber', value: 'oklch(0.86 0.14 85)' },
  { id: 'coral', label: 'Coral', value: 'oklch(0.8 0.14 30)' },
  { id: 'violet', label: 'Violet', value: 'oklch(0.82 0.11 300)' },
  { id: 'rose', label: 'Rose', value: 'oklch(0.83 0.12 350)' }
]

export const DEFAULT_ACCENT = WHITE.id

export function isAccentId(value: unknown): value is string {
  return typeof value === 'string' && ACCENT_PRESETS.some((preset) => preset.id === value)
}

/**
 * The CSS colour for a stored id, falling back to white.
 *
 * The fallback matters on both sides of the bridge: settings written by a newer
 * build can name a preset this one has never heard of, and the answer to that
 * is the default accent, not an empty custom property.
 */
export function accentPreset(id: string | null | undefined): AccentPreset {
  return ACCENT_PRESETS.find((candidate) => candidate.id === id) ?? WHITE
}

export function accentValue(id: string | null | undefined): string {
  return accentPreset(id).value
}

/**
 * How large the interface is drawn, as a zoom factor on the whole renderer.
 *
 * A percentage rather than a resolution: the launcher cannot and should not
 * change the TV's video mode, and zooming the window is what the user actually
 * means by "make it bigger". Presets rather than a slider, for the same reason
 * the accent is a row of swatches — one press per choice, no fighting a
 * continuous control with a d-pad.
 *
 * Stored as an id, again like the accent: the value ends up as an argument to
 * `webContents.setZoomFactor`, and a hand-edited settings file should not be
 * able to put the UI at 0.01.
 */
export interface UiScalePreset {
  /** Stored in settings.json. Stable — renaming one resets that user's choice. */
  id: string
  label: string
  /** Zoom factor handed to `webContents.setZoomFactor`. */
  value: number
}

const SCALE_100: UiScalePreset = { id: '100', label: '100%', value: 1 }

export const UI_SCALE_PRESETS: readonly UiScalePreset[] = [
  { id: '75', label: '75%', value: 0.75 },
  SCALE_100,
  { id: '125', label: '125%', value: 1.25 },
  { id: '150', label: '150%', value: 1.5 },
  { id: '175', label: '175%', value: 1.75 }
]

export const DEFAULT_UI_SCALE = SCALE_100.id

export function isScaleId(value: unknown): value is string {
  return typeof value === 'string' && UI_SCALE_PRESETS.some((preset) => preset.id === value)
}

/** The zoom factor for a stored id, falling back to 1 for anything unknown. */
export function scaleValue(id: string | null | undefined): number {
  return (UI_SCALE_PRESETS.find((candidate) => candidate.id === id) ?? SCALE_100).value
}

/**
 * How large the on-screen keyboard is drawn.
 *
 * A second size control rather than a reuse of `uiScale`, because it is not the
 * same question. That one zooms the launcher's own renderer; the keyboard LB +
 * RB raises is not the launcher — it is a sheet over somebody else's window,
 * with one job, being typed on. Its right size follows from the pad and the
 * distance rather than from how large the covers are, and the field being
 * filled in is *behind* it, so a bigger keyboard covers more of the thing you
 * are typing into. 150% on the grid and 90% here is a coherent pair of answers.
 *
 * The value is a **CSS multiplier**, written into `--kb-scale`, and deliberately
 * not a zoom factor. `setZoomFactor` on the compose window would break the one
 * CSS pixel = one DIP identity that `composeSafeBottom` depends on: that inset
 * is measured in display pixels in main and consumed as CSS pixels in the page.
 *
 * Stored as an id, like the other two, for the same reason.
 */
export interface KeyboardScalePreset {
  /** Stored in settings.json. Stable — renaming one resets that user's choice. */
  id: string
  label: string
  /** Multiplier written into `--kb-scale` on the keyboard. */
  value: number
}

const KEYBOARD_100: KeyboardScalePreset = { id: '100', label: '100%', value: 1 }

/**
 * A tighter range than `UI_SCALE_PRESETS`, bounded at both ends by something
 * measurable rather than by taste. The panel is sized off one unit clamped
 * against the viewport, so the top step is the largest that still leaves the
 * six-row Italian layout inside a 1080p screen, and the bottom one is about the
 * smallest key a thumbstick-driven cursor can be relied on to hit.
 *
 * **Only `'100'` is shared with `UI_SCALE_PRESETS`, and that is deliberate.**
 * It means `isScaleId` and `isKeyboardScaleId` are not interchangeable, so a
 * copy-paste of the wrong one into `sanitise()` fails the suite rather than
 * shipping a setting that silently never saves.
 */
export const KEYBOARD_SCALE_PRESETS: readonly KeyboardScalePreset[] = [
  { id: '80', label: '80%', value: 0.8 },
  { id: '90', label: '90%', value: 0.9 },
  KEYBOARD_100,
  { id: '115', label: '115%', value: 1.15 },
  { id: '130', label: '130%', value: 1.3 }
]

export const DEFAULT_KEYBOARD_SCALE = KEYBOARD_100.id

export function isKeyboardScaleId(value: unknown): value is string {
  return typeof value === 'string' && KEYBOARD_SCALE_PRESETS.some((preset) => preset.id === value)
}

/** The multiplier for a stored id, falling back to 1 for anything unknown. */
export function keyboardScaleValue(id: string | null | undefined): number {
  return (KEYBOARD_SCALE_PRESETS.find((candidate) => candidate.id === id) ?? KEYBOARD_100).value
}
