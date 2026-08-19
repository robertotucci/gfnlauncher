/**
 * Types shared across the main, preload and renderer processes.
 *
 * This file is the IPC contract. It must stay free of Node and DOM imports so
 * that all three bundles can consume it.
 */

import type { BluetoothAction } from './bluetooth'
import type { ScreenOwnership } from './input'
import { DEFAULT_ACCENT, DEFAULT_UI_SCALE } from './theme'

/** A digital store that GeForce NOW can link to and sync a library from. */
export interface GameStore {
  /** Provider id as used by NVIDIA's Account Linking Service (ALS). */
  id: string
  label: string
}

export type GameAvailability = 'available' | 'maintenance' | 'unavailable'

export interface GfnGame {
  /**
   * NVIDIA catalog id: the variant the harvest picked, and the game's identity
   * everywhere in the launcher — focus ids, the details index, the cache key.
   *
   * It is also the default launch target, but not necessarily the final one:
   * `selectedVariantId` overrides it. Resolve a launch through
   * `resolveLaunchTarget` in `@shared/games` rather than reading this directly.
   */
  cmsId: string
  title: string
  /** Lowercased, punctuation-stripped title used for sorting and search. */
  sortName: string
  /** Optional slug passed through to the deep link when present. */
  shortName: string | null
  /** Set for DLC/edition variants that launch through a base game. */
  parentGameId: string | null
  publisher: string | null
  developer: string | null
  genres: string[]
  /**
   * The title ships ray tracing — NVIDIA's "RTX ON".
   *
   * A property of the game, not of the user, so unlike `owned` it reads the
   * same signed in or out and the badge is never conditional on the view.
   *
   * Collapsed from a per-*variant* fact: the feed flags editions, not titles,
   * and 17 of the 171 disagree across their stores. True when any edition is
   * ray-traced, which is how the GFN client resolves it. See `variantRtx`.
   */
  rtx: boolean
  /** Stores this title can be played from, and whether the user owns it there. */
  stores: GameStoreOwnership[]
  images: {
    tile: string | null
    hero: string | null
    logo: string | null
  }
  availability: GameAvailability
  /** e.g. "Ultimate" when the title needs a tier above the user's. */
  membershipTier: string | null
  /** True when the user owns this title on at least one linked store. */
  owned: boolean
  /**
   * The variant GFN launches, when the user has told it which.
   *
   * Keyed on the variant rather than the store: `storeId` is not unique within
   * a title — `UNKNOWN` and `NONE` both occur — and the mutation that sets this
   * takes a variant id anyway.
   */
  selectedVariantId: string | null
}

export interface GameStoreOwnership {
  storeId: string
  storeLabel: string
  owned: boolean
  /**
   * This store's edition. The launch deep link and every ownership mutation
   * take this value; `GfnGame.cmsId` is only the one the harvest defaulted to.
   */
  variantId: string
  /** This edition's slug, passed through to the deep link when present. */
  shortName: string | null
  /** The store's own product page. Null for the stores the feed has none for. */
  storeUrl: string | null
}

/** How well a title takes a gamepad — the first thing that matters on a sofa. */
export type GamepadSupport = 'full' | 'partial' | 'none'

/**
 * Everything the details panel shows that a tile does not.
 *
 * Kept out of `GfnGame` on purpose: the catalog snapshot crosses the IPC bridge
 * on every start, and this is text and screenshot URLs for one title at a time.
 * Only the public feed carries any of it, so it is legitimately absent for a
 * game the launcher only knows from the authenticated catalog.
 */
export interface GameDetails {
  cmsId: string
  /** Localised by the request's language. Null for the handful that have none. */
  description: string | null
  /** Capped; the feed offers about ten per title. */
  screenshots: string[]
  keyArt: string | null
  /** ISO 8601, from the same variant the deep link targets. */
  releaseDate: string | null
  gamepad: GamepadSupport
  /** Human labels: "Gamepad", "Keyboard", "Mouse", "DualSense", "Wheel"… */
  controls: string[]
  /** Subscriptions that include this title, e.g. "Xbox Game Pass". */
  subscriptions: string[]
}

/** State of one store account the user has linked to GeForce NOW. */
export interface LinkedProvider {
  id: string
  label: string
  state: 'linked' | 'expired' | 'unlinked'
  /** ISO 8601, or null when never synced. */
  syncedAt: string | null
  gamesSynced: number | null
  /**
   * Whether this store does library sync at all.
   *
   * Linking and syncing are separate capabilities: Epic can be connected and
   * still owns nothing GFN will pull, which is why its games have to be marked
   * by hand. GFN's own client checks this before it asks, and asking anyway is
   * a 400 the user can do nothing about. True when GFN did not say, so an
   * unanswered question degrades to the old behaviour rather than to a store
   * that silently stops syncing.
   */
  canSync: boolean
}

