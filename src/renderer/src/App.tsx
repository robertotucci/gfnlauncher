import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  CatalogSnapshot,
  GameDetails,
  GameStoreOwnership,
  GfnClientInfo,
  GfnGame,
  LinkedProvider,
  PowerAction,
  Settings,
  StatusSnapshot,
  StoreMutationResult
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
import { useGamepad, useIntent } from '@/gamepad/GamepadProvider'
import { useSpatialFocus } from '@/focus/SpatialFocus'
import { NavRail, type View } from '@/components/NavRail'
import { HeroPanel } from '@/components/HeroPanel'
import { GenreStrip } from '@/components/GenreStrip'
import { GameGrid } from '@/components/GameGrid'
import { SettingsScreen } from '@/components/SettingsScreen'
import { StatusScreen } from '@/components/StatusScreen'
import { SearchOverlay, SEARCH_SCOPE } from '@/components/SearchOverlay'
import { GameDetailsModal, DETAILS_SCOPE } from '@/components/GameDetailsModal'
import { ScreenshotViewer, SHOTS_SCOPE } from '@/components/ScreenshotViewer'
import { PowerDialog, POWER_FIRST_ID, POWER_SCOPE } from '@/components/PowerDialog'
import { StatusFooter, type LegendEntry, type SignalState } from '@/components/StatusFooter'
import { LoadingBar } from '@/components/LoadingBar'
import {
  LaunchNotice,
  launchFailureReason,
  type LaunchNoticeState
} from '@/components/LaunchNotice'

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

