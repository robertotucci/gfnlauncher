import type { ChildProcess } from 'node:child_process'
import type { LaunchRequest, LaunchResult } from '@shared/types'
import { launchShortName } from '@shared/games'
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
 *
 * **`shortName` is never omitted, and that is the whole reason this function is
 * interesting.** Its *value* is inert — Playnite has shipped the constant
 * `game_gfn_pc` for every title for years — but its *presence* is the switch
 * that decides whether the client honours the variant we named or goes and
 * resolves one itself. From the client's `PlatformSelectionUIService`:
 *
 * ```js
 * let N = false
 * if (!activeConfig.shortName) N = true          // ← the only input
 * finalizeStreamerConfig(N, cmsId.toString())
 * // N false → updateStreamerConfig(cmsId); moveToNextState()   — streams our variant
 * // N true  → refetch the app, variants.find(v => v.gfn.library?.selected)
 * //           …and open the store picker when that finds nothing
 * ```
 *
 * That second branch can never succeed for a multi-store title: it fetches with
 * `isCmsId: true`, which is the path where `fetchAppdata` drops
 * `includeLibraryFields`, and the resulting `GetAppDataQueryForCmsId` selects
 * `library { installed playStatus }` — no `selected`. So the search is always
 * undefined and the user is always asked, however clear the answer is on our
 * side. See docs/gfn-api.md.
 *
 * The fallback is the variant id, which is not an invention: the feed itself
 * emits a numeric `shortName` for 222 variants and every one of them is that
 * variant's own id. The client does the same thing internally when a variant
 * has no slug (`V.shortName = b.id`).
 *
 * `parentGameId` is still omitted when absent, and that omission *is* correct —
 * the app normalises a missing optional to `""`, so the two are the same thing.
 */
export function buildUrlRoute(request: LaunchRequest): string {
  const params = new URLSearchParams()
  params.set('cmsId', request.cmsId)
  params.set('launchSource', LAUNCH_SOURCE)
  params.set('shortName', launchShortName(request))
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
/**
 * Ceiling on any one field.
 *
 * The values these fields really carry are a nine-digit catalog id and a slug —
 * `witcher3` — so this is two orders of magnitude of headroom, not a limit
 * anything real will meet. It is here because these four strings are the only
 * renderer-supplied values in the launcher that become *argv*: `URLSearchParams`
 * makes them harmless to parse, and does nothing about length, so a forged
 * megabyte would come back as a bare `E2BIG` from `spawn` with nothing to say
 * which control produced it.
 */
const MAX_FIELD_CHARS = 512

export function isLaunchRequest(value: unknown): value is LaunchRequest {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Partial<LaunchRequest>

  const identifier = (field: unknown): boolean =>
    typeof field === 'string' && field.length > 0 && field.length <= MAX_FIELD_CHARS

  const optional = (field: unknown): boolean =>
    field === undefined ||
    field === null ||
    (typeof field === 'string' && field.length <= MAX_FIELD_CHARS)

  return (
    identifier(input.cmsId) &&
    identifier(input.gameId) &&
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

export interface LaunchHooks {
  /**
   * Handed the live `flatpak run` handle the moment the spawn is confirmed,
   * which is also the moment `ok: true` is decided — so it fires exactly when a
   * launch succeeded, and never otherwise.
   *
   * A callback rather than a field on `LaunchResult`: that object is structured
   * -cloned across the IPC bridge and a `ChildProcess` on it would throw on the
   * way out. It also leaves the policy question — what to do when the client
   * dies — with `ipc.ts`, which owns the window, rather than here.
   *
   * The handle has to be *held* by whoever takes it. An unref'd child nobody
   * references is collectable, and a collected handle delivers no `exit` event.
   */
  onSpawned?: (child: ChildProcess) => void
}

export async function launchGame(
  request: LaunchRequest,
  hooks: LaunchHooks = {}
): Promise<LaunchResult> {
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
    // Logged because this is a two-second pause with nothing on screen to
    // explain it, and because "the second launch of the session behaves
    // differently" is the shape of half the launch reports here.
    console.info(`A client is already running; killing it and waiting ${KILL_SETTLE_MS} ms.`)
    await killGfn()
    await delay(KILL_SETTLE_MS)
  }

  const result = await spawnFlatpak(buildLaunchArgv(request), 'native', hooks)
  return { ...result, replacedRunningClient }
}

/** Starts the GFN client with no game. See `buildOpenArgv`. */
export async function openGfnClient(hooks: LaunchHooks = {}): Promise<LaunchResult> {
  return spawnFlatpak(buildOpenArgv(), 'native', hooks)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function spawnFlatpak(
  argv: string[],
  mode: 'native',
  hooks: LaunchHooks = {}
): Promise<LaunchResult> {
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
      // `LaunchNotice` shows this for eight seconds and then it is gone; the
      // log is where it is still available when somebody asks what happened.
      console.error(`Launch failed: ${printable} — ${err.message}`)
      resolve({ ok: false, command: printable, error: err.message, mode })
    })

    child.once('spawn', () => {
      child.unref()
      // Before `resolve`, so nobody downstream can observe a successful launch
      // that the session watch has not been offered yet.
      hooks.onSpawned?.(child)
      resolve({ ok: true, command: printable, error: null, mode })
    })
  })
}
