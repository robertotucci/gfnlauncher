/**
 * Notices — the launcher telling the user something it decided on its own.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Pointer mode is the launcher's most silent feature. Holding L3 + R3 flips a
 * mode read from `/dev/input/js*` in the main process, and the only feedback is
 * a cursor appearing — or *not* appearing, when the setting is off, when the
 * portal refuses, or when one of our own windows took the pointer instead. From
 * three metres those two are the same picture, and a control that silently does
 * nothing is the one failure nobody on a sofa can diagnose.
 *
 * ── The shape, and why the whole lifecycle is here ──────────────────────────
 *
 * Main owns the queue and pushes the *rendered list* to whichever surface has
 * the screen; the surfaces are presentational and hold no timers. That is what
 * lets the same notice cross from the launcher's own window to the overlay that
 * draws over a game without either one having to know the other exists.
 *
 * So `stepNotices` is a pure fold over the whole life of a notice — appear,
 * hold, leave, go — for the same reason `stepPad`, `stepChord` and
 * `stepHandback` are: the suite has no DOM and no Electron, and this is the
 * only way any of it is assertable. `leaving` is part of the pushed state
 * rather than something a component works out, because the exit animation has
 * to play in a window main is about to hide.
 *
 * Pure, no Node and no DOM: this compiles into all three bundles.
 */

/**
 * The kinds of hardware a notice can be about.
 *
 * `BluetoothKind` in `@shared/types` is an alias of this rather than a second
 * copy of the list — the Devices screen's vocabulary turned out to be the right
 * one for a card about a controller that arrived over USB, and two lists of the
 * same ten words is exactly the shape this codebase keeps saying not to write.
 * The name moved here because this is the module that is not about Bluetooth.
 */
export type DeviceKind =
  | 'gamepad'
  | 'keyboard'
  | 'mouse'
  | 'headset'
  | 'headphones'
  | 'speaker'
  | 'display'
  | 'computer'
  | 'phone'
  | 'unknown'

/**
 * What happened, with whatever the sentence needs and nothing else.
 *
 * A union rather than a bare kind plus optional fields, so a device notice
 * cannot be raised without a device to name — the wording is generated, and a
 * card reading "undefined connected" is the one failure mode a copy table has.
 */
export type Announcement =
  | { readonly kind: 'pointer-on' }
  | { readonly kind: 'pointer-off' }
  | { readonly kind: 'device-connected'; readonly name: string; readonly device: DeviceKind }
  | { readonly kind: 'device-disconnected'; readonly name: string; readonly device: DeviceKind }

/**
 * Which icon to draw, as an id rather than a component.
 *
 * `@shared` has to stay free of DOM types, so the Lucide mapping lives in the
 * renderer and this is the vocabulary the two agree on.
 */
export type NoticeIcon =
  | 'pointer'
  | 'pointer-off'
  | 'gamepad'
  | 'keyboard'
  | 'mouse'
  | 'headphones'
  | 'speaker'
  | 'display'
  | 'computer'
  | 'phone'
  | 'device'

export interface Notice {
  /** Monotonic within a run. The React key, and how main finds one again. */
  readonly id: number
  /**
   * Notices sharing a group replace each other rather than stacking.
   *
   * Pointer on and pointer off are one group: toggling the mode twice in three
   * seconds is the everyday case, and two cards is the wrong answer to it.
   */
  readonly group: string
  readonly title: string
  /** The second line, or nothing. Names the way out where there is one. */
  readonly hint: string | null
  readonly icon: NoticeIcon
  /** Its time is up and the surface is playing the exit. Set by main. */
  readonly leaving: boolean
  /** Monotonic ms at which this notice's next transition is due. */
  readonly dueAt: number
}

/** How long a notice is readable for before it starts to go. */
export const NOTICE_MS = 3_500

/**
 * How long the exit animation has.
 *
 * Deliberately a shared constant rather than a duration only the stylesheet
 * knows: main is what removes the notice, so the two have to agree or the card
 * is unmounted mid-slide. It matches the 150 ms `animate-out` in `NoticeStack`
 * with a frame's slack.
 */
export const NOTICE_EXIT_MS = 180

/**
 * How many can be on screen at once.
 *
 * Three, because the fourth is not read — this is a television at three metres,
 * not a desktop notification tray — and because the overlay window on X11 is
 * sized to hold exactly this many.
 */
export const NOTICE_MAX = 3

/** Everything about a notice except its identity and where it is in its life. */
export type NoticeContent = Pick<Notice, 'group' | 'title' | 'hint' | 'icon'>

/**
 * What each kind of device is called in a sentence, and which glyph it wears.
 *
 * "Controller" rather than "gamepad", because that is the word the Settings
 * screen and the footer already use. `unknown` is a real answer rather than a
 * gap: BlueZ hands out no icon for most Low Energy hardware on first sight, and
 * "Device connected" beside its name is still the whole of what happened.
 */
