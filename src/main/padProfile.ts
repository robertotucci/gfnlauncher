import { readFileSync, readdirSync } from 'node:fs'
import {
  XPAD_LAYOUT,
  joydevLayout,
  parseCapabilityBitmap,
  transportOf,
  type PadProfile
} from '@shared/padLayout'

/**
 * Asking `/sys` what each pad on this machine actually is.
 *
 * ── Why it is here and not in the evdev reader ──────────────────────────────
 *
 * It was there, and it now has three consumers rather than one: the reader
 * itself, the `pad:list` channel the renderer pulls, and the snapshot the
 * pointer preload is handed on `pointer:restore`. The rule that says
 * `pointer/evdev.ts` must keep exactly one consumer is about the thing that
 * reads a *live* pad while a game is on screen. **This module opens nothing.**
 * It has no loop, no stream and no timer; the worst a bug in it can do is
 * describe a pad wrongly, and every caller of it falls back rather than acting
 * on a description it cannot verify.
 *
 * ── Why it enumerates /sys rather than /dev/input ───────────────────────────
 *
 * The evdev reader lists `/dev/input` because it has to *open* the node.
 * Nothing here does, and `/sys/class/input` carries the same `js*` entries — so
 * the profiles survive a sandbox that has had `--device=all` revoked, where the
 * nodes are there and unopenable. That is the configuration `padAccess.ts`
 * exists to explain, and a launcher that can still say "this is a DualSense on
 * Bluetooth" while it cannot read the pad is a launcher whose log answers the
 * question.
 */

const SYSFS_INPUT = '/sys/class/input'
const JS_NODE = /^js\d+$/

/**
 * `unsigned long`, which is what the kernel prints the capability bitmaps in.
 *
 * A 32-bit process reading them on a 64-bit kernel gets `in_compat_syscall()`,
 * and the kernel splits each long into two 32-bit halves for it — so the width
 * follows *our* build rather than the machine's. It lives here rather than in
 * `@shared/padLayout` because two of that module's three importers have no
 * `process` to ask.
 */
export const CAPABILITY_WORD_BITS =
  process.arch === 'ia32' || process.arch === 'arm' ? 32 : 64

/** One attribute, or `''`. A missing file is an ordinary answer here. */
function attribute(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Everything one node can say about itself.
 *
 * Never null: a pad that is present but unreadable still has to be describable,
 * because the evdev reader has already opened its stream by the time it asks
 * and something has to be assumed for it. `resolved` is how the caller — and
 * the Devices screen — tells the two apart, and `'assumed'` is the state worth
 * a line in the log, since it is the one where a button can be wrong.
 */
export function padProfileFor(node: string, root = SYSFS_INPUT): PadProfile {
  const device = `${root}/${node}/device`
  const keys = parseCapabilityBitmap(attribute(`${device}/capabilities/key`), CAPABILITY_WORD_BITS)
  const abs = parseCapabilityBitmap(attribute(`${device}/capabilities/abs`), CAPABILITY_WORD_BITS)
  const layout = joydevLayout(keys, abs)
  // A device with no buttons or no axes is not one this can describe, and an
  // empty layout is also what a bitmap we failed to parse looks like. Either
  // way it is not an answer, and half a layout is a shifted one.
  const known = layout.buttons.length > 0 && layout.axes.length > 0

  return {
    node,
    name: attribute(`${device}/name`) || 'unnamed',
    vendor: attribute(`${device}/id/vendor`).toLowerCase(),
    product: attribute(`${device}/id/product`).toLowerCase(),
    transport: transportOf(Number.parseInt(attribute(`${device}/id/bustype`), 16)),
    resolved: known ? 'kernel' : 'assumed',
    buttons: known ? layout.buttons : XPAD_LAYOUT.buttons,
    axes: known ? layout.axes : XPAD_LAYOUT.axes
  }
}

/** Every joystick node present right now. Empty is the normal case at boot. */
export function listPadProfiles(root = SYSFS_INPUT): PadProfile[] {
  let nodes: string[]
  try {
    nodes = readdirSync(root)
      .filter((name) => JS_NODE.test(name))
      .sort()
  } catch {
    // No /sys/class/input, or no permission. Both mean "nothing to describe",
    // which every caller has to survive rather than report.
    return []
  }

  return nodes.map((node) => padProfileFor(node, root))
}
