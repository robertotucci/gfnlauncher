/**
 * What each numbered button on a pad actually is, and how to ask.
 *
 * ── Why this is shared rather than a detail of the evdev reader ─────────────
 *
 * It began as one: `src/main/pointer/evdev.ts` needed it because joydev numbers
 * the buttons a device *declares*, so the stick clicks are 9 and 10 on an Xbox
 * pad over USB, 13 and 14 on the same pad over Bluetooth and 11 and 12 on a
 * DualSense. That is written out at length there and in ARCHITECTURE.md.
 *
 * The browser turns out to have the same problem, and the same answer.
 * Chromium's Linux gamepad fetcher reads `/dev/input/js*` too, and applies a
 * **standard** layout only to the pads whose vendor and product ids are in its
 * own table (`gamepad_standard_mappings_linux.cc`). For everything else —
 * no-name USB pads, a good many third-party PlayStation-shaped ones, some
 * models over some transports — `Gamepad.mapping` is `""` and the indices are
 * joydev's own. Which is exactly the numbering `joydevLayout` below reproduces.
 *
 * So the same capability bitmaps answer both questions, and the vocabulary sits
 * where all three processes can reach it. **This module opens nothing and reads
 * nothing.** It is codes, orderings and pure translation; `src/main/padProfile.ts`
 * is what goes to `/sys` for the numbers, and `openPadReader` is still the only
 * thing in the repository that opens a device.
 */

// ── The kernel's own codes, from `linux/input-event-codes.h` ────────────────

/**
 * These are what a device *declares*, and they are the stable half: BTN_THUMBL
 * is 0x13d on every pad, every driver and every transport. The joydev **index**
 * it then arrives on is not stable at all, which is what the rest of this file
 * is about.
 *
 * **Do not reach for the compass aliases to check these.** The header defines
 * 0x133 as `BTN_NORTH` *and* as `BTN_X`, and 0x134 as `BTN_WEST` *and* as
 * `BTN_Y` — backwards from where those two are printed on an Xbox pad, where X
 * is the western button and Y the northern one. The letters are right, the
 * compass is a historical mistake the kernel cannot now correct, and everything
 * here uses the numbers so neither can mislead anybody.
 */
export const EV_KEY = {
  a: 0x130,
  b: 0x131,
  x: 0x133,
  y: 0x134,
  lb: 0x136,
  rb: 0x137,
  lt: 0x138,
  rt: 0x139,
  select: 0x13a,
  start: 0x13b,
  mode: 0x13c,
  l3: 0x13d,
  r3: 0x13e
} as const

export const EV_ABS = {
  x: 0x00,
  y: 0x01,
  z: 0x02,
  rx: 0x03,
  ry: 0x04,
  rz: 0x05,
  hat0x: 0x10,
  hat0y: 0x11
} as const

/**
 * The d-pad codes for a pad that reports it as four buttons.
 *
 * Most report it as a pair of hat *axes* and these are unused; a DualSense on
 * `hid-playstation` reports it as BTN_DPAD_UP…RIGHT, which arrive as four more
 * joydev buttons after the gamepad block. Both have to fold to the same answer
 * or the on-screen keyboard is undrivable on half the pads in the room.
 */
export const EV_DPAD = { up: 0x220, down: 0x221, left: 0x222, right: 0x223 } as const

/** joydev's two ranges, in the order it walks them. From `joydev.c`. */
const BTN_MISC = 0x100
const BTN_JOYSTICK = 0x120
const KEY_MAX = 0x2ff
const ABS_CNT = 0x40

// ── Reading the layout out of a capability bitmap ───────────────────────────

/** What one pad calls each joydev index. */
export interface PadLayout {
  /** The evdev key code at each joydev button index. */
  readonly buttons: readonly number[]
  /** The evdev abs code at each joydev axis index. */
  readonly axes: readonly number[]
}

const HEX_WORD = /^[0-9a-f]+$/i

