import type { LaunchRequest, LaunchResult } from '@shared/types'
import { hostSpawn } from '../host'
import { GFN_APP_ID, GFN_CEF_BINARY, GFN_CEF_DIR, isGfnRunning, killGfn } from './flatpak'

/**
 * Value GFN's own web bundle uses for externally initiated launches.
 * Extracted as a literal (`launchSource=External`) from the shipped mall bundle.
 */
const LAUNCH_SOURCE = 'External'

/**
 * Builds the deep link fragment the CEF client understands.
 *
 * Shape, taken from the client binary:
 *   --url-route="#?cmsId=<id>&launchSource=<src>&shortName=<name>&parentGameId=<pid>"
 */
export function buildUrlRoute(request: LaunchRequest): string {
  const params = new URLSearchParams()
  params.set('cmsId', request.cmsId)
  params.set('launchSource', LAUNCH_SOURCE)
  if (request.shortName) params.set('shortName', request.shortName)
  if (request.parentGameId) params.set('parentGameId', request.parentGameId)
  return `#?${params.toString()}`
}

/** Builds the full argv for `flatpak`. Pure, so it can be asserted in tests. */
export function buildLaunchArgv(request: LaunchRequest): string[] {
  return [
    'run',
    `--command=${GFN_CEF_BINARY}`,
    `--cwd=${GFN_CEF_DIR}`,
    GFN_APP_ID,
    `--url-route=${buildUrlRoute(request)}`
  ]
}

/**
 * Argv that opens the client on its own home screen, with no deep link.
 *
 * Deliberately goes through the Flatpak wrapper rather than the CEF binary the
 * launch path targets. The wrapper is what runs `GeForceNOW_Downloader` and the
 * self-update check, and this is the one entry point where we want those: the
 * whole reason to open the real client is to use the parts of it the launcher
 * does not reimplement.
 */
export function buildOpenArgv(): string[] {
  return ['run', GFN_APP_ID]
}

/**
 * Guards the `gfn:launch` payload before it reaches the deep link.
 *
 * Lives here rather than in `@shared`, for the same reason `isPowerAction` sits
 * in `power.ts`: a validator belongs next to the thing it protects. Without it
 * a malformed payload throws a TypeError that crosses the bridge as a rejected
 * promise, which is the one shape the renderer does not model.
 */
export function isLaunchRequest(value: unknown): value is LaunchRequest {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Partial<LaunchRequest>

  const optional = (field: unknown): boolean =>
    field === undefined || field === null || typeof field === 'string'

  return (
    typeof input.cmsId === 'string' &&
    input.cmsId.length > 0 &&
    typeof input.gameId === 'string' &&
    input.gameId.length > 0 &&
    optional(input.shortName) &&
    optional(input.parentGameId)
  )
}

/**
 * How long to let the old client go away before spawning the replacement.
 *
 * `flatpak kill` returns as soon as the signal is sent, not once the processes
 * are reaped, and a fresh instance that races the dying one is refused by the
 * same lock that made the kill necessary.
 */
const KILL_SETTLE_MS = 2_000

export async function launchGame(request: LaunchRequest): Promise<LaunchResult> {
  if (!isLaunchRequest(request)) {
    return { ok: false, command: null, error: 'Malformed launch request', mode: 'native' }
  }

  // A running client swallows the deep link: the second process reads the route,
  // logs it, and exits without forwarding it, so the user gets no game and no
  // error. Replacing the client is the only delivery that works — verified
  // against v2.0.87.130. It is not gratuitous: the client sits on the mall after
  // a game exits, so this is the normal state from the second launch onwards.
  const replacedRunningClient = await isGfnRunning()
  if (replacedRunningClient) {
    await killGfn()
    await delay(KILL_SETTLE_MS)
  }

  const result = await spawnFlatpak(buildLaunchArgv(request), 'native')
  return { ...result, replacedRunningClient }
}

/** Starts the GFN client with no game. See `buildOpenArgv`. */
export async function openGfnClient(): Promise<LaunchResult> {
  return spawnFlatpak(buildOpenArgv(), 'native')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function spawnFlatpak(argv: string[], mode: 'native'): Promise<LaunchResult> {
  return new Promise<LaunchResult>((resolve) => {
    // `hostSpawn` is what makes this work from inside a Flatpak, where `flatpak`
    // is not on the sandbox's PATH. `buildLaunchArgv` stays innocent of that:
    // the argv it produces is the one the *host* runs either way, and prefixing
    // it is the one job this function has that the pure builder should not.
    //
    // `printable` carries the prefix, though. It is what LaunchNotice puts on
    // screen, and a command the reader cannot paste back is worth less than one
    // they can.
    const { child, printable } = hostSpawn('flatpak', argv)

    child.once('error', (err) => {
      resolve({ ok: false, command: printable, error: err.message, mode })
    })

    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true, command: printable, error: null, mode })
    })
  })
}
