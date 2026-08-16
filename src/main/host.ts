import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

/**
 * The boundary between "this process" and "the machine it is running on".
 *
 * Packaged as a Flatpak, the launcher is not the host any more. `flatpak` and
 * `systemctl` are not on the sandbox's PATH, and reaching them means going back
 * out through `flatpak-spawn --host`. That is one fact affecting four modules —
 * gfn/flatpak.ts, gfn/launch.ts, power.ts and autostart.ts — so it lives in one
 * place rather than four, for the same reason `stepAside()` in ipc.ts does: two
 * copies of a rule diverge, and only one of them gets fixed.
 *
 * Outside a Flatpak nothing here changes anything. `hostCommand` returns its
 * arguments untouched, so the AppImage and the .deb run exactly the argv they
 * ran before this module existed — which is what `host.test.ts` pins.
 *
 * Every claim below was checked against flatpak 1.18.1 rather than assumed; the
 * surprising ones are marked.
 */

const run = promisify(execFile)

/**
 * Whether we are inside a Flatpak sandbox.
 *
 * `/.flatpak-info` is written into every Flatpak container by the runtime and
 * exists nowhere else. Read once at module load: it cannot change while the
 * process lives, and the launch path would otherwise pay a stat per game.
 *
 * Not `process.env.FLATPAK_ID`, which is also set for a nested `flatpak-spawn`
 * and is easy to inherit by accident.
 */
export const IS_SANDBOXED = existsSync('/.flatpak-info')

/**
 * Our own Flatpak application id, or null when we are not one.
 *
 * `autostart.ts` needs it for two things a desktop entry cannot get anywhere
 * else: the `Exec=flatpak run <id>` that survives the sandbox, and the icon
 * name, which is the app id inside a Flatpak and the executable name outside.
 */
export const FLATPAK_ID = process.env.FLATPAK_ID ?? null

/** Shown in the `blocked` message and in the autostart entry. Kept beside the id it names. */
const OWN_APP_ID = 'io.github.robertotucci.GfnLauncher'

export interface HostCommandOptions {
  /**
   * Environment for the *host* command.
   *
   * This is not cosmetic. **`flatpak-spawn --host` does not forward the
   * sandbox's environment**: a host command started from inside a Flatpak
   * inherits the host session's env, so setting `LC_ALL` on our own process
   * reaches nothing. Verified — `flatpak-spawn --host sh -c 'echo $LC_ALL'`
   * prints the session's value, not ours. The only way through is an explicit
   * `--env=` per variable, which is what this becomes.
   */
  env?: Record<string, string>
  /** Injectable so the two branches are testable without a sandbox to run them in. */
  sandboxed?: boolean
}

/**
 * Rewrites a command so it runs on the host rather than in the sandbox.
 *
 * Pure, for the same reason `buildPowerArgv` and `buildLaunchArgv` are pure:
 * what comes out of here kills processes and suspends machines, and the test
 * suite has to assert the exact argv without running it.
 *
 * The `--` is not decoration — it stops `flatpak-spawn` from reading the child's
 * flags as its own, and every caller here passes flags, starting with
 * `flatpak run --command=…`. Verified that flatpak-spawn consumes the separator
 * rather than passing it on as a command name.
 */
export function hostCommand(
  command: string,
  args: readonly string[],
  { env, sandboxed = IS_SANDBOXED }: HostCommandOptions = {}
): [command: string, args: string[]] {
  if (!sandboxed) return [command, [...args]]

  const envArgs = Object.entries(env ?? {}).map(([key, value]) => `--env=${key}=${value}`)
  return ['flatpak-spawn', ['--host', ...envArgs, '--', command, ...args]]
}

/** The argv as a user would have to type it, for error messages and LaunchNotice. */
export function printableCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