/**
 * Reads one of the capability bitmaps a device publishes under sysfs.
 *
 * The format is a run of hex words, **most significant first**, and it has two
 * traps in it. Leading empty words are skipped entirely, so the word count
 * varies by device and cannot be used to locate anything; and the words that
 * are printed are not zero-padded, so `0` and `8000000000` are both one word.
 * Only the *last* word is at a known position — it is always word 0 — which is
 * why this indexes from the end.
 *
 * `wordBits` is an argument rather than a constant because the width follows
 * the *reading process*: a 32-bit build on a 64-bit kernel gets
 * `in_compat_syscall()` and the kernel splits each long in half for it. Main
 * passes `CAPABILITY_WORD_BITS`; this file cannot read `process.arch` because
 * two of the three contexts that import it have no `process`.
 */
export function parseCapabilityBitmap(text: string, wordBits = 64): Set<number> {
  const bits = new Set<number>()
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)

  for (let index = 0; index < words.length; index += 1) {
    const word = words[words.length - 1 - index]
    // A bitmap we cannot read is worse than none: it would produce a plausible
    // layout with everything shifted. Refuse the whole thing instead.
    if (!word || !HEX_WORD.test(word)) return new Set()

    // BigInt rather than Number: a single word carries 64 bits and the top one
    // of them is well past what a double can hold exactly.
    const value = BigInt(`0x${word}`)
    for (let bit = 0; bit < wordBits; bit += 1) {
      if ((value >> BigInt(bit)) & 1n) bits.add(index * wordBits + bit)
    }
  }

  return bits
}

/**
 * joydev's own ordering, from `joydev_connect()`.
 *
 * Buttons come in two passes: everything from BTN_JOYSTICK up, ascending, and
 * *then* the BTN_MISC block below it. The order is deliberate on the kernel's
 * part — it keeps a gamepad's face buttons at index 0 on a device that also
 * declares the older joystick codes. Axes are one pass, ascending, and the
 * d-pad is in there as a pair of axes rather than four buttons on most pads.
 */
export function joydevLayout(keys: Iterable<number>, abs: Iterable<number>): PadLayout {
  const ascending = (first: number, second: number): number => first - second
  const codes = [...keys].sort(ascending)

  return {
    buttons: [
      ...codes.filter((code) => code >= BTN_JOYSTICK && code <= KEY_MAX),
      ...codes.filter((code) => code >= BTN_MISC && code < BTN_JOYSTICK)
    ],
    axes: [...abs].filter((code) => code < ABS_CNT).sort(ascending)
  }
}

/**
 * What `xpad` produces, used when the capability bitmaps cannot be read.
 *
 * A guess, and named as one — but the *best* guess: it is the layout the evdev
 * reader assumed unconditionally until the Bluetooth case proved it was not
 * universal, so falling back to it can only leave a pad no worse off than
 * before. Every caller says so in the log rather than letting a cursor that
 * does not appear be the only symptom.
 */
export const XPAD_LAYOUT: PadLayout = {
  buttons: [
    EV_KEY.a,
    EV_KEY.b,
    EV_KEY.x,
    EV_KEY.y,
    EV_KEY.lb,
    EV_KEY.rb,
    EV_KEY.select,
    EV_KEY.start,
    EV_KEY.mode,
    EV_KEY.l3,
    EV_KEY.r3
  ],
  axes: [
    EV_ABS.x,
    EV_ABS.y,
    // ABS_Z is the left trigger here, not the right stick. Getting this wrong
    // once meant a cursor that drifted whenever a trigger rested off centre.
    EV_ABS.z,
    EV_ABS.rx,
    EV_ABS.ry,
    EV_ABS.rz,
    EV_ABS.hat0x,
    EV_ABS.hat0y
  ]
}

/** The joydev indices of two axes, or null when the device lacks either. */
export function axisIndices(
  layout: PadLayout,
  x: number,
  y: number
): { readonly x: number; readonly y: number } | null {
  const first = layout.axes.indexOf(x)
  const second = layout.axes.indexOf(y)
  return first === -1 || second === -1 ? null : { x: first, y: second }
}

