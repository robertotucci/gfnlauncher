/**
 * The launcher's own log file: the one artefact a bug report can carry.
 *
 * ── Why a file at all ───────────────────────────────────────────────────────
 *
 * Everything else in this codebase is built on the premise that there is no
 * keyboard in front of the app — `LaunchNotice` exists for it, the power dialog
 * quotes polkit for it, `blocked` is a distinct `HostFailureKind` for it. The
 * same premise says nothing useful about *reporting* a fault: `console.warn`
 * goes to a terminal nobody opened, and the two packaged forms make even that
 * conditional. An AppImage started from a file manager has no stdout anyone can
 * read, and a Flatpak's goes to the journal under an app id most people would
 * not think to grep.
 *
 * So the launcher keeps its own log, in its own userData directory, and the
 * README names the exact path for each install form. One file, one generation
 * of history, size-capped.
 *
 * ── Why console is patched rather than replaced ─────────────────────────────
 *
 * There were already twenty-odd `console.warn`/`console.error` sites, every one
 * of them at a point somebody had decided was worth reporting. Introducing a
 * second logging vocabulary would have meant converting them and then policing
 * which one new code uses. Patching `console` keeps every existing site — and
 * every future one, and the ones inside Electron itself — going to the file for
 * free, and leaves `console.error` meaning exactly what it already meant.
 *
 * ── Why every line is redacted ──────────────────────────────────────────────
 *
 * This file is meant to be attached to a public issue. Three files on a machine
 * running this launcher hold live credentials (see CLAUDE.md), and while no
 * module here logs their *contents* deliberately, "deliberately" is not a
 * property a log can be shipped on: an error object from a failed request can
 * carry a URL with a token in the query, and a stack frame can carry a path.
 * `redactSecrets` runs over every line on the way to disk — belt to the braces
 * that `parseZoneAssignment`'s narrow return type and `streamLog`'s "log the
 * offset, never the chunk" rule already provide.
 *
 * The redaction is deliberately *not* applied to the terminal copy: under
 * `npm run dev` the developer is the audience and the machine is theirs.
 *
 * ── Writes are synchronous, and that is the point ───────────────────────────
 *
 * A buffered stream loses its tail on the exact failure this file exists to
 * explain — a crash, an OOM kill, a `poweroff` the user asked for. One
 * `writeSync` per line costs nothing at this volume (a quiet session writes a
 * few dozen lines) and the last line before the process died is the one worth
 * having.
 */

import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Which process a line came from.
 *
 * `gui` is the renderer, teed in by `index.ts` off `console-message`. Worth a
 * column of its own: "the grid threw" and "the catalog walk threw" are very
 * different reports, and without this they read identically.
 */
export type LogSource = 'main' | 'gui'

/** Directory name under `userData`. Named in the README; do not rename lightly. */
const LOG_DIR = 'logs'

/** The current log. `gfn-launcher.log.1` is the previous one. */
const LOG_NAME = 'gfn-launcher.log'

/**
 * When the log is rotated.
 *
 * One megabyte is roughly a fortnight of ordinary use and still small enough to
 * attach to an issue without thinking about it. Exactly one generation is kept:
 * the failure people report is nearly always the one they just saw, and a
 * launcher is not a service whose history is worth accumulating.
 */
const MAX_LOG_BYTES = 1_000_000

/**
 * Ceiling on one line.
 *
 * A third-party error can carry a whole HTML error page in `stderr`, and a log
 * that turns over its only generation because of one such line has lost the
 * context that made it useful.
 */
const MAX_LINE_CHARS = 4_000

