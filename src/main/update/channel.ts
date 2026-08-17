/**
 * Which install form this is, and the two commands the Flatpak one needs.
 *
 * Pure, and the argv builders follow the house rule for a specific reason: what
 * `buildFlatpakUpdateArgv` produces replaces the running application, and the
 * suite has to be able to assert the exact string without running it. Same
 * bargain as `buildPowerArgv`.
 */

import type { UpdateChannel } from '@shared/types'

/** Our own Flatpak application id. The same literal `host.ts` keeps for its message. */
export const OWN_APP_ID = 'io.github.robertotucci.GfnLauncher'

/**
 * What the answer is derived from, injected rather than read, so all four
 * branches are testable from one process.
 */
export interface InstallEnvironment {
  /** `IS_SANDBOXED` from host.ts — `/.flatpak-info` exists. */
  sandboxed: boolean
  /** `FLATPAK_ID`, which is set inside a sandbox and by a nested flatpak-spawn. */
  flatpakId: string | null
  /** `process.env.APPIMAGE`: the host path of the AppImage that mounted us. */
  appImage: string | null
  /** `app.isPackaged`. False under `npm run dev`. */
  packaged: boolean
}

/**
 * Decides who is allowed to replace this launcher.
 *
 * Order matters and is not arbitrary:
 *
 * - **Unpackaged first.** A development run has an `out/` directory and a git
 *   checkout behind it, and the last thing it should do is download a release
 *   over itself. It is also the only branch that would otherwise be wrong for
 *   an obvious reason — `npm run dev` inherits neither marker, so it would fall
 *   through to `system` and offer a `.deb` to a working tree.
 * - **Flatpak before AppImage**, because a Flatpak launched from a terminal that
 *   itself came from an AppImage would inherit `APPIMAGE` in its environment.
 *   `/.flatpak-info` cannot be inherited: the runtime writes it into the
 *   container.
 * - **`system` is the fallback rather than `unknown`.** Packaged, not sandboxed
 *   and not an AppImage is the `.deb` — installed under /opt by a package
 *   manager that owns those files. Being wrong here costs a sentence pointing at
 *   the wrong tool; the branch installs nothing either way.
 */
export function resolveUpdateChannel({
  sandboxed,
  flatpakId,
  appImage,
  packaged
}: InstallEnvironment): UpdateChannel {
  if (!packaged) return 'unknown'
  if (sandboxed || flatpakId) return 'flatpak'
  if (appImage) return 'appimage'
  return 'system'
}

/**
 * `flatpak update` for one application.
 *
 * **`--assumeyes` and not `--noninteractive`, and the difference is the
 * progress bar.** `--noninteractive` selects flatpak's quiet transaction, whose
 * entire output for a 19 MB pull is one line naming the ref — measured, on
 * flatpak 1.18.1, not inferred. `--assumeyes` prints a percentage per line
 * instead, which is what `scanFlatpakProgress` reads and the only way this
 * launcher can say how far an update has got.
 *
 * The question that switch was originally avoiding does not arise: with stdout
 * piped and **stdin at /dev/null**, flatpak completes unattended — also
 * measured, both ways round. Anything it did decide to ask would read EOF and
 * fail, which is a refusal the notice can show rather than a button that hangs.
 *
 * No `--user` or `--system`. Flatpak finds the installation the app is in, and
 * naming the wrong one turns "already up to date" into "not installed". A
 * system-wide install will want polkit and will fail non-interactively; that
 * arrives as a refusal the notice shows, which is the right outcome — it is the
 * same posture as the power menu, where polkit is also allowed to say no.
 */
export function buildFlatpakUpdateArgv(appId: string): [string, ...string[]] {
  return ['flatpak', 'update', '--assumeyes', appId]
}

/**
 * Whether a string is safe to put in the relaunch command below.
 *
 * Application ids are `[A-Za-z0-9._-]` by Flatpak's own rules, and the one the
 * launcher uses comes from `FLATPAK_ID` — an environment variable, which is the
 * only input on this path that did not come from a literal in this repository.
 * `buildFlatpakRelaunchArgv` interpolates into `sh -c`, so it gets checked
 * rather than trusted, and the caller falls back to `OWN_APP_ID`.
 */
