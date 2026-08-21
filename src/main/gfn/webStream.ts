import { BrowserWindow } from 'electron'
import type { LaunchRequest, LaunchResult } from '@shared/types'
import { launchShortName } from '@shared/games'
import { POINTER_PRELOAD, registerPointerTarget } from '../pointer'
import { getAuthSession } from './partition'

/**
 * NVIDIA's own web client, hosted in a window we own.
 *
 * This is the shape `hmlendea/gfn-electron` ships in production, and it is a
 * *different route* from the deep link the desktop client takes: the Flatpak's
 * Angular bundle routes on `#?cmsId=…` and has no `streamer` path at all, while
 * the web build has `streamer` and no url-route handler. Neither form works
 * against the other target — do not unify them.
 */
const STREAMER_BASE = 'https://play.geforcenow.com/mall/'

/**
 * Chromium build the spoofed user agent claims to be. Read off the running
 * Electron rather than pinned, so the string stays self-consistent as Electron
 * moves and never advertises a version whose behaviour we do not have.
 */
function chromeVersion(): string {
  return process.versions.chrome ?? '120.0.0.0'
}

/**
 * The streamer window presents itself as Edge on Linux rather than as Electron
 * — the same disguise gfn-electron wears, and it is that project's evidence
 * that it is needed at all.
 */
export function buildUserAgent(version = chromeVersion()): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36 Edg/${version}`
}

/**
 * The `sec-ch-ua` headers that would agree with that user agent.
 *
 * **Not installed, deliberately.** Applying them needs
 * `webRequest.onBeforeSendHeaders`, Electron keeps only the *last* listener
 * registered on a session, and `webAuth` owns that hook on this very partition
 * — it attaches one for the length of a capture and then clears it with `null`.
 * A second registration here would silently disarm the credential capture if a
 * background `ensureSession` happened to overlap a launch, which trades a
 * cosmetic mismatch for a broken sign-in.
 *
 * Kept and tested because the shape is the hard part to rediscover. If the site
 * ever starts rejecting on hints, the fix is one owner for the partition's
 * hooks that both callers register sub-handlers with — not a second listener.
 */
export function buildClientHints(version = chromeVersion()): Record<string, string> {
  const major = version.split('.')[0] ?? '120'

  return {
    'sec-ch-ua': `"Microsoft Edge";v="${major}", "Chromium";v="${major}", "Not?A_Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"'
  }
}

/**
 * Builds the web streamer URL. Pure, so the shape is asserted in tests rather
 * than discovered on a TV.
 *
 * `launchSource=External` matches the native path and is a real member of the
 * client's enum (`Unknown` / `GeForceNOW` / `External` / `Deeplink`), which the
 * bundle maps straight onto a telemetry dimension — it tags where a launch came
 * from and selects no behaviour. gfn-electron sends `GeForceNOW` because it
 * *is* the mall; we are not, so we say so.
 *
 * **`shortName` belongs here too**, contrary to what this path was long assumed
 * to be able to do. The two routes differ in shape, not in vocabulary: the same
 * parser reads `cmsId`, `launchSource`, `shortName`, `appLaunchMode`,
 * `sdkClient`, `parentGameId` and `accountLinked` off either one, and feeds the
 * same `StreamerModule`. So the web player can pin a store after all, by the
 * same mechanism and for the same reason as the deep link — see
 * `launchShortName`.
 */
export function buildStreamerUrl(request: LaunchRequest): string {
  const params = new URLSearchParams()
  params.set('launchSource', 'External')
  params.set('cmsId', request.cmsId)
  params.set('shortName', launchShortName(request))

  // The query rides inside the fragment: everything after `#` is the Angular
  // route, so this cannot be assembled with `URL.searchParams`.
  return `${STREAMER_BASE}#/streamer?${params.toString()}`
}

let streamWindow: BrowserWindow | null = null

/**
 * Opens a game in the hosted web client.
 *
 * Reuses `persist:gfn-session`, so a user who has signed in through the
 * launcher's own login window arrives already authenticated — the one thing
 * this path has over running gfn-electron alongside us.
 */
export async function launchViaWeb(
  request: LaunchRequest,
  onClosed: () => void
): Promise<LaunchResult> {
  const url = buildStreamerUrl(request)

  try {
    if (streamWindow && !streamWindow.isDestroyed()) {
      // One stream at a time. Navigating the existing window is also the warm
      // hand-off the native client refuses to do — the one thing this path is
      // better at. Awaited like the cold branch, so a failure is reported
      // rather than left as an unhandled rejection.
      await streamWindow.loadURL(url)
      streamWindow.focus()
      return { ok: true, command: url, error: null, mode: 'web' }
    }

    const ses = getAuthSession()
    const userAgent = buildUserAgent()

    const window = new BrowserWindow({
      show: false,
      fullscreen: true,
      autoHideMenuBar: true,
      backgroundColor: '#08090c',
      title: 'GeForce NOW',
      webPreferences: {
        session: ses,
        // Third-party page: no bridge, no Node. Same terms the login window
        // renders under, including the pointer preload — the mall has menus a
        // pad cannot reach either, and a game that opens a launcher of its own
        // needs somewhere to click.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: POINTER_PRELOAD
      }
    })

    registerPointerTarget(window, 'the web player')

    // Not `webPreferences.userAgent`, which is not a real option and is silently
    // dropped — gfn-electron passes it there too and gets away with it only
    // because it also calls this.
    window.webContents.setUserAgent(userAgent)

    streamWindow = window

    window.once('ready-to-show', () => {
      window.show()
      window.focus()
    })

    window.on('closed', () => {
      streamWindow = null
      // Registered here rather than left to the caller's own listener: the
      // launcher is fullscreen behind this window and the pad cannot raise a
      // blurred window, so handing focus back is not optional.
      onClosed()
    })

    await window.loadURL(url)
    return { ok: true, command: url, error: null, mode: 'web' }
  } catch (error) {
    if (streamWindow && !streamWindow.isDestroyed()) streamWindow.destroy()
    streamWindow = null
    return { ok: false, command: url, error: (error as Error).message, mode: 'web' }
  }
}

export function closeStreamWindow(): void {
  if (streamWindow && !streamWindow.isDestroyed()) streamWindow.destroy()
  streamWindow = null
}
