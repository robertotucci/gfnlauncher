import { unwatchFile, watchFile, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { GfnClientInfo, ZoneStatus } from '@shared/types'
import { resetAppConfig } from './gfn/appConfig'
import { detectGfn, GFN_APP_ID, sameClient } from './gfn/flatpak'
import { currentZone } from './status'
import { readZoneAssignment, sameZone, zoneStoragePath } from './status/zone'

/**
 * Following the GeForce NOW client while it changes underneath us.
 *
 * The launcher reads four things out of somebody else's application — the
 * client's version, where it is installed, the service hostnames inside that
 * install (`gfn/appConfig.ts`), and the routing configuration in its state
 * directory (`status/zone.ts`) — and every one of them was read once and
 * remembered, on the assumption that a client does not change mid-session.
 *
 * That assumption is false, and each way it fails is silent:
 *
 * - **The install path does not go stale, it goes away.** `flatpak info
 *   --show-location` answers with a *commit directory*, and an update deploys a
 *   new one and prunes the old. A remembered path is then an ENOENT, which
 *   `readAlsServerUrl()` used to answer by memoising the default host — losing
 *   a proxy-overridden ALS server for the rest of the run.
 * - The footer and the Settings screen keep naming the previous version.
 * - The Status screen keeps naming the datacenter the user just moved away
 *   from, until they leave the view and come back.
 * - A client *installed* after the launcher started stays `installed: false`
 *   for ever, which sends `launchMode: auto` to the web player.
 *
 * So this module watches, and pushes what changed. It is armed once for the
 * life of the process, which is what makes it the launcher's own background
 * work rather than something bolted on beside it.
 *
 * ── What is watched, and why those paths ────────────────────────────────────
 *
 * The **deploy pointer**, not `flatpak info` on a timer: an update repoints
 *
 *   ~/.local/share/flatpak/app/com.nvidia.geforcenow/current/active
 *
 * (`current` → `x86_64/master`, `active` → `<64-hex commit>`) and `stat`
 * follows symlinks, so the deployed commit's inode arrives as an ordinary
 * change. `current` keeps the path free of the architecture and the branch.
 * Both installation roots are watched because GFN may be installed per-user or
 * system-wide, and both are already granted `:ro` in the Flatpak manifest.
 *
 * `~/.local/share/flatpak/.changed` would be one target instead of two and is
 * **deliberately not used**: the manifest grants the *app subdirectory*, so
 * that file is not visible from inside our own sandbox at all.
 *
 * And `sharedstorage.json`, for the datacenter. Note that the client rewrites
 * it for reasons that have nothing to do with routing — token rotation,
 * telemetry, consent — which is why `sameZone` compares the resolved zone
 * rather than trusting the write.
 *
 * **`watchFile`, not `watch`**, for the three reasons already written out in
 * `gfn/streamLog.ts`: an atomic replace moves the inode out from under inotify,
 * `stat(2)` behaves identically across the Flatpak bind mount, and Node calls
 * the listener with every field zeroed for a path that does not exist — which
 * is how "GeForce NOW is not installed yet" costs nothing here. Its one sharp
 * edge is the mirror of that last point, and it is in `markMoved`: an existing
 * path is *silent* until it changes.
 *
 * ── The rule that must not be simplified away ───────────────────────────────
 *
 * **The pointer nominates; the probe describes; only the pointer may authorise
 * "absent".** This watcher re-probes at precisely the moment the flatpak
 * installation is busiest — the pointer moved *because* a transaction is
 * running — and `probeGfn` cannot tell "not installed" from "the portal did not
 * answer in time". Pushing a timed-out probe would tell the user their client
 * had vanished in the middle of a perfectly ordinary update, and would route
 * their next launch to a browser. So a probe that says absent while a deploy
 * pointer is still on disk is a failed probe, and is dropped. Same decomposition
 * as `handback.ts`'s two signals, inverted.
 *
 * ── Why there is no `did-finish-load` replay ────────────────────────────────
 *
 * `screen.ts` re-sends on every renderer load because `handedOff` has no pull:
 * a renderer that comes back after `render-process-gone` has no other way to
 * learn it. Both facts here do have one, at the right moment — `gfn.info()` in
 * the renderer's mount effect, `status.get()` on *every* entry to the Status
 * view — and both of those read main's caches, which this module keeps current.
 * A reloaded renderer therefore re-derives both by asking. The asymmetry is
 * deliberate; do not add a replay to match.
 */

/** What one `stat` of a watched path told us. */
export interface FileMark {
  readonly present: boolean
  readonly ino: number
  readonly mtimeMs: number
  readonly size: number
}

/**
 * Node's zeroed-stats convention, given a name.
 *
 * A `watchFile` listener is handed every field at zero when the path does not
 * exist — measured, not assumed: registering against a missing path fires once
 * immediately, an existing path fires only when it changes.
 */
export function fileMark(stats: Stats): FileMark {
  return {
    present: stats.mtimeMs !== 0,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    size: stats.size
  }
}

/**
 * Whether a stat tick is news.
 *
 * Pure and total, and the one place a Node or flatpak behaviour change can
 * break this module — hence a test rather than a comment.
 *
 * **This is not `streamLog.ts`'s `curr.mtimeMs === 0` guard, and copying that
 * one here would be a bug.** For a log, zeroed stats only ever mean "the client
 * has not written it yet". For a deploy pointer they mean *either* "GFN was
 * never installed" *or* "GFN has just been uninstalled", which is very much
 * news. The distinction is in the transition, not the value, so absence has to
 * be compared rather than skipped.
 *
 * ── Why a first sighting is news when the path is there ─────────────────────
 *
 * **`watchFile` does not call the listener when it arms against a path that
 * exists.** It takes that stat as its own baseline and stays silent; the first
 * call comes only when something actually changes. So there are exactly two
 * ways the listener runs with nothing recorded yet, and `present` tells them
 * apart:
 *
 * - the path was **missing** when we armed — Node's documented single call with
 *   every field zeroed. GeForce NOW is not installed. Not news.
 * - the path **existed** when we armed and has now changed for the first time.
 *   That is the user re-pinning their region, or an update landing. News.
 *
 * Reading a first sighting as a baseline in both cases swallows exactly one
 * change per path per run — and since a launcher is started once and the
 * datacenter is changed once, that is *the* change, every time. This function
 * shipped that way for a day; the symptom was a Status screen that only caught
 * up on the second change, or on a manual refresh.
 */
export function markMoved(previous: FileMark | null, current: FileMark): boolean {
  if (previous === null) return current.present
  if (previous.present !== current.present) return true
  // Two absences are the same absence; ino, size and mtime are all zero anyway.
  if (!current.present) return false
  return (
    previous.ino !== current.ino ||
    previous.mtimeMs !== current.mtimeMs ||
    previous.size !== current.size
  )
}

/** `app/<id>/current/active`, relative to an installation root. */
const DEPLOY_POINTER = ['app', GFN_APP_ID, 'current', 'active'] as const

/**
 * The deploy pointer in both flatpak installation roots, per-user first.
 *
 * A function taking `home`, for the same reason as `zoneStoragePath()` and
 * `streamLogPath()`. Tested because a wrong string here fails **completely
 * silently**: the watch arms against a path that will never change, nothing
 * throws, nothing is logged, and the feature simply does not exist. These two
 * must agree with the `--filesystem=…:ro` grants in
 * `flatpak/io.github.robertotucci.GfnLauncher.yml`.
 */
export function deployPointerPaths(home: string = homedir()): readonly [string, string] {
  return [
    join(home, '.local', 'share', 'flatpak', ...DEPLOY_POINTER),
    join('/var', 'lib', 'flatpak', ...DEPLOY_POINTER)
  ]
}

/**
 * How often the client's configuration is stat'd.
 *
 * The responsive one of the two: somebody who has just re-pinned a region in
 * the GeForce NOW app is walking back to the launcher, and this is the number
 * that decides whether the Status screen has caught up by the time they look.
 */
const ZONE_POLL_MS = 2_000

/**
 * How often the deploy pointers are stat'd.
 *
 * The affordable one, in the spirit of `handback`'s `PROBE_LAZY_MS`: nobody
 * watches an update land, and a version on the Settings nameplate that is ten
 * seconds late is not a fact anyone can perceive.
 */
const DEPLOY_POLL_MS = 10_000

/**
 * How long a burst of writes is allowed to settle before anything is re-read.
 *
 * The client rewrites its storage in more than one pass, and an update moves
 * the pointer while other things are still landing. One derivation per burst.
 */
const COALESCE_MS = 250

/** One watch at a time, module-level — the same shape as `active` in `handback.ts`. */
let active: { stop: () => void } | null = null

/** Idempotent, and safe when nothing is armed. */
export function disarmClientWatch(): void {
  active?.stop()
  active = null
}

/**
 * Starts following the installed client. Called once, from `app.whenReady()`.
 *
 * `getWindow` is a thunk rather than a window, matching `registerIpcHandlers`
 * and `createDisplayWakeLock`: this is armed *before* the first
 * `createWindow()`, so that a client change during a slow first load is not
 * missed, and the window it eventually pushes to may be a later one.
 */
export function armClientWatch(getWindow: () => BrowserWindow | null): void {
  disarmClientWatch()

  const zonePath = zoneStoragePath()
  const deployPaths = deployPointerPaths()

  const marks = new Map<string, FileMark>()
  const watches: Array<{ path: string; listener: (curr: Stats) => void }> = []

  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let deriving = false
  let zonePending = false
  let deployPending = false

  /** The last values actually delivered, so only real changes cross. */
  let sentClient: GfnClientInfo | null = null
  let sentZone: ZoneStatus | null = null
  /** Whether a zone read error has already been held back once. See `refreshZone`. */
  let zoneErrorHeld = false

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    for (const watch of watches) unwatchFile(watch.path, watch.listener)
  }

  /**
   * Delivers a payload, reporting whether it actually went anywhere.
   *
   * The caller records it as sent **only when this returns true** — a deliberate
   * deviation from `screen.ts`, which records first and gets away with it
   * because of its `did-finish-load` replay. There is no replay here, and this
   * is armed before the window exists, so a change in that first few hundred
   * milliseconds would otherwise be filed as delivered and never sent. Nothing
   * is lost by dropping it: the renderer pulls both facts at mount.
   */
  const send = (channel: string, payload: unknown): boolean => {
    const window = getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false
    window.webContents.send(channel, payload)
    return true
  }

  /**
   * Whether a deploy pointer is still on disk, for the rule in the header.
   *
   * An unrecorded path counts as present, and that is not a fudge: `watchFile`
   * stays silent about a path that existed when we armed and says so
   * immediately about one that did not, so "no mark" can only mean the pointer
   * was there. Erring towards present errs towards keeping a client we might
   * still have, which is the safe direction.
   */
  const pointerPresent = (): boolean =>
    deployPaths.some((path) => marks.get(path)?.present ?? true)

  const refreshClient = async (): Promise<void> => {
    const info = await detectGfn(true)
    if (stopped) return

    if (!info.installed && pointerPresent()) {
      // Surfaced, not swallowed — but a warning rather than a pushed state,
      // because the state would be a lie. See the header.
      console.warn(
        'GeForce NOW is deployed but could not be read after its install changed; ' +
          `keeping the previous reading${info.error ? ` — ${info.error}` : ''}`
      )
      return
    }

    // The service configuration we cached came out of the install that has just
    // been replaced. After `detectGfn`, never before: clearing it while the
    // remembered path is still the pruned one would only re-read the dead file.
    resetAppConfig()

    if (sameClient(sentClient, info)) return
    if (send(IPC.gfnClient, info)) sentClient = info
  }

  const refreshZone = async (): Promise<void> => {
    const zone = currentZone(await readZoneAssignment())
    if (stopped) return

    // A file caught mid-write parses as nothing at all. Rather than replace a
    // good nameplate with "could not be read" and correct it two seconds later,
    // hold the first such reading and let the next tick decide. Not swallowed:
    // it is logged here, the second one is pushed, and `status:get` reports the
    // identical error the moment the user opens the view.
    if (zone.assignment.error !== null && sentZone !== null && sentZone.assignment.error === null) {
      if (!zoneErrorHeld) {
        zoneErrorHeld = true
        console.warn(`GeForce NOW's configuration could not be read at ${zonePath}; will retry`)
        return
      }
    }
    zoneErrorHeld = false

    if (sameZone(sentZone, zone)) return
    if (send(IPC.statusZone, zone)) sentZone = zone
  }

  const derive = async (): Promise<void> => {
    const deployMoved = deployPending
    const zoneMoved = zonePending
    deployPending = false
    zonePending = false

    if (deployMoved) await refreshClient()
    // Also on a deploy move: installing or removing the client is the one thing
    // that makes its configuration appear or disappear.
    if (!stopped && (zoneMoved || deployMoved)) await refreshZone()
  }

  const run = (): void => {
    timer = null
    // A derivation already in flight cannot see flags raised after it started;
    // its own `finally` re-checks them, so there is nothing to do here.
    if (stopped || deriving) return

    deriving = true
    void derive()
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'unknown error'
        console.warn(`Could not re-read the GeForce NOW client: ${reason}`)
      })
      .finally(() => {
        deriving = false
        if (!stopped && (zonePending || deployPending)) schedule()
      })
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    // `unref` so a launcher on its way out is never held open by a timer whose
    // only job is to ask a question — the `displaySleep.ts` precedent, the same
    // one `persistent: false` follows below.
    timer = setTimeout(run, COALESCE_MS)
    timer.unref()
  }

  const watch = (path: string, interval: number, raise: () => void): void => {
    const listener = (curr: Stats): void => {
      if (stopped) return
      const next = fileMark(curr)
      const moved = markMoved(marks.get(path) ?? null, next)
      marks.set(path, next)
      if (!moved) return
      raise()
      schedule()
    }

    watches.push({ path, listener })
    watchFile(path, { interval, persistent: false }, listener)
  }

  watch(zonePath, ZONE_POLL_MS, () => {
    zonePending = true
  })
  for (const path of deployPaths) {
    watch(path, DEPLOY_POLL_MS, () => {
      deployPending = true
    })
  }

  active = { stop }
}
