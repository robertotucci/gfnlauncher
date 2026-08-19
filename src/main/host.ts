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

/**
 * Shown in the `blocked` message and in the autostart entry. Kept beside the id
 * it names.
 *
 * Exported for `padAccess.ts`, which spells out the other `flatpak override`
 * this launcher can tell a user to run. Two permissions, one id, one place.
 */
export const OWN_APP_ID = 'io.github.robertotucci.GfnLauncher'

/**
 * How long any host command may take before it is killed.
 *
 * **Every call on this boundary is a round trip through a D-Bus portal**, and a
 * portal is a service that can stop answering — `xdg-desktop-portal` restarting
 * during a session is the ordinary way that happens. Without a bound the
 * failure is not a slow launcher, it is a stopped one, and in two places that
 * matters more than anywhere else in the codebase:
 *
 * - `getSettings()` reads the autostart entry through here, and `createWindow`
 *   awaits `getSettings()`. A host call that never returns is a launcher that
 *   never opens a window at all — no error, no UI, nothing to report.
 * - `handback`'s watch schedules its next probe from the *result* of the last
 *   one. A probe that never resolves ends the watch silently, and the launcher
 *   stays behind the GeForce NOW client after the game is over, which on a
 *   television with no keyboard is a dead end.
 *
 * Fifteen seconds is far longer than any of these take (`flatpak ps` answers in
 * tens of milliseconds) and short enough that the failure reads as a failure.
 */
const HOST_TIMEOUT_MS = 15_000

/** A host command that took longer than this is worth a line in the log. */
const SLOW_COMMAND_MS = 2_000

/**
 * How long a streaming host command may go without printing anything.
 *
 * Its own figure, and much larger than `HOST_TIMEOUT_MS`, because the one
 * caller is `flatpak update`: the whole command legitimately runs for minutes,
 * but it prints a percentage as it goes, so *silence* is the signal rather than
 * duration. Two minutes is far past any gap flatpak leaves between lines and
 * still short enough that a stalled update ends in a refusal the notice can
 * show rather than a progress bar that never moves again.
 */
const STREAM_STALL_MS = 120_000

/**
 * Variables Chromium writes into **our own** `process.env`, which every child
 * this module starts would otherwise inherit.
 *
 * ── The one that is not cosmetic ────────────────────────────────────────────
 *
 * `EGL_PLATFORM=wayland` is set by Electron's ozone/Wayland backend for its own
 * GPU process. Inherited by `flatpak run com.nvidia.geforcenow`, it reaches the
 * GeForce NOW client's CEF, which **dies with SIGTRAP about three seconds in** —
 * measured, repeatedly, on Electron 43 under a KDE Wayland session: the client
 * window appears, shows in `flatpak ps`, and is gone by the fourth second. The
 * same `flatpak run`, with the same `detached`/`stdio: 'ignore'` options, from a
 * plain Node process, runs indefinitely. Bisecting the five variables below
 * against a clean environment names this one and only this one.
 *
 * The symptom is the worst kind this launcher can produce: pressing Play starts
 * the client, the launcher steps out of the way, and the screen goes back to the
 * desktop with nothing anywhere saying why. It affects the AppImage and the .deb
 * — not the Flatpak, whose commands go out through `flatpak-spawn --host`, which
 * does not forward the sandbox's environment at all.
 *
 * ── Why the rest go too ─────────────────────────────────────────────────────
 *
 * None of them is a fact about the machine; each is Chromium configuring itself.
 * `GDK_BACKEND` and `NO_AT_BRIDGE` would impose our toolkit backend and disable
 * the accessibility bridge in an unrelated program, `FC_FONTATIONS` selects a
 * Skia font stack that means nothing outside it, and `CHROME_DESKTOP` names
 * *our* .desktop file — a child that reads it is mis-associated in the session's
 * window tracking.
 *
 * ── Why they are deleted and not restored ───────────────────────────────────
 *
 * There is nothing to restore them to. Three of the five are already set before
 * the first line of `index.ts` runs, so no snapshot taken from JavaScript can
 * see what the session had. Deleting is the right answer anyway: unset means the
 * child autodetects, which is what it would have done had the launcher not been
 * a Chromium application.
 */
const CHROMIUM_INJECTED_ENV = [
  'EGL_PLATFORM',
  'GDK_BACKEND',
  'FC_FONTATIONS',
  'NO_AT_BRIDGE',
  'CHROME_DESKTOP'
] as const

/**
 * The environment a host command should run in: this process's, minus the part
 * of it that is Chromium talking to itself.
 *
 * Pure and exported for the same reason the argv builders are — what it returns
 * decides whether the GeForce NOW client survives being started, and the suite
 * has to be able to assert it without a Wayland session to prove it on.
 */
