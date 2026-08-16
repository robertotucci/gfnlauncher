/**
 * Which glyph set the footer legend speaks.
 *
 * Not a hardware fact: it is whatever the user last touched. A pad left
 * connected but idle while someone types must not have the legend naming
 * buttons nobody is pressing — across a dim room the legend is the only
 * instruction manual there is, so it has to describe the device in hand.
 */
export type InputScheme = 'keyboard' | 'xbox' | 'playstation'

export type PadScheme = Exclude<InputScheme, 'keyboard'>

/**
 * Sony's USB vendor id. Chromium appends "Vendor: xxxx Product: yyyy" to the
 * pad id on Linux, and that is the sturdiest part of the string: a clone can
 * call itself anything, but a pad wired like a DualShock reports Sony's id.
 */
const SONY_VENDOR = '054c'

/** Fallback for the pads that arrive without a vendor id (some BT stacks). */
const PLAYSTATION_NAMES = /dual\s?(shock|sense)|playstation|\bps[345]\b|\bsony\b/i

/**
 * Xbox is the default because the W3C standard layout is named after it: an
 * unidentifiable pad is far likelier to be an Xbox-labelled clone than a Sony
 * one, and A/B/X/Y is already what the button indices mean.
 */
export function detectPadScheme(id: string): PadScheme {
  const vendor = /vendor:\s*([0-9a-f]{4})/i.exec(id)?.[1]?.toLowerCase()
  if (vendor === SONY_VENDOR || PLAYSTATION_NAMES.test(id)) return 'playstation'
  return 'xbox'
}
