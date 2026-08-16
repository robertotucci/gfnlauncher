import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AuthResult,
  AuthStatus,
  CatalogSnapshot,
  GameDetails,
  GfnClientInfo,
  GfnGame,
  LaunchResult,
  LinkedProvider,
  PowerResult,
  Settings,
  StatusSnapshot,
  StoreMutationResult,
  SyncAllResult,
  SyncResult
} from '@shared/types'
import { resolveLaunchPath } from '@shared/games'
import { isPowerAction, runPowerAction } from './power'
import { detectGfn } from './gfn/flatpak'
import { isLaunchRequest, launchGame, openGfnClient } from './gfn/launch'
import { launchViaWeb } from './gfn/webStream'
import { getCatalog, markOwned, markSelected, patchGame, refreshCatalog } from './gfn/catalog'
import { getDetails } from './gfn/details'
import type { GfnGraphQLConfig } from './gfn/graphql'
import { listProviders, selectVariant, setOwned } from './gfn/library'
import { syncProvider, type AlsConfig } from './gfn/als'
import { readAlsServerUrl } from './gfn/appConfig'
import { ensureSession, isAuthenticated, signIn, signOut } from './gfn/session'
import { listRecent, recordPlay } from './recent'
import { getStatus, refreshStatus } from './status'
import { getSettings, updateSettings } from './settings'
import { applyUiScale } from './uiScale'

const NOT_CONNECTED = 'Not connected to a GeForce NOW session'

/**
 * Gets the launcher off the screen without closing it.
 *
 * **Fullscreen first, then minimise.** On Linux `minimize()` is a request to the
 * window manager, and a good many of them — plus Wayland compositors, where
 * `set_minimized` is explicitly a hint — ignore an iconify request aimed at a
 * fullscreen surface. Dropping fullscreen makes it an ordinary window first, so
 * the request is one the compositor will honour. The failure it avoids is silent:
 * the launcher simply stays on top of whatever it was stepping aside for.
 *
 * `main/index.ts` puts fullscreen back when the window is restored.
 *
 * Shared by "Back to desktop" and by `hideOnLaunch`, because two minimise paths
 * would drift and only one of them would ever get fixed.
 */
function stepAside(window: BrowserWindow | null): void {
  // `mainWindow` is never cleared, so this can be handed a destroyed window;
  // calling into one throws, and inside `gfn:launch` that would report a failure
  // for a game that had already started.
  if (!window || window.isDestroyed()) return
  if (window.isFullScreen()) window.setFullScreen(false)
  window.minimize()
}

/**
 * Brings the launcher back after a window we own closed on top of it.
 *
 * The mirror of `stepAside`, and the same reasoning as the `second-instance`
 * handler in `main/index.ts`: fullscreen has to be re-applied from settings or
 * the launcher returns as a 1600x900 desktop app and stays one. Only the web
 * stream path needs this — the native client is somebody else's process, so
 * there is no close event to hang it off.
 */
async function restoreLauncher(window: BrowserWindow | null): Promise<void> {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if ((await getSettings()).fullscreen) window.setFullScreen(true)
  window.focus()
}

/**
 * All privileged work lives behind these handlers. The renderer never spawns a
 * process, touches the filesystem, or holds a GFN token.
 *
 * Anything needing a live session degrades to an empty or refused result rather
 * than throwing across the bridge: an unauthenticated launcher should still
 * browse its cache and launch games, because the deep link needs no token.
 */
