/**
 * Fetching a release artefact onto this disk, verified.
 *
 * One caller — the AppImage update path — and the whole file exists to make
 * that one caller safe. Overwriting the launcher's own executable is the single
 * most destructive thing in this codebase: get it wrong on a machine with no
 * keyboard and there is no launcher and no way to start one. So three rules,
 * and none of them is optional.
 *
 * **Nothing is installed unverified.** The asset's sha256 comes from the GitHub
 * API and the bytes are hashed as they arrive. A mismatch — or a missing digest
 * — deletes the download and reports; it never reaches the destination.
 *
 * **The old file is only replaced by a `rename`.** Same filesystem, so it is
 * atomic: either the old AppImage is there or the new one is, and there is no
 * instant where the path holds half a download. Replacing a *running* AppImage
 * this way is safe on Linux — the runtime holds the mount open on the inode,
 * which `rename` does not touch — and it is what AppImageUpdate does.
 *
 * **A stalled transfer ends.** See `STALL_TIMEOUT_MS`.
 */

import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { access, chmod, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type { UpdateProgress } from '@shared/types'
import type { ReleaseAsset } from './release'

/**
 * How long the transfer may go without receiving a byte.
 *
 * The second timeout in the launcher, and `statuspage.ts` — which documents
 * itself as the first — is the precedent this cites. Its reasoning applies here
 * exactly: this is a control the user just pressed, on a screen with no
 * keyboard, and a progress bar that stops moving forever is the failure nobody
 * can diagnose from a sofa.
 *
 * It is an *inactivity* timeout rather than a total one, which is the
 * difference from that precedent and the reason it cannot simply be
 * `AbortSignal.timeout`: that aborts the whole operation including the body, so
 * any total figure generous enough for 130 MB on a slow line would be far too
 * long to notice a dead connection.
 */
const STALL_TIMEOUT_MS = 45_000

/** Progress is pushed at most this often. A byte count per chunk would be a flood. */
const PROGRESS_INTERVAL_MS = 200

/** Mode of the finished file: executable, because it is the launcher. */
const EXECUTABLE_MODE = 0o755

export class DownloadError extends Error {}

/**
 * Downloads an asset beside its destination and swaps it in.
 *
 * The temporary file is a sibling of the target rather than in `/tmp`, for two
 * reasons: `rename` across filesystems fails with EXDEV, and a 130 MB write into
 * a tmpfs is a 130 MB write into RAM. Its name is dotted so a half-finished
 * download is not offered by a file manager, and it is removed on every failure
 * path.
 */
export async function downloadAndReplace(
  asset: ReleaseAsset,
  destination: string,
  onProgress: (progress: UpdateProgress) => void
): Promise<void> {
  if (!asset.sha256) {
    throw new DownloadError(
      `${asset.name} was published without a checksum, so it cannot be verified. Install it by hand from the release page.`
    )
  }

  const temporary = join(dirname(destination), `.${asset.name}.part`)

  try {
    const digest = await fetchToFile(asset, temporary, onProgress)

    onProgress({ phase: 'verifying', percent: 100, receivedBytes: asset.bytes, totalBytes: asset.bytes })
    if (digest !== asset.sha256) {
      throw new DownloadError(
        'The download does not match the checksum GitHub published for it, so it was discarded.'
      )
    }

    onProgress({ phase: 'installing', percent: 100, receivedBytes: asset.bytes, totalBytes: asset.bytes })
    // Before the rename, not after: a file that is in place but not executable
    // is a launcher that will not start, and there is no window between the two
    // in which anything could try.
    await chmod(temporary, EXECUTABLE_MODE)
    await rename(temporary, destination)
  } catch (error) {
    // Nothing has been swapped in at any point this can be reached from, so the
    // machine is exactly as it was.
    await rm(temporary, { force: true }).catch(() => {})
    throw error instanceof DownloadError
      ? error
      : new DownloadError(error instanceof Error ? error.message : String(error))
  }
}

/** Streams the body to `path`, hashing and reporting as it goes. Returns the hex digest. */
async function fetchToFile(
  asset: ReleaseAsset,
  path: string,
  onProgress: (progress: UpdateProgress) => void
): Promise<string> {
  const controller = new AbortController()
  let stall: NodeJS.Timeout | null = null
  const resetStall = (): void => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(() => controller.abort(new DownloadError(STALLED)), STALL_TIMEOUT_MS)
  }

  resetStall()
  try {
    const response = await fetch(asset.url, {
      signal: controller.signal,
      // GitHub's API requires one; the CDN redirect does not care, but the
      // request starts at api.github.com's `browser_download_url` host.
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' }
    })

    if (!response.ok || !response.body) {
      throw new DownloadError(`${asset.name} could not be downloaded (HTTP ${response.status}).`)
    }

    // The asset's own `size`, not `content-length`: the length can be absent
    // behind a redirect, and the API already told us exactly how big this is.
    const total = asset.bytes || Number(response.headers.get('content-length') ?? 0)
    const hash = createHash('sha256')
    let received = 0
    let lastReport = 0

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        resetStall()
        hash.update(chunk)
        received += chunk.byteLength
        const now = Date.now()
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          onProgress(downloadProgress(received, total))
        }
        callback(null, chunk)
      }
    })

    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(path))
    onProgress(downloadProgress(received, total))

    // A truncated body that ends cleanly is a real outcome — a proxy closing
    // mid-transfer — and the digest below would catch it anyway. Saying which
    // of the two happened is worth the four lines.
    if (total > 0 && received !== total) {
      throw new DownloadError(
        `The download ended early: ${received} of ${total} bytes. Check the connection and try again.`
      )
    }

    return hash.digest('hex')
  } catch (error) {
    if (controller.signal.aborted) throw new DownloadError(STALLED)
    throw error
  } finally {
    if (stall) clearTimeout(stall)
  }
}

const STALLED = 'The download stopped receiving data. Check the connection and try again.'

/**
 * A download report carrying both counts.
 *
 * `percent` is filled in here rather than left to the renderer, because the two
 * update paths measure differently — flatpak reports a percentage and no bytes
 * — and the notice should not have to know which one it is looking at.
 */
function downloadProgress(received: number, total: number): UpdateProgress {
  return {
    phase: 'downloading',
    percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
    receivedBytes: received,
    totalBytes: total
  }
}

/**
 * Identifies the launcher to GitHub.
 *
 * Not the compliance ritual it is for NVIDIA's game list, where a missing
 * `User-Agent` drops the connection with no status at all — GitHub simply asks
 * for one. Kept anyway so a rate-limited request is attributable to something.
 */
export const USER_AGENT = 'gfn-launcher (+https://github.com/robertotucci/gfnlauncher)'

/**
 * Whether this process could actually overwrite the AppImage.
 *
 * Checked before the button is offered rather than after it is pressed: an
 * AppImage in `/opt`, or one owned by another user, is a perfectly ordinary
 * installation and the honest thing is to say so up front instead of
 * downloading 130 MB and then failing at the rename.
 *
 * The *directory* is what has to be writable, not the file: `rename` replaces a
 * directory entry, and a read-only file in a writable directory can still be
 * replaced.
 */
export async function canReplace(path: string): Promise<boolean> {
  try {
    await stat(path)
    await access(dirname(path), constants.W_OK)
    return true
  } catch {
    return false
  }
}
