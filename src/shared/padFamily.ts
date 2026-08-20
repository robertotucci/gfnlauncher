import type { PadIdentity } from './padLayout'

/**
 * What the buttons on the pad in somebody's hands are *called*.
 *
 * ── The distinction this file rests on ──────────────────────────────────────
 *
 * A family changes the glyphs and never the meanings. The launcher's button map
 * is **positional** — bottom confirms, right goes back, left searches, top opens
 * settings — and so is the kernel's: `BTN_SOUTH` is the bottom button on every
 * pad ever made, including the ones where it is printed **B**. So a Switch pad
 * is relabelled here and remapped nowhere, which is what Steam and the rest of
 * the Linux desktop do, and what means the same thumb movement works whichever
 * pad somebody picks up.
 *
 * ── Why it is shared ────────────────────────────────────────────────────────
 *
 * Three surfaces need the same answer and none of them can ask another: the
 * launcher's own footer legend, the cursor hint the bridgeless preload draws
 * into NVIDIA's page, and the badges printed on the keys of both on-screen
 * keyboards. They used to hold three private copies of "X is space", which is
 * why a DualSense was told to press X and Y for a keyboard that has neither.
 */
export type PadFamily = 'xbox' | 'playstation' | 'nintendo'

export const PAD_FAMILIES: readonly PadFamily[] = ['xbox', 'playstation', 'nintendo']

export function isPadFamily(value: unknown): value is PadFamily {
  return typeof value === 'string' && (PAD_FAMILIES as readonly string[]).includes(value)
}

/**
 * Sony's and Nintendo's USB vendor ids.
 *
 * **Two rows and no more, deliberately.** A vendor table looks like the sturdy
 * answer and is not: 8BitDo, Hori, PowerA and Razer each ship pads of all three
 * shapes under one id, so a row for any of them would be wrong for half their
 * catalogue. These two make only their own layout, which is what makes the id
 * evidence rather than a guess.
 */
const SONY_VENDOR = '054c'
const NINTENDO_VENDOR = '057e'

/** For the stacks that hand over a pad with no vendor id at all. */
const PLAYSTATION_NAMES = /dual\s?(shock|sense)|playstation|\bps[345]\b|\bsony\b|nacon|raiju/i

/**
 * "Pro" on its own is not enough — an 8BitDo Pro 2 is an Xbox-layout pad — so
 * this wants the phrase.
 */
const NINTENDO_NAMES = /nintendo|switch\s?pro|joy-?con|pro controller/i

/**
 * Xbox is the default because the W3C standard layout is named after it: an
 * unidentifiable pad is far likelier to be an Xbox-labelled clone than anything
 * else, and A/B/X/Y is already what the button positions mean.
 */
export function detectPadFamily(identity: PadIdentity): PadFamily {
  if (identity.vendor === SONY_VENDOR) return 'playstation'
  if (identity.vendor === NINTENDO_VENDOR) return 'nintendo'
  if (PLAYSTATION_NAMES.test(identity.name)) return 'playstation'
  if (NINTENDO_NAMES.test(identity.name)) return 'nintendo'
  return 'xbox'
}

/**
 * One family for a room with more than one pad in it.
 *
 * Agree, or fall back to Xbox. The footer legend can afford to follow whichever
 * pad was touched last, because it is redrawn sixty times a second; the badge
 * printed on a keycap cannot, since it is pushed to a window that has no idea a
 * second controller exists. Naming one of two disagreeing pads would be a
 * legend that is wrong for whoever is holding the other one, and the neutral
 * answer is the layout every other pad is a relabelling of.
 */
export function padFamilyOf(identities: readonly PadIdentity[]): PadFamily {
  const families = new Set(identities.map(detectPadFamily))
  const only = [...families]
  return only.length === 1 && only[0] ? only[0] : 'xbox'
}

/** The seven buttons anything in this launcher ever names. */
export type PadButton = 'south' | 'east' | 'west' | 'north' | 'lb' | 'rb' | 'start'

/**
 * What each family prints on each of them.
 *
 * **These are drawn as text, so the characters have to exist in whatever font
 * the machine has.** That is the same rule that turned the footer's PlayStation
 * shapes into Lucide icons: a face font with no `△` in it renders tofu, and the
 * launcher has to be readable offline on whatever it shipped with. `○ □ △` are
 * Geometric Shapes, which DejaVu Sans covers and the Flatpak runtime ships;
 * `×` is **U+00D7 MULTIPLICATION SIGN**, in Latin-1 and therefore in
 * everything, and not U+2715, which is Dingbats and is not safe. `☰` already
 * ships on these keycaps, so it is precedent rather than new risk.
 *
 * L3 and R3 are deliberately absent: nothing prints them, and an unread entry
 * is one more thing to keep true.
 */
export const PAD_BUTTON_NAMES: Readonly<Record<PadFamily, Readonly<Record<PadButton, string>>>> = {
  xbox: { south: 'A', east: 'B', west: 'X', north: 'Y', lb: 'LB', rb: 'RB', start: '☰' },
  playstation: { south: '×', east: '○', west: '□', north: '△', lb: 'L1', rb: 'R1', start: '☰' },
  nintendo: { south: 'B', east: 'A', west: 'Y', north: 'X', lb: 'L', rb: 'R', start: '+' }
}

/** One button's name on one family, for the callers that want just the one. */
export function padButtonName(family: PadFamily, button: PadButton): string {
  return PAD_BUTTON_NAMES[family][button]
}