/**
 * Where the right stick is, which is the only judgement call in this file.
 *
 * It is the same one SDL makes: **ABS_RX/ABS_RY when the device has both**,
 * which is where `xpad` and `hid-playstation` put it, and ABS_Z/ABS_RZ
 * otherwise, which is where an Xbox pad over Bluetooth puts it — that pad
 * spends ABS_RX and ABS_RY on nothing and its triggers on ABS_GAS and
 * ABS_BRAKE. Reading the pair the wrong way round means a page that scrolls
 * when a trigger is squeezed.
 *
 * One function rather than one per caller: the evdev reader and the browser
 * translation both need it, and two copies of this rule would disagree about
 * one pad and nobody would notice which.
 */
export function rightStick(layout: PadLayout): { readonly x: number; readonly y: number } | null {
  return axisIndices(layout, EV_ABS.rx, EV_ABS.ry) ?? axisIndices(layout, EV_ABS.z, EV_ABS.rz)
}

// ── One device, as main can describe it to the other two contexts ───────────

/** How the pad is attached. `other` covers virtual devices and odd buses. */
export type PadTransport = 'usb' | 'bluetooth' | 'other'

/** BUS_USB and BUS_BLUETOOTH, from `linux/input.h`. */
const BUS_USB = 0x03
const BUS_BLUETOOTH = 0x05

export function transportOf(bustype: number): PadTransport {
  if (bustype === BUS_USB) return 'usb'
  if (bustype === BUS_BLUETOOTH) return 'bluetooth'
  return 'other'
}

/**
 * Identity and layout for one `/dev/input/js*` node.
 *
 * Crosses the bridge and the pointer preload's channel, so it is plain data:
 * no `Set`, no class, nothing that does not survive structured clone.
 */
export interface PadProfile {
  /** `js0`. Named in the log so a wrong match can be traced to one device. */
  readonly node: string
  /** `/sys/class/input/<node>/device/name`. Never a secret. */
  readonly name: string
  /** Four lowercase hex digits, or `''` when `/sys` would not say. */
  readonly vendor: string
  readonly product: string
  readonly transport: PadTransport
  /** Whether the layout came from the kernel or from `XPAD_LAYOUT`. */
  readonly resolved: 'kernel' | 'assumed'
  /** `PadLayout`, inlined so a profile is one flat object on the wire. */
  readonly buttons: readonly number[]
  readonly axes: readonly number[]
}

export function layoutOfProfile(profile: PadProfile): PadLayout {
  return { buttons: profile.buttons, axes: profile.axes }
}

/**
 * The same shape a `Gamepad.id` parses to, from the kernel's side.
 *
 * So `detectPadFamily` is one function with two sources rather than two
 * functions that agree today: the renderer asks it about a string Chromium
 * built, and main asks it about the very files Chromium built that string from.
 */
export function identityOfProfile(profile: PadProfile): PadIdentity {
  return {
    name: profile.name,
    vendor: profile.vendor || null,
    product: profile.product || null,
    standard: false
  }
}

// ── Correlating one of Chromium's pads with one of those ────────────────────

/**
 * What Chromium's `Gamepad.id` says.
 *
 * The Linux fetcher builds it as `"<name> (STANDARD GAMEPAD Vendor: vvvv
 * Product: pppp)"`, dropping the middle phrase when it has no standard mapping
 * for the device. Every part of it is optional in practice — some stacks
 * produce a pad with no vendor id at all — so nothing here throws on a shape it
 * did not expect, it just answers null and the caller falls back.
 */
export interface PadIdentity {
  readonly name: string
  readonly vendor: string | null
  readonly product: string | null
  /** Chromium said `STANDARD GAMEPAD`, so the indices are the W3C ones. */
  readonly standard: boolean
}

const ID_SUFFIX = /\s*\(\s*(?:STANDARD GAMEPAD\s+)?Vendor:\s*[0-9a-f]{4}\s+Product:\s*[0-9a-f]{4}\s*\)\s*$/i

export function parsePadId(id: string): PadIdentity {
  const vendor = /vendor:\s*([0-9a-f]{4})/i.exec(id)?.[1]?.toLowerCase() ?? null
  const product = /product:\s*([0-9a-f]{4})/i.exec(id)?.[1]?.toLowerCase() ?? null

  return {
    name: id.replace(ID_SUFFIX, '').trim(),
    vendor,
    product,
    standard: /standard gamepad/i.test(id)
  }
}

