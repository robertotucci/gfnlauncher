import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  BluetoothResult,
  BluetoothSnapshot,
  CatalogSnapshot,
  GameDetails,
  GameStoreOwnership,
  GfnClientInfo,
  GfnGame,
  LinkedProvider,
  PowerAction,
  Settings,
  StatusSnapshot,
  StoreMutationResult,
  UpdateApplyResult,
  UpdateProgress,
  UpdateStatus
} from '@shared/types'
import { RECENT_LIMIT } from '@shared/types'
import {
  ALL_GENRES,
  RTX_FILTER,
  collectGenres,
  cycleGenre,
  resolveLaunchTarget
} from '@shared/games'
import { accentValue, DEFAULT_ACCENT } from '@shared/theme'
import type { BluetoothAction } from '@shared/bluetooth'
import { useGamepad, useIntent } from '@/gamepad/GamepadProvider'
import { usePadWakeLock } from '@/gamepad/wakeLock'
import { useSpatialFocus } from '@/focus/SpatialFocus'
import { NavRail, type View } from '@/components/NavRail'
import { HeroPanel } from '@/components/HeroPanel'
import { GenreStrip } from '@/components/GenreStrip'
import { GameGrid } from '@/components/GameGrid'
import { SettingsScreen } from '@/components/SettingsScreen'
import { StatusScreen } from '@/components/StatusScreen'
import {
  ACTION_LABELS,
  DevicesScreen,
  DEVICES_CONFIRM_ID,
  DEVICES_SCAN_ID,
  deviceFocusId,
  deviceFor,
  primaryAction
} from '@/components/DevicesScreen'
import { DonateScreen, DONATE_FOCUS_ID } from '@/components/DonateScreen'
import { SearchOverlay, SEARCH_SCOPE } from '@/components/SearchOverlay'
import { GameDetailsModal, DETAILS_SCOPE } from '@/components/GameDetailsModal'
import { ScreenshotViewer, SHOTS_SCOPE } from '@/components/ScreenshotViewer'
import { PowerDialog, POWER_FIRST_ID, POWER_SCOPE } from '@/components/PowerDialog'
import { UpdateDialog, UPDATE_SCOPE, updateLandingId } from '@/components/UpdateDialog'
import { StatusFooter, type LegendEntry, type SignalState } from '@/components/StatusFooter'
import { LoadingBar } from '@/components/LoadingBar'
import {
  LaunchNotice,
  launchFailureReason,
  type LaunchNoticeState
} from '@/components/LaunchNotice'
import { cn } from '@/lib/utils'

const ROOT_SCOPE = 'root'

/**
 * How long a layer takes to fade out. Overlays are conditionally mounted, so
 * the exit has to be waited out before unmounting or it never plays.
 */
const EXIT_MS = 150

/**
 * How long to let a store sync run before reloading the catalog.
 *
 * ALS answers 202 and finishes in its own time, so there is nothing to await.
 * The number is GFN's own `accountLinking.defaultSyncWaitInterval` — what the
 * real client waits before believing a library is current — rather than a guess.
 */
const SYNC_SETTLE_MS = 10_000

/**
 * How long a failed launch stays on screen. Generous on purpose: it carries a
 * command string, and it is the only account of the fault anyone in the room
 * will ever get.
 */
const LAUNCH_NOTICE_MS = 8_000

/**
 * How long the launcher waits before restarting itself into a new version.
 *
 * There is a countdown at all because this is the launcher taking the screen
 * away from somebody who may have pressed the button and walked off, and ten
 * seconds is long enough to read what is about to happen and stop it from three
 * metres. It is not a confirmation dialog: the user already confirmed by
 * installing, and an appliance that needs a second yes to finish the job it was
 * told to do is an appliance that leaves itself half-updated.
 */
const RESTART_COUNTDOWN_S = 10

/**
 * How often the Devices screen re-reads the Bluetooth state.
 *
 * A poll rather than a subscription, and the bridge has the argument for why:
 * its five main → renderer channels each exist because the renderer cannot know
 * there is anything to ask about, and a screen watching a discovery list plainly
 * can. Main answers out of a model its own D-Bus signals keep current, so this
 * costs a structured clone and nothing on the bus. It only runs while the screen
 * is open.
 */
const BLUETOOTH_POLL_MS = 1_000

/** "1 store" / "3 stores", so the notice line reads like a sentence. */
function storeCount(count: number): string {
  return `${count} store${count === 1 ? '' : 's'}`
}

/**
 * One result out of the first-paint batch, or a fallback and a line in the log.
 *
 * The batch used to be a `Promise.all`, which is the wrong shape for it: these
 * five calls are independent, and a single rejection left *none* of them
 * applied — `catalogSource` stayed null, so `catalogPending` stayed true, and
 * the launcher sat on a loading bar for the rest of the session with nothing on
 * screen to say why. Settling them one at a time means one broken answer costs
 * one part of the screen.
 */
function settled<T>(result: PromiseSettledResult<T>, what: string, fallback: T): T {
  if (result.status === 'fulfilled') return result.value
  console.error(`${what} could not be loaded:`, result.reason)
  return fallback
}

/** Fold case, accents and punctuation so "Baldur's" matches "baldurs". */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