export interface GfnClientInfo {
  installed: boolean
  version: string | null
  /** Host-side Flatpak install root, or null when not installed. */
  installPath: string | null
  /**
   * Why the probe could not answer, when that is not simply "no client here".
   *
   * Null in the ordinary cases — installed, or genuinely absent. It is set only
   * when the launcher was *prevented* from looking: packaged as a Flatpak
   * without permission to reach the host, every `flatpak` call fails, and
   * rendering that as "GeForce NOW is not installed" is a sentence that sends
   * the user to reinstall a client that was there all along.
   */
  error: string | null
}

export interface LaunchRequest {
  /** The *variant* to launch: what goes into the deep link. */
  cmsId: string
  /**
   * The `GfnGame.cmsId` this launch came from.
   *
   * Not the same value as `cmsId` whenever the user picked a store: the deep
   * link wants that store's edition, while play history and focus ids are keyed
   * on the game. Recording the resolved variant instead would leave the ~850
   * multi-store titles unmatchable against their own tiles.
   */
  gameId: string
  shortName?: string | null
  parentGameId?: string | null
}

/**
 * Which of the two ways to start a game was taken.
 *
 * `native` hands a deep link to the installed Flatpak — the whole point of the
 * launcher. `web` opens NVIDIA's own web client in a window we own, and exists
 * only so a machine without the Flatpak is not a dead end.
 */
export type LaunchPath = 'native' | 'web'

/**
 * User preference above `LaunchPath`.
 *
 * The default is `native`, **not** `auto`, and that is a deliberate refusal to
 * be clever. `auto` decides from `detectGfn()`, so a probe that fails for a
 * transient reason — `flatpak` not yet on `PATH` when the launcher autostarts
 * with the session is the realistic one — reads as "no client installed" and
 * quietly streams in a browser window instead of handing the game to the
 * installed client. It would work, and it would not be what was asked for.
 *
 * So the substitution never happens on its own: `native` fails loudly and names
 * the fix, `web` is somebody choosing it, and `auto` is available for anyone who
 * wants the convenience knowing what it costs.
 */
export type LaunchMode = 'auto' | LaunchPath

export const LAUNCH_MODES: readonly LaunchMode[] = ['auto', 'native', 'web']

export function isLaunchMode(value: unknown): value is LaunchMode {
  return typeof value === 'string' && (LAUNCH_MODES as readonly string[]).includes(value)
}

export interface LaunchResult {
  ok: boolean
  /** The exact argv that was spawned, or the URL opened, for troubleshooting. */
  command: string | null
  error: string | null
  /** Which path ran, so the UI can say so rather than guess. */
  mode: LaunchPath
  /**
   * Whether a running client had to be ended first.
   *
   * A second `flatpak run` carrying a deep link is discarded while an instance
   * holds the lock, so the only way to honour the request is to replace the
   * client. Surfaced because the user is owed an explanation for a stream that
   * just disappeared.
   */
  replacedRunningClient?: boolean
}

/**
 * Bumped whenever a refresh starts harvesting something a previous one did not,
 * harvesting it from somewhere better, or laying it out differently.
 *
 * An older cache is not corrupt, just wrong in ways nothing can see at read
 * time: a catalog written before the details panel existed has no
 * `details.json` beside it, one written before `rtx` was read off the public
 * feed has the badge missing from more than half the ray-traced titles, and one
 * written before `sortByName` is in whatever order NVIDIA's gateway happened to
 * return — `sortString: 'ALPHABETICAL'` is sent and not honoured. All of them
 * read as perfectly good JSON, which is why the version is the only thing that
 * can tell them apart. Treating the whole file as absent costs one background
 * refresh and fixes itself.
 *
 * The counter starts at 1 with the first public release. The numbers it ran
 * through before then described caches on development machines and nothing
 * else, so carrying them forward would have made the first shipped format look
 * like the seventh.
 */
export const CATALOG_CACHE_VERSION = 1

export interface CatalogSnapshot {
  games: GfnGame[]
  /** Absent on caches written before this field existed. */
  version?: number
  /** ISO 8601 timestamp of when this snapshot was produced. */
  fetchedAt: string
  /**
   * Where the data came from.
   *
   * `network` is the authenticated catalog, the only one that knows ownership.
   * `public` is the sign-in-free feed: real, launchable titles, but everything
   * reads as unowned. `fixture` means development seed data, which does not
   * launch at all.
   */
  source: 'network' | 'public' | 'cache' | 'fixture'
}

