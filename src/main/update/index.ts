/**
 * Whether there is a newer launcher, and installing it where that is ours to do.
 *
 * ── The shape of the problem ────────────────────────────────────────────────
 *
 * There are three ways to install this launcher and they have three different
 * owners. A Flatpak is updated by `flatpak` on the host. An AppImage is one file
 * with nobody responsible for it, which is why it is the only one this process
 * replaces itself. A `.deb` belongs to a package manager that needs root, and
 * root is not on the table here — the same answer this project already gives to
 * waking the machine with a gamepad.
 *
 * So `canApply` is a separate fact from `available`, and the notice needs both:
 * every install form can be *told* about a release, and only two of them can do
 * anything about it. Conflating them would either hide the news from `.deb`
 * users or hand them a button that cannot work — and a control that silently
 * does nothing is the one failure nobody on a sofa can diagnose.
 *
 * ── Why a Flatpak restarts through the host ─────────────────────────────────
 *
 * `flatpak update` deploys the new commit; the *running* sandbox keeps the old
 * one bind-mounted into it, because that is the filesystem it was started with.
 * So `app.relaunch()`, which re-execs inside this sandbox, comes back on the
 * version it started with — a restart button that silently reinstates the old
 * version, which is worse than no button and is why there was no button here
 * until `buildFlatpakRelaunchArgv` existed.
 *
 * What does work is having the *host* start the new instance once we are gone.
 * See that builder for the three details that make it safe, and
 * `restartIntoUpdate` below for the race that decides the order of the last two
 * statements in it. The AppImage path needs none of this: by then the file
 * behind `$APPIMAGE` is the new one and Electron's own `relaunch` runs it.
 *
 * The check itself is memoised in this module the same way the status board is,
 * and for the same reason: opening Settings twice in a minute is navigation,
 * not a request for a fresh answer. It is memory-only — a release seen last week
 * is not a fact worth persisting when re-reading it costs one small request.
 */

import { app } from 'electron'
import { LATEST_RELEASE_API_URL } from '@shared/update'
import type { UpdateApplyResult, UpdateProgress, UpdateStatus } from '@shared/types'
import { isNewerVersion, normaliseVersion } from '@shared/version'
import {
  classifyHostFailure,
  hostCommand,
  hostExecFile,
  hostExecStreaming,
  printableCommand,
  FLATPAK_ID,
  IS_SANDBOXED
} from '../host'
import { getSettings } from '../settings'
import {
  buildFlatpakCommitArgv,
  buildFlatpakRelaunchArgv,
  buildFlatpakUpdateArgv,
  OWN_APP_ID,
  resolveUpdateChannel
} from './channel'
import { scanFlatpakProgress } from './flatpakProgress'
import { canReplace, downloadAndReplace, USER_AGENT } from './download'
import { parseRelease, pickAsset, type ReleaseInfo } from './release'

/**
 * How long a check is believed.
 *
 * Longer than the status board's minute because the thing being watched moves
 * in weeks rather than seconds, and short enough that a launcher left running
 * all evening notices a release cut during it.
 */
const CHECK_TTL_MS = 30 * 60_000

/**
 * How long to wait for GitHub.
 *
 * Cites `statuspage.ts`, which documents itself as the launcher's first fetch
 * timeout and the reasoning for having one: this is behind a control the user
 * pressed, and a spinner that never resolves is the failure that cannot be
 * diagnosed without a keyboard. Generous for a 30 KB JSON document.
 */
const REQUEST_TIMEOUT_MS = 10_000

let release: ReleaseInfo | null = null
let checkedAt: number | null = null
let lastError: string | null = null
let inFlight: Promise<void> | null = null

/**
 * The current install form.
 *
 * Exported because `app:diagnostics` needs the same answer and this is the only
 * place that knows how it is derived — a second copy of the four inputs would
 * be a second thing to keep in step with `resolveUpdateChannel`.
 */
export function updateChannel(): ReturnType<typeof resolveUpdateChannel> {
  return resolveUpdateChannel({
    sandboxed: IS_SANDBOXED,
    flatpakId: FLATPAK_ID,
    appImage: process.env.APPIMAGE ?? null,
    packaged: app.isPackaged
  })
}

/** Local alias, so the call sites below read as they did. */
const channel = updateChannel

/**
 * Fetches the newest release, degrading rather than throwing.
 *
 * Same posture as `revalidate` in `status/index.ts`: on failure the last good
 * answer is kept and the error travels beside it, so a dropped connection makes
 * the notice stale rather than blank.
 */