/**
 * Why a host command did not run.
 *
 * `blocked` exists because it is the one failure the user can actually fix, and
 * the one that disappears if collapsed into the others: revoke
 * `--talk-name=org.freedesktop.Flatpak` in Flatseal and every `flatpak` probe
 * starts failing, which — reported as `missing` — reads as "GeForce NOW is not
 * installed". The user then reinstalls a client that was there all along.
 */
export type HostFailureKind =
  /** The command could not be started on the host: absent, or not executable. */
  | 'missing'
  /** We are sandboxed and the sandbox is not allowed to reach the host. */
  | 'blocked'
  /** The command ran and returned non-zero. */
  | 'failed'

export interface HostFailure {
  kind: HostFailureKind
  /** Safe to show in the UI. */
  message: string
}

/**
 * How `flatpak-spawn` reports the two failures that are not the child's own.
 *
 * Both arrive prefixed `Portal call failed:`, so that prefix discriminates
 * nothing and is not matched on. What does discriminate is locale-independent
 * by luck rather than design, and worth spelling out, because the obvious
 * patterns are wrong:
 *
 *   blocked  Portal call failed: org.freedesktop.DBus.Error.ServiceUnknown
 *            Hint: --host only works when the Flatpak is allowed to talk to
 *            org.freedesktop.Flatpak
 *
 *   missing  Portal call failed: Failed to start command: Esecuzione del
 *            processo figlio «foo» non riuscita (File o directory non esistente)
 *
 * **The inner half of the second one is translated**, and not by us: it is
 * generated by the portal on the host, under the host session's locale, so it
 * arrives already localised and no `LC_ALL` we set can change it. Matching
 * "no such file or directory" would therefore work in English and nowhere else.
 * A D-Bus error name and the English `Failed to start command:` prefix are the
 * only stable things in either message.
 *
 * Note also what is *not* here: "permission denied". That is the inner,
 * translated text for a host file that exists but is not executable — a
 * `missing`, not a sandbox refusal. Reading it as `blocked` would send the user
 * to Flatseal to fix a file mode.
 */
const BLOCKED_PATTERNS = [
  /org\.freedesktop\.DBus\.Error\.(ServiceUnknown|AccessDenied)/,
  /org\.freedesktop\.Flatpak/
]

const UNSTARTABLE_PATTERN = /Failed to start command/i

/**
 * Turns whatever `execFile` rejected with into something the UI can say out loud.
 *
 * Pure, so all three branches are testable without a sandbox to run them in.
 */
export function classifyHostFailure(
  error: unknown,
  sandboxed: boolean = IS_SANDBOXED
): HostFailure {
  const code = (error as { code?: unknown } | null)?.code
  const stderr = String((error as { stderr?: unknown } | null)?.stderr ?? '')
  const message =
    error instanceof Error && error.message ? error.message : 'The command could not be run'

  // ENOENT from Node means the *outer* binary was missing: `flatpak-spawn`
  // inside a sandbox — which would mean a broken runtime, not a user problem —
  // or the command itself outside one.
  if (code === 'ENOENT') {
    return {
      kind: 'missing',
      message: sandboxed
        ? 'flatpak-spawn is missing from the runtime, so the host cannot be reached.'
        : message
    }
  }

  if (sandboxed && BLOCKED_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return {
      kind: 'blocked',
      message:
        'This Flatpak is not allowed to reach the host, so it cannot see or start GeForce NOW. ' +
        'Grant it the org.freedesktop.Flatpak permission in Flatseal, or run: ' +
        `flatpak override --user --talk-name=org.freedesktop.Flatpak ${OWN_APP_ID}`
    }
  }

  if (sandboxed && UNSTARTABLE_PATTERN.test(stderr)) {
    return { kind: 'missing', message: 'The command could not be started on the host.' }
  }

  return { kind: 'failed', message: stderr.trim() || message }
}

/**
 * Runs a host command to completion.
 *
 * Rejects with whatever `execFile` rejected with, unchanged, so existing callers
 * keep working; anything needing to tell the three failures apart hands the
 * error to `classifyHostFailure`.
 */