/**
 * Outcome of a mutation that changes what the launcher knows about a title.
 *
 * Carries the patched game back rather than making the renderer guess: the
 * alternative is a twelve-second catalog refresh for a one-field change, and an
 * optimistic guess that the mutation silently rejected is worse than either.
 * Null on failure, so nothing is applied that GFN did not accept.
 */
export interface StoreMutationResult {
  ok: boolean
  error: string | null
  game: GfnGame | null
}

export interface SyncResult {
  /** ALS returns 202 (accepted); the sync itself completes asynchronously. */
  accepted: boolean
  providerId: string
  /**
   * HTTP status, or null when the request never got an answer.
   *
   * Carried so that "the credential was refused" can be told from "the service
   * is unwell" without parsing `error`. Main uses it to decide whether a
   * re-capture is worth trying; the renderer ignores it.
   */
  status: number | null
  error: string | null
}

/**
 * Outcome of asking every linked store to resync at once.
 *
 * `results` is empty and `error` set when there was nothing to ask — no session
 * or no linked store — which is a different thing from every store refusing,
 * and the UI has to be able to say which happened.
 */
export interface SyncAllResult {
  results: SyncResult[]
  error: string | null
}

/**
 * How many titles the Recent view remembers.
 *
 * Shared because both sides quote it: main truncates the stored list to it, and
 * the renderer's empty-state copy names the number.
 */
export const RECENT_LIMIT = 10

export interface Settings {
  /** Register the launcher to start with the desktop session. */
  autostart: boolean
  /** Start fullscreen. Couch usage wants this on. */
  fullscreen: boolean
  /**
   * Which way to start a game. See `LaunchMode` — defaults to the installed
   * client, and never substitutes the web player without being told to.
   */
  launchMode: LaunchMode
  /**
   * Id of an `ACCENT_PRESETS` entry in `@shared/theme` — the only part of the
   * palette the user can change. Stored as an id rather than a colour so a
   * hand-edited settings file cannot put arbitrary CSS into `--brand`.
   */
  accentColor: string
  /**
   * Id of a `UI_SCALE_PRESETS` entry in `@shared/theme`, applied as a zoom
   * factor on the whole renderer. An id rather than a number for the same
   * reason as the accent: the value becomes an argument to
   * `webContents.setZoomFactor`.
   */
  uiScale: string
  locale: string
  /**
   * Whether the user has signed in at least once. Not a preference and not
   * shown in the UI — it tells the launcher whether the persisted browser
   * session is worth reviving, so a fresh install never pays for a pointless
   * headless sign-in attempt.
   */
  gfnLinked: boolean
  /**
   * Ask GitHub whether there is a newer launcher, once per start.
   *
   * A real preference rather than a hidden constant: this is the one request
   * the launcher makes that is about *itself* rather than about GeForce NOW,
   * and someone running it on a metered or air-gapped connection is owed a way
   * to turn it off. Off, the Settings row still checks on demand — the toggle
   * governs the automatic check, not the feature.
   */
  updateCheck: boolean
  /**
   * The version whose notice the user pressed "Not now" on.
   *
   * Not a preference either. It is what stops the popup from being a thing that
   * appears on every single start until you give in: dismissing records the
   * version, and only a release newer than it opens the notice again. Null
   * before the first dismissal.
   */
  dismissedUpdate: string | null
  /**
   * Let L3 + R3 raise a cursor outside the launcher's own windows.
   *
   * A real preference, and off by default, because it is the one feature here
   * that reaches past the application: it opens a `RemoteDesktop` portal
   * session, which is a one-time system permission dialog and a virtual pointer
   * the compositor keeps for as long as the launcher runs. Nobody should
   * discover that by accident.
   *
   * Off, the pad still gets a cursor inside the sign-in window and the web
   * player — those need no permission and are not governed by this.
   */
  pointerDesktop: boolean
  /**
   * The portal's `restore_token` from the last grant, or null.
   *
   * Not a preference; it is what stops the permission dialog reappearing every
   * time. Held here rather than in a file of its own because it is exactly the
   * kind of small, atomic, launcher-owned fact `settings.json` exists for.
   *
   * It is not a credential for anything but this machine's own compositor, and
   * it is never logged.
   */
  pointerRestoreToken: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  autostart: false,
  fullscreen: true,
  // Not `auto`: see `LaunchMode`. Handing the game to the installed client is
  // what the launcher is for, and falling back to a browser window is a choice
  // the user makes, not one a failed probe makes for them.
  launchMode: 'native',
  accentColor: DEFAULT_ACCENT,
  uiScale: DEFAULT_UI_SCALE,
  locale: 'en_US',
  gfnLinked: false,
  updateCheck: true,
  dismissedUpdate: null,
  // Off: it costs a system permission dialog the first time it is used.
  pointerDesktop: false,
  pointerRestoreToken: null
}