async function revalidate(): Promise<void> {
  try {
    const response = await fetch(LATEST_RELEASE_API_URL, {
      headers: {
        // GitHub rejects an anonymous request with no User-Agent outright.
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    // A repository with no published release answers 404, and that is not a
    // failure worth putting on screen — it means there is nothing to offer.
    if (response.status === 404) {
      release = null
      checkedAt = Date.now()
      lastError = null
      return
    }

    if (!response.ok) {
      // 403 here is the rate limit, which is 60 requests an hour per address
      // and unreachable at one check per launch — unless something starts
      // calling this in a loop, in which case saying so is the whole point.
      throw new Error(`GitHub answered ${response.status}`)
    }

    const parsed = parseRelease(await response.json())
    if (!parsed) throw new Error('The release feed could not be read')

    release = parsed
    checkedAt = Date.now()
    lastError = null
    console.info(`Update check: newest release is ${parsed.version} (tag ${parsed.tag}).`)
  } catch (error) {
    console.warn('Update check failed:', error)
    lastError =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'github.com did not respond in time.'
        : error instanceof Error
          ? error.message
          : 'The release feed could not be reached.'
  }
}

/** Shares one request between concurrent callers, mirroring `revalidateOnce` in status. */
function revalidateOnce(): Promise<void> {
  inFlight ??= revalidate().finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Whether this build can install the release it just found, and why not.
 *
 * The AppImage answer needs the filesystem: an AppImage under `/opt`, or one
 * owned by another user, is an ordinary installation, and finding that out
 * *after* downloading 130 MB and failing at the rename would be the worst
 * possible time.
 */
async function applicability(
  found: ReleaseInfo
): Promise<{ canApply: boolean; blockedReason: string | null; downloadBytes: number | null }> {
  const asset = pickAsset(found.assets, channel())

  switch (channel()) {
    case 'flatpak':
      // Nothing to check ahead of time: whether a remote has the new commit is
      // something only `flatpak update` can answer, and it answers it honestly.
      return { canApply: true, blockedReason: null, downloadBytes: null }

    case 'appimage': {
      const target = process.env.APPIMAGE ?? ''
      if (!asset) {
        return {
          canApply: false,
          blockedReason: 'This release has no AppImage to download.',
          downloadBytes: null
        }
      }
      if (!asset.sha256) {
        return {
          canApply: false,
          blockedReason:
            'This release published no checksum for its AppImage, so it will not be installed unverified.',
          downloadBytes: asset.bytes
        }
      }
      if (!(await canReplace(target))) {
        return {
          canApply: false,
          blockedReason: `${target || 'The AppImage'} cannot be written to by this user, so it has to be replaced by hand.`,
          downloadBytes: asset.bytes
        }
      }
      return { canApply: true, blockedReason: null, downloadBytes: asset.bytes }
    }

    case 'system':
      return {
        canApply: false,
        blockedReason:
          'This copy was installed by your package manager, which owns the files — install the new package the same way you installed this one.',
        downloadBytes: asset?.bytes ?? null
      }

    default:
      return {
        canApply: false,
        blockedReason: 'This launcher is running from source, so there is nothing here to replace.',
        downloadBytes: null
      }
  }
}

/**
 * Whether there is a newer launcher.
 *
 * Never throws: a failed request comes back as a status carrying `error`, which
 * is the same contract `getStatus` offers and the reason neither needs a
 * try/catch at the IPC handler.
 */
export async function getUpdateStatus(force = false): Promise<UpdateStatus> {
  // The preference is honoured here rather than in the renderer, so that a
  // launcher with checks turned off can still be *asked* what version it is —
  // the Settings nameplate needs `currentVersion` whatever the toggle says, and
  // the alternative was a second channel that only returned a string.
  //
  // `force` overrides it, and that is the point: the toggle governs the
  // automatic check, not the feature. Someone who turned it off and then
  // pressed "Check for updates" has asked plainly.
  const allowed = force || (await getSettings()).updateCheck
  const fresh = checkedAt !== null && Date.now() - checkedAt < CHECK_TTL_MS
  if (allowed && (force || !fresh)) await revalidateOnce()

  const currentVersion = normaliseVersion(app.getVersion()) ?? app.getVersion()
  const available = release !== null && isNewerVersion(release.version, currentVersion)
  const applies =
    available && release
      ? await applicability(release)
      : { canApply: false, blockedReason: null, downloadBytes: null }

  return {
    currentVersion,
    latestVersion: release?.version ?? null,
    available,
    channel: channel(),
    canApply: applies.canApply,
    blockedReason: applies.blockedReason,
    // Only when there is something to install: notes for a release the user is
    // already running are an answer to a question nobody asked.
    notes: available ? (release?.notes ?? []) : [],
    publishedAt: available ? (release?.publishedAt ?? null) : null,
    downloadBytes: applies.downloadBytes,
    checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
    error: lastError
  }
}

/** Installs the update, on the two paths where that is this launcher's job. */
export async function applyUpdate(
  onProgress: (progress: UpdateProgress) => void
): Promise<UpdateApplyResult> {
  const status = await getUpdateStatus()

  if (!status.available || !release) {
    return {
      ok: false,
      restartRequired: false,
      canRestart: false,
      command: null,
      error: status.error ?? 'There is no newer version to install.'
    }
  }

  if (!status.canApply) {
    return {
      ok: false,
      restartRequired: false,
      canRestart: false,
      command: null,
      error: status.blockedReason ?? 'This build cannot install its own updates.'
    }
  }

  return channel() === 'flatpak'
    ? applyFlatpak(onProgress)
    : applyAppImage(release, onProgress)
}

/**
 * `flatpak update`, with a before-and-after commit read around it.
 *
 * The commit comparison is the whole reason this is not three lines. Exit 0
 * from `flatpak update` means "I did what you asked", and what it asked for may
 * have been nothing: a bundle installed by hand has no remote behind it, so the
 * command succeeds, changes not one byte, and a naive implementation would
 * report an update that never happened and send the user to restart into the
 * same version. Comparing the deployed commit is exact and, unlike flatpak's
 * own output, is not translated into the host session's language.
 */
async function applyFlatpak(
  onProgress: (progress: UpdateProgress) => void
): Promise<UpdateApplyResult> {
  const appId = FLATPAK_ID ?? OWN_APP_ID
  const [command, ...argv] = buildFlatpakUpdateArgv(appId)
  // The argv as it will really run, `flatpak-spawn` prefix and all — this ends
  // up on screen beside a refusal, and half of one sends the reader hunting.
  const printable = printableCommand(...hostCommand(command, argv))

  const before = await deployedCommit(appId)
  console.info(`Updating the Flatpak: ${printable} (deployed commit ${before ?? 'unreadable'})`)

  try {
    // Line-buffered across chunks: a pipe splits where it likes, and half of
    // "74%" reads as 4%. `scanFlatpakProgress` hands back the tail for exactly
    // this.
    let remainder = ''
    await hostExecStreaming(command, argv, (chunk) => {
      const scan = scanFlatpakProgress(remainder + chunk)
      remainder = scan.remainder
      if (scan.percent !== null) {
        onProgress({
          phase: 'downloading',
          percent: scan.percent,
          // Flatpak counts in percent and never says how many bytes, so these
          // stay zero and the notice shows a bar without a byte count.
          receivedBytes: 0,
          totalBytes: 0
        })
      }
    })
  } catch (error) {
    return {
      ok: false,
      restartRequired: false,
      canRestart: false,
      command: printable,
      error: classifyHostFailure(error).message
    }
  }

  onProgress({ phase: 'installing', percent: 100, receivedBytes: 0, totalBytes: 0 })
  const after = await deployedCommit(appId)
  // The pair is the evidence, and the reason this is not three lines: exit 0
  // from `flatpak update` means "I did what you asked", which may have been
  // nothing at all. Both hashes in the log settle the question afterwards.
  console.info(`Flatpak update finished: ${before ?? 'unreadable'} → ${after ?? 'unreadable'}`)

  // Unreadable commits on both sides: the update ran and exited 0, and we have
  // nothing to contradict it with. Believe it rather than calling a success a
  // failure — the restart is what proves it either way.
  if (before !== null && after !== null && before === after) {
    return {
      ok: false,
      restartRequired: false,
      canRestart: false,
      command: printable,
      error:
        'Flatpak found nothing to update. If this was installed from a .flatpak file rather than a remote, there is no remote to update from — install the new bundle from the release page.'
    }
  }

  // `canRestart` is true here now, and it is `buildFlatpakRelaunchArgv` that
  // earns it: the restart happens on the host, after this process is gone, so
  // it starts the *new* deploy rather than the one this sandbox is holding open.
  return { ok: true, restartRequired: true, canRestart: true, command: printable, error: null }
}

/** The active deploy's commit, or null when it could not be read. */
async function deployedCommit(appId: string): Promise<string | null> {
  try {
    const [command, ...argv] = buildFlatpakCommitArgv(appId)
    const { stdout } = await hostExecFile(command, argv)
    return stdout.trim() || null
  } catch {
    // Not a failure of its own: `applyFlatpak` treats an unreadable commit as
    // "no evidence either way" and trusts the exit code instead.
    return null
  }
}

/** Downloads the new AppImage and swaps it in. See `download.ts` for the rules. */
async function applyAppImage(
  found: ReleaseInfo,
  onProgress: (progress: UpdateProgress) => void
): Promise<UpdateApplyResult> {
  const target = process.env.APPIMAGE
  const asset = pickAsset(found.assets, 'appimage')

  if (!target || !asset) {
    return {
      ok: false,
      restartRequired: false,
      canRestart: false,
      command: null,
      error: 'There is no AppImage in this release to install.'
    }
  }

  try {
    await downloadAndReplace(asset, target, onProgress)
  } catch (error) {
    return {
      ok: false,
      restartRequired: false,
      canRestart: false,
      // The URL rather than an argv: there is no command here, and naming the
      // file that failed is the equivalent diagnostic.
      command: asset.url,
      error: error instanceof Error ? error.message : String(error)
    }
  }

  return { ok: true, restartRequired: true, canRestart: true, command: target, error: null }
}

/**
 * Restarts into the version just installed.
 *
 * Two mechanisms, because the two install forms fail differently, and the
 * difference is not cosmetic — picking the wrong one comes back on the *old*
 * version while claiming to have updated.
 *
 * **AppImage: Electron's own relaunch.** `execPath` is `$APPIMAGE`, not
 * `process.execPath`: inside a running AppImage the latter points into the
 * temporary mount, which is unmounted the moment this process exits, so
 * Electron would relaunch a path that no longer exists. `$APPIMAGE` is the host
 * path, and after the swap it is the new file.
 *
 * **Flatpak: the host starts it, after we are gone.** `app.relaunch()` re-execs
 * inside this sandbox, which still has the old deploy bind-mounted — the reason
 * there was no restart here at all until `buildFlatpakRelaunchArgv` existed. So
 * a host-side shell waits for this instance to leave `flatpak ps` and then runs
 * `flatpak run`, which mounts the new deploy. See that builder for why it waits
 * rather than sleeps, and why it backgrounds itself.
 *
 * **The relaunch is awaited, not fired and forgotten, and that is a race and
 * not a style preference.** `flatpak-spawn` is a process *inside this sandbox*
 * that makes a D-Bus call to the portal and exits. When the last process in a
 * sandbox goes, bwrap tears the namespace down and kills whatever is left in it
 * — so quitting the instant after spawning could kill `flatpak-spawn` mid-call,
 * and the restart would simply never happen. Waiting costs nothing, because the
 * command backgrounds itself and the outer shell returns in about two
 * milliseconds (measured); what it buys is the certainty that the host process
 * exists before this one stops existing.
 *
 * Waiting also gives the failure somewhere to go: a sandbox with the host
 * permission revoked rejects here, and the launcher stays up instead of closing
 * itself with nothing able to reopen it.
 *
 * Returns false rather than quitting when it cannot restart, which is what
 * keeps a renderer that asks anyway from closing a launcher that has no way
 * back. The `.deb` never reaches here: nothing installed the update.
 */
export async function restartIntoUpdate(): Promise<boolean> {
  if (channel() === 'appimage') {
    const appImage = process.env.APPIMAGE
    if (!appImage) return false
    console.info(`Restarting into the new AppImage at ${appImage}.`)
    app.relaunch({ execPath: appImage })
    app.quit()
    return true
  }

  if (channel() === 'flatpak') {
    const [command, ...argv] = buildFlatpakRelaunchArgv(FLATPAK_ID ?? OWN_APP_ID)
    // Written *before* the handover, because everything after this point
    // happens on the host and after this process is gone. If the launcher does
    // not come back, this is the last line of the old session's log and the
    // first thing to read.
    console.info(`Handing the restart to the host: ${printableCommand(command, argv)}`)
    try {
      await hostExecFile(command, argv)
    } catch (error) {
      // Quitting now would leave a television with no launcher and no way to
      // start one, so a relaunch that could not even be handed over means we
      // stay exactly where we are.
      console.error('Could not schedule the restart, so the launcher is staying up:', error)
      return false
    }
    app.quit()
    return true
  }

  return false
}

/** Test seam, mirroring `resetStatus`. */
export function resetUpdateCheck(): void {
  release = null
  checkedAt = null
  lastError = null
  inFlight = null
}