export function hostEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env = { ...base, ...overrides }
  for (const key of CHROMIUM_INJECTED_ENV) {
    // Unless the caller asked for it by name, in which case it is a deliberate
    // choice about the child rather than a leak from us.
    if (!(key in overrides)) delete env[key]
  }
  return env
}

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
  /** Overrides `HOST_TIMEOUT_MS` for a call known to be slower or faster. */
  timeoutMs?: number
  /**
   * A non-zero exit is an *answer* here, not a fault, so keep it out of the log.
   *
   * Two callers, and both would otherwise write a warning on their most common
   * outcome: `test -f` exits 1 for "the autostart entry is not there", which is
   * every start with autostart off, and `flatpak kill` exits 1 with "is not
   * running", which is every first launch of a session.
   */
  quiet?: boolean
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
  /**
   * It never answered, and was killed at `HOST_TIMEOUT_MS`.
   *
   * Its own kind rather than a `failed` with an unusual message, because it is
   * the only one of the four that says nothing about the *command* — a portal
   * that has stopped answering fails every call on this boundary identically,
   * and a launcher reporting "GeForce NOW could not be started" for it would be
   * pointing at the wrong thing.
   */
  | 'timeout'
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
 * Pure, so all four branches are testable without a sandbox to run them in.
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

  // `execFile`'s own timeout kills the child, which arrives as an error
  // carrying `killed` and the signal it used. Checked before the patterns
  // below, because a command killed part-way can have written anything to
  // stderr first.
  //
  // `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` is excluded because it also sets
  // `killed`, and it means the opposite: the command answered, at length. No
  // caller here produces a megabyte of output, so this is a guard against a
  // future one being misreported rather than an observed case.
  if (
    (error as { killed?: unknown } | null)?.killed === true &&
    code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  ) {
    return {
      kind: 'timeout',
      message: sandboxed
        ? 'The host did not answer in time. If this keeps happening, the desktop portal may have stopped running.'
        : 'The command did not finish in time and was stopped.'
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
 * keep working; anything needing to tell the four failures apart hands the
 * error to `classifyHostFailure`.
 *
 * **Bounded by `HOST_TIMEOUT_MS`**, which is the one behaviour here that is not
 * a passthrough — see that constant for the two places where an unbounded call
 * is not slow but fatal.
 *
 * Only the interesting outcomes reach the log. A failure always does; a success
 * only when it was slow enough to be worth knowing about. The alternative is a
 * line every ten seconds for the length of every session, from `handback`'s
 * probe alone, which would bury everything else in the file.
 */
export async function hostExecFile(
  command: string,
  args: readonly string[],
  options: HostCommandOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const { env, sandboxed = IS_SANDBOXED, timeoutMs = HOST_TIMEOUT_MS, quiet = false } = options
  const [outer, outerArgs] = hostCommand(command, args, { env, sandboxed })
  const startedAt = Date.now()

  try {
    // Sandboxed, `env` has already become `--env=` flags on the outer argv and
    // must not also be set on flatpak-spawn itself, which does not forward it.
    const result = await run(outer, outerArgs, {
      timeout: timeoutMs,
      ...(sandboxed ? {} : { env: hostEnvironment(process.env, env) })
    })

    const elapsed = Date.now() - startedAt
    if (elapsed >= SLOW_COMMAND_MS) {
      console.warn(`Host command took ${elapsed} ms: ${printableCommand(outer, outerArgs)}`)
    }

    return { stdout: String(result.stdout), stderr: String(result.stderr) }
  } catch (error) {
    // Named here, once, rather than in each of the seven callers — several of
    // which swallow the failure on purpose (`isGfnRunning`, `killGfn`,
    // `hostFileExists`) and would otherwise leave nothing behind at all.
    const failure = classifyHostFailure(error, sandboxed)
    // `quiet` still reports the failures that are never an answer: a sandbox
    // that cannot reach the host, and a portal that stopped replying, are worth
    // knowing about whichever command hit them.
    if (!quiet || failure.kind === 'blocked' || failure.kind === 'timeout') {
      console.warn(
        `Host command failed (${failure.kind}, ${Date.now() - startedAt} ms): ` +
          `${printableCommand(outer, outerArgs)} — ${failure.message}`
      )
    }
    throw error
  }
}

/**
 * Runs a host command, reporting its output as it arrives.
 *
 * `hostExecFile` buffers to completion, which is right for everything that
 * answers in milliseconds and wrong for the one caller here: `flatpak update`
 * runs for as long as a download takes, and the percentage it prints on the way
 * is the only thing the launcher can put on a progress bar.
 *
 * Two details it does not share with `hostExecFile`:
 *
 * **stdin is `/dev/null`.** Measured, not assumed: with it, `flatpak update -y`
 * completes unattended. Anything a future flatpak decided to ask would read EOF
 * and fail, which is a refusal the caller can show — where an inherited stdin
 * would be a button that hangs with nothing on screen to say why.
 *
 * **stdout and stderr both reach `onOutput`.** Which stream flatpak writes
 * progress to is not a contract, and a caller that guessed wrong would show a
 * frozen bar rather than an error.
 *
 * **A silent transfer ends.** `timeoutMs` here is an *inactivity* timeout
 * rather than a total one, for exactly the reason `STALL_TIMEOUT_MS` in
 * `download.ts` is: any total figure generous enough for a slow line would be
 * far too long to notice a dead one. `flatpak update` prints a percentage line
 * per chunk, so silence for two minutes means it has stopped, and the update
 * notice has no cancel button behind which a hang could be waited out.
 *
 * Rejects in `execFile`'s shape — an `Error` carrying `stderr` and `code` — so
 * `classifyHostFailure` reads it the same way it reads every other failure here.
 */
export function hostExecStreaming(
  command: string,
  args: readonly string[],
  onOutput: (chunk: string) => void,
  options: HostCommandOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const { env, sandboxed = IS_SANDBOXED, timeoutMs = STREAM_STALL_MS } = options
  const [outer, outerArgs] = hostCommand(command, args, { env, sandboxed })
  const printable = printableCommand(outer, outerArgs)

  console.info(`Host command (streaming): ${printable}`)

  return new Promise((resolve, reject) => {
    const child = spawn(outer, outerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Sandboxed, `env` is already `--env=` flags on the outer argv and must
      // not also be set on flatpak-spawn, which does not forward it.
      ...(sandboxed ? {} : { env: hostEnvironment(process.env, env) })
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let stall: NodeJS.Timeout | null = null

    // Not named `run`: that is the promisified `execFile` at module scope, and
    // shadowing it here would be a trap for the next reader.
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      if (stall) clearTimeout(stall)
      stall = null
      settle()
    }

    const resetStall = (): void => {
      // Output can still arrive between the kill and the `close`, and a timer
      // armed after the promise has settled would outlive everything it was
      // watching.
      if (settled) return
      if (stall) clearTimeout(stall)
      stall = setTimeout(() => {
        console.warn(`Host command produced no output for ${timeoutMs} ms; stopping: ${printable}`)
        // SIGTERM rather than SIGKILL: `flatpak` cleans up a partial pull on
        // its way out, and a repository left mid-transaction is a worse state
        // to leave a machine in than a failed update.
        child.kill('SIGTERM')
        finish(() =>
          reject(
            Object.assign(new Error(`${command} stopped responding`), {
              stderr,
              stdout,
              killed: true
            })
          )
        )
      }, timeoutMs)
      stall.unref()
    }

    resetStall()

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      resetStall()
      onOutput(text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      resetStall()
      onOutput(text)
    })

    // ENOENT on the outer binary arrives here, already carrying `code`.
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code) =>
      finish(() =>
        code === 0
          ? resolve({ stdout, stderr })
          : reject(
              Object.assign(new Error(`${command} exited ${code}`), { stderr, stdout, code })
            )
      )
    )
  })
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
    await hostExecFile('test', ['-f', path], { quiet: true })
    return true
  } catch {
    // `test` exits 1 for "no", which arrives as a rejection. Every other reason
    // to fail — no host access, no `test` — also means we cannot claim it is
    // there, so they collapse to the same answer. `quiet` because "no" is the
    // common answer and would otherwise be a warning on every start.
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
    const child = spawn(outer, outerArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: hostEnvironment()
    })

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
  const { env, sandboxed = IS_SANDBOXED } = options
  const [outer, outerArgs] = hostCommand(command, args, options)
  // The full argv *including* the flatpak-spawn prefix, because this string
  // ends up on screen in LaunchNotice and its whole value is naming the exact
  // command that failed. A half-quoted one sends the reader hunting.
  const printable = printableCommand(outer, outerArgs)

  // Logged unconditionally, unlike `hostExecFile`'s successes: this is the
  // launcher doing the one thing it exists to do, it happens once per press,
  // and "which argv did it actually run" is the first question of every launch
  // report. `LaunchNotice` says it on screen for eight seconds; this is the
  // copy that is still there tomorrow.
  console.info(`Host spawn: ${printable}`)

  return {
    // Detached: what this starts must outlive the launcher, and the launcher
    // must not block on a session that can run for hours.
    //
    // `hostEnvironment` is the load-bearing part, and the one place in this
    // module where it is not merely tidy: this is the call that starts the
    // GeForce NOW client, and inheriting our `EGL_PLATFORM` kills it three
    // seconds later. See that function.
    //
    // **Applied on both branches**, unlike everywhere else here, and that is
    // deliberate rather than sloppy. The observed failure is unsandboxed, where
    // the child inherits this env directly. Sandboxed it should be unreachable,
    // because `flatpak-spawn --host` was measured not to forward the sandbox's
    // environment — but that is a fact about one version of one tool, this is
    // the only call in the launcher that starts a *graphical* program, and the
    // failure it guards against is a black screen with no explanation. Stripping
    // five variables from the environment `flatpak-spawn` itself runs in costs
    // nothing if the measurement holds, and covers us if it ever stops holding.
    child: spawn(outer, outerArgs, {
      detached: true,
      stdio: 'ignore',
      env: hostEnvironment(process.env, sandboxed ? {} : env)
    }),
    printable
  }
}