/**
 * What the launcher can ask the machine to do when the user is done playing.
 *
 * These are the logind verbs, not our own vocabulary: they map one-to-one onto
 * `systemctl <action>`, which is what keeps `buildPowerArgv` a lookup rather
 * than a translation table.
 */
export type PowerAction = 'suspend' | 'reboot' | 'poweroff'

/** Mirrors `LaunchResult`: the argv comes back so a refusal can be diagnosed. */
export interface PowerResult {
  ok: boolean
  command: string | null
  error: string | null
}

/**
 * Whether handing a URL to the desktop worked.
 *
 * No argv to report, unlike `PowerResult`: there is no command of ours to name,
 * only whatever the desktop decided a browser is.
 */
export interface OpenResult {
  ok: boolean
  error: string | null
}

/**
 * Health of one Statuspage component.
 *
 * Statuspage's own vocabulary, kept verbatim: it is a closed set, the launcher
 * has no better words for it, and renaming it here would only put a translation
 * table between us and the thing we are reporting.
 */
export type ComponentHealth =
  | 'operational'
  | 'degraded_performance'
  | 'partial_outage'
  | 'major_outage'
  | 'under_maintenance'

/**
 * Page-level rollup. `unknown` is ours, not Statuspage's: it means the fetch
 * failed, which is a different thing from every system being fine.
 */
export type PageIndicator = 'none' | 'minor' | 'major' | 'critical' | 'maintenance' | 'unknown'

/** One datacenter, or one per-region service such as Cloud Storage. */
export interface StatusComponent {
  /**
   * Statuspage's id, and the only stable key here: leaf *names* repeat — twenty
   * regions each have a component called "Cloud Storage".
   */
  id: string
  /** Tier suffix stripped: "NP-FRK-08", not "NP-FRK-08 [RTX 5080]". */
  name: string
  health: ComponentHealth
}

/** A Statuspage component group — which on this page means a GFN region. */
export interface StatusRegion {
  id: string
  /** "Germany". The ` [RTX 5080]` suffix is lifted out into `tier`. */
  name: string
  /** "RTX 5080" when the group name carried one. */
  tier: string | null
  /**
   * One of the twelve `… - Alliance Partner` groups: run by a partner rather
   * than NVIDIA, and offered only in that partner's territory. Listed apart
   * because most users can reach none of them.
   */
  partner: boolean
  /** Statuspage's own rollup for the group. Not derived from `components`. */
  health: ComponentHealth
  components: StatusComponent[]
}

export interface StatusIncidentUpdate {
  id: string
  status: string
  body: string
  /** ISO 8601. */
  at: string
}

export interface StatusIncident {
  id: string
  title: string
  /** `investigating` | `identified` | `monitoring` for incidents; `scheduled` | `in_progress` | `verifying` for maintenance. */
  status: string
  impact: 'none' | 'minor' | 'major' | 'critical' | 'maintenance'
  /** ISO 8601. */
  startedAt: string
  /** Newest first, the order Statuspage sends them in. */
  updates: StatusIncidentUpdate[]
  /**
   * Ids of the regions this touches.
   *
   * Usually empty: most GeForce NOW incidents are about one game rather than
   * one datacenter, and carry no components at all. Which is why the UI lists
   * open incidents globally and only *marks* the region-scoped ones — filtering
   * to "affects me" would hide almost everything almost always.
   */
  regionIds: string[]
  /** Scheduled maintenance only: when it runs. */
  window: { from: string; until: string } | null
}

/**
 * Which datacenter the installed GFN client will stream from, read off the
 * client's own on-disk configuration.
 *
 * This is the one thing the launcher can say that NVIDIA's status page cannot,
 * and it needs no network: it comes from a file this machine already has.
 */
export interface ZoneAssignment {
  /** `pinned` when the user chose a region in GFN's settings, `auto` when they left it alone. */
  routing: 'pinned' | 'auto'
  /** The region as the client names it: "Germany". Null when nothing could be read. */
  regionName: string | null
  /** Datacenter code from the last session: "NP-FRK-08". Null before the first stream. */
  zoneCode: string | null
  /**
   * False when the pin was changed after the last session, which leaves
   * `zoneCode` pointing at the region the user just moved away from.
   */
  zoneCurrent: boolean
  /** Round-trip GFN itself measured for this region, in ms. Null when never tested. */
  latencyMs: number | null
  /** Why nothing could be resolved, so the UI can say it instead of rendering a blank. */
  error: string | null
}