export async function hostExecFile(
  command: string,
  args: readonly string[],
  options: HostCommandOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const { env, sandboxed = IS_SANDBOXED } = options
  const [outer, outerArgs] = hostCommand(command, args, { env, sandboxed })

  // Sandboxed, `env` has already become `--env=` flags on the outer argv and
  // must not also be set on flatpak-spawn itself, which does not forward it.
  const result = await run(outer, outerArgs, sandboxed ? {} : { env: { ...process.env, ...env } })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}

/**
 * Filesystem operations that have to land on the *host* rather than in our
 * private per-app directory.
 *
 * There is exactly one caller: the XDG autostart entry, which is read by the
 * session at login and therefore has to exist in the user's real
 * `~/.config/autostart`. Two ways to reach it, and this is the cheaper one:
 *
 * - `--filesystem=xdg-config/autostart:create` mounts the real directory into
 *   the sandbox, and would be a *second* permission to justify to Flathub —
 *   one its linter already flags as unnecessary, because the Background portal
 *   exists.
 * - `flatpak-spawn` reuses the host access we cannot avoid having anyway, since
 *   nothing else can start the GeForce NOW client.
 *
 * (The Background portal would be better than either, and is not reachable
 * from here: it is a D-Bus request/response pair over the session bus, Electron
 * exposes no binding for it, and a native D-Bus module is ruled out by
 * `npmRebuild: false`. Worth revisiting if Electron ever wraps it.)
 *
 * Outside a sandbox these are the plain `fs/promises` calls they look like.
 */
export async function hostFileExists(path: string): Promise<boolean> {
  if (!IS_SANDBOXED) {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  try {
    await hostExecFile('test', ['-f', path])
    return true
  } catch {
    // `test` exits 1 for "no", which arrives as a rejection. Every other reason
    // to fail — no host access, no `test` — also means we cannot claim it is
    // there, so they collapse to the same answer.
    return false
  }
}

/** Writes `contents` to a host path, creating the parent directory. */
export async function hostWriteFile(path: string, contents: string): Promise<void> {
  if (!IS_SANDBOXED) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, 'utf8')
    return
  }

  await hostExecFile('mkdir', ['-p', dirname(path)])
  // Through stdin rather than as an argument: the payload is multi-line and
  // contains characters a shell would reinterpret, and `tee` needs no shell at
  // all — `flatpak-spawn` execs it directly.
  await new Promise<void>((resolve, reject) => {
    const [outer, outerArgs] = hostCommand('tee', [path])
    const child = spawn(outer, outerArgs, { stdio: ['pipe', 'ignore', 'pipe'] })

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(Object.assign(new Error(`tee exited ${code}`), { stderr, code }))
    )

    child.stdin?.end(contents, 'utf8')
  })
}

/** Removes a host path, succeeding when it was already gone. */
export async function hostRemoveFile(path: string): Promise<void> {
  if (!IS_SANDBOXED) {
    await rm(path, { force: true })
    return
  }
  await hostExecFile('rm', ['-f', path])
}

/** Starts a host command without waiting for it. See `spawnFlatpak` in gfn/launch.ts. */
export function hostSpawn(
  command: string,
  args: readonly string[],
  options: HostCommandOptions = {}
): { child: ChildProcess; printable: string } {
  const [outer, outerArgs] = hostCommand(command, args, options)
  return {
    // Detached: what this starts must outlive the launcher, and the launcher
    // must not block on a session that can run for hours.
    child: spawn(outer, outerArgs, { detached: true, stdio: 'ignore' }),
    // The full argv *including* the flatpak-spawn prefix, because this string
    // ends up on screen in LaunchNotice and its whole value is naming the exact
    // command that failed. A half-quoted one sends the reader hunting.
    printable: printableCommand(outer, outerArgs)
  }
}
