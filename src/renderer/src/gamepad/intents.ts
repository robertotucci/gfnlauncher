export type Direction = 'up' | 'down' | 'left' | 'right'

/**
 * `start` is named after the button rather than after a meaning, because it has
 * none of its own: on the grid it plays the focused title, inside the details
 * panel it closes it. Every other action here means one thing everywhere, and
 * calling this one `details` — as it was when A launched games directly — would
 * leave a `case 'details'` branch that starts a game.
 */
export type GamepadAction =
  | 'confirm'
  | 'back'
  | 'search'
  | 'menu'
  | 'start'
  | 'pageLeft'
  | 'pageRight'

export type Intent =
  | { kind: 'move'; direction: Direction }
  | { kind: 'action'; action: GamepadAction }

export type IntentHandler = (intent: Intent) => void

/**
 * Standard Gamepad mapping. Index positions come from the W3C "standard"
 * layout, which every Xbox/PlayStation/8BitDo pad reports on Linux.
 */
export const BUTTON_ACTIONS: Record<number, GamepadAction> = {
  0: 'confirm', // A / Cross
  1: 'back', // B / Circle
  2: 'search', // X / Square
  3: 'menu', // Y / Triangle
  4: 'pageLeft', // LB / L1
  5: 'pageRight', // RB / R1
  // Menu / Options / Start. Taking this one leaves every face button meaning
  // exactly what it meant before.
  9: 'start'
}

export const DPAD_DIRECTIONS: Record<number, Direction> = {
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right'
}

/** Sticks drift; below this a pad at rest would scroll the UI on its own. */
export const STICK_DEADZONE = 0.55

/** Hold-to-repeat, tuned to feel like a console list rather than a text field. */
export const REPEAT_DELAY_MS = 420
export const REPEAT_INTERVAL_MS = 90

/** Keyboard mirror of the pad, so the UI stays operable during development. */
export const KEY_BINDINGS: Record<string, Intent> = {
  ArrowUp: { kind: 'move', direction: 'up' },
  ArrowDown: { kind: 'move', direction: 'down' },
  ArrowLeft: { kind: 'move', direction: 'left' },
  ArrowRight: { kind: 'move', direction: 'right' },
  Enter: { kind: 'action', action: 'confirm' },
  Escape: { kind: 'action', action: 'back' },
  // Backspace is deliberately not bound to "back": while the search overlay is
  // open it has to delete a character, and a key cannot mean both.
  '/': { kind: 'action', action: 'search' },
  Tab: { kind: 'action', action: 'menu' },
  // F1 rather than a letter: the search overlay types letters, and by the same
  // rule that keeps Backspace off "back", a key cannot mean both.
  F1: { kind: 'action', action: 'start' },
  // Brackets sit side by side under one hand, the way LB and RB do, and the
  // search overlay only ever consumes letters, digits and space — so unlike a
  // letter key these can page a list without also typing into a query.
  '[': { kind: 'action', action: 'pageLeft' },
  ']': { kind: 'action', action: 'pageRight' }
}

/**
 * Which key stands in for each action, derived from the bindings above rather
 * than written out again: the footer legend reads this when no pad is in hand,
 * and a legend that disagrees with the keyboard is worse than no legend.
 * First binding wins, so an action bound twice shows its primary key.
 */
export const ACTION_KEYS: Partial<Record<GamepadAction, string>> = {}
for (const [key, intent] of Object.entries(KEY_BINDINGS)) {
  if (intent.kind === 'action') ACTION_KEYS[intent.action] ??= key
}

/** Reads the direction a pad is currently pointing, d-pad or left stick. */
export function readDirection(pad: Gamepad): Direction | null {
  for (const [index, direction] of Object.entries(DPAD_DIRECTIONS)) {
    if (pad.buttons[Number(index)]?.pressed) return direction
  }

  const x = pad.axes[0] ?? 0
  const y = pad.axes[1] ?? 0

  // A diagonal push should resolve to one axis, not both.
  if (Math.abs(x) > Math.abs(y)) {
    if (x <= -STICK_DEADZONE) return 'left'
    if (x >= STICK_DEADZONE) return 'right'
  } else {
    if (y <= -STICK_DEADZONE) return 'up'
    if (y >= STICK_DEADZONE) return 'down'
  }

  return null
}