/** Redactions, in the order they are applied. Each is documented at its use. */
const REDACTIONS: readonly [RegExp, string][] = [
  // A JWT, which is what `sharedstorage.json`'s `idToken` is and what
  // `session.ts` reads an `exp` out of. Anchored on `eyJ` — the base64 of `{"`,
  // with which every JWT header begins — so it cannot match a dotted hostname
  // or a reverse-DNS application id.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<jwt>'],
  // A token that is not a JWT. Three dot-separated runs of sixteen or more
  // token characters does not occur in prose, in a path, or in any application
  // id or hostname this launcher handles.
  [/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '<token>'],
  // A named Authorization header, however it was written down. The *scheme*
  // survives, because which scheme was used is a genuine diagnostic —
  // `webAuth.ts` logs `authScheme=GFNJWT` precisely to answer "was this a
  // bearer at all". First, so the generic `key: value` rule below never gets to
  // eat the scheme as though it were the credential.
  [/(\bauthorization["']?\s*[:=]\s*["']?)([A-Za-z]+\s+)?([^"'\s,&}]{8,})/gi, '$1$2<redacted>'],
  // The same credential quoted without its header name — in a stack frame, or
  // in a replayed header dump.
  [/\b(Bearer|GFNJWT|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>'],
  // A credential in a JSON body, a query string or a `key=value` diagnostic.
  [
    /(["']?(?:access_?token|id_?token|client_?token|refresh_?token|session_?token|api[_-]?key|password|secret)["']?\s*[:=]\s*["']?)([^"'\s,&}]{4,})/gi,
    '$1<redacted>'
  ],
  // The account's email address, which `sharedstorage.json` carries inside its
  // `idToken` and which an NVIDIA error page can echo back.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+\b/g, '<email>'],
  // The machine's MAC address and its router's, both of which are in that same
  // file. Colon-separated only: the bare form is indistinguishable from a hash.
  [/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, '<mac>']
]

/**
 * Takes the credentials out of a line.
 *
 * Pure, and tested, because this is the function that decides whether the file
 * the README asks people to attach is safe to attach. Being wrong in the
 * cautious direction costs a diagnostic; being wrong in the other direction
 * publishes somebody's session.
 *
 * Deliberately *not* redacted: file paths, including the home directory. They
 * are most of the value of the log — half the failures here are a path that was
 * not readable — and the README says plainly that they are in there.
 */
export function redactSecrets(text: string): string {
  let redacted = text
  for (const [pattern, replacement] of REDACTIONS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

/**
 * Renders whatever was handed to `console.warn(...)` as one string.
 *
 * Pure, so the awkward cases are pinned by tests rather than discovered in a
 * log somebody needed. Errors keep their stack — the whole reason to have this
 * file — and an object that cannot be serialised degrades to its `String()`
 * rather than throwing inside the logger.
 */
export function formatArgs(args: readonly unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === 'string') return value
      if (value instanceof Error) {
        return value.stack ?? `${value.name}: ${value.message}`
      }
      if (value === null) return 'null'
      if (value === undefined) return 'undefined'
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value)
        } catch {
          // Circular, or a getter that threw. Naming the type beats losing the
          // whole line.
          return `[unserialisable ${Object.prototype.toString.call(value)}]`
        }
      }
      return String(value)
    })
    .join(' ')
}

/**
 * One line, as it lands on disk.
 *
 * Fixed-width level and source columns so the file can be read with `grep` and
 * skimmed by eye — a log nobody can scan is a log nobody reads.
 */
export function formatLogLine(entry: {
  at: Date
  level: LogLevel
  source: LogSource
  message: string
}): string {
  const message = entry.message.length > MAX_LINE_CHARS
    ? `${entry.message.slice(0, MAX_LINE_CHARS)}… (${entry.message.length} chars truncated)`
    : entry.message

  return (
    `${entry.at.toISOString()}  ${entry.level.toUpperCase().padEnd(5)} ${entry.source.padEnd(4)}  ` +
    // Newlines inside a stack are indented rather than left flush, so one entry
    // is visibly one entry.
    `${message.replace(/\n/g, '\n    ')}\n`
  )
}

/** Directory the log lives in. Named in the README. */
export function logDirectory(): string {
  return join(app.getPath('userData'), LOG_DIR)
}

/** The file a bug report should carry. */
export function logFilePath(): string {
  return join(logDirectory(), LOG_NAME)
}