/** The client's assignment, matched onto the fleet. */
export interface ZoneStatus {
  assignment: ZoneAssignment
  /** The region the zone resolved to, or null when it matched nothing. */
  region: StatusRegion | null
  /** The exact datacenter, when `zoneCode` matched a component. */
  component: StatusComponent | null
}

export interface StatusSnapshot {
  /** Statuspage's own summary line, e.g. "All Systems Operational". */
  summary: string | null
  indicator: PageIndicator
  regions: StatusRegion[]
  /** Unresolved only. */
  incidents: StatusIncident[]
  /** Active and upcoming only. */
  maintenance: StatusIncident[]
  zone: ZoneStatus
  /** ISO 8601 of the last *successful* fetch. Null when there has never been one. */
  fetchedAt: string | null
  /**
   * Set when the last attempt failed. The rest of the snapshot is then either
   * the last known good state — dated by `fetchedAt` — or empty.
   */
  error: string | null
}

/**
 * How this copy of the launcher was installed, and therefore who is allowed to
 * replace it.
 *
 * Not a cosmetic label: it selects the whole update path. A Flatpak is updated
 * by `flatpak` on the host, an AppImage is one file this process can overwrite,
 * and a `.deb` belongs to the package manager — which needs root, and root is
 * not on the table here for the same reason it is not for waking the machine
 * with a gamepad.
 */
export type UpdateChannel =
  /** Packaged as a Flatpak. `flatpak update` on the host. */
  | 'flatpak'
  /** A single AppImage file the launcher can download over. */
  | 'appimage'
  /** Installed by the system's package manager — a `.deb` today. */
  | 'system'
  /** Running from source, or from something none of the above describes. */
  | 'unknown'

/**
 * Whether there is a newer launcher, and what can be done about it here.
 *
 * `available` and `canApply` are separate facts and the UI needs both: every
 * install form can be *told* about a release, and only two of them can install
 * one. Conflating them would either hide the news from `.deb` users or offer
 * them a button that cannot work.
 */
export interface UpdateStatus {
  /** This build, from `package.json`. */
  currentVersion: string
  /** Newest published release, normalised without the tag's `v`. Null when unknown. */
  latestVersion: string | null
  available: boolean
  channel: UpdateChannel
  /** True when confirming the notice actually installs something. */
  canApply: boolean
  /**
   * Why it cannot, in a sentence the user can act on. Null when it can, or when
   * there is nothing to install anyway.
   */
  blockedReason: string | null
  /** Release notes, already reduced to a few lines readable at three metres. */
  notes: string[]
  /** ISO 8601 of the release. */
  publishedAt: string | null
  /** Size of the artefact this build would download, when there is one to name. */
  downloadBytes: number | null
  /** ISO 8601 of the last *successful* check. Null when there has never been one. */
  checkedAt: string | null
  /** Set when the last check failed. Everything else is then last known good. */
  error: string | null
}

/**
 * Where a running update has got to. Pushed over `update:progress`.
 *
 * Two sources that count differently, which is why `percent` is its own field
 * rather than something the UI derives. The AppImage path counts bytes, because
 * it is doing the transfer. The Flatpak path counts percent, because `flatpak`
 * is doing the transfer and a percentage is all it prints — it never says how
 * many bytes, so the byte fields stay zero there and the notice shows a bar
 * with no figures beside it rather than a made-up total.
 */
export interface UpdateProgress {
  phase: 'downloading' | 'verifying' | 'installing'
  /** 0–100 when the source can say, null while it cannot yet. */
  percent: number | null
  receivedBytes: number
  /** 0 when the source counts in percent, or when the server sent no length. */
  totalBytes: number
}

/**
 * Outcome of installing an update.
 *
 * Mirrors `PowerResult` in carrying the argv: a `flatpak update` that polkit
 * refused is diagnosable only if the command is on screen beside the refusal.
 */
export interface UpdateApplyResult {
  ok: boolean
  /**
   * True when the new version is on disk and only a restart is left.
   *
   * Not the same as "the launcher can restart itself" — a Flatpak cannot, since
   * the running sandbox has the old deploy bind-mounted into it, so the honest
   * answer there is that the update takes effect the next time it opens.
   */
  restartRequired: boolean
  /** Set when the launcher can put the new version on screen right now. */
  canRestart: boolean
  command: string | null
  error: string | null
}

/**
 * What a bug report needs to name, resolved on the side that knows it.
 *
 * All four values live in the main process — the log path comes from
 * `userData`, the channel from `resolveUpdateChannel` — and the renderer's only
 * use for them is to print them. Kept out of `Settings` deliberately: none of
 * these is a preference, and putting them there would mean a `sanitise` branch
 * for a field nobody can set.
 */