export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.gfnInfo, async (): Promise<GfnClientInfo> => detectGfn())

  ipcMain.handle(IPC.gfnLaunch, async (_event, request: unknown): Promise<LaunchResult> => {
    // Validated here as well as inside `launchGame`, the same way `app:power`
    // guards its union: an unchecked payload becomes a TypeError, and a
    // rejected promise is the one result shape the renderer cannot render.
    if (!isLaunchRequest(request)) {
      return {
        ok: false,
        command: null,
        error: 'Malformed launch request',
        mode: 'native'
      }
    }

    const settings = await getSettings()
    const path = resolveLaunchPath(settings.launchMode, (await detectGfn()).installed)

    const result =
      path === 'web'
        ? await launchViaWeb(request, () => void restoreLauncher(getWindow()))
        : await launchGame(request)

    if (result.ok) {
      // The one choke point downstream of a confirmed start, so it is where
      // play history is written. `gameId`, not `cmsId`: the latter is the
      // store edition GFN was handed, which does not match a tile.
      await recordPlay(request.gameId)

      // Never on the web path: that stream is our own window, and a minimised
      // launcher behind it could not be raised again once it closed — the pad
      // cannot focus a blurred window. `restoreLauncher` handles the way back.
      if (path === 'native' && settings.hideOnLaunch) {
        // GFN takes over the screen; stepping aside avoids fighting it for
        // focus, which would also kill our own gamepad input.
        stepAside(getWindow())
      }
    }

    return result
  })

  ipcMain.handle(IPC.gfnOpen, async (): Promise<LaunchResult> => {
    const result = await openGfnClient()
    // Unconditional, unlike `hideOnLaunch`: the point of this button is to put
    // the user in front of the GFN window, and a fullscreen launcher sitting on
    // top of it would make the button look like it did nothing.
    if (result.ok) stepAside(getWindow())
    return result
  })

  ipcMain.handle(IPC.authStatus, async (): Promise<AuthStatus> => ({
    authenticated: isAuthenticated()
  }))

  ipcMain.handle(IPC.authSignIn, async (): Promise<AuthResult> => {
    try {
      const { locale } = await getSettings()
      await signIn(locale)
      // Remember that a browser session now exists, so a later start knows it
      // is worth reviving headlessly.
      await updateSettings({ gfnLinked: true })
      return { ok: true, error: null }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Sign-in failed' }
    }
  })

  ipcMain.handle(IPC.authSignOut, async (): Promise<void> => {
    await signOut()
    await updateSettings({ gfnLinked: false })
  })

  ipcMain.handle(IPC.catalogGet, async (): Promise<CatalogSnapshot> => getCatalog())

  ipcMain.handle(IPC.catalogRefresh, async (): Promise<CatalogSnapshot> => {
    const { locale, gfnLinked } = await getSettings()
    // No session is not a failure here: `refreshCatalog` falls back to the
    // public feed, which needs no account and still launches.
    return refreshCatalog((await ensureSession(locale, gfnLinked)) ?? undefined, locale)
  })

  // Never touches the network: details are harvested during a catalog refresh
  // and read back from disk, so opening the panel cannot stall on a request.
  ipcMain.handle(
    IPC.catalogDetails,
    async (_event, cmsId: string): Promise<GameDetails | null> => getDetails(cmsId)
  )

  ipcMain.handle(IPC.libraryProviders, async (): Promise<LinkedProvider[]> => {
    const { locale, gfnLinked } = await getSettings()
    const session = await ensureSession(locale, gfnLinked)
    if (!session) return []
    try {
      return await listProviders(session)
    } catch (error) {
      console.error('Provider listing failed:', error)
      return []
    }
  })

  /**
   * Builds the ALS client's configuration from the live session.
   *
   * ALS is a different backend from the GraphQL API but authenticates off the
   * same partition, so it gets the same captured credentials. Its base URL is
   * read from the installed client rather than hardcoded — a proxy override can
   * replace it, and the launcher must follow whatever the client is using.
   */
  async function alsConfig(session: GfnGraphQLConfig): Promise<AlsConfig> {
    return {
      serverUrl: await readAlsServerUrl(),
      // Deliberately not `session.token`. That credential is scoped to the
      // GraphQL gateway, and handing it to a different service is how a
      // request that the partition's cookies would have authenticated gets
      // rejected instead. `als.ts` strips the captured one for the same reason.
      token: null,
      clientId: session.clientId,
      clientVersion: session.clientVersion,
      headers: session.headers
    }
  }

  ipcMain.handle(
    IPC.librarySync,
    async (_event, providerId: string): Promise<SyncResult> => {
      const { locale, gfnLinked } = await getSettings()
      const session = await ensureSession(locale, gfnLinked)
      if (!session) return { accepted: false, providerId, error: NOT_CONNECTED }
      return syncProvider(await alsConfig(session), providerId)
    }
  )

  /**
   * Asks every linked store to resync.
   *
   * Stores are independent, so they go out together and each reports for
   * itself — one expired link should not stop the others. An empty `results`
   * with an `error` means there was nothing to ask, which the UI has to be able
   * to tell apart from every store refusing.
   */
  ipcMain.handle(IPC.librarySyncAll, async (): Promise<SyncAllResult> => {
    const { locale, gfnLinked } = await getSettings()
    const session = await ensureSession(locale, gfnLinked)
    if (!session) return { results: [], error: NOT_CONNECTED }

    let providers: LinkedProvider[]
    try {
      providers = await listProviders(session)
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : 'Could not list linked stores'
      }
    }

    // An expired or unlinked store has nothing to sync; asking anyway would
    // report a failure the user cannot act on from here.
    const linked = providers.filter((provider) => provider.state === 'linked')
    if (linked.length === 0) return { results: [], error: 'No linked stores to sync' }

    const config = await alsConfig(session)
    return {
      results: await Promise.all(
        linked.map((provider) => syncProvider(config, provider.id))
      ),
      error: null
    }
  })

  /**
   * Runs a mutation against one store's edition, then mirrors the result into
   * the cached catalog.
   *
   * The patch is applied **only** after the server accepted the change: a
   * locally-marked title that GFN never recorded would vanish on the next
   * refresh with nothing to explain why. On success the patched game travels
   * back so the renderer can swap one entry instead of re-fetching the catalog.
   */
  async function mutateVariant(
    cmsId: string,
    mutate: (session: GfnGraphQLConfig) => Promise<void>,
    patch: (game: GfnGame) => GfnGame
  ): Promise<StoreMutationResult> {
    const { locale, gfnLinked } = await getSettings()
    const session = await ensureSession(locale, gfnLinked)
    if (!session) return { ok: false, error: NOT_CONNECTED, game: null }

    try {
      await mutate(session)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Request failed',
        game: null
      }
    }

    return { ok: true, error: null, game: await patchGame(cmsId, patch) }
  }

  ipcMain.handle(
    IPC.librarySetOwned,
    async (_event, cmsId: string, variantId: string, owned: boolean) =>
      mutateVariant(
        cmsId,
        (session) => setOwned(session, variantId, owned),
        markOwned(variantId, owned)
      )
  )

  ipcMain.handle(IPC.librarySelectVariant, async (_event, cmsId: string, variantId: string) =>
    mutateVariant(
      cmsId,
      (session) => selectVariant(session, variantId),
      markSelected(variantId)
    )
  )

  // Neither throws: a failed fetch comes back as a snapshot carrying `error`.
  // The zone half is read off a local file and is worth showing on its own, so
  // an unreachable status page must not cost the whole screen.
  ipcMain.handle(IPC.statusGet, async (): Promise<StatusSnapshot> => getStatus())
  ipcMain.handle(IPC.statusRefresh, async (): Promise<StatusSnapshot> => refreshStatus())

  ipcMain.handle(IPC.recentList, async (): Promise<string[]> => listRecent())

  ipcMain.handle(IPC.settingsGet, async (): Promise<Settings> => getSettings())
  ipcMain.handle(
    IPC.settingsUpdate,
    async (_event, patch: Partial<Settings>): Promise<Settings> => {
      const next = await updateSettings(patch)
      // Applied here rather than waiting for a reload: the cursor is sitting on
      // the scale row, and a size control that only takes effect next start is
      // a control nobody can judge.
      if (patch.uiScale !== undefined) applyUiScale(getWindow(), next.uiScale)
      return next
    }
  )

  ipcMain.handle(IPC.appQuit, async (): Promise<void> => {
    app.quit()
  })

  ipcMain.handle(IPC.appMinimize, async (): Promise<void> => {
    stepAside(getWindow())
  })

  ipcMain.handle(IPC.appPower, async (_event, action: unknown): Promise<PowerResult> => {
    // Validated rather than trusted: whatever arrives here becomes an argument
    // to systemctl, and the channel is where the renderer stops being ours.
    if (!isPowerAction(action)) {
      return { ok: false, command: null, error: `Unknown power action: ${String(action)}` }
    }
    return runPowerAction(action)
  })
}