function sameLayout(first: PadProfile, second: PadProfile): boolean {
  return (
    first.buttons.length === second.buttons.length &&
    first.axes.length === second.axes.length &&
    first.buttons.every((code, index) => code === second.buttons[index]) &&
    first.axes.every((code, index) => code === second.axes[index])
  )
}

/**
 * Which `/dev/input/js*` node is the pad the browser is describing.
 *
 * Vendor and product first, since they are what the kernel and Chromium both
 * read from the same place; the name second, for the stacks that produce an id
 * with no ids in it.
 *
 * **Ambiguity answers null unless it does not matter.** Two identical pads
 * produce one identity and two candidates, and the right answer is obvious
 * because their layouts are identical — so equal layouts resolve, and anything
 * else refuses. Guessing there would mean translating one pad's presses through
 * another pad's numbering, which is the exact bug this module exists to end.
 */
export function matchPadProfile(
  identity: PadIdentity,
  profiles: readonly PadProfile[]
): PadProfile | null {
  const byIds =
    identity.vendor && identity.product
      ? profiles.filter(
          (profile) => profile.vendor === identity.vendor && profile.product === identity.product
        )
      : []

  const candidates =
    byIds.length > 0
      ? byIds
      : identity.name
        ? profiles.filter((profile) => profile.name === identity.name)
        : []

  const first = candidates[0]
  if (!first) return null
  return candidates.every((profile) => sameLayout(first, profile)) ? first : null
}

// ── Making an unmapped pad look like a standard one ─────────────────────────

/**
 * The W3C standard layout, as evdev codes.
 *
 * Seventeen entries because that is what the specification defines, ending in
 * the guide button; nothing in this launcher reads past 15, but producing the
 * spec's shape means no caller has to know that.
 *
 * Six and seven are the analogue triggers, which most pads report as *axes*
 * rather than buttons — a pad without BTN_TL2/BTN_TR2 simply has no button
 * there, and that is honest. Nothing here reads the triggers, by the same rule
 * that keeps them out of `PadReading`.
 */
export const STANDARD_BUTTON_CODES: readonly number[] = [
  EV_KEY.a,
  EV_KEY.b,
  EV_KEY.x,
  EV_KEY.y,
  EV_KEY.lb,
  EV_KEY.rb,
  EV_KEY.lt,
  EV_KEY.rt,
  EV_KEY.select,
  EV_KEY.start,
  EV_KEY.l3,
  EV_KEY.r3,
  EV_DPAD.up,
  EV_DPAD.down,
  EV_DPAD.left,
  EV_DPAD.right,
  EV_KEY.mode
]

/** Which raw index each W3C index is on this pad. −1 where the pad has none. */
export interface StandardMap {
  /** One entry per `STANDARD_BUTTON_CODES` position. */
  readonly buttons: readonly number[]
  /** Left x, left y, right x, right y. */
  readonly axes: readonly number[]
  /** The hat pair, when the d-pad arrives as axes rather than buttons. */
  readonly hat: { readonly x: number; readonly y: number } | null
}

/** Nothing on this device answers to any W3C position. */
const NO_STANDARD_MAP: StandardMap = {
  buttons: STANDARD_BUTTON_CODES.map(() => -1),
  axes: [-1, -1, -1, -1],
  hat: null
}

/**
 * Whether this device is a gamepad at all.
 *
 * `BTN_SOUTH` is the definition rather than a heuristic: it is `BTN_GAMEPAD`
 * under another name, and a driver that declares it is telling the kernel this
 * is a pad. A flight stick declares `BTN_TRIGGER` instead — which joydev also
 * numbers **0**, the index a pad gives to A — and its throttle sits on ABS_Z at
 * full deflection for the whole of a session. Folded in as though it were a
 * pad, that trigger presses confirm and that throttle scrolls the page.
 *
 * This only ever applies to a device Chromium has *no* standard mapping for, so
 * it cannot silence a pad that works today.
 */
export function isGamepad(profile: PadProfile): boolean {
  return profile.buttons.includes(EV_KEY.a)
}