/** The generation before it, kept so a crash-and-restart does not erase itself. */
function previousLogPath(): string {
  return `${logFilePath()}.1`
}

let fd: number | null = null
let written = 0
let started = false
/** Kept from before the patch, so a failure inside the logger cannot recurse. */
let rawConsoleError: typeof console.error = console.error

/**
 * Appends one line, rotating first when the file has grown past its cap.
 *
 * Never throws. A log that takes the launcher down with it — a full disk, a
 * read-only home — would be worse than no log at all, so the first write
 * failure closes the file and the launcher carries on with the terminal copy
 * alone.
 */
export function writeLogLine(level: LogLevel, source: LogSource, message: string): void {
  if (fd === null) return

  const line = formatLogLine({ at: new Date(), level, source, message: redactSecrets(message) })

  try {
    if (written + line.length > MAX_LOG_BYTES) rotate()
    if (fd === null) return
    written += writeSync(fd, line)
  } catch (error) {
    const failed = fd
    fd = null
    try {
      if (failed !== null) closeSync(failed)
    } catch {
      // Already gone. Nothing left to do about it.
    }
    rawConsoleError('Log file could not be written; continuing without it:', error)
  }
}

/** Closes the current file, moves it aside and opens a fresh one. */
function rotate(): void {
  if (fd !== null) closeSync(fd)
  fd = null
  renameSync(logFilePath(), previousLogPath())
  fd = openSync(logFilePath(), 'a')
  written = 0
}

/**
 * Opens the log and points `console` at it.
 *
 * Called as early in `index.ts` as it can be — before the window, before the
 * IPC handlers — because the failures worth having a log for include the ones
 * that stop either from happening. It needs nothing from `app.whenReady()`:
 * `getPath('userData')` is resolved from the app name and is available from the
 * first line of the process.
 *
 * Idempotent, and returns the path so the caller can announce it.
 */
export function initLogging(): string {
  if (started) return logFilePath()
  started = true

  const path = logFilePath()

  try {
    mkdirSync(logDirectory(), { recursive: true })
    // Rotated on open as well as on write, so a session that ends abruptly does
    // not leave the next one appending to an oversized file forever.
    written = sizeOf(path)
    if (written > MAX_LOG_BYTES) {
      renameSync(path, previousLogPath())
      written = 0
    }
    fd = openSync(path, 'a')
  } catch (error) {
    // The launcher runs perfectly well without a log; it just cannot be
    // diagnosed as easily. Say so on the terminal and carry on.
    rawConsoleError('Log file could not be opened; continuing without it:', error)
    fd = null
  }

  patchConsole()
  watchForCrashes()
  return path
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * Tees `console` into the file.
 *
 * The original functions are called first and unchanged, so `npm run dev` keeps
 * the terminal output it always had — including the colours and object
 * inspection that `formatArgs` deliberately does not try to reproduce.
 */
function patchConsole(): void {
  const levels: [keyof Console, LogLevel][] = [
    ['debug', 'debug'],
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error']
  ]

  rawConsoleError = console.error.bind(console)

  for (const [method, level] of levels) {
    const original = console[method] as (...args: unknown[]) => void
    const bound = original.bind(console)
    ;(console as unknown as Record<string, unknown>)[method] = (...args: unknown[]): void => {
      bound(...args)
      writeLogLine(level, 'main', formatArgs(args))
    }
  }
}

/**
 * Records the two failures that would otherwise leave nothing behind.
 *
 * **An uncaught exception does not end the process here.** Node's default is to
 * exit, and on a television that is a launcher that vanishes with no window, no
 * message and no clue. Installing a handler keeps it up in whatever state it is
 * in — which is very often perfectly usable, since most of what runs in this
 * process is a background refresh — and writes down exactly what happened. A
 * launcher that is degraded is strictly better than one that is gone, and the
 * log is what turns "it closed by itself" into a bug report.
 */
function watchForCrashes(): void {
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception in the main process:', error)
  })

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection in the main process:', reason)
  })
}
