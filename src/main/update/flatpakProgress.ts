/**
 * Reading a percentage out of `flatpak update`'s output.
 *
 * ── The evidence ────────────────────────────────────────────────────────────
 *
 * Established from real runs against flatpak 1.18.1 with stdout piped, which is
 * the only shape that matters here — the launcher never gives flatpak a TTY.
 * Two facts decided the design and both were measured rather than assumed:
 *
 * **`--noninteractive` prints no progress at all.** It selects flatpak's quiet
 * transaction, whose entire output for an install is one line naming the ref.
 * That is why `buildFlatpakUpdateArgv` asks for `--assumeyes` instead; see the
 * note there.
 *
 * **With `--assumeyes` and no TTY, every progress update is its own line.**
 * Verbatim, from a 19 MB pull:
 *
 * ```
 * Looking for matches…
 *  1.     app.curocalc.calculator stable  i  flathub  < 19,4 MB
 * Installing…
 * Installing…                        0%  0 bytes/s
 * Installing… ██████████████▊       74%
 * Installing… ████████████████████ 100%
 * Installation complete.
 * ```
 *
 * ── What is parsed, and what is deliberately not ────────────────────────────
 *
 * **Only the digits before a `%`.** Everything else on those lines is a trap of
 * the kind `classifyHostFailure` already documents: `Installing…`,
 * `Installation complete.` and `Looking for matches…` are translatable, and the
 * size and speed are formatted by `g_format_size` in the host session's locale
 * — note `19,4 MB` above, on an Italian host. The percentage comes from a plain
 * `%3d%%`, so it carries no grouping separator and reads the same everywhere.
 *
 * Not parsing the verb is also what makes this indifferent to install, update
 * or uninstall, and to a future release renaming any of them.
 *
 * **Completion is not read from here.** "Updates complete." is translated too,
 * and worse, it is printed even when flatpak found nothing to do. `applyFlatpak`
 * compares deployed commits instead, which is exact. This file only ever moves
 * a bar.
 */

/**
 * A percentage, and whatever was left mid-line.
 *
 * The remainder exists because a pipe splits where it likes: a chunk can end
 * inside `7` `4%`, and parsing that half would report 4%. The caller carries it
 * into the next chunk, so only whole lines are ever read.
 */
export interface ProgressScan {
  /** 0–100, or null when this text carried no progress line. */
  percent: number | null
  /** Trailing partial line, to be prepended to the next chunk. */
  remainder: string
}

/**
 * A percentage that ends a word.
 *
 * The lookahead is what keeps this off anything that merely contains a digit
 * and a `%` — and the reason it is anchored at all is the ref listing that
 * flatpak prints before the transaction, which is the one line here that
 * carries arbitrary text from a remote.
 */
const PERCENT = /(\d{1,3})%(?=\s|$)/g

/**
 * Folds a chunk of output into the latest percentage.
 *
 * The *last* match in the chunk wins rather than the first: several progress
 * lines can arrive in one read, and the newest is the only one worth showing.
 */
export function scanFlatpakProgress(text: string): ProgressScan {
  const newline = text.lastIndexOf('\n')
  if (newline === -1) return { percent: null, remainder: text }

  const complete = text.slice(0, newline)
  const remainder = text.slice(newline + 1)

  let percent: number | null = null
  for (const match of complete.matchAll(PERCENT)) {
    const value = Number(match[1])
    // Flatpak clamps its own progress and logs "Unexpectedly got > 100%" when
    // it has to, so a value above 100 means this matched something that was
    // never a percentage.
    if (value >= 0 && value <= 100) percent = value
  }

  return { percent, remainder }
}
