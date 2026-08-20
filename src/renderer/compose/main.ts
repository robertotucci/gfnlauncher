import Keyboard from 'simple-keyboard'
import 'simple-keyboard/build/css/index.css'
// Self-hosted and bundled beside this page, like the launcher's own: this runs
// offline, and `font-src 'self'` in the page's CSP is what permits it. Mono is
// the legends and the field — a keycap legend is a utility face and the field
// is a buffer — and the sans is the two lines of prose around them.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './compose.css'
import type { ComposeView } from '@shared/keyboardLayout'

/**
 * The keyboard the launcher types into other people's windows with.
 *
 * ── What is here and what is in main ────────────────────────────────────────
 *
 * This page holds **no state**. Main reads the pad from `/dev/input/js*`, so
 * main is the only place that can know which key the selection is on; it owns
 * the text, the layer and the cursor, and pushes all three over `compose:view`
 * on every keystroke. What is left here is `simple-keyboard` and a stylesheet.
 *
 * The one thing this page originates is a **click**: the launcher already has a
 * cursor on screen when this opens, so the keys have to be pressable with it,
 * and a click is the only event main cannot see for itself.
 *
 * ── Why the library ─────────────────────────────────────────────────────────
 *
 * It is MIT, it has no runtime dependencies of its own, and Vite bundles it
 * into `out/renderer` beside this file — so it ships inside the application and
 * needs nothing installed on the machine. The layout is ours (`@shared/
 * keyboardLayout.ts`, alphabetical for the reason recorded there); what the
 * library provides is the drawing, the layers and the hit testing.
 */

interface ComposeBridge {
  onView(listener: (view: ComposeView) => void): void
  press(button: string): void
}

declare global {
  interface Window {
    readonly compose: ComposeBridge
  }
}

const text = document.getElementById('text')

/**
 * Built on the first view rather than at load.
 *
 * The layout comes from main with the rest of the state, so there is exactly
 * one copy of it in the product and this page cannot drift from the grid the
 * pad is being walked over.
 */
let keyboard: Keyboard | null = null

/**
 * The four things the stylesheet cannot know, as custom properties on the root.
 *
 * The user's accent, the size they asked for, how many rows this layout draws,
 * and how much of the bottom of this window the compositor left unusable. Same
 * shape as the launcher's own `--brand` effect in `App.tsx`, for the same
 * reason: a value that is a *choice* belongs in a custom property, not in a
 * class the stylesheet has to enumerate.
 *
 * Written on every view rather than diffed. Blink drops a `setProperty` whose
 * value has not changed before it invalidates anything, so the comparison is
 * already being done one layer down.
 *
 * `--safe-bottom` is in CSS pixels of the untransformed viewport, so nothing
 * that consumes it may sit inside a scaled subtree — which is why `--kb-scale`
 * is a multiplier inside `calc()` and never a `transform: scale()`.
 */
function applyLook(root: CSSStyleDeclaration, view: ComposeView): void {
  root.setProperty('--accent', view.accent)
  root.setProperty('--kb-scale', String(view.scale))
  root.setProperty('--rows', String(view.rows))
  root.setProperty('--safe-bottom', `${view.safeBottom}px`)
}

/**
 * The pad button printed on a keycap, one custom property per key.
 *
 * `content` needs a *quoted* string, and the quotes have to be in the property
 * value — `content: var(--sc)` inserts whatever the property holds verbatim.
 * The stylesheet then maps each key to its own property with a `[data-skbtn]`
 * selector, which is the only hook a library that owns its DOM leaves for this.
 */
function applyShortcuts(root: CSSStyleDeclaration, shortcuts: ComposeView['shortcuts']): void {
  for (const [button, glyph] of Object.entries(shortcuts)) {
    // `{space}` → `--sc-space`. The braces are the library's marker for a
    // function key and mean nothing to CSS.
    root.setProperty(`--sc-${button.slice(1, -1)}`, `"${glyph}"`)
  }
}

/**
 * What the page can see and main cannot, said once per open.
 *
 * Main knows the size it asked the compositor for and the size it was given,
 * and on Wayland it is told neither where the window went nor what the page did
 * with it. Both of those have been wrong here at least once. This is the other
 * half of that log line: the viewport the stylesheet actually laid out against,
 * and where the panel ended up inside it. A `bottom` past `innerHeight` is the
 * page overflowing; a panel that fits and is still clipped on screen is the
 * compositor, and those two have been indistinguishable from a photograph.
 *
 * After a frame, because the measurement is only true once the keyboard has
 * been drawn and the fonts have settled.
 */
function reportGeometry(): void {
  requestAnimationFrame(() => {
    const panel = document.querySelector('.panel')
    if (!panel) return
    const box = panel.getBoundingClientRect()
    console.info(
      `viewport ${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio}, ` +
        `panel ${Math.round(box.width)}x${Math.round(box.height)} ` +
        `top ${Math.round(box.top)} bottom ${Math.round(box.bottom)}`
    )
  })
}

window.compose.onView((view) => {
  if (text) text.textContent = view.text

  const root = document.documentElement.style
  applyLook(root, view)

  if (!keyboard) {
    applyShortcuts(root, view.shortcuts)
    // `.simple-keyboard` and *only* that class on the host element: the library
    // rebuilds the container's class list from `className.split(' ')[0]` plus
    // its own theme classes, so a second class on it is silently dropped — and
    // with it every stylesheet rule hanging off that class. The first version
    // of this page had `class="keyboard simple-keyboard"` and drew the
    // library's white default theme over a dark launcher.
    keyboard = new Keyboard('.simple-keyboard', {
      layout: { default: [...view.layout.default], shift: [...view.layout.shift] },
      display: { ...view.display },
      mergeDisplay: true,
      // Every press goes back to main, including the function keys: main
      // decides what a key means, here and for the pad, so there is one answer
      // rather than two that have to agree.
      onKeyPress: (button: string) => window.compose.press(button),
      // Its own highlighting is for a physical keyboard being mirrored, which
      // is not what this is: the selection is the pad's and arrives in `view`.
      physicalKeyboardHighlight: false,
      preventMouseDownDefault: true,
      useButtonTag: false
    })

    reportGeometry()
  }

  keyboard.setOptions({
    layoutName: view.layer,
    // `buttonTheme` is how a library that owns its own DOM lets somebody else
    // say which key is selected. Replaced wholesale each time rather than
    // added to, so the previous selection cannot survive the move.
    buttonTheme: [{ class: 'sk-selected', buttons: view.selected }]
  })
})