/** "1 store" / "3 stores", so the notice line reads like a sentence. */
function storeCount(count: number): string {
  return `${count} store${count === 1 ? '' : 's'}`
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
  /** A store mutation is in flight, and what the last one had to say. */
  const [storeBusy, setStoreBusy] = useState(false)
  const [storeNotice, setStoreNotice] = useState<string | null>(null)
  const [handoff, setHandoff] = useState(false)
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
  const [authenticated, setAuthenticated] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const { connected, windowFocused, scheme } = useGamepad()
  const { focusedId, focus, move, confirm, setActiveScope } = useSpatialFocus()

  // Everything the first paint needs, and nothing that can block it. Listing
  // providers may revive a browser session, which takes seconds — it must not
  // hold the UI hostage, so it runs on its own afterwards.
  useEffect(() => {
    void (async () => {
      const [snapshot, loadedSettings, info, auth, recent] = await Promise.all([
        window.launcher.catalog.get(),
        window.launcher.settings.get(),
        window.launcher.gfn.info(),
        window.launcher.auth.status(),
        // Ten ids off a local file: cheap enough to belong in the first batch,
        // and the Recent rail item is a dead end until it arrives.
        window.launcher.recent.list()
      ])
      setGames(snapshot.games)
      setCatalogSource(snapshot.source)
      setSettings(loadedSettings)
      setClient(info)
      setAuthenticated(auth.authenticated)
      setRecentIds(recent)
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      setProviders(await window.launcher.library.providers())
      setAuthenticated((await window.launcher.auth.status()).authenticated)
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

  const overlayOpen = detailsGame !== null || searchOpen || shots !== null || powerOpen

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
          : // Cycling from the strip itself: follow the selection along the strip
          // rather than dropping the cursor into the grid mid-flick.
          focusedIdRef.current?.startsWith('genre:')
          ? `genre:${genre}`
          : // Otherwise re-seat the grid. The tile the user was on has usually
            // just been filtered out, and letting it unregister unattended
            // hands focus to the nav rail.
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

  const launch = useCallback(async (game: GfnGame) => {
    setHandoff(true)
    setLaunchNotice(null)
    // Through the resolver, not the raw cmsId: a title the user has pointed at
    // another store has to start that store's edition.
    const result = await window.launcher.gfn.launch(resolveLaunchTarget(game))

    if (result.ok) {
      // Main wrote the history entry; read it back rather than guessing at the
      // ordering rules, which are its to own.
      setRecentIds(await window.launcher.recent.list())
      // Only the happy path gets the full hold: HANDING OFF is meant to cover
      // the seconds before GFN takes the screen, and there is nothing to cover
      // when nothing is coming.
      window.setTimeout(() => setHandoff(false), 2500)
      return
    }

    setHandoff(false)
    setLaunchNotice({ reason: launchFailureReason(result), command: result.command })
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
    setSearchOpen(true)
    setActiveScope(SEARCH_SCOPE)
    // Land on the keyboard, not on the result list — searching is the reason
    // this overlay opened.
    window.setTimeout(() => focus('key:A'), 0)
  }, [setActiveScope, focus])

  const closeSearch = useCallback(() => {
    setSearchClosing(true)
    window.setTimeout(() => {
      setSearchOpen(false)
      setSearchClosing(false)
      setQuery('')
      setActiveScope(ROOT_SCOPE)
    }, EXIT_MS)
  }, [setActiveScope])

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

    // A layer on its way out still owns the screen; input during those few
    // frames would act on something the user can no longer see.
    if (detailsClosing || searchClosing || shotsClosing || powerClosing) return

    const detailsOpen = detailsGame !== null

    switch (intent.action) {
      case 'confirm':
        if (!shotsOpen) confirm()
        break
      case 'back':
        if (powerOpen) closePower()
        else if (shotsOpen) closeShots()
        else if (detailsOpen) closeDetails()
        else if (searchOpen) closeSearch()
        else if (view !== 'library') setView('library')
        break
      case 'search':
        if (shotsOpen || powerOpen) break
        // Inside the panel X is not "search" — there is nothing to search — so
        // it carries the one action the face buttons had no room for.
        if (detailsOpen) {
          toggleOwnedForFocus()
          break
        }
        if (searchOpen) closeSearch()
        else openSearch()
        break
      case 'menu':
        if (!searchOpen && !detailsOpen && !shotsOpen && !powerOpen) {
          setView((current) => (current === 'settings' ? 'library' : 'settings'))
        }
        break
      // Start means nothing on its own — it is whatever the layer in front of
      // the user has left over. On the grid that is the one-press launch that A
      // used to be; in the details panel it is the way back out.
      case 'start':
        if (shotsOpen || powerOpen) break
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
          view !== 'settings' &&
          view !== 'status' &&
          view !== 'recent'
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
    setSettings(await window.launcher.settings.update(patch))
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
    setStatusLoading(true)
    void window.launcher.status
      .get()
      .then(setStatus)
      .finally(() => setStatusLoading(false))
  }, [view])

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
        setSyncFailed(true)
        setSyncNotice(results[0]?.error ?? 'No store accepted the request.')
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
  const legend: LegendEntry[] = powerOpen
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
            : view === 'settings'
              ? [
                  { action: 'confirm', label: 'Toggle' },
                  { action: 'back', label: 'Back' },
                  { action: 'menu', label: 'Library' }
                ]
              : [
                  { action: 'confirm', label: 'Details' },
                  { action: 'start', label: 'Play' },
                  { action: 'back', label: 'Back' },
                  { action: 'search', label: 'Search' },
                  { action: 'menu', label: 'Settings' }
                ]

  return (
    <div className="bg-background flex h-full flex-col">
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
                onUpdate={updateSettings}
                onRefreshCatalog={refreshCatalog}
                onSyncAll={() => void syncAllStores()}
                onOpenGfn={() => void openGfnApp()}
                onSignIn={signIn}
                onSignOut={signOut}
              />
            </>
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
      </div>

      <LaunchNotice notice={launchNotice} />

      <LoadingBar active={catalogPending || refreshing || statusRefreshing} />

      <StatusFooter
        entries={legend}
        scheme={scheme}
        signal={signalState}
        version={client?.version ?? null}
        status={
          !windowFocused
            ? 'WINDOW NOT FOCUSED — PAD INPUT PAUSED'
            : !connected
              ? 'NO GAMEPAD DETECTED — USING ARROW KEYS'
              : null
        }
      />
    </div>
  )
}