export interface Diagnostics {
  /** The file to attach. Absolute, and the same path the README names. */
  logPath: string
  version: string
  channel: UpdateChannel
  /** Whether this is the Flatpak, which decides where the path above points. */
  sandboxed: boolean
}

/**
 * What kind of thing a Bluetooth device is, as far as an icon is concerned.
 *
 * Ours rather than BlueZ's: the daemon publishes a freedesktop *icon name*
 * ("input-gaming", "audio-headset") and, for devices that carry none, a packed
 * class-of-device integer. Both are resolved to one of these on the main side
 * by `deviceKind`, so the renderer picks a glyph from a closed union instead of
 * pattern-matching a string somebody else owns.
 */
export type BluetoothKind =
  | 'gamepad'
  | 'headset'
  | 'headphones'
  | 'speaker'
  | 'keyboard'
  | 'mouse'
  | 'phone'
  | 'computer'
  | 'display'
  | 'unknown'

export interface BluetoothDevice {
  /**
   * `AA:BB:CC:DD:EE:FF`. The launcher's key for this device — focus ids and
   * every action payload carry it — and deliberately never drawn on screen: a
   * MAC read from three metres is noise, and two devices with the same name are
   * told apart by the signal meter instead.
   *
   * It never reaches the log either. `redactSecrets` would replace it with
   * `<mac>` anyway, which is why every diagnostic in `src/main/bluetooth/`
   * names the device and the operation rather than the address.
   */
  address: string
  /** `Alias` when the user has renamed it, else `Name`, else a placeholder. */
  name: string
  kind: BluetoothKind
  paired: boolean
  connected: boolean
  /** dBm, while a scan is running and the adapter is hearing it. Null otherwise. */
  rssi: number | null
  /** `org.bluez.Battery1.Percentage`. Null for a device that reports none. */
  battery: number | null
  /** An action on this device is in flight, so the row shows a spinner. */
  busy: boolean
}

/**
 * A pairing BlueZ wants answered before it can finish.
 *
 * `confirm` is numeric comparison: the same six digits are on both devices and
 * the user says whether they match. `display` is a code to type on the *other*
 * device, so there is nothing here to press and the band clears itself when the
 * pairing completes.
 *
 * The two agent methods that ask the launcher to *type* a code are refused
 * outright — a pad cannot — and that refusal arrives as an ordinary action
 * error rather than as one of these.
 */
export interface BluetoothPairingRequest {
  address: string
  name: string
  kind: 'confirm' | 'display'
  /** Six digits, zero-padded, as BlueZ hands it over. */
  passkey: string
}

export interface BluetoothSnapshot {
  /** False when the machine has no adapter, or bluetoothd is not running. */
  available: boolean
  powered: boolean
  /**
   * **Our** scan, not `Adapter1.Discovering`.
   *
   * That property is adapter-global and is routinely true because the desktop's
   * own Bluetooth panel is scanning. Reporting it would have this screen claim
   * to be searching when it is not, and leave the control unable to stop it.
   */
  scanning: boolean
  adapterName: string | null
  /** Known to the adapter. Connected first, then by name. */
  paired: BluetoothDevice[]
  /** Unpaired and currently being heard. Strongest signal first. */
  nearby: BluetoothDevice[]
  request: BluetoothPairingRequest | null
  /**
   * Why the feature is unusable at all — no adapter, no daemon, a sandbox
   * refused the bus. Not where a failed action goes: that is `BluetoothResult`,
   * because "this pairing did not work" and "there is no Bluetooth here" want
   * different sentences in different places on the screen.
   */
  error: string | null
}

/**
 * Outcome of one Bluetooth action.
 *
 * Carries the snapshot for the same reason `StoreMutationResult` carries the
 * patched game: the caller has just changed the thing it is displaying, and a
 * second round trip to find out what happened is a frame of the screen
 * disagreeing with itself.
 */
export interface BluetoothResult {
  ok: boolean
  error: string | null
  snapshot: BluetoothSnapshot
}

export interface AuthStatus {
  authenticated: boolean
}

export interface AuthResult {
  ok: boolean
  error: string | null
}

