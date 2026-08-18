import { describe, expect, it } from 'vitest'
import { deployPointerPaths, markMoved, type FileMark } from './clientWatch'

/** What `fileMark` produces for a path Node reported as missing. */
const ABSENT: FileMark = { present: false, ino: 0, mtimeMs: 0, size: 0 }

function mark(overrides: Partial<FileMark> = {}): FileMark {
  return { present: true, ino: 1361287, mtimeMs: 1787086989000, size: 40, ...overrides }
}

describe('markMoved', () => {
  it('reads the client being uninstalled as a change', () => {
    // The assertion this function exists for. `streamLog.ts` skips zeroed stats
    // outright, because for a log they only ever mean "not written yet"; copied
    // here that guard would leave the launcher reporting a client that is gone.
    expect(markMoved(mark(), ABSENT)).toBe(true)
  })

  it('reads the client being installed while we run as a change', () => {
    expect(markMoved(ABSENT, mark())).toBe(true)
  })

  it('reads the deploy pointer moving to a new commit as a change', () => {
    // The whole feature: `active` is repointed by the update, and stat follows
    // it, so the new commit directory arrives as a new inode.
    expect(markMoved(mark(), mark({ ino: 1361999 }))).toBe(true)
  })

  it('reads a file rewritten in place as a change', () => {
    // `sharedstorage.json` keeps its inode across a plain rewrite, so neither
    // mtime nor size may be left out of the comparison.
    expect(markMoved(mark(), mark({ mtimeMs: 1787090000000 }))).toBe(true)
    expect(markMoved(mark(), mark({ size: 12975 }))).toBe(true)
  })

  it('reads a first sighting of a path that is there as a change', () => {
    // The regression that made this whole feature look broken. `watchFile`
    // stays silent when it arms against a path that exists — it keeps that stat
    // as its own baseline — so the listener running with nothing recorded can
    // only mean the file has *just changed* for the first time. Treating that
    // as a baseline swallows exactly one change per path per run, which for a
    // launcher started once and a datacenter changed once is every change there
    // is.
    expect(markMoved(null, mark())).toBe(true)
  })

  it('does not treat arming against a missing client as news', () => {
    // The other way the listener runs with nothing recorded: Node's documented
    // single zeroed call for a path that is not there. GeForce NOW is not
    // installed, which is not an event.
    expect(markMoved(null, ABSENT)).toBe(false)
  })

  it('says nothing about a tick with nothing behind it', () => {
    expect(markMoved(mark(), mark())).toBe(false)
    expect(markMoved(ABSENT, ABSENT)).toBe(false)
  })
})

describe('deployPointerPaths', () => {
  it('names both installation roots, per-user first', () => {
    // These two strings must agree with the `--filesystem=…:ro` grants in
    // flatpak/io.github.robertotucci.GfnLauncher.yml. A wrong one produces no
    // error and no log line — the watch simply never fires — which is why it is
    // pinned here rather than left to the manual checks.
    expect(deployPointerPaths('/home/somebody')).toEqual([
      '/home/somebody/.local/share/flatpak/app/com.nvidia.geforcenow/current/active',
      '/var/lib/flatpak/app/com.nvidia.geforcenow/current/active'
    ])
  })
})