export function standardMap(profile: PadProfile): StandardMap {
  if (!isGamepad(profile)) return NO_STANDARD_MAP

  const layout = layoutOfProfile(profile)
  const left = axisIndices(layout, EV_ABS.x, EV_ABS.y)
  const right = rightStick(layout)
  const hat = axisIndices(layout, EV_ABS.hat0x, EV_ABS.hat0y)

  return {
    buttons: STANDARD_BUTTON_CODES.map((code) => profile.buttons.indexOf(code)),
    axes: [left?.x ?? -1, left?.y ?? -1, right?.x ?? -1, right?.y ?? -1],
    hat
  }
}

/**
 * Whether Chromium is really reporting this node's raw numbering.
 *
 * The premise of the whole translation is that an unmapped pad arrives with the
 * joydev indices the kernel gave it, which means the counts have to agree. They
 * do today, and this is what keeps that from being an assumption: a Chromium
 * that changed how it enumerates, a node matched to the wrong device, a pad
 * past Chromium's own length caps — all three arrive here as a mismatch, and
 * the caller then leaves the pad exactly as it treats it now.
 */
export function mapFits(profile: PadProfile, buttonCount: number, axisCount: number): boolean {
  return profile.buttons.length === buttonCount && profile.axes.length === axisCount
}

/**
 * A `Gamepad` reduced to plain data.
 *
 * `@shared` may not name DOM types — main's tsconfig has no DOM lib, and this
 * module is imported there — so each reader builds one of these in a line.
 */
export interface RawPad {
  readonly buttons: readonly boolean[]
  readonly axes: readonly number[]
}

export interface StandardReading {
  readonly buttons: readonly boolean[]
  readonly axes: readonly number[]
}

/** Past this a hat counts as pressed. joydev reports exactly ±1; this is slack. */
const HAT_THRESHOLD = 0.5

/**
 * Makes an unmapped pad look standard, so nothing downstream has to know.
 *
 * **A null map is the identity**, and that is the fail-open path: a pad
 * Chromium already mapped, a pad that matched no node, a pad whose counts did
 * not agree — all of them come through here untouched and are read exactly as
 * they were before any of this existed.
 *
 * The one thing it derives rather than moves is the d-pad. Most pads report it
 * as a pair of hat axes and the standard layout has it as four buttons, so
 * 12–15 are synthesised from the hat when the device declares no BTN_DPAD_*.
 * That is what keeps `DPAD_DIRECTIONS`, `BUTTON_ACTIONS` and the on-screen
 * keyboard's grid working verbatim on every pad in the room.
 */
export function standardReading(raw: RawPad, map: StandardMap | null): StandardReading {
  if (!map) return { buttons: raw.buttons, axes: raw.axes }

  const buttons = map.buttons.map((index) => (index === -1 ? false : (raw.buttons[index] ?? false)))
  const axes = map.axes.map((index) => (index === -1 ? 0 : (raw.axes[index] ?? 0)))

  if (map.hat) {
    const x = raw.axes[map.hat.x] ?? 0
    const y = raw.axes[map.hat.y] ?? 0
    // Or-ed rather than assigned: a pad that somehow declares both keeps
    // whichever of the two it is actually using.
    buttons[12] = buttons[12] || y <= -HAT_THRESHOLD
    buttons[13] = buttons[13] || y >= HAT_THRESHOLD
    buttons[14] = buttons[14] || x <= -HAT_THRESHOLD
    buttons[15] = buttons[15] || x >= HAT_THRESHOLD
  }

  return { buttons, axes }
}

// ── Deciding what to do with one pad the browser handed over ────────────────

/**
 * Everything above is *how* to translate; this last section is **whether** to,
 * which is the part with the failure modes in it. It is one function of five
 * arguments, called from the renderer's poll loop and from the bridgeless
 * preload's, because neither of those can be tested — the suite has no DOM and
 * no controller — and every branch is a judgement that can be wrong on
 * somebody's hardware. Each one names itself in `note`, which is the line the
 * log gets, so a pad behaving oddly is one grep rather than a guess.
 *
 * **Every branch fails open.** A null map is the identity, which is exactly how
 * this launcher read every pad before any of this existed: a pad that matches
 * nothing, a pad whose counts disagree and a machine with no `/sys` all come
 * out behaving as they do today rather than worse. The one thing taken *away*
 * is a device that declares no gamepad buttons, and that is the fix rather than
 * the risk — a flight stick's trigger is joydev index 0, which is the index
 * this launcher reads as confirm.
 */