/** The surface exposed to the renderer through the preload contextBridge. */
export interface LauncherApi {
  gfn: {
    info(): Promise<GfnClientInfo>
    /**
     * Fires when the installed client changes: updated, installed or removed
     * while the launcher was open. Returns its own unsubscribe.
     *
     * There is nothing to poll for this. The renderer asks `info()` once at
     * mount and has no later moment at which asking again would mean anything,
     * and nothing in the renderer polls at all — the one repeat clock in that
     * process is the gamepad loop, deliberately.
     */
    onClient(listener: (info: GfnClientInfo) => void): () => void
    launch(request: LaunchRequest): Promise<LaunchResult>
    /**
     * Opens the GFN client on its own home screen, with no game.
     *
     * The way to reach settings the launcher does not mirror — stream quality,
     * account linking, controller mapping — and have them apply to the sessions
     * it starts. Steps the launcher aside, since a fullscreen window on top of
     * the thing it just opened would make the button look broken.
     */
    open(): Promise<LaunchResult>
  }
  catalog: {
    get(): Promise<CatalogSnapshot>
    refresh(): Promise<CatalogSnapshot>
    /** Null when the launcher has nothing beyond the tile for this title. */
    details(cmsId: string): Promise<GameDetails | null>
  }
  library: {
    providers(): Promise<LinkedProvider[]>
    sync(providerId: string): Promise<SyncResult>
    /**
     * Asks every linked store to resync — GFN's own "Refresh library", for all
     * of them at once. Each store is accepted or refused on its own, so a
     * partial success is the normal outcome and comes back as such.
     */
    syncAll(): Promise<SyncAllResult>
    /**
     * Manual override for titles GFN's store sync misses — Epic being the one
     * most people hit. `cmsId` says which catalog entry to patch, `variantId`
     * which store's edition is being marked.
     */
    setOwned(cmsId: string, variantId: string, owned: boolean): Promise<StoreMutationResult>
    /** Records which store's edition GFN should launch. Does not launch it. */
    selectVariant(cmsId: string, variantId: string): Promise<StoreMutationResult>
  }
  auth: {
    status(): Promise<AuthStatus>
    /** Opens NVIDIA's sign-in page in a window the launcher owns. */
    signIn(): Promise<AuthResult>
    signOut(): Promise<void>
  }
  status: {
    /**
     * GeForce NOW's server status, plus where this machine's client is pointed.
     *
     * Returns the memoised snapshot while it is fresh. Never throws: a failed
     * fetch comes back as a snapshot carrying `error`, because the zone half of
     * it is read locally and is worth showing even when the network half is not
     * available.
     */
    get(): Promise<StatusSnapshot>
    /** Re-checks now, ignoring the cache. What the refresh control calls. */
    refresh(): Promise<StatusSnapshot>
    /**
     * Fires when the client's datacenter moves — the user changed their server
     * location in the GeForce NOW app, or a session came back from a different
     * zone. Returns its own unsubscribe.
     *
     * Carries **only** the zone, not a snapshot: merge it into the one already
     * held and drop it when there is none. A zone with no board behind it would
     * have to invent a `fetchedAt` and an `error`, and a screen the user has
     * never opened has nothing to correct anyway.
     */
    onZone(listener: (zone: ZoneStatus) => void): () => void
  }
  /**
   * Pairing and connecting the hardware in the room.
   *
   * BlueZ does all of it — the launcher is a client of the system's Bluetooth
   * stack in exactly the way the desktop's own panel is, and nothing here
   * implements a pairing of its own.
   *
   * **No subscription, unlike the other live surfaces on this bridge.** The
   * five main → renderer channels each exist because the renderer has no way of
   * knowing there is anything to ask about; the Devices screen knows perfectly
   * well that it is looking at a moving list, so it polls this while it is open
   * and main answers out of a model its own D-Bus signals keep current. A poll
   * therefore costs no bus traffic, and the bridge does not grow a sixth push.
   */
  bluetooth: {
    /** Never throws: an unusable adapter comes back as a snapshot with `error`. */
    get(): Promise<BluetoothSnapshot>
    /**
     * Starts or stops discovery.
     *
     * Discovery is reference-counted by BlueZ per client, so stopping releases
     * only the launcher's request and cannot end a scan the desktop started.
     * A scan left running stops itself after a minute.
     */
    scan(on: boolean): Promise<BluetoothResult>
    /** Turns the adapter itself on or off — `Adapter1.Powered`. */
    power(on: boolean): Promise<BluetoothResult>
    /** Pair, connect, disconnect or forget the device with this address. */
    act(action: BluetoothAction, address: string): Promise<BluetoothResult>
    /**
     * Answers the pairing confirmation in `BluetoothSnapshot.request`.
     *
     * BlueZ is holding a D-Bus call open while this is pending, so a request
     * that is never answered is a pairing that never finishes. The screen only
     * shows the band while a request exists, and leaving the screen cancels it.
     */
    respond(accept: boolean): Promise<BluetoothResult>
  }
  recent: {
    /**
     * `GfnGame.cmsId`s of the last titles launched from here, newest first and
     * capped at `RECENT_LIMIT`. Ids rather than games: the catalog already
     * crosses the bridge whole, and a title can leave it between two runs.
     */
    list(): Promise<string[]>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
  }
  update: {
    /**
     * Whether there is a newer launcher.
     *
     * Never throws: a failed request comes back as a status carrying `error`,
     * the same posture as `status.get()`. Served from a short-lived memory
     * cache unless `force` — the Settings row forces, the check after first
     * paint does not.
     */
    check(force: boolean): Promise<UpdateStatus>
    /**
     * Installs the update this build is able to install.
     *
     * Refuses rather than throws when it cannot: a `.deb` is the package
     * manager's business, and the result says so instead of pretending.
     */
    apply(): Promise<UpdateApplyResult>
    /**
     * Restarts into the version just installed.
     *
     * Only ever offered when `UpdateApplyResult.canRestart` said so. False when
     * the launcher refused rather than restarting — a Flatpak whose host
     * permission was revoked cannot hand the relaunch over, and quitting anyway
     * would leave a television with no launcher and nothing able to start one.
     *
     * The boolean is not decoration: without it the notice sits on
     * "Restarting…" for a restart that is never coming, which is the one
     * failure on this path nobody in the room can diagnose.
     */
    restart(): Promise<boolean>
    /**
     * Byte counts during a download, for the one operation here long enough to
     * need them.
     *
     * Returns its own unsubscribe. The listener receives the payload alone —
     * the `IpcRendererEvent` carrying it, and the `sender` on that event, stay
     * on the preload side of the bridge.
     */
    onProgress(listener: (progress: UpdateProgress) => void): () => void
  }
  app: {
    quit(): Promise<void>
    /**
     * Steps aside without closing: leaves fullscreen and minimises.
     *
     * Deliberately not a `PowerAction` — those become arguments to `systemctl`,
     * and this ends nothing. Note that the pad cannot undo this: a minimised
     * launcher stops acting on input (`shouldAcceptInput`) and could not raise
     * itself in any case. Coming back needs a mouse or a keyboard, and the UI
     * has to say so.
     */
    minimize(): Promise<void>
    /**
     * Suspends, reboots or powers off the host.
     *
     * The launcher is the last thing on screen before the TV goes off, so it
     * has to be able to end the session without a keyboard. Nothing here is
     * privileged: these go to logind, which decides whether to allow them.
     */
    power(action: PowerAction): Promise<PowerResult>
    /**
     * Opens the donation page in whatever the desktop calls a browser.
     *
     * Takes no argument on purpose. The URL is a constant both sides import
     * from `@shared/donate`, so nothing crosses the bridge and there is nothing
     * to validate — which is a stronger guarantee than validating it would be.
     *
     * The QR code on the Support screen is the path that always works; this is
     * for the machine that happens to have a browser in front of it.
     */
    openDonation(): Promise<OpenResult>
    /**
     * Reports that the pad is being used, so main can keep the display awake.
     *
     * Fire-and-forget, and the only method here that returns nothing: there is
     * no result and no failure to report. Throttled by `usePadWakeLock` to one
     * call per `PAD_ACTIVITY_PING_MS`; see `@shared/wakeLock` for why a
     * launcher has to ask for this at all.
     */
    padActivity(): void
    /**
     * Where the log file is, so the interface can say which one to attach.
     *
     * Takes no argument, like `openDonation` and for the same reason. Never
     * throws: every field is read out of this process's own state.
     */
    diagnostics(): Promise<Diagnostics>
    /**
     * Who has the screen, whenever that changes.
     *
     * The second subscription on this bridge, written out for the same reason as
     * `update.onProgress` rather than exposed as a generic `on(channel, …)`.
     * `GamepadProvider` folds it into `shouldAcceptInput`; nothing else reads it.
     *
     * The current value is re-sent on every load, so a renderer brought back
     * after `render-process-gone` does not resume mid-game believing it is the
     * thing on screen.
     */
    onScreen(listener: (screen: ScreenOwnership) => void): () => void
    /**
     * Whether the desktop cursor is up, whenever that changes.
     *
     * The launcher's own UI has no cursor and needs none — every control is
     * reachable by spatial focus. What it needs is to *stop* answering the
     * stick while a cursor is being driven over it, or the same push would both
     * move the pointer and walk the grid behind it.
     *
     * Only main can say: the chord that raises this cursor is read from
     * `/dev/input/js*` in the main process, because the two places it is wanted
     * — a game in front, a minimised launcher — are the two where the renderer
     * cannot see a pad at all.
     */
    onPointerMode(listener: (active: boolean) => void): () => void
  }
}
