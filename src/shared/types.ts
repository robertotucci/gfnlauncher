/**
 * Types shared across the main, preload and renderer processes.
 *
 * This file is the IPC contract. It must stay free of Node and DOM imports so
 * that all three bundles can consume it.
 */

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
 * or harvesting it from somewhere better.
 *
 * An older cache is not corrupt, just wrong in ways nothing can see at read
 * time — a catalog written before the details panel existed has no
 * `details.json` beside it, and v4 filled `rtx` from a stale marketing keyword
 * that missed more than half the ray-traced catalog. Both read as perfectly
 * good JSON. Treating the whole file as absent costs one background refresh and
 * fixes itself.
 */
export const CATALOG_CACHE_VERSION = 6

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
  /** Minimise the launcher once GFN has been handed a game. */
  hideOnLaunch: boolean
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
}

export const DEFAULT_SETTINGS: Settings = {
  autostart: false,
  fullscreen: true,
  hideOnLaunch: true,
  // Not `auto`: see `LaunchMode`. Handing the game to the installed client is
  // what the launcher is for, and falling back to a browser window is a choice
  // the user makes, not one a failed probe makes for them.
  launchMode: 'native',
  accentColor: DEFAULT_ACCENT,
  uiScale: DEFAULT_UI_SCALE,
  locale: 'en_US',
  gfnLinked: false
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
  app: {
    quit(): Promise<void>
    /**
     * Steps aside without closing: leaves fullscreen and minimises.
     *
     * Deliberately not a `PowerAction` — those become arguments to `systemctl`,
     * and this ends nothing. Note that the Gamepad API only reports to a focused
     * window, so the pad cannot undo this; coming back needs a mouse or a
     * keyboard, and the UI has to say so.
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
  }
}
