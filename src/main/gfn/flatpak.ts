import type { GfnClientInfo } from '@shared/types'
import { classifyHostFailure, hostExecFile } from '../host'

/** Flatpak application id of the official NVIDIA GeForce NOW Linux client. */
export const GFN_APP_ID = 'com.nvidia.geforcenow'

/**
 * Path of the CEF binary *inside* the Flatpak sandbox.
 *
 * We target it directly rather than the app's default command: the wrapper at
 * /app/bin/GeForceNOW reads $1 only as a relaunch sentinel and then invokes
 * ./GeForceNOW with no arguments, so any --url-route passed to `flatpak run`
 * is silently discarded and GFN opens on its home screen.
 */
export const GFN_CEF_BINARY = '/app/cef/GeForceNOW'

/**
 * Working directory the wrapper cd's into before exec'ing the binary. The
 * binary resolves its resources relative to this, so bypassing the wrapper
 * means we have to reproduce it.
 */
export const GFN_CEF_DIR = '/app/cef'

/** Parses the version out of `flatpak info` output (it lives in the Subject line). */
export function parseVersion(flatpakInfoOutput: string): string | null {
  return /Version:\s*([0-9][0-9.]*)/.exec(flatpakInfoOutput)?.[1] ?? null
}

/**
 * App ids from `flatpak ps --columns=application` — one per line, no header,
 * and empty output when nothing is running.
 */
export function parseRunningApps(psOutput: string): string[] {
  return psOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Whether a GFN client is already up.
 *
 * This is not a diagnostic: a second `flatpak run` carrying a deep link is
 * *silently discarded* while an instance holds the lock. The new process logs
 * `Launched with URL route!`, then exits 0 in about a millisecond without
 * forwarding anything, so the running client never learns which game was asked
 * for. See `launchGame` for what the launcher does about it.
 */
export async function isGfnRunning(): Promise<boolean> {
  try {
    const { stdout } = await hostExecFile('flatpak', ['ps', '--columns=application'])
    return parseRunningApps(stdout).includes(GFN_APP_ID)
  } catch {
    // Treat an unreadable process list as "nothing running": the launch that
    // follows is the user's actual request, and refusing it on a failed probe
    // would be a worse answer than a possibly-redundant one.
    return false
  }
}

/**
 * Ends the running client so a deep link can be delivered to a fresh one.
 *
 * `flatpak kill` exits 1 with "is not running" when there is nothing to kill,
 * which is a success for our purposes, so every failure is swallowed.
 */
export async function killGfn(): Promise<void> {
  try {
    // `quiet`: exit 1 for "is not running" is this command's ordinary answer on
    // the first launch of a session, and a warning for it every time would bury
    // the ones that mean something.
    await hostExecFile('flatpak', ['kill', GFN_APP_ID], { quiet: true })
  } catch {
    // Already gone, or not ours to kill. The spawn that follows is the thing
    // that actually has to work, and it reports for itself.
  }
}

/**
 * Whether two probes describe the same install.
 *
 * Four scalars, and it earns a name because it is used twice: `clientWatch.ts`
 * pushes on it, and the log line below is gated on it.
 *
 * The non-obvious field is `installPath`. A re-deploy of the *same* version
 * still moves the commit directory — see `probeGfn` — and `appConfig.ts` reads
 * a file out of that path, so a move with no version change is very much a
 * change.
 */
export function sameClient(previous: GfnClientInfo | null, next: GfnClientInfo): boolean {
  return (
    previous !== null &&
    previous.installed === next.installed &&
    previous.version === next.version &&
    previous.installPath === next.installPath &&
    previous.error === next.error
  )
}

/** Memoised because the launch path consults it and pays two execs otherwise. */
let cachedInfo: GfnClientInfo | null = null

/**
 * Which probe is allowed to write `cachedInfo`.
 *
 * Bumped on entry, checked on exit, and the reason is `clientWatch.ts`: two
 * probes are now genuinely concurrent, and they can resolve out of order.
 *
 *   T0  the launch path calls `detectGfn()` on a cold cache — reads the old commit
 *   T1  `flatpak update com.nvidia.geforcenow` lands and prunes it
 *   T2  the watcher calls `detectGfn(true)` — reads the new commit
 *   T3  the watcher's probe resolves and caches the new path
 *   T4  the launch path's probe resolves and overwrites it with the pruned one
 *
 * From T4 the cached `installPath` is not merely stale, it does not exist, and
 * `readAlsServerUrl()` ENOENTs on it for the rest of the run. Only the most
 * recently *started* probe may write, so T4 becomes a no-op.
 */
let generation = 0

export async function detectGfn(force = false): Promise<GfnClientInfo> {
  if (cachedInfo && !force) return cachedInfo

  const at = ++generation
  const info = await probeGfn()

  // Superseded: a later probe describes an install this one may already have
  // been wrong about. Whatever it cached wins; with nothing cached yet, our own
  // reading is still the only one anybody has.
  if (at !== generation) return cachedInfo ?? info

  const previous = cachedInfo
  cachedInfo = info

  // Once per *change*, not once per probe — the watcher re-probes on every
  // deploy move and this line would otherwise repeat. It is worth writing at
  // all because it is the fact that decides whether `launchMode: auto` streams
  // in a browser instead of handing the game to the client, which is the single
  // most confusing outcome this launcher has.
  if (!sameClient(previous, info)) {
    console.info(
      `GeForce NOW client: installed=${info.installed} ` +
        `version=${info.version ?? 'unknown'} ` +
        `path=${info.installPath ?? 'none'}` +
        (info.error ? ` — ${info.error}` : '')
    )
  }

  return info
}

/**
 * Asks the host what is installed.
 *
 * `--show-location` answers with the **commit directory**, not a stable path:
 *
 *   ~/.local/share/flatpak/app/com.nvidia.geforcenow/x86_64/master/<64-hex commit>
 *
 * An update deploys a new one and prunes the old, so a remembered `installPath`
 * does not go stale, it goes away. That is what `clientWatch.ts` watches for.
 */
async function probeGfn(): Promise<GfnClientInfo> {
  let installPath: string | null = null
  try {
    const { stdout } = await hostExecFile('flatpak', ['info', '--show-location', GFN_APP_ID])
    installPath = stdout.trim() || null
  } catch (error) {
    // Four different things reach here and only one of them is "not installed".
    // Packaged as a Flatpak we may simply not be allowed to ask, and reporting
    // that as an absent client would send the user to reinstall something that
    // was there all along — so the reason travels with the answer and the
    // Settings screen says which it was.
    //
    // `timeout` joins `blocked` because the watcher re-probes exactly when the
    // flatpak installation is busiest: the deploy pointer moved because a
    // transaction is running, and a portal round trip can outlast
    // `HOST_TIMEOUT_MS` while it does. `failed` is the only kind that means
    // flatpak answered and said no.
    const failure = classifyHostFailure(error)
    return {
      installed: false,
      version: null,
      installPath: null,
      error: failure.kind === 'blocked' || failure.kind === 'timeout' ? failure.message : null
    }
  }

  let version: string | null = null
  try {
    // Passed through `hostCommand` as `--env=` rather than set on our own
    // process: flatpak-spawn does not forward the sandbox's environment, so a
    // plain env option would silently reach nothing once packaged.
    const { stdout } = await hostExecFile('flatpak', ['info', GFN_APP_ID], {
      env: { LANG: 'C', LC_ALL: 'C' }
    })
    version = parseVersion(stdout)
  } catch {
    // A detected install with an unreadable version is still usable.
  }

  return { installed: true, version, installPath, error: null }
}
