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
    await hostExecFile('flatpak', ['kill', GFN_APP_ID])
  } catch {
    // Already gone, or not ours to kill. The spawn that follows is the thing
    // that actually has to work, and it reports for itself.
  }
}

/** Memoised because the launch path consults it and pays two execs otherwise. */
let cachedInfo: GfnClientInfo | null = null

export async function detectGfn(force = false): Promise<GfnClientInfo> {
  if (cachedInfo && !force) return cachedInfo
  cachedInfo = await probeGfn()
  return cachedInfo
}

async function probeGfn(): Promise<GfnClientInfo> {
  let installPath: string | null = null
  try {
    const { stdout } = await hostExecFile('flatpak', ['info', '--show-location', GFN_APP_ID])
    installPath = stdout.trim() || null
  } catch (error) {
    // Three different things reach here and only one of them is "not installed".
    // Packaged as a Flatpak we may simply not be allowed to ask, and reporting
    // that as an absent client would send the user to reinstall something that
    // was there all along — so the reason travels with the answer and the
    // Settings screen says which it was.
    const failure = classifyHostFailure(error)
    return {
      installed: false,
      version: null,
      installPath: null,
      error: failure.kind === 'blocked' ? failure.message : null
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