export function App(): ReactNode {
  const [games, setGames] = useState<GfnGame[]>([])
  const [catalogSource, setCatalogSource] = useState<CatalogSnapshot['source'] | null>(null)
  /** Set once a refresh has run and *still* produced nothing but seed data. */
  const [fixturesAreFinal, setFixturesAreFinal] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [providers, setProviders] = useState<LinkedProvider[]>([])
  const [client, setClient] = useState<GfnClientInfo | null>(null)
  const [view, setView] = useState<View>('library')
  const [genre, setGenre] = useState<string>(ALL_GENRES)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchClosing, setSearchClosing] = useState(false)
  const [query, setQuery] = useState('')
  /** Where focus was when the overlay opened, so it can be handed back. */
  const searchOrigin = useRef<string | null>(null)
  const [detailsGame, setDetailsGame] = useState<GfnGame | null>(null)
  const [details, setDetails] = useState<GameDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsClosing, setDetailsClosing] = useState(false)
  /** Where focus was when the panel opened, so it can be handed back. */
  const detailsOrigin = useRef<{ id: string; scope: string } | null>(null)
  /** Index of the screenshot on screen, or null when the viewer is closed. */
  const [shots, setShots] = useState<number | null>(null)
  const [shotsClosing, setShotsClosing] = useState(false)
  /** Which thumbnail the viewer was opened from, so B can go back to it. */
  const shotsOrigin = useRef<string | null>(null)
  const [powerOpen, setPowerOpen] = useState(false)
  const [powerClosing, setPowerClosing] = useState(false)
  const [powerBusy, setPowerBusy] = useState(false)
  const [powerError, setPowerError] = useState<string | null>(null)
  /** What the last update check found. Null until one has run. */
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateClosing, setUpdateClosing] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateApplying, setUpdateApplying] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null)
  const [updateResult, setUpdateResult] = useState<UpdateApplyResult | null>(null)
  /** Seconds left before the launcher restarts itself, or null when nothing is. */
  const [restartIn, setRestartIn] = useState<number | null>(null)
  /**
   * The restart was asked for and refused.
   *
   * A separate flag from `updateResult`, because the install succeeded: the new
   * version is on disk and only the reopening failed, and folding it into the
   * result would replace "installed" with "failed" and hide the half that
   * worked.
   */
  const [restartRefused, setRestartRefused] = useState(false)
  /** Where focus was when the notice opened, so it can be handed back. */
  const updateOrigin = useRef<string | null>(null)
  /**
   * The notice has been on screen once this run.
   *
   * Set by `openUpdate` rather than by the effect that calls it, so closing the
   * notice with B cannot let the effect immediately put it back up — which is
   * what happens if the "shown" flag belongs to the automatic path alone.
   */
  const updateShown = useRef(false)
  /** Why the donation page did not open, or null. Cleared on leaving Support. */
  const [donateError, setDonateError] = useState<string | null>(null)
  /** A store mutation is in flight, and what the last one had to say. */
  const [storeBusy, setStoreBusy] = useState(false)
  const [storeNotice, setStoreNotice] = useState<string | null>(null)
  const [handoff, setHandoff] = useState(false)
  /** The same fact as `handoff`, reachable from a callback with `[]` deps. */
  const launching = useRef(false)
  /** Why the last launch failed, or null. Cleared by the next press. */
  const [launchNotice, setLaunchNotice] = useState<LaunchNoticeState | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  /** Game ids of what was played last, newest first. Owned by main. */
  const [recentIds, setRecentIds] = useState<string[]>([])
  const [syncing, setSyncing] = useState(false)
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  const [syncFailed, setSyncFailed] = useState(false)
  const [gfnOpenError, setGfnOpenError] = useState<string | null>(null)
  /** GFN's server status. Null until the user first opens the view. */
  const [status, setStatus] = useState<StatusSnapshot | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusRefreshing, setStatusRefreshing] = useState(false)
  /** The Bluetooth adapter and what it can see. Null until the screen is opened. */
  const [bluetooth, setBluetooth] = useState<BluetoothSnapshot | null>(null)
  const [bluetoothLoading, setBluetoothLoading] = useState(false)
  /** What the last Bluetooth action had to say. Cleared by the next one. */
  const [bluetoothNotice, setBluetoothNotice] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  /**
   * The launcher came up unable to talk to its own main process.
   *
   * Its own state rather than a notice, because it outranks everything the
   * footer would otherwise be saying: with no bridge there is no pad handling
   * worth reporting on and no control on any screen that does anything. Held
   * already-uppercased, since the footer prints it verbatim.
   */
  const [bootError, setBootError] = useState<string | null>(null)
  /** Where the log file is, for the Settings nameplate. Null until it answers. */
  const [logPath, setLogPath] = useState<string | null>(null)

  const { connected, windowFocused, inputAccepted, scheme } = useGamepad()
  const { focusedId, focus, move, confirm, setActiveScope } = useSpatialFocus()

  // A joystick does not reset a compositor's idle timer, so browsing with the
  // pad would otherwise be watched by a screen on its way to blanking.
  usePadWakeLock()

  // Everything the first paint needs, and nothing that can block it. Listing
  // providers may revive a browser session, which takes seconds — it must not
  // hold the UI hostage, so it runs on its own afterwards.
  //
  // Settled rather than all-or-nothing: see `settled`. The bridge itself
  // failing is handled separately, because that is not one answer missing but
  // every answer missing, and it needs saying out loud.
  useEffect(() => {
    void (async () => {
      if (!window.launcher) {
        // A preload that did not load. Every control on every screen is inert
        // from here, so the honest thing is to name it rather than let the user
        // press things — and `catalogPending` has to be released or the
        // loading bar runs forever on top of it.
        // Short, because it shares the footer strip with the legend and the two
        // version nameplates. The long form of the same fact is on the crash
        // screen and in the log.
        setBootError('MAIN PROCESS UNREACHABLE — RESTART THE LAUNCHER')
        setCatalogSource('fixture')
        setFixturesAreFinal(true)
        return
      }

      const [snapshot, loadedSettings, info, auth, recent] = await Promise.allSettled([
        window.launcher.catalog.get(),
        window.launcher.settings.get(),
        window.launcher.gfn.info(),
        window.launcher.auth.status(),
        // Ten ids off a local file: cheap enough to belong in the first batch,
        // and the Recent rail item is a dead end until it arrives.
        window.launcher.recent.list()
      ])

      // Falling back to `fixture` rather than to an empty cache is deliberate:
      // it is the one source the auto-refresh effect below reacts to, so a
      // catalog read that failed transiently is retried from the network
      // instead of leaving an empty grid nothing will ever fill.
      const catalog = settled(snapshot, 'The catalogue', {
        games: [],
        fetchedAt: '',
        source: 'fixture' as const
      })
      setGames(catalog.games)
      setCatalogSource(catalog.source)
      // Left null on failure on purpose: `SettingsScreen` renders skeletons for
      // a null `settings`, which is a truer picture than a screen full of
      // defaults the file does not actually contain.
      const loaded = settled<Settings | null>(loadedSettings, 'Settings', null)
      if (loaded) setSettings(loaded)
      setClient(settled<GfnClientInfo | null>(info, 'The GeForce NOW client probe', null))
      setAuthenticated(settled(auth, 'Sign-in state', { authenticated: false }).authenticated)
      setRecentIds(settled(recent, 'Play history', []))
    })()
  }, [])

  /**
   * The half of the first load that has to wait for a session.
   *
   * **Sequential, and that is the whole point of the effect.** `library.providers()`
   * is what revives the persisted browser session — a headless capture that takes
   * a few seconds — and `auth.status()` is a synchronous read of the result.
   * Asking for both at once resolves the second one first, out of the state that
   * existed *before* the revival, and pins `authenticated` to false for the rest
   * of the session: the Settings screen then offers "Sign in to GeForce NOW"
   * directly above the list of stores that sign-in just fetched, "Refresh every
   * store library" is disabled with "Sign in first", and the details panel
   * refuses to set a launch store. All of it on an account that is signed in.
   */
  useEffect(() => {
    void (async () => {
      if (!window.launcher) return
      try {
        setProviders(await window.launcher.library.providers())
      } catch (error) {
        console.error('Linked stores could not be loaded:', error)
      }
      try {
        setAuthenticated((await window.launcher.auth.status()).authenticated)
      } catch (error) {
        console.error('Sign-in state could not be read:', error)
      }
    })()
  }, [])

  /**
   * The one token the user owns, pushed onto the document.
   *
   * `--brand` already holds white from the stylesheet, so there is nothing to
   * paint until settings arrive — a launcher that flashed a different accent on
   * every start would read as broken.
   */
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--brand',
      accentValue(settings?.accentColor ?? DEFAULT_ACCENT)
    )
  }, [settings?.accentColor])

  /**
   * True from the first frame until there is a real catalog to show.
   *
   * `catalog:get` answers immediately but may only have seed data, and the walk
   * that replaces it takes about twelve seconds. Rendering fixtures in the
   * meantime would show a grid of tiles that cannot launch and then swap them
   * out — better to hold the shape of the screen and say what is happening.
   * `fixturesAreFinal` is the escape: a refresh that fails must not leave the
   * launcher loading forever.
   */
  const catalogPending =
    catalogSource === null || (catalogSource === 'fixture' && !fixturesAreFinal)

  const library = useMemo(() => games.filter((game) => game.owned), [games])

  /**
   * Play history resolved against the catalog, newest first.
   *
   * Ids that no longer match anything are dropped rather than rendered as
   * blanks: a title can leave the catalog between two runs, and the history
   * outlives the catalog on purpose.
   */
  const recentGames = useMemo(() => {
    const byId = new Map(games.map((game) => [game.cmsId, game]))
    return recentIds
      .map((cmsId) => byId.get(cmsId))
      .filter((game): game is GfnGame => game !== undefined)
  }, [games, recentIds])

  /**
   * The view's games before the filter, and after it.
   *
   * The facets come from `inView`, not from the whole catalog: a library of
   * thirty titles offering twenty genre chips would be twenty ways to empty the
   * grid. `rtxCount` is derived the same way, and for the same reason.
   */
  const inView = view === 'library' ? library : view === 'recent' ? recentGames : games
  const genreFacets = useMemo(() => collectGenres(inView), [inView])
  const rtxCount = useMemo(() => inView.filter((game) => game.rtx).length, [inView])
  const visibleGames = useMemo(() => {
    // Recent is a chronology, not a collection: it carries no strip, and
    // filtering it would punch holes in an order the user is reading as
    // "what I played, in the order I played it".
    if (view === 'recent' || genre === ALL_GENRES) return inView
    if (genre === RTX_FILTER) return inView.filter((game) => game.rtx)
    return inView.filter((game) => game.genres.includes(genre))
  }, [inView, genre, view])

  const results = useMemo(() => {
    const needle = normalise(query)
    if (!needle) return games
    return games.filter((game) => normalise(game.title).includes(needle))
  }, [games, query])

  const overlayOpen =
    detailsGame !== null || searchOpen || shots !== null || powerOpen || updateOpen

  const focusedGame = useMemo(() => {
    const cmsId = focusedId?.replace(/^(tile|result):/, '')
    const match =
      cmsId && cmsId !== focusedId ? games.find((game) => game.cmsId === cmsId) : undefined
    // Falling back to the first tile keeps the hero populated while focus sits
    // on the nav rail, instead of leaving a third of the screen blank.
    return match ?? visibleGames[0] ?? null
  }, [focusedId, games, visibleGames])

  /**
   * Land in the content, not on the nav rail: whatever the view is, the reason
   * for switching to it is what it contains.
   *
   * Keyed on the *reason* rather than on the list, because the list now changes
   * identity for reasons that must not move the cursor — marking a game owned
   * rewrites `games`, and a genre change rewrites `visibleGames` while the user
   * is standing on the strip. Watching the data would yank focus in both cases.
   * A timeout rather than a microtask, so this still wins over the focus
   * manager's "first registered element" fallback.
   */
  const lastLanding = useRef<string | null>(null)

  /**
   * Where the cursor is, readable without making it a dependency.
   *
   * The landing effect below must react to the *reason* for a view change and
   * to nothing else. Depending on `focusedId` directly would make it re-run
   * when the focus manager recovers a lost cursor mid-transition — cancelling
   * its own pending timer, then bailing on `lastLanding` — and the launcher
   * would sit on the nav rail every time the view changed.
   */
  const focusedIdRef = useRef(focusedId)
  focusedIdRef.current = focusedId

  useEffect(() => {
    // An overlay owns the cursor while it is up; re-seating the grid underneath
    // would move where B lands the user back.
    if (overlayOpen) return

    const landing = `${view}/${genre}`
    if (lastLanding.current === landing) return

    const target =
      view === 'settings'
        ? 'setting:auth'
        : // Refresh is the only focusable above the fold, and re-checking is the
          // most useful thing the cursor's first resting place could do here.
          view === 'status'
          ? 'status:refresh'
          : // Same rule on Devices: looking for something is why the screen was
            // opened, and Scan is the only control that is always there.
            view === 'devices'
            ? DEVICES_SCAN_ID
            : // The code is the only focusable on the Support screen, so this
              // is not a preference — without it the chain falls through to a
              // tile that is not mounted, `focus()` parks the id as pending,
              // and that gags the focus manager's own recovery for the rest of
              // the session.
              view === 'support'
              ? DONATE_FOCUS_ID
              : // Cycling from the strip itself: follow the selection along the
                // strip rather than dropping the cursor into the grid mid-flick.
                focusedIdRef.current?.startsWith('genre:')
                ? `genre:${genre}`
                : // Otherwise re-seat the grid. The tile the user was on has
                  // usually just been filtered out, and letting it unregister
                  // unattended hands focus to the nav rail.
                  visibleGames[0] && `tile:${visibleGames[0].cmsId}`
    // Recorded only once there is somewhere to go. On the very first paint the
    // grid is still empty, and marking the landing done there would mean focus
    // never moves off the nav rail when the catalog finally arrives.
    if (!target) return
    lastLanding.current = landing

    const timer = window.setTimeout(() => focus(target), 0)
    return () => window.clearTimeout(timer)
  }, [view, genre, overlayOpen, visibleGames, focus])

  // A filter can vanish under the user: switching to a library that has none of
  // that genre, or un-owning its last title. Clamping here rather than resetting
  // on every view change keeps one rule for all of them — and RTX is checked
  // against its own count, since it is not one of the genre facets.
  useEffect(() => {
    if (genre === ALL_GENRES) return
    if (genre === RTX_FILTER) {
      if (rtxCount === 0) setGenre(ALL_GENRES)
      return
    }
    if (!genreFacets.some((facet) => facet.code === genre)) setGenre(ALL_GENRES)
  }, [genre, genreFacets, rtxCount])

  // A failed hand-off to the browser describes one press, not a standing state.
  // Left alone it would still be sitting under the code on the next visit, with
  // nothing on screen to say it was stale.
  useEffect(() => {
    if (view !== 'support') setDonateError(null)
  }, [view])

  const launch = useCallback(async (game: GfnGame) => {
    // One launch at a time, and a ref rather than the `handoff` state because
    // this callback has `[]` deps and never sees a newer one.
    //
    // Not a nicety: `gfn:launch` opens by killing whatever GeForce NOW instance
    // is running, so a second press during the two seconds it takes to settle
    // and spawn would kill the client that the first press had just started.
    // The input gate does not cover this — the launcher still has focus for the
    // first moment of a handoff — and ☰ is both "Play" and the button somebody
    // reaches for out of impatience.
    if (launching.current) return
    launching.current = true
    setHandoff(true)
    setLaunchNotice(null)

    try {
      // Through the resolver, not the raw cmsId: a title the user has pointed at
      // another store has to start that store's edition.
      const result = await window.launcher.gfn.launch(resolveLaunchTarget(game))

      if (result.ok) {
        // Main wrote the history entry; read it back rather than guessing at
        // the ordering rules, which are its to own.
        setRecentIds(await window.launcher.recent.list())
        // Only the happy path gets the full hold: HANDING OFF is meant to cover
        // the seconds before GFN takes the screen, and there is nothing to
        // cover when nothing is coming. The re-entrancy guard runs out with it,
        // since that is exactly the window in which a second launch would kill
        // the client this one started.
        window.setTimeout(() => {
          launching.current = false
          setHandoff(false)
        }, 2500)
        return
      }

      launching.current = false
      setHandoff(false)
      setLaunchNotice({ reason: launchFailureReason(result), command: result.command })
    } catch (error) {
      // `gfn:launch` answers with a `LaunchResult` rather than throwing, so
      // reaching here means the bridge itself did. Caught because the footer is
      // already reading HANDING OFF: leaving it there would be the launcher
      // claiming a game is starting when nothing is, which is worse than any
      // error it could show instead.
      console.error('Launch request failed:', error)
      launching.current = false
      setHandoff(false)
      setLaunchNotice({
        reason: 'The launcher could not reach its own main process.',
        command: null
      })
    }
  }, [])

  // Long enough to read a command string at three metres, then gone: there is
  // no way to dismiss it by hand, because giving it a button would mean giving
  // it focus, and the cursor belongs to the grid.
  useEffect(() => {
    if (!launchNotice) return
    const timer = window.setTimeout(() => setLaunchNotice(null), LAUNCH_NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [launchNotice])

  const openSearch = useCallback(() => {
    // Remembered the way the details panel and the update notice remember
    // theirs: restoring the scope alone leaves the cursor wherever `focusFirst`
    // puts it, which is the top-left of the screen — the nav rail. Closing a
    // search you opened from a tile should put you back on that tile, not three
    // presses away from it.
    searchOrigin.current = focusedIdRef.current
    setSearchOpen(true)
    setActiveScope(SEARCH_SCOPE)
    // Land on the keyboard, not on the result list — searching is the reason
    // this overlay opened.
    window.setTimeout(() => focus('key:A'), 0)
  }, [setActiveScope, focus])

  const closeSearch = useCallback(() => {
    setSearchClosing(true)
    window.setTimeout(() => {
      const origin = searchOrigin.current
      searchOrigin.current = null
      setSearchOpen(false)
      setSearchClosing(false)
      setQuery('')
      setActiveScope(ROOT_SCOPE)
      // Only a tile, and only one that is still on the grid. Search covers the
      // whole catalog while the grid behind it may be a genre or the library,
      // and a title un-owned from the panel leaves the library while the overlay
      // is up. Asking for an id that is not mounted would park it as pending,
      // which gags the focus manager's own recovery until the next scope change.
      const cmsId = origin?.startsWith('tile:') ? origin.slice('tile:'.length) : null
      if (origin && cmsId && visibleGames.some((game) => game.cmsId === cmsId)) {
        window.setTimeout(() => focus(origin), 0)
      }
    }, EXIT_MS)
  }, [setActiveScope, focus, visibleGames])

  const openDetails = useCallback(
    (game: GfnGame, originId: string, originScope: string) => {
      detailsOrigin.current = { id: originId, scope: originScope }
      setDetailsGame(game)
      setDetails(null)
      setDetailsLoading(true)
      setActiveScope(DETAILS_SCOPE)
      // Land on Play, not on whatever registered first. A timeout rather than a
      // microtask, so this wins over the focus manager's own fallback. It also
      // makes A the whole journey: A on a tile opens this, A again plays.
      window.setTimeout(() => focus('detail:play'), 0)

      void window.launcher.catalog.details(game.cmsId).then((loaded) => {
        // The user may have closed the panel, or opened another title, while
        // this was in flight.
        setDetailsGame((current) => {
          if (current?.cmsId === game.cmsId) {
            setDetails(loaded)
            setDetailsLoading(false)
          }
          return current
        })
      })
    },
    [setActiveScope, focus]
  )

  const closeDetails = useCallback(() => {
    setDetailsClosing(true)
    window.setTimeout(() => {
      const origin = detailsOrigin.current
      detailsOrigin.current = null
      setDetailsGame(null)
      setDetails(null)
      setDetailsClosing(false)
      setStoreNotice(null)
      if (!origin) return
      // Explicitly, because restoring the scope alone would drop the cursor on
      // the nav rail rather than the tile this was opened from.
      setActiveScope(origin.scope)
      window.setTimeout(() => focus(origin.id), 0)
    }, EXIT_MS)
  }, [setActiveScope, focus])

  const openShots = useCallback(
    (index: number, originId: string) => {
      shotsOrigin.current = originId
      setShots(index)
      setActiveScope(SHOTS_SCOPE)
      window.setTimeout(() => focus('shot:stage'), 0)
    },
    [setActiveScope, focus]
  )

  const closeShots = useCallback(() => {
    setShotsClosing(true)
    window.setTimeout(() => {
      const origin = shotsOrigin.current
      shotsOrigin.current = null
      setShots(null)
      setShotsClosing(false)
      setActiveScope(DETAILS_SCOPE)
      // Back to the exact thumbnail, not to the start of the strip: the user
      // came from one image and expects to be standing on it again.
      if (origin) window.setTimeout(() => focus(origin), 0)
    }, EXIT_MS)
  }, [setActiveScope, focus])

  const openPower = useCallback(() => {
    setPowerError(null)
    setPowerOpen(true)
    setActiveScope(POWER_SCOPE)
    // Sleep, not Cancel: it is what the user came here for nine times out of
    // ten, and the destructive options sit further down the list.
    window.setTimeout(() => focus(POWER_FIRST_ID), 0)
  }, [setActiveScope, focus])

  const closePower = useCallback(() => {
    setPowerClosing(true)
    window.setTimeout(() => {
      setPowerOpen(false)
      setPowerClosing(false)
      setPowerBusy(false)
      setActiveScope(ROOT_SCOPE)
      // Back to the rail button that opened this, not to the top of the rail.
      window.setTimeout(() => focus('nav:power'), 0)
    }, EXIT_MS)
  }, [setActiveScope, focus])

  const openUpdate = useCallback(
    (status: UpdateStatus) => {
      updateShown.current = true
      updateOrigin.current = focusedIdRef.current
      setUpdate(status)
      setUpdateResult(null)
      setUpdateProgress(null)
      setUpdateOpen(true)
      setActiveScope(UPDATE_SCOPE)
      // Land on the install row when there is one — the notice exists to be
      // acted on. A timeout rather than a microtask, so this wins over the
      // focus manager's "first registered element" fallback.
      window.setTimeout(() => focus(updateLandingId(status)), 0)
    },
    [setActiveScope, focus]
  )

  const closeUpdate = useCallback(() => {
    setUpdateClosing(true)
    window.setTimeout(() => {
      const origin = updateOrigin.current
      updateOrigin.current = null
      setUpdateOpen(false)
      setUpdateClosing(false)
      setUpdateApplying(false)
      setUpdateProgress(null)
      // Closing stops the countdown, and that is not a detail: a launcher that
      // restarted itself after the notice had gone would look like a crash.
      setRestartIn(null)
      setRestartRefused(false)
      setActiveScope(ROOT_SCOPE)
      // Back to whatever opened this — the Settings row, or wherever the cursor
      // was standing when the check came back on its own.
      if (origin) {
        window.setTimeout(() => focus(origin), 0)
        return
      }
      // No origin means the notice opened itself before the cursor had settled
      // anywhere — a cold start, where the catalog had only just arrived. Clear
      // the landing marker instead of guessing: `overlayOpen` has just changed,
      // so the landing effect re-runs and seats the grid the way it would have
      // if the notice had never appeared.
      lastLanding.current = null
    }, EXIT_MS)
  }, [setActiveScope, focus])

  /**
   * Closes the notice and records the version, so it does not open itself again.
   *
   * The difference between this and `closeUpdate` is the whole reason "Not now"
   * is not just a cancel: without it the popup would reappear on every start
   * until the user gave in, which is the behaviour that makes people turn
   * update checks off entirely.
   */
  const dismissUpdate = useCallback(() => {
    const version = update?.latestVersion
    // Through `setSettings` rather than fire-and-forget: the renderer's copy of
    // the settings is what the auto-open effect reads, and a stale one would
    // have it disagree with the file about what has been dismissed.
    if (version) {
      void window.launcher.settings.update({ dismissedUpdate: version }).then(setSettings)
    }
    closeUpdate()
  }, [update?.latestVersion, closeUpdate])

  /**
   * Installs the update, on the paths where that is the launcher's to do.
   *
   * A failure keeps the notice open and shows the reason and the command,
   * exactly as the power dialog does with a polkit refusal — and leaves the row
   * in place reading "Try again", because the most likely failure here is a
   * connection that dropped halfway.
   */
  const applyUpdate = useCallback(async () => {
    setUpdateApplying(true)
    setUpdateResult(null)
    setUpdateProgress(null)
    try {
      const result = await window.launcher.update.apply()
      setUpdateResult(result)
      if (result.ok) {
        // Nothing left to be told about: the version on disk is the one the
        // notice was offering.
        const version = update?.latestVersion
        if (version) {
          void window.launcher.settings.update({ dismissedUpdate: version }).then(setSettings)
        }
        // Land on whatever the installed state put in front of the user, since
        // the row the cursor was on has just been replaced.
        window.setTimeout(() => focus(result.canRestart ? 'update:restart' : 'update:close'), 0)
        // The launcher has to reopen to be the new version, so it does — after
        // a countdown the user can stop. A Flatpak restarts through the host,
        // an AppImage through Electron; neither is something the renderer has
        // to know about.
        if (result.canRestart) setRestartIn(RESTART_COUNTDOWN_S)
      }
    } finally {
      setUpdateApplying(false)
    }
  }, [update?.latestVersion, focus])

  /**
   * Hands a power action to logind.
   *
   * A refusal keeps the dialog open and says so. Sleep resolves once the
   * machine has already woken again, at which point the dialog has outlived its
   * purpose — the other two never return, because the app is gone.
   */
  const runPower = useCallback(
    async (action: PowerAction) => {
      setPowerBusy(true)
      setPowerError(null)
      const result = await window.launcher.app.power(action)
      if (!result.ok) {
        setPowerBusy(false)
        setPowerError(result.error ?? 'The system refused the request.')
        return
      }
      closePower()
    },
    [closePower]
  )

  /**
   * Steps aside to the desktop, leaving the launcher running.
   *
   * The dialog is dismissed first so the launcher is not sitting on a modal when
   * it comes back — and it comes back through a second launch, since a blurred
   * window gets no gamepad events and cannot raise itself.
   */
  const returnToDesktop = useCallback(() => {
    closePower()
    void window.launcher.app.minimize()
  }, [closePower])

  /**
   * Hands the donation page to the desktop.
   *
   * The QR code beside this is the path that always works; this is the shortcut
   * for a machine that has a browser. A refusal is put on screen rather than
   * swallowed, because the alternative is a press that appears to do nothing.
   */
  const openDonation = useCallback(async () => {
    setDonateError(null)
    const result = await window.launcher.app.openDonation()
    if (!result.ok) {
      setDonateError(result.error ?? 'Nothing on this machine offered to open the link.')
    }
  }, [])

  /** Steps the viewer, wrapping so a held shoulder button never dead-ends. */
  const stepShot = useCallback(
    (step: number) => {
      const total = details?.screenshots.length ?? 0
      if (total === 0) return
      setShots((current) => (current === null ? null : (current + step + total) % total))
    },
    [details]
  )

  /**
   * Applies a store mutation and folds the answer back into the catalog.
   *
   * Main returns the patched game because it has already written it to the
   * cache, so replacing the one entry here keeps the renderer and disk saying
   * the same thing without a twelve-second refresh. A refusal changes nothing
   * but the notice line — a title marked owned that GFN never recorded would
   * disappear at the next refresh with nothing to explain why.
   */
  const applyStoreMutation = useCallback(
    async (run: () => Promise<StoreMutationResult>, success: string) => {
      setStoreBusy(true)
      setStoreNotice(null)
      try {
        const result = await run()
        if (!result.ok || !result.game) {
          setStoreNotice(result.error ?? 'GeForce NOW did not accept the change.')
          return
        }
        const updated = result.game
        setGames((current) =>
          current.map((entry) => (entry.cmsId === updated.cmsId ? updated : entry))
        )
        setDetailsGame((current) => (current?.cmsId === updated.cmsId ? updated : current))
        setStoreNotice(success)
      } finally {
        setStoreBusy(false)
      }
    },
    []
  )

  const selectStore = useCallback(
    (game: GfnGame, store: GameStoreOwnership) =>
      applyStoreMutation(
        () => window.launcher.library.selectVariant(game.cmsId, store.variantId),
        `${game.title} will launch from ${store.storeLabel}.`
      ),
    [applyStoreMutation]
  )

  /**
   * Marks the store under the cursor owned, or clears it.
   *
   * On X rather than a button of its own: the face buttons are all spoken for,
   * and X does nothing inside this panel today. It is the escape hatch for what
   * GFN's store sync cannot reach — Epic being the one most people hit.
   */
  const toggleOwnedForFocus = useCallback(() => {
    if (!detailsGame || !focusedId) return
    const store = detailsGame.stores.find(
      (candidate) => focusedId === `detail:store:${candidate.variantId}`
    )
    if (!store) return

    void applyStoreMutation(
      () => window.launcher.library.setOwned(detailsGame.cmsId, store.variantId, !store.owned),
      store.owned
        ? `No longer marked as owned on ${store.storeLabel}.`
        : `Marked as owned on ${store.storeLabel}.`
    )
  }, [detailsGame, focusedId, applyStoreMutation])

  /** The tile or search result under the cursor, or null anywhere else. */
  const gameForFocus = useCallback(():
    | { game: GfnGame; id: string; scope: string }
    | null => {
    if (!focusedId) return null
    const match = /^(tile|result):(.+)$/.exec(focusedId)
    if (!match) return null
    const game = games.find((candidate) => candidate.cmsId === match[2])
    if (!game) return null
    return { game, id: focusedId, scope: match[1] === 'result' ? SEARCH_SCOPE : ROOT_SCOPE }
  }, [focusedId, games])

  /**
   * Starts the focused title without opening anything.
   *
   * A opens the details panel, which is the right default — but handing a game
   * to GFN is still what the launcher is *for*, and the Start button keeps that
   * one press away for someone who already knows what they want.
   */
  const launchFocused = useCallback(() => {
    const target = gameForFocus()
    if (target) void launch(target.game)
  }, [gameForFocus, launch])

  useIntent((intent) => {
    const shotsOpen = shots !== null

    // A layer on its way out still owns the screen; input during those few
    // frames would act on something the user can no longer see. Above the
    // `move` branch rather than below it, which is where it used to sit: the
    // cursor was free to walk out of a panel that was still on screen while
    // every button was correctly ignored, and there is no reason for the two to
    // disagree.
    if (detailsClosing || searchClosing || shotsClosing || powerClosing || updateClosing) return

    // An update being installed is the one modal state the launcher does not
    // let you leave. Closing would not stop the download, and a dialog that
    // says "installing" while the user is back on the grid is a lie about what
    // the machine is doing. It is seconds long and it ends by itself.
    if (updateApplying) return

    if (intent.kind === 'move') {
      // The viewer holds one image, so there is nowhere for the spatial model
      // to move to. Left and right page the set instead.
      if (shotsOpen) {
        if (intent.direction === 'left') stepShot(-1)
        else if (intent.direction === 'right') stepShot(1)
        return
      }
      move(intent.direction)
      return
    }

    const detailsOpen = detailsGame !== null

    switch (intent.action) {
      case 'confirm':
        if (!shotsOpen) confirm()
        break
      case 'back':
        if (updateOpen) closeUpdate()
        else if (powerOpen) closePower()
        else if (shotsOpen) closeShots()
        else if (detailsOpen) closeDetails()
        else if (searchOpen) closeSearch()
        // Devices is a page of Settings rather than a destination, so B goes
        // back the way the user came in. Everywhere else B means "the library".
        else if (view === 'devices') setView('settings')
        else if (view !== 'library') setView('library')
        break
      case 'search':
        if (shotsOpen || powerOpen || updateOpen) break
        // Inside the panel X is not "search" — there is nothing to search — so
        // it carries the one action the face buttons had no room for.
        if (detailsOpen) {
          toggleOwnedForFocus()
          break
        }
        // Same reasoning one screen over: there is nothing to search on the
        // Devices screen, and forgetting a device is the action A had no room
        // for. Inert unless the cursor is on a paired row.
        if (view === 'devices') {
          forgetFocusedDevice()
          break
        }
        if (searchOpen) closeSearch()
        else openSearch()
        break
      case 'menu':
        if (!searchOpen && !detailsOpen && !shotsOpen && !powerOpen && !updateOpen) {
          setView((current) => (current === 'settings' ? 'library' : 'settings'))
        }
        break
      // Start means nothing on its own — it is whatever the layer in front of
      // the user has left over. On the grid that is the one-press launch that A
      // used to be; in the details panel it is the way back out.
      case 'start':
        if (shotsOpen || powerOpen || updateOpen) break
        if (detailsOpen) closeDetails()
        else launchFocused()
        break
      // The shoulder buttons mean the same thing on both layers: step through
      // the set in front of you. Screenshots in the viewer, genres everywhere
      // else — and never while the search overlay owns the screen.
      case 'pageLeft':
      case 'pageRight': {
        const step = intent.action === 'pageLeft' ? -1 : 1
        if (shotsOpen) stepShot(step)
        else if (
          !detailsOpen &&
          !searchOpen &&
          !powerOpen &&
          !updateOpen &&
          view !== 'settings' &&
          view !== 'status' &&
          view !== 'recent' &&
          view !== 'devices' &&
          view !== 'support'
        ) {
          setGenre((current) => cycleGenre(genreFacets, current, step, rtxCount))
        }
        break
      }
      default:
        break
    }
  })

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    try {
      setSettings(await window.launcher.settings.update(patch))
    } catch (error) {
      // Main keeps a write failure to itself and returns the value anyway, so
      // this only fires if the bridge did — but every row on the Settings
      // screen ends here, and an unhandled rejection would leave one of them
      // as a control that does nothing and says nothing.
      console.error('Settings could not be updated:', error)
    }
  }, [])

  const refreshCatalog = useCallback(async () => {
    setRefreshing(true)
    try {
      const snapshot = await window.launcher.catalog.refresh()
      setGames(snapshot.games)
      setCatalogSource(snapshot.source)
      // A refresh that comes back with seed data has exhausted the options:
      // stop waiting on it and show what there is.
      if (snapshot.source === 'fixture') setFixturesAreFinal(true)
      setProviders(await window.launcher.library.providers())
    } catch (error) {
      // `catalog:refresh` degrades rather than throwing, so reaching here means
      // the bridge itself did — and the important part is not the message, it
      // is releasing `catalogPending`. Without that the launcher waits on a
      // refresh that has already failed, forever, behind a loading bar.
      console.error('Catalogue refresh failed:', error)
      setFixturesAreFinal(true)
    } finally {
      setRefreshing(false)
    }
  }, [])

  /** Re-checks the status board now. What the Refresh control calls. */
  const refreshStatus = useCallback(async () => {
    setStatusRefreshing(true)
    try {
      setStatus(await window.launcher.status.refresh())
    } finally {
      setStatusRefreshing(false)
    }
  }, [])

  /**
   * Loaded on entry to the view, not on first paint.
   *
   * It is a network call, and the rule for those here is that they stay off the
   * path to the first frame — nobody who opens the launcher to play a game is
   * waiting on NVIDIA's status page.
   *
   * On *every* entry rather than only the first, because main holds the board
   * for a minute and revalidates past that: asking each time costs nothing when
   * the user is flicking through the rail, and a launcher left running all
   * evening otherwise keeps showing the board it fetched at boot. The skeleton
   * only appears when there is nothing to show yet, so a re-check does not
   * blank a screen the user is already reading.
   */
  useEffect(() => {
    if (view !== 'status') return
    // Guarded, like the mount-time effects: this one runs during the commit
    // that switches to the view, so with no bridge it would take the whole
    // interface down rather than leaving an empty board behind the footer's
    // report of why.
    if (!window.launcher) return
    setStatusLoading(true)
    void window.launcher.status
      .get()
      .then(setStatus)
      .catch((error: unknown) => console.error('The status board could not be read:', error))
      .finally(() => setStatusLoading(false))
  }, [view])

  /**
   * The Bluetooth snapshot, readable from a cleanup with no dependency on it.
   *
   * Leaving the Devices screen has two things to undo — a running scan and a
   * confirmation BlueZ is holding a `Pair` call open for — and the effect that
   * has to undo them keys on `view` alone. Depending on the snapshot as well
   * would tear the poll down and rebuild it every second.
   */
  const bluetoothRef = useRef<BluetoothSnapshot | null>(null)
  bluetoothRef.current = bluetooth

  /**
   * Reads the adapter for as long as the screen is up.
   *
   * A poll, deliberately — see `BLUETOOTH_POLL_MS`. It also covers the changes
   * that are nobody's press: a headset switched off across the room, a pad
   * whose battery moved, a device BlueZ evicted after the scan stopped.
   */
  useEffect(() => {
    if (view !== 'devices') return
    // Guarded like the status effect: this runs during the commit that switches
    // to the view, so with no bridge it would take the whole interface down
    // rather than leaving an empty screen behind the footer's report of why.
    if (!window.launcher) return

    let live = true
    const read = (): void => {
      void window.launcher.bluetooth
        .get()
        .then((next) => {
          if (!live) return
          setBluetooth(next)
          setBluetoothLoading(false)
        })
        .catch((error: unknown) => console.error('Bluetooth state could not be read:', error))
    }

    setBluetoothLoading(true)
    read()
    const timer = window.setInterval(read, BLUETOOTH_POLL_MS)

    return () => {
      live = false
      window.clearInterval(timer)
      const last = bluetoothRef.current
      // Answered rather than abandoned: BlueZ is blocked on that reply, and a
      // pairing left half-open holds the adapter until the daemon times it out.
      if (last?.request?.kind === 'confirm') void window.launcher.bluetooth.respond(false)
      // The sixty-second timeout in main would get here eventually. Leaving the
      // screen is a clearer statement than a timer, and it is what stops the
      // radio scanning behind a game.
      if (last?.scanning) void window.launcher.bluetooth.scan(false)
    }
  }, [view])

  /**
   * Runs one Bluetooth action and folds the answer back in.
   *
   * Every one of them answers with the snapshot after the fact, so the screen
   * never has to wait a poll to catch up with a press — the same bargain
   * `StoreMutationResult` makes by carrying the patched game.
   */
  const runBluetooth = useCallback(async (run: () => Promise<BluetoothResult>) => {
    setBluetoothNotice(null)
    try {
      const result = await run()
      setBluetooth(result.snapshot)
      setBluetoothLoading(false)
      if (!result.ok) setBluetoothNotice(result.error ?? 'BlueZ refused the request.')
    } catch (error) {
      // These channels answer with a result rather than throwing, so reaching
      // here means the bridge did. Caught because the alternative is a row that
      // spins and never says anything.
      console.error('Bluetooth request failed:', error)
      setBluetoothNotice('The launcher could not reach its own main process.')
    }
  }, [])

  /**
   * The confirmation takes the cursor, and gives it back.
   *
   * Keyed on the address rather than on the request object, which changes
   * identity on every poll. The band is two focusables inside the screen's own
   * scope, so there is nothing to restore beyond putting the cursor back on the
   * row the pairing started from — without which it would land wherever the
   * focus manager recovers to, which is the top of the screen.
   */
  const pendingConfirm =
    bluetooth?.request?.kind === 'confirm' ? bluetooth.request.address : null
  const confirmOrigin = useRef<string | null>(null)

  useEffect(() => {
    if (view !== 'devices') return
    if (pendingConfirm) {
      confirmOrigin.current = pendingConfirm
      const timer = window.setTimeout(() => focus(DEVICES_CONFIRM_ID), 0)
      return () => window.clearTimeout(timer)
    }
    const origin = confirmOrigin.current
    if (!origin) return
    confirmOrigin.current = null
    const timer = window.setTimeout(() => focus(deviceFocusId(origin)), 0)
    return () => window.clearTimeout(timer)
  }, [view, pendingConfirm, focus])

  /** The device under the cursor, for the legend and for X. */
  const focusedDevice = useMemo(() => deviceFor(bluetooth, focusedId), [bluetooth, focusedId])

  /**
   * Forgets the device under the cursor.
   *
   * On X rather than a button of its own, the same repurposing the details
   * panel makes for "mark owned": A is already the row's own action, and a
   * second control inside the row is the nesting that is not allowed here.
   */
  const forgetFocusedDevice = useCallback(() => {
    if (!focusedDevice?.paired) return
    void runBluetooth(() => window.launcher.bluetooth.act('forget', focusedDevice.address))
  }, [focusedDevice, runBluetooth])

  /**
   * Asks every linked store to resync, then reloads what came of it.
   *
   * The wait is the awkward part and is deliberately visible: ALS accepts the
   * request and finishes later, so there is no completion to await and no way
   * to show progress. Reloading the catalog afterwards is the whole point —
   * without it the button would change nothing the user can see.
   */
  const syncAllStores = useCallback(async () => {
    setSyncing(true)
    setSyncNotice(null)
    setSyncFailed(false)
    try {
      const { results, error } = await window.launcher.library.syncAll()
      if (error) {
        setSyncFailed(true)
        setSyncNotice(error)
        return
      }

      const accepted = results.filter((result) => result.accepted).length
      if (accepted === 0) {
        // Every store that refused, not just the first one. Stores usually fail
        // together and for the same reason, so the distinct set is one sentence
        // in the common case and the whole truth in the one that matters.
        const reasons = [
          ...new Set(results.map((result) => result.error).filter((error) => error !== null))
        ]
        setSyncFailed(true)
        setSyncNotice(reasons.join(' · ') || 'No store accepted the request.')
        return
      }

      setSyncNotice(
        `Resync requested from ${accepted} of ${storeCount(results.length)}. Reloading the catalog…`
      )
      await new Promise((resolve) => window.setTimeout(resolve, SYNC_SETTLE_MS))
      await refreshCatalog()
      setSyncNotice(`Resynced ${accepted} of ${storeCount(results.length)}.`)
    } finally {
      setSyncing(false)
    }
  }, [refreshCatalog])

  /** Hands the screen to the real client, for the settings we do not mirror. */
  const openGfnApp = useCallback(async () => {
    setGfnOpenError(null)
    const result = await window.launcher.gfn.open()
    if (!result.ok) {
      console.error('Could not open GeForce NOW:', result.error, result.command)
      setGfnOpenError(result.error ?? 'The GeForce NOW app could not be started.')
    }
  }, [])

  // A machine that has never fetched anything falls back to seed data, whose
  // ids launch nothing. The public catalog needs no account, so pull it as soon
  // as the first paint is done rather than leaving placeholders on screen.
  // Re-running is not a risk: a failed refresh leaves the source unchanged, and
  // the effect only fires when it changes.
  useEffect(() => {
    if (catalogSource !== 'fixture') return
    void refreshCatalog()
  }, [catalogSource, refreshCatalog])

  /**
   * Asks GitHub whether there is a newer launcher, once per run.
   *
   * Off the first-paint path, like every other network call here: nobody who
   * opened the launcher to play a game is waiting on a release feed.
   *
   * Called unconditionally even though the check is a preference, because main
   * owns that decision — with the toggle off it answers out of what it already
   * knows and touches no network, and the Settings nameplate still gets a
   * version to print. The renderer asking "may I?" first would put the same
   * rule in two places.
   */
  useEffect(() => {
    void window.launcher?.update
      .check(false)
      .then(setUpdate)
      // `update:check` degrades rather than throwing, so this only fires if the
      // bridge did. Caught anyway: an unhandled rejection here is invisible, and
      // this call also supplies the version the footer and the Settings
      // nameplate print.
      .catch((error: unknown) => console.error('Update check failed:', error))
  }, [])

  /**
   * Where the log file is.
   *
   * Asked for once, off the first-paint path like every other call that is not
   * needed to draw the grid. It is only ever printed — on the Settings
   * nameplate and on the crash screen — so nothing waits on it.
   */
  useEffect(() => {
    void window.launcher?.app
      .diagnostics()
      .then((diagnostics) => setLogPath(diagnostics.logPath))
      .catch((error: unknown) => console.error('Diagnostics could not be read:', error))
  }, [])

  /**
   * Puts the notice up, once, when there is something to say and room to say it.
   *
   * Separate from the check above because the two have different timing: the
   * check is a background request that may land while the grid is still
   * loading, and a modal that appears over a half-drawn screen — or over an
   * open details panel — reads as an interruption rather than as news. So it
   * waits for the launcher to be sitting still.
   *
   * A version the user has already dismissed is not news either. That is what
   * makes "Not now" mean something.
   */
  useEffect(() => {
    if (updateShown.current || overlayOpen || catalogPending) return
    if (!settings || !update?.available) return
    if (update.latestVersion === settings.dismissedUpdate) return
    openUpdate(update)
  }, [update, settings, overlayOpen, catalogPending, openUpdate])

  /**
   * Byte counts during a download.
   *
   * The one thing main pushes rather than answers, and the subscription is torn
   * down with the component — the preload hands back its own unsubscribe, so
   * this is the whole cleanup.
   */
  //
  // Optional, like the two effects above it, and for a reason worth naming: this
  // one runs on mount and *synchronously*. Reaching through a bridge that failed
  // to load throws during the commit, React unmounts the tree, and the crash
  // screen replaces the launcher — which means the `bootError` the first effect
  // exists to display could never be read. The honest report of a missing
  // preload has to outlive the missing preload.
  useEffect(() => window.launcher?.update.onProgress(setUpdateProgress), [])

  /**
   * The GeForce NOW client changing underneath us — updated, installed or
   * removed while this window has been open.
   *
   * `gfn.info()` in the boot effect above answers once and there is no later
   * moment at which asking again would occur to anyone, so main tells instead.
   * Nothing else is needed in the UI: `signalState` already puts `handoff`
   * ahead of `client`, so a version arriving mid-launch cannot flicker the
   * footer while a game is starting.
   */
  useEffect(() => window.launcher?.gfn.onClient(setClient), [])

  /**
   * The datacenter moving, which happens in the GeForce NOW app rather than
   * here — so the launcher is behind the user when it does, and a Status screen
   * left open would otherwise keep naming the region they left.
   *
   * Only the zone crosses, so it is merged into the snapshot rather than
   * replacing it. With no snapshot yet the push is dropped on purpose: entering
   * the view fetches a whole one, and half a board with an invented timestamp
   * would be worse than none.
   */
  useEffect(
    () =>
      window.launcher?.status.onZone((zone) =>
        setStatus((previous) => (previous ? { ...previous, zone } : previous))
      ),
    []
  )

  /**
   * Counts down to the restart, then asks for it.
   *
   * One second per tick rather than a single timeout, because the number on
   * screen is the whole point — a silent ten-second wait before the launcher
   * vanishes is indistinguishable from a crash.
   *
   * It stops at zero rather than going negative: `restartIn === 0` is the state
   * the notice renders as "Restarting…", and it is also what keeps this from
   * asking twice if the quit takes a moment to arrive.
   */
  useEffect(() => {
    if (restartIn === null) return
    if (restartIn === 0) {
      void window.launcher.update
        .restart()
        .then((restarting) => {
          // Main refuses rather than quitting when it cannot bring the launcher
          // back — a Flatpak with the host permission revoked is the case that
          // matters. Without this the notice would sit on "Restarting…" for a
          // restart that is never coming, which is the one failure on this path
          // nobody three metres away can diagnose.
          if (!restarting) {
            setRestartIn(null)
            setRestartRefused(true)
          }
        })
        .catch((error: unknown) => {
          console.error('Restart request failed:', error)
          setRestartIn(null)
          setRestartRefused(true)
        })
      return
    }
    const timer = window.setTimeout(() => setRestartIn((left) => (left ?? 1) - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [restartIn])

  /** Restarts now, cutting the countdown short. */
  const restartNow = useCallback(() => setRestartIn(0), [])

  /** Re-checks now, ignoring the cache. What the Settings row calls. */
  const checkUpdate = useCallback(async () => {
    setUpdateChecking(true)
    try {
      const status = await window.launcher.update.check(true)
      setUpdate(status)
      // Straight into the notice when there is one: the row was pressed to find
      // out, and making the user find a second control to read the answer would
      // be a step for nothing. No update, and the row says so under itself.
      if (status.available) openUpdate(status)
    } finally {
      setUpdateChecking(false)
    }
  }, [openUpdate])

  const signIn = useCallback(async () => {
    setSigningIn(true)
    setAuthError(null)
    try {
      const result = await window.launcher.auth.signIn()
      setAuthenticated(result.ok)
      setAuthError(result.error)
      if (result.ok) await refreshCatalog()
    } finally {
      setSigningIn(false)
    }
  }, [refreshCatalog])

  const signOut = useCallback(async () => {
    await window.launcher.auth.signOut()
    setAuthenticated(false)
    setProviders([])
    setAuthError(null)
  }, [])

  const signalState: SignalState = launchNotice
    ? 'failed'
    : handoff
      ? 'handoff'
      : client?.installed
        ? 'ready'
        : 'absent'

  /**
   * Entries name actions, not buttons: StatusFooter draws them as A/B/X/Y,
   * ✕/○/□/△ or keycaps depending on what the user is actually holding.
   *
   * Inside the details panel the legend has to follow focus, not just state:
   * A means Play, Set store or View depending on what the cursor is sitting on,
   * and a footer that says "Play" while A sets a store is worse than no footer.
   */
  const legend: LegendEntry[] = updateOpen
    ? // Deliberately empty while an update installs: there is no button, and a
      // legend naming one that does nothing is worse than a bare footer.
      updateApplying
      ? []
      : [
          { action: 'confirm', label: 'Select' },
          { action: 'back', label: 'Close' }
        ]
    : powerOpen
    ? [
        { action: 'confirm', label: 'Select' },
        { action: 'back', label: 'Cancel' }
      ]
    : shots !== null
      ? [{ action: 'back', label: 'Close' }]
      : detailsGame
        ? focusedId?.startsWith('detail:store:')
          ? [
              { action: 'confirm', label: 'Set launch store' },
              {
                action: 'search',
                label: detailsGame.stores.find(
                  (store) => focusedId === `detail:store:${store.variantId}`
                )?.owned
                  ? 'Not owned'
                  : 'Owned'
              },
              { action: 'back', label: 'Close' }
            ]
          : focusedId?.startsWith('detail:shot:')
            ? [
                { action: 'confirm', label: 'View' },
                { action: 'back', label: 'Close' }
              ]
            : [
                { action: 'confirm', label: 'Play' },
                { action: 'back', label: 'Close' }
              ]
        : searchOpen
          ? [
              { action: 'confirm', label: 'Details' },
              { action: 'start', label: 'Play' },
              { action: 'back', label: 'Close search' }
            ]
          : view === 'status'
            ? [
                {
                  action: 'confirm',
                  label: focusedId === 'status:refresh' ? 'Refresh' : 'Expand'
                },
                { action: 'back', label: 'Back' },
                { action: 'menu', label: 'Settings' }
              ]
            : view === 'devices'
              ? [
                  // A means whatever the row under the cursor is for, and the
                  // legend has to say the same word the press will do — which
                  // is why `primaryAction` is read here as well as in the row.
                  {
                    action: 'confirm',
                    label: focusedDevice
                      ? ACTION_LABELS[primaryAction(focusedDevice)]
                      : focusedId === DEVICES_SCAN_ID && bluetooth?.scanning
                        ? 'Stop scanning'
                        : 'Select'
                  },
                  // Only on a row where there is something to forget. X is
                  // inert on the scan control and on a device that is merely
                  // nearby, and a legend naming a button that does nothing is
                  // worse than a shorter legend.
                  ...(focusedDevice?.paired
                    ? [{ action: 'search' as const, label: 'Forget' }]
                    : []),
                  { action: 'back', label: 'Back' },
                  { action: 'menu', label: 'Settings' }
                ]
            : view === 'settings'
              ? [
                  { action: 'confirm', label: 'Toggle' },
                  { action: 'back', label: 'Back' },
                  { action: 'menu', label: 'Library' }
                ]
              : view === 'support'
                ? [
                    { action: 'confirm', label: 'Open in browser' },
                    { action: 'back', label: 'Back' },
                    { action: 'menu', label: 'Settings' }
                  ]
                : [
                    { action: 'confirm', label: 'Details' },
                    { action: 'start', label: 'Play' },
                    { action: 'back', label: 'Back' },
                    { action: 'search', label: 'Search' },
                    { action: 'menu', label: 'Settings' }
                  ]

  return (
    <div
      className={cn(
        'bg-background flex h-full flex-col',
        // The other half of `shouldAcceptInput`, and it closes a hole that
        // predates pointer mode.
        //
        // The pad has been gated since the day a pause menu behind a stream
        // could reach `gfn:launch` and kill the client it was streaming from.
        // The *pointer* never was. A real mouse click on the launcher sitting
        // behind a game still lands on a tile, and pointer mode adds a second
        // way for one to get there: the portal cursor injects a genuine click
        // at the compositor, so a cursor that wanders off the edge of a
        // non-fullscreen GeForce NOW window arrives here.
        //
        // Same gate, same failure direction: a focused launcher is accepted
        // unconditionally, so this can never make a window somebody is looking
        // at unclickable.
        !inputAccepted && 'pointer-events-none'
      )}
    >
      {/* No top bar: above the footer the screen belongs to cover art. */}
      <div className="relative flex min-h-0 flex-1">
        <NavRail view={view} scope={ROOT_SCOPE} onSelect={setView} onPower={openPower} />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {view === 'status' ? (
            // Renders its own header: the Refresh control belongs on the same
            // row as the title, which is the one thing the settings header shape
            // has no room for.
            <StatusScreen
              snapshot={status}
              loading={statusLoading}
              refreshing={statusRefreshing}
              scope={ROOT_SCOPE}
              locale={settings?.locale.replace('_', '-') ?? 'en-US'}
              onRefresh={() => void refreshStatus()}
            />
          ) : view === 'settings' ? (
            <>
              <section className="shrink-0 px-10 pt-8 pb-6">
                <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
                  Launcher
                </p>
                <h1 className="mt-3 text-[clamp(1.9rem,3.4vw,2.75rem)] leading-none font-semibold tracking-tight">
                  Settings
                </h1>
              </section>
              <SettingsScreen
                settings={settings}
                providers={providers}
                scope={ROOT_SCOPE}
                gfnInstalled={client?.installed ?? false}
                gfnVersion={client?.version ?? null}
                gfnProbeError={client?.error ?? null}
                gfnOpenError={gfnOpenError}
                refreshing={refreshing}
                syncing={syncing}
                syncNotice={syncNotice}
                syncFailed={syncFailed}
                authenticated={authenticated}
                signingIn={signingIn}
                authError={authError}
                update={update}
                updateChecking={updateChecking}
                appVersion={update?.currentVersion ?? null}
                logPath={logPath}
                onUpdate={updateSettings}
                onOpenDevices={() => setView('devices')}
                onRefreshCatalog={refreshCatalog}
                onSyncAll={() => void syncAllStores()}
                onOpenGfn={() => void openGfnApp()}
                onSignIn={signIn}
                onSignOut={signOut}
                onCheckUpdate={() => void checkUpdate()}
                onShowUpdate={() => {
                  if (update) openUpdate(update)
                }}
              />
            </>
          ) : view === 'devices' ? (
            // Renders its own header for the reason Status does: the scan
            // control belongs on the same row as the title.
            <DevicesScreen
              snapshot={bluetooth}
              loading={bluetoothLoading}
              scope={ROOT_SCOPE}
              notice={bluetoothNotice}
              onScan={(on) => void runBluetooth(() => window.launcher.bluetooth.scan(on))}
              onPower={(on) => void runBluetooth(() => window.launcher.bluetooth.power(on))}
              onAct={(action: BluetoothAction, address) =>
                void runBluetooth(() => window.launcher.bluetooth.act(action, address))
              }
              onRespond={(accept) =>
                void runBluetooth(() => window.launcher.bluetooth.respond(accept))
              }
            />
          ) : view === 'support' ? (
            // Owns its header too, for a different reason than Status does: the
            // page is a centred plate, and the header is the only part of it
            // that is not.
            <DonateScreen
              scope={ROOT_SCOPE}
              error={donateError}
              onOpen={() => void openDonation()}
            />
          ) : (
            <>
              <HeroPanel game={focusedGame} loading={catalogPending} />
              {/* No strip in Recent: see `visibleGames`. */}
              {!catalogPending && view !== 'recent' && (
                <GenreStrip
                  genres={genreFacets}
                  active={genre}
                  total={inView.length}
                  rtxCount={rtxCount}
                  scope={ROOT_SCOPE}
                  scheme={scheme}
                  onSelect={setGenre}
                />
              )}
              <GameGrid
                games={visibleGames}
                scope={ROOT_SCOPE}
                loading={catalogPending}
                showOwnership={view !== 'library'}
                onActivate={(game) => openDetails(game, `tile:${game.cmsId}`, ROOT_SCOPE)}
                emptyMessage={
                  genre === RTX_FILTER ? (
                    <p className="text-muted-foreground text-sm">
                      Nothing here has ray tracing. Open Catalog to see every RTX title.
                    </p>
                  ) : genre !== ALL_GENRES ? (
                    <p className="text-muted-foreground text-sm">
                      Nothing in this genre. Press the shoulder buttons to try another.
                    </p>
                  ) : view === 'library' ? (
                    <div className="max-w-xl">
                      <p className="text-base">
                        {authenticated ? 'Your library is empty.' : 'Not signed in.'}
                      </p>
                      <p className="text-muted-foreground mt-2 text-sm">
                        {authenticated
                          ? 'Link a store account inside the GeForce NOW app. Everything you own there that reaches the GFN catalog appears here on its own.'
                          : 'The catalog is public and every title here launches, but only a signed-in session knows which ones you own.'}
                      </p>
                    </div>
                  ) : view === 'recent' ? (
                    <div className="max-w-xl">
                      <p className="text-base">Nothing played yet.</p>
                      <p className="text-muted-foreground mt-2 text-sm">
                        The last {RECENT_LIMIT} titles you start from here collect on this screen,
                        newest first. Games launched from the GeForce NOW app itself do not count —
                        the launcher only sees what it hands over.
                      </p>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      The catalog has not been loaded yet.
                    </p>
                  )
                }
              />
            </>
          )}
        </main>

        {searchOpen && (
          <SearchOverlay
            query={query}
            results={results}
            closing={searchClosing}
            suspended={detailsGame !== null}
            onQueryChange={setQuery}
            onActivate={(game) => openDetails(game, `result:${game.cmsId}`, SEARCH_SCOPE)}
          />
        )}

        {detailsGame && (
          <GameDetailsModal
            game={detailsGame}
            details={details}
            loading={detailsLoading}
            closing={detailsClosing}
            locale={settings?.locale ?? 'en_US'}
            authenticated={authenticated}
            busy={storeBusy}
            notice={storeNotice}
            onPlay={() => {
              void launch(detailsGame)
              closeDetails()
            }}
            onClose={closeDetails}
            onOpenShot={(index) => openShots(index, `detail:shot:${index}`)}
            onSelectStore={(store) => void selectStore(detailsGame, store)}
          />
        )}

        {shots !== null && details && detailsGame && (
          <ScreenshotViewer
            shots={details.screenshots}
            index={shots}
            title={detailsGame.title}
            closing={shotsClosing}
            onClose={closeShots}
          />
        )}

        {powerOpen && (
          <PowerDialog
            closing={powerClosing}
            busy={powerBusy}
            error={powerError}
            onRun={(action) => void runPower(action)}
            onDesktop={returnToDesktop}
            onClose={closePower}
          />
        )}

        {updateOpen && update && (
          <UpdateDialog
            status={update}
            progress={updateProgress}
            applying={updateApplying}
            result={updateResult}
            restartIn={restartIn}
            restartRefused={restartRefused}
            closing={updateClosing}
            onApply={() => void applyUpdate()}
            onRestart={restartNow}
            onDismiss={dismissUpdate}
            onClose={closeUpdate}
          />
        )}
      </div>

      <LaunchNotice notice={launchNotice} />

      <LoadingBar active={catalogPending || refreshing || statusRefreshing} />

      <StatusFooter
        entries={legend}
        scheme={scheme}
        signal={signalState}
        version={client?.version ?? null}
        // Off the update status rather than a channel of its own: main answers
        // `currentVersion` whether or not the check is allowed to touch the
        // network, which is exactly why the Settings nameplate reads it there
        // too. Null until that first call lands, and the footer simply has one
        // fewer item until it does.
        appVersion={update?.currentVersion ?? null}
        status={
          // Ahead of both of the others: with no bridge there is nothing for a
          // pad to drive, so reporting on the pad would be describing the wrong
          // problem.
          bootError
            ? bootError
            : !windowFocused
              ? 'WINDOW NOT FOCUSED — PAD INPUT PAUSED'
              : !connected
                ? 'NO GAMEPAD DETECTED — USING ARROW KEYS'
                : null
        }
      />
    </div>
  )
}
