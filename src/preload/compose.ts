import { contextBridge, ipcRenderer } from 'electron'
import type { IPC as IpcChannels } from '@shared/ipc'
import type { ComposeView } from '@shared/keyboardLayout'

/**
 * The bridge for the composed keyboard, and the third preload in this app.
 *
 * ── Why this one *does* expose something ────────────────────────────────────
 *
 * `pointer.ts` exposes nothing at all, and the reason is written across its
 * header: the pages it runs on are NVIDIA's. This one runs on a page that is
 * entirely ours — a local file, no network, no third party, built by our own
 * renderer bundle — so the argument does not apply. What it hands over is two
 * things and both are narrow: a callback for what to draw, and a way to say
 * which key was clicked. Main validates the second against the layout and
 * against the sender's id, because that is what this boundary is for.
 *
 * ── The one-file rule ───────────────────────────────────────────────────────
 *
 * Nothing here is imported at runtime except `electron`. The `IPC` import is a
 * **type**, erased at build time, and the two channel names below are literals
 * the compiler checks against it — the same arrangement `pointer.ts` uses, for
 * the same reason: two preload entries that share a runtime module make Rollup
 * hoist it into a chunk that a sandboxed preload cannot `require`, and then
 * every preload in the application dies at load. `oneFilePerPreload` in
 * `electron.vite.config.ts` fails the build rather than let that ship.
 *
 * `ComposeView` arrives the same way and under the same rule. It used to be a
 * hand-kept copy here, a second copy in the page, and an untyped object literal
 * in main — three declarations of a nine-field payload, of which the one that
 * *sends* it had no contract at all. It is one declaration in
 * `@shared/keyboardLayout` now, imported as a type by all three;
 * `verbatimModuleSyntax` guarantees the import is erased, and if anybody ever
 * reaches for a *value* from that module here the build fails loudly.
 */

const VIEW: (typeof IpcChannels)['composeView'] = 'compose:view'
const PRESS: (typeof IpcChannels)['composePress'] = 'compose:press'

contextBridge.exposeInMainWorld('compose', {
  onView(listener: (view: ComposeView) => void): void {
    ipcRenderer.on(VIEW, (_event, view: ComposeView) => listener(view))
  },
  press(button: string): void {
    ipcRenderer.send(PRESS, button)
  }
})
