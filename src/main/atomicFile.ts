import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Writing one of the launcher's own files without the possibility of a half of
 * one being left behind.
 *
 * ── Why this is not paranoia ────────────────────────────────────────────────
 *
 * This launcher has a **power menu**. "Turn off" is a first-class control on
 * the last screen anyone sees before the television goes dark, so `poweroff`
 * arriving in the middle of a write is not a hypothetical failure — it is a
 * documented feature of the product firing during ordinary use. `writeFile` is
 * truncate-then-write, and a truncated `settings.json` reads as no settings at
 * all: `sanitise` falls back to `DEFAULT_SETTINGS` on a parse error, so the
 * accent, the scale, the launch mode and the dismissed-update marker are simply
 * gone, and nothing on screen explains why.
 *
 * The same argument covers `recent.json` — the play history the Recent view is
 * made of — and, more cheaply, the two caches: `catalog.json` is four megabytes
 * and `details.json` seven, and a half-written one is four megabytes of nothing
 * that has to be re-walked anyway.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * Write a sibling, flush it, rename over the target. `rename(2)` within one
 * directory is atomic, so a reader sees either the old file or the new one and
 * never a prefix of either — the same guarantee, and for the same reason, that
 * `download.ts` gets from replacing the AppImage by rename rather than in place.
 *
 * **The flush is not optional and is why this is not three lines.** Without an
 * `fsync` on the temporary file, the rename can reach the disk before the bytes
 * do, which on a hard power cut leaves the directory entry pointing at a file
 * of zeroes — a *worse* outcome than the truncation this exists to prevent,
 * because the old copy is gone too.
 *
 * The temporary name carries the pid so two processes cannot collide on it, and
 * is dotted so a half-written cache is not offered by a file manager.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`)

  await mkdir(directory, { recursive: true })

  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(temporary, path)
  } catch (error) {
    // The target is untouched on every path that reaches here, so the only
    // thing to clean up is our own sibling.
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