const DEVICE_NOUNS: Record<DeviceKind, { readonly noun: string; readonly icon: NoticeIcon }> = {
  gamepad: { noun: 'Controller', icon: 'gamepad' },
  keyboard: { noun: 'Keyboard', icon: 'keyboard' },
  mouse: { noun: 'Mouse', icon: 'mouse' },
  headset: { noun: 'Headset', icon: 'headphones' },
  headphones: { noun: 'Headphones', icon: 'headphones' },
  speaker: { noun: 'Speaker', icon: 'speaker' },
  display: { noun: 'Display', icon: 'display' },
  computer: { noun: 'Computer', icon: 'computer' },
  phone: { noun: 'Phone', icon: 'phone' },
  unknown: { noun: 'Device', icon: 'device' }
}

/**
 * What each announcement says.
 *
 * Pure and exported for the reason `launchFailureReason` is: wording that is
 * read from a sofa gets a test rather than an eyeball.
 *
 * **The device cards are grouped by name, not by which watcher saw it.** A
 * Bluetooth controller is seen twice — BlueZ says the link came up, and a
 * joystick node appears a moment later — and one device arriving is one card.
 * Grouping on the name is what collapses them without either watcher having to
 * know the other exists; when the two names disagree the cost is two true cards
 * rather than a wrong one. It is also what makes a disconnect *replace* that
 * device's connect card instead of stacking under it.
 */
export function noticeContent(what: Announcement): NoticeContent {
  switch (what.kind) {
    case 'pointer-on':
      return {
        group: 'pointer',
        title: 'Pointer on',
        // The chord is the one thing about pointer mode nobody discovers by
        // accident, and it is the same chord both ways.
        hint: 'Hold L3 + R3 to put it away',
        icon: 'pointer'
      }
    case 'pointer-off':
      return {
        group: 'pointer',
        title: 'Pointer off',
        hint: 'Hold L3 + R3 to bring it back',
        icon: 'pointer-off'
      }
    case 'device-connected':
    case 'device-disconnected': {
      const { noun, icon } = DEVICE_NOUNS[what.device]
      const state = what.kind === 'device-connected' ? 'connected' : 'disconnected'

      return {
        group: deviceGroup(what.name),
        title: `${noun} ${state}`,
        // The name is the hint rather than the title because it is the part
        // that varies without meaning anything at a glance: "Headphones
        // connected" is the sentence, and `WH-1000XM4` is which ones.
        hint: what.name,
        icon
      }
    }
  }
}

/** One device, however many watchers saw it. See `noticeContent`. */
export function deviceGroup(name: string): string {
  return `device:${name.trim().toLowerCase()}`
}

/** A notice arriving, or the clock reaching one of the deadlines below. */
export type NoticeEvent = { readonly kind: 'show'; readonly notice: Notice } | { readonly kind: 'tick' }

export interface NoticeStep {
  readonly next: Notice[]
  /**
   * When to tick next, or `null` when there is nothing left to wait for.
   *
   * The earliest deadline across the list, so main arms exactly one timer for
   * the whole queue rather than one per notice — and disarms it outright when
   * this is `null`, instead of spinning at some interval over an empty list.
   */
  readonly dueAt: number | null
}

/**
 * One fold over the queue.
 *
 * Three rules, and the first is the one that is easy to get wrong:
 *
 * - **A replacement drops its predecessor outright** rather than setting it
 *   `leaving`. Both cards occupy the same coordinates, so an exit playing under
 *   an entrance is two overlapping rectangles sliding in opposite directions.
 * - A notice past its `dueAt` turns `leaving` and gets `NOTICE_EXIT_MS` more; a
 *   `leaving` notice past its `dueAt` is gone.
 * - Over `NOTICE_MAX` the **oldest** goes, because the newest is the one the
 *   user just caused.
 */
export function stepNotices(
  live: readonly Notice[],
  event: NoticeEvent,
  now: number
): NoticeStep {
  const next =
    event.kind === 'show'
      ? [...live.filter((notice) => notice.group !== event.notice.group), event.notice].slice(
          -NOTICE_MAX
        )
      : live
          .map((notice) => {
            if (now < notice.dueAt) return notice
            if (notice.leaving) return null
            return { ...notice, leaving: true, dueAt: now + NOTICE_EXIT_MS }
          })
          .filter((notice): notice is Notice => notice !== null)

  return { next, dueAt: earliest(next) }
}

function earliest(notices: readonly Notice[]): number | null {
  let soonest: number | null = null
  for (const notice of notices) {
    if (soonest === null || notice.dueAt < soonest) soonest = notice.dueAt
  }
  return soonest
}