export function isFlatpakAppId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

/**
 * How long the relaunch waits for this instance to be gone before giving up.
 *
 * A bound rather than a bare `while`, because the loop runs on the host and
 * outlives us: a launcher whose quit is cancelled would otherwise leave a shell
 * polling `flatpak ps` for the rest of the session. Timing out is safe — it
 * runs `flatpak run` anyway, the still-live launcher's single-instance lock
 * refuses it, and the user keeps the launcher they already had.
 */
const RELAUNCH_WAIT_SECONDS = 30

/**
 * Starts a fresh instance once this one has exited.
 *
 * ── Why a Flatpak cannot restart itself the ordinary way ────────────────────
 *
 * `flatpak update` deploys a new commit; the running sandbox keeps the old one
 * bind-mounted, because that is the filesystem it was started with. So
 * `app.relaunch()` — which re-execs `process.execPath` inside this sandbox —
 * comes back on the version it started with. A restart button that silently
 * reinstates the old version is worse than no button, which is why there was no
 * button here at all until this existed.
 *
 * The way out is to have the *host* start the new instance after we are gone.
 *
 * ── Why this is a shell, when `host.ts` prefers not to be ────────────────────
 *
 * `hostWriteFile` goes out of its way to avoid `sh -c`, and that reasoning does
 * not transfer: it was avoiding shell *quoting* of multi-line file content.
 * Here the only interpolated value is an application id checked by
 * `isFlatpakAppId`, and the thing actually needed is sequencing — wait, then
 * run — which `flatpak-spawn` has no way to express.
 *
 * Three details, each load-bearing:
 *
 * **It waits for the instance to disappear rather than sleeping a guessed
 * number of seconds.** The failure mode of guessing short is the worst one this
 * feature has: the new instance finds the old lock still held, quits, and a
 * television is left with no launcher at all. Polling `flatpak ps` is exact,
 * and in the ordinary case it is also faster than any sleep long enough to be
 * safe.
 *
 * **The whole thing is backgrounded, so the outer `sh` exits immediately.**
 * Without the `&`, `flatpak-spawn` sits waiting for its host child — and
 * `flatpak-spawn` is a process *inside our sandbox*, so the sandbox could not
 * tear down, the instance would never leave `flatpak ps`, and the loop below
 * would wait for itself until it timed out. Backgrounding cuts that knot: the
 * client returns, our sandbox is free to go, and the host subshell is reparented
 * to init.
 *
 * **`exec`**, so no shell lingers behind the new launcher for the rest of the
 * session.
 */
export function buildFlatpakRelaunchArgv(appId: string): [string, ...string[]] {
  const id = isFlatpakAppId(appId) ? appId : OWN_APP_ID
  const wait = `n=0; while [ "$n" -lt ${RELAUNCH_WAIT_SECONDS} ] && flatpak ps --columns=application | grep -qF ${id}; do n=$((n+1)); sleep 1; done`
  return ['sh', '-c', `(${wait}; exec flatpak run ${id}) >/dev/null 2>&1 </dev/null &`]
}

/**
 * The commit currently deployed for an application.
 *
 * This is how the launcher knows whether the update did anything, and it exists
 * because the obvious alternative does not work. `flatpak update` prints
 * "Nothing to do." when there is nothing to do — **on the host, in the host
 * session's language**, exactly like the portal messages `classifyHostFailure`
 * refuses to match on. A commit hash is the same in every locale.
 *
 * The case this catches is real and is the common one for anybody who did not
 * install from Flathub: a `.flatpak` bundle installed by hand has no remote to
 * update from, so `flatpak update` succeeds, changes nothing, and exits 0.
 * Without this the notice would claim an update it never made.
 */
export function buildFlatpakCommitArgv(appId: string): [string, ...string[]] {
  return ['flatpak', 'info', '--show-commit', appId]
}