/** Where the numbering being used came from. Drawn on the Devices screen. */
export type PadNumbering =
  /** Chromium mapped it; the indices are the W3C ones and nothing is derived. */
  | 'standard'
  /** Unmapped, and translated through what the kernel says this device is. */
  | 'kernel'
  /** Unmapped and unplaceable, so read as though it were standard. */
  | 'assumed'
  /** Not a controller. A joystick, a wheel, a pedal set — read as nothing. */
  | 'ignored'

export interface PadTranslation {
  /** Passed to `standardReading`. Null is the identity. */
  readonly map: StandardMap | null
  readonly numbering: PadNumbering
  readonly transport: PadTransport
  /** One sentence for the log, or null when there is nothing worth a line. */
  readonly note: string | null
}

const STANDARD: PadTranslation = {
  map: null,
  numbering: 'standard',
  transport: 'other',
  note: null
}

export function translatePad(
  id: string,
  mapped: boolean,
  buttonCount: number,
  axisCount: number,
  profiles: readonly PadProfile[]
): PadTranslation {
  const identity = parsePadId(id)
  const profile = matchPadProfile(identity, profiles)
  const name = identity.name || 'unnamed'

  // The overwhelming majority, and the cheapest branch: Chromium already did
  // this work and second-guessing it is how you break the pad that works.
  if (mapped) return { ...STANDARD, transport: profile?.transport ?? 'other' }

  if (!profile) {
    return {
      map: null,
      numbering: 'assumed',
      transport: 'other',
      note:
        `Pad "${name}" reports no standard mapping and matches no joystick node; ` +
        'assuming the standard layout, so some of its buttons may be wrong.'
    }
  }

  if (profile.resolved === 'assumed') {
    // The node is there and its capability bitmaps are not, so the only layout
    // main could offer is `XPAD_LAYOUT` — a guess. The evdev reader takes that
    // guess because it has no alternative; here there is one, and it is better:
    // leaving the pad standard is what the launcher did before any of this, and
    // shuffling its buttons through a layout nobody read is a way to make a pad
    // that half worked stop working.
    return {
      map: null,
      numbering: 'assumed',
      transport: profile.transport,
      note:
        `Pad "${name}" reports no standard mapping and ${profile.node}'s own numbering ` +
        'could not be read; assuming the standard layout, so some of its buttons may be wrong.'
    }
  }

  if (!mapFits(profile, buttonCount, axisCount)) {
    // The premise check. The whole translation rests on Chromium reporting the
    // kernel's own indices, which is true today and is not ours to guarantee —
    // so a disagreement about how many there are ends the matter here, and the
    // pad is read exactly as it was before any of this existed.
    return {
      map: null,
      numbering: 'assumed',
      transport: profile.transport,
      note:
        `Pad "${name}" reports ${buttonCount} buttons and ${axisCount} axes where ` +
        `${profile.node} declares ${profile.buttons.length} and ${profile.axes.length}; ` +
        'assuming the standard layout.'
    }
  }

  if (!isGamepad(profile)) {
    return {
      map: standardMap(profile),
      numbering: 'ignored',
      transport: profile.transport,
      note:
        `Pad "${name}" (${profile.node}) declares no gamepad buttons, so it is a ` +
        'joystick or a wheel rather than a controller and the launcher will not read it as one.'
    }
  }

  const map = standardMap(profile)
  return {
    map,
    numbering: 'kernel',
    transport: profile.transport,
    note:
      `Pad "${name}" reports no standard mapping; using ${profile.node}'s own numbering ` +
      `(${profile.buttons.length} buttons, ${profile.axes.length} axes, d-pad on ` +
      `${map.hat ? 'the hat' : 'its own buttons'}).`
  }
}
