import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { DONATION_URL } from '@shared/donate'
import { isBluetoothAction, isBluetoothAddress } from '@shared/bluetooth'
import type {
  AuthResult,
  AuthStatus,
  BluetoothResult,
  BluetoothSnapshot,
  CatalogSnapshot,
  Diagnostics,
  GameDetails,
  GfnClientInfo,
  GfnGame,
  LaunchResult,
  LinkedProvider,
  OpenResult,
  PowerResult,
  Settings,
  StatusSnapshot,
  StoreMutationResult,
  SyncAllResult,
  SyncResult,
  UpdateApplyResult,
  UpdateStatus
} from '@shared/types'
import { resolveLaunchPath } from '@shared/games'
import type { PadProfile } from '@shared/padLayout'
import { listPadProfiles } from './padProfile'
import { isPowerAction, runPowerAction } from './power'
import { act, getBluetooth, respondToPairing, setPowered, setScan } from './bluetooth'
import { createDisplayWakeLock } from './displaySleep'
import { IS_SANDBOXED } from './host'
import { logFilePath } from './log'
import { detectGfn } from './gfn/flatpak'
import { armHandback, disarmHandback } from './gfn/handback'
import { isLaunchRequest, launchGame, openGfnClient } from './gfn/launch'
import { launchViaWeb } from './gfn/webStream'
import { getCatalog, markOwned, markSelected, patchGame, refreshCatalog } from './gfn/catalog'
import { getDetails } from './gfn/details'
import type { GfnGraphQLConfig } from './gfn/graphql'
import { listProviders, selectVariant, setOwned } from './gfn/library'
import { syncProvider, type AlsConfig } from './gfn/als'
import { readAlsServerUrl } from './gfn/appConfig'
import {
  ensureSession,
  getAlsToken,
  invalidateSession,
  isAuthenticated,
  signIn,
  signOut
} from './gfn/session'
import { updatePointerSettings } from './pointer'
import { listRecent, recordPlay } from './recent'
import { setHandedOff } from './screen'
import { getStatus, refreshStatus } from './status'
import { getSettings, updateSettings } from './settings'
import { applyUpdate, getUpdateStatus, restartIntoUpdate, updateChannel } from './update'
import { applyUiScale } from './uiScale'
import { restoreLauncher, setFullscreen, stepAside } from './window'

const NOT_CONNECTED = 'Not connected to a GeForce NOW session'

/**
 * All privileged work lives behind these handlers. The renderer never spawns a
 * process, touches the filesystem, or holds a GFN token.
 *
 * Anything needing a live session degrades to an empty or refused result rather
 * than throwing across the bridge: an unauthenticated launcher should still
 * browse its cache and launch games, because the deep link needs no token.
 */
export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const displayWakeLock = createDisplayWakeLock(getWindow)

  ipcMain.handle(IPC.gfnInfo, async (): Promise<GfnClientInfo> => detectGfn())

  ipcMain.handle(IPC.gfnLaunch, async (_event, request: unknown): Promise<LaunchResult> => {
    // Validated here as well as inside `launchGame`, the same way `app:power`
    // guards its union: an unchecked payload becomes a TypeError, and a
    // rejected promise is the one result shape the renderer cannot render.
    if (!isLaunchRequest(request)) {
      console.error('Refused a malformed launch request from the renderer.')
      return {
        ok: false,
        command: null,
        error: 'Malformed launch request',
        mode: 'native'
      }
    }

    // Before anything else, and specifically before `launchGame` — whose first
    // act is `killGfn()`. A watch left armed by the previous launch would read
    // that kill as "the session ended", find the client gone during
    // `KILL_SETTLE_MS`, and raise the launcher on top of a launch two seconds
    // from spawning.
    disarmHandback()

    // Before the kill and the spawn, not after, so the `KILL_SETTLE_MS` gap and
    // the client's own start-up are covered too — the launcher is about to be
    // behind something and it should stop acting on the pad from here. Released
    // below if nothing starts, and by the session watch's `onEnded` otherwise.
    setHandedOff(true, 'launching a game')

    const settings = await getSettings()
    const installed = (await detectGfn()).installed
    const path = resolveLaunchPath(settings.launchMode, installed)

    // The decision, not just the outcome. `launchMode: auto` silently choosing
    // the web player because a probe came back false is the most confusing
    // thing this launcher can do — `LaunchMode` refuses to make it the default
    // for exactly that reason — and this line is what makes it visible after
    // the fact rather than something the user has to guess at.
    console.info(
      `Launching ${request.gameId} (variant ${request.cmsId}) via ${path} ` +
        `[mode=${settings.launchMode}, client ${installed ? 'installed' : 'not installed'}]`
    )

    const result =
      path === 'web'
        ? await launchViaWeb(request, () => {
            // Our own window, but a fullscreen one that takes the focus, so the
            // launcher behind it is in exactly the position it is in behind the
            // native client.
            setHandedOff(false, 'web stream closed')
            void restoreLauncher(getWindow())
          })
        : await launchGame(request, {
            // Armed on the spawn rather than after the await, so the watch
            // exists before the client can possibly have finished a session.
            onSpawned: (child) =>
              armHandback({
                child,
                autoClose: true,
                onClientGone: () => void restoreLauncher(getWindow()),
                onEnded: () => setHandedOff(false, 'session watch ended')
              })
          })

    if (result.ok) {
      // The one choke point downstream of a confirmed start, so it is where
      // play history is written. `gameId`, not `cmsId`: the latter is the
      // store edition GFN was handed, which does not match a tile.
      await recordPlay(request.gameId)
    } else {
      // Nothing started, so no watch was armed and nothing else will release it.
      setHandedOff(false, 'launch failed')
    }

    // **The launcher deliberately does not step aside here.** GFN opens
    // fullscreen on top of it on its own, and an iconified launcher is one the
    // pad cannot raise — which used to make quitting a game a dead end. It stays
    // where it is and `armHandback` brings it back to the front when the client
    // goes away.
    //
    // Which is why `setHandedOff` above is not optional. A launcher left mapped,
    // fullscreen and polling behind a stream is one Chromium keeps handing pad
    // data to, and it spent every game acting on it: the cursor moved, and a
    // pause menu could reach this handler and kill the client it is streaming
    // from. Staying put is right; staying put *and* staying live was the bug.

    return result
  })

  ipcMain.handle(IPC.gfnOpen, async (): Promise<LaunchResult> => {
    disarmHandback()
    const result = await openGfnClient({
      // `autoClose: false`: the user asked for the real client on purpose, so
      // nothing here ends it. The watch is still worth arming — in a desktop
      // session this path minimises, and there is nothing a pad can do to raise
      // an iconified window, so the way back matters more here rather than less.
      onSpawned: (child) =>
        armHandback({
          child,
          autoClose: false,
          onClientGone: () => void restoreLauncher(getWindow()),
          onEnded: () => setHandedOff(false, 'session watch ended')
        })
    })
    // Unlike the launch path above: the point of this button is to put the user
    // in front of the GFN window for the things the launcher does not mirror,
    // and a fullscreen launcher on top of it would make the button look broken.
    if (result.ok) {
      setHandedOff(true, 'the GeForce NOW client was opened')
      stepAside(getWindow())
    }
    return result
  })

  ipcMain.handle(IPC.authStatus, async (): Promise<AuthStatus> => ({
    authenticated: isAuthenticated()
  }))

  ipcMain.handle(IPC.authSignIn, async (): Promise<AuthResult> => {
    // NVIDIA's login page is the one part of the product that is not
    // gamepad-navigable, so it is also the one place where the user is typing a
    // password into a window of ours while the launcher sits behind it. Driving
    // the grid blind underneath that is the same defect as driving it behind a
    // game, and it wants the same answer.
    setHandedOff(true, 'the sign-in window is open')
    try {
      const { locale } = await getSettings()
      await signIn(locale)
      // Remember that a browser session now exists, so a later start knows it
      // is worth reviving headlessly.
      await updateSettings({ gfnLinked: true })
      return { ok: true, error: null }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Sign-in failed' }
    } finally {
      setHandedOff(false, 'the sign-in window is closed')
    }
  })

  ipcMain.handle(IPC.authSignOut, async (): Promise<void> => {
    // `clearStorageData` reaching into Chromium's session store can fail, and a
    // rejection here crosses as a rejected promise — the one shape the renderer
    // does not model, which would leave "Sign out" as a control that does
    // nothing. The in-memory session is dropped either way, so the worst case
    // is a persisted cookie jar that outlives the sign-out, which the next
    // sign-in overwrites.
    try {
      await signOut()
    } catch (error) {
      console.error('Sign-out could not clear the stored session:', error)
    }
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
   * ALS is a different backend from the GraphQL API and, unlike it, does not
   * accept the partition's cookies: it wants the Starfleet id token the capture
   * reads off the hosted web client. Its base URL is read from the installed
   * client rather than hardcoded — a proxy override can replace it, and the
   * launcher must follow whatever the client is using.
   */
  async function alsConfig(session: GfnGraphQLConfig): Promise<AlsConfig> {
    return {
      serverUrl: await readAlsServerUrl(),
      // Deliberately not `session.token`. That credential is scoped to the
      // GraphQL gateway and uses a different scheme; handing it to another
      // service is how a request gets rejected rather than authenticated.
      // `als.ts` strips the captured one for the same reason.
      token: getAlsToken(),
      clientId: session.clientId,
      clientVersion: session.clientVersion,
      headers: session.headers
    }
  }

  /**
   * Syncs the given stores, re-capturing the session once if ALS refuses.
   *
   * The ALS credential outlives neither the login nor the launcher's own idea
   * of it: it has its own expiry, and it can be revoked server-side with no
   * sign here until a 401 comes back. So a missing token is topped up before
   * asking, and a wholesale refusal buys exactly one silent re-capture and one
   * retry. Exactly one — a headless capture boots the entire GFN web app, and a
   * loop of them behind a button press is worse than the error it is avoiding.
   *
   * A partial refusal is left alone: if one store accepted, the credential is
   * fine and the others failed for reasons of their own.
   */
  async function syncWithRetry(
    session: GfnGraphQLConfig,
    locale: string,
    gfnLinked: boolean,
    providerIds: string[]
  ): Promise<SyncResult[]> {
    let live = session
    if (!getAlsToken()) {
      invalidateSession()
      live = (await ensureSession(locale, gfnLinked)) ?? session
    }

    const run = async (config: AlsConfig): Promise<SyncResult[]> =>
      Promise.all(providerIds.map((providerId) => syncProvider(config, providerId)))

    const config = await alsConfig(live)
    let results = await run(config)
    // Only worth re-capturing if the attempt actually carried a credential.
    // Having just topped one up and come back empty, doing it again buys the
    // same nothing at the price of a second headless boot.
    const refused =
      config.token !== null &&
      results.every((result) => !result.accepted) &&
      results.some((result) => result.status === 401)

    if (refused) {
      console.error(
        `Library sync refused for ${providerIds.join(', ')}; re-capturing the session`
      )
      invalidateSession()
      const fresh = await ensureSession(locale, gfnLinked)
      if (fresh) results = await run(await alsConfig(fresh))
    }

    for (const result of results) {
      // Never the response body: ALS is an authenticated service and its
      // errors have quoted the request back before now.
      if (!result.accepted) {
        console.error(`Library sync failed for ${result.providerId}: status=${result.status}`)
      }
    }

    return results
  }

  ipcMain.handle(
    IPC.librarySync,
    async (_event, providerId: string): Promise<SyncResult> => {
      const { locale, gfnLinked } = await getSettings()
      const session = await ensureSession(locale, gfnLinked)
      if (!session) {
        return { accepted: false, providerId, status: null, error: NOT_CONNECTED }
      }
      const [result] = await syncWithRetry(session, locale, gfnLinked, [providerId])
      // One provider in, one result out; the fallback exists for the type only.
      return result ?? { accepted: false, providerId, status: null, error: 'Sync request failed' }
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

    // An expired or unlinked store has nothing to sync, and a store that does
    // not do library sync at all answers 400; asking either one reports a
    // failure the user cannot act on from here.
    const linked = providers.filter((provider) => provider.state === 'linked')
    if (linked.length === 0) return { results: [], error: 'No linked stores to sync' }

    const syncable = linked.filter((provider) => provider.canSync)
    if (syncable.length === 0) {
      return { results: [], error: 'No connected store supports library sync' }
    }

    return {
      results: await syncWithRetry(
        session,
        locale,
        gfnLinked,
        syncable.map((provider) => provider.id)
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

    try {
      return { ok: true, error: null, game: await patchGame(cmsId, patch) }
    } catch (error) {
      // The mutation itself succeeded — GFN has recorded it — and only mirroring
      // it into the four-megabyte cache failed. Rejecting here would cross the
      // bridge as a rejected promise, which the renderer does not model, and
      // would report a change that did happen as one that did not. The next
      // refresh brings the same answer back from NVIDIA on its own.
      console.error('Store mutation succeeded but the catalogue cache could not be updated:', error)
      return { ok: false, error: 'The change was saved, but this launcher could not record it.', game: null }
    }
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

  /**
   * Bluetooth. Five pulls, no push — see the note on these channels in
   * `@shared/ipc` for why the Devices screen polls rather than subscribing.
   *
   * None of them throws. An unusable adapter, a stopped daemon and a sandbox
   * that was refused the bus all arrive as a snapshot carrying `error`, which
   * is the same posture `status:get` takes: half a screen with a sentence on it
   * beats a rejected promise the renderer does not model.
   */
  ipcMain.handle(IPC.bluetoothGet, async (): Promise<BluetoothSnapshot> => getBluetooth())

  ipcMain.handle(
    IPC.bluetoothScan,
    async (_event, on: unknown): Promise<BluetoothResult> => setScan(on === true)
  )

  ipcMain.handle(
    IPC.bluetoothPower,
    async (_event, on: unknown): Promise<BluetoothResult> => setPowered(on === true)
  )

  ipcMain.handle(
    IPC.bluetoothAct,
    async (_event, action: unknown, address: unknown): Promise<BluetoothResult> => {
      // Both halves validated before either becomes a D-Bus call, the same way
      // `app:power` guards its union. The address is checked for *shape* here
      // and then resolved against main's own mirror in `act`, so a well-formed
      // address for a device the launcher has never seen is still refused.
      if (!isBluetoothAction(action)) {
        console.error(`Refused an unknown Bluetooth action from the renderer: ${String(action)}`)
        return {
          ok: false,
          error: `Unknown Bluetooth action: ${String(action)}`,
          snapshot: await getBluetooth()
        }
      }
      if (!isBluetoothAddress(address)) {
        // The address itself is not echoed: `redactSecrets` would take it out
        // of the log anyway, and repeating a malformed one back adds nothing.
        console.error(`Refused a malformed Bluetooth address from the renderer (${action}).`)
        return {
          ok: false,
          error: 'Malformed device address',
          snapshot: await getBluetooth()
        }
      }
      return act(action, address)
    }
  )

  ipcMain.handle(
    IPC.bluetoothRespond,
    async (_event, accept: unknown): Promise<BluetoothResult> => respondToPairing(accept === true)
  )

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
      // Same reason, plus one this row has to itself: there is no F11 on a
      // sofa, so this toggle is the only way a gamepad can put a launcher that
      // ended up windowed back to fullscreen.
      if (patch.fullscreen !== undefined) setFullscreen(getWindow(), next.fullscreen)
      // Unconditional rather than behind a `patch.pointerDesktop !== undefined`
      // check: the desktop backend reads its settings from a snapshot, because
      // the chord lives inside a 60 Hz tick where nothing may be asynchronous.
      // A snapshot that is only refreshed when the pointer row is touched goes
      // stale the first time the token is written from anywhere else.
      updatePointerSettings(next)
      return next
    }
  )

  /**
   * Whether there is a newer launcher.
   *
   * `force` is validated the way every other payload on this boundary is, even
   * though the worst a forged one could do is skip a cache: the rule is that
   * the channel is where the renderer stops being ours, and an exception with a
   * good excuse is how the rule stops being followed.
   */
  ipcMain.handle(
    IPC.updateCheck,
    async (_event, force: unknown): Promise<UpdateStatus> => getUpdateStatus(force === true)
  )

  /**
   * Installs it, reporting progress to whoever asked.
   *
   * Progress goes to `event.sender` rather than to the main window: it belongs
   * to this request, and a window that navigated away mid-download is not a
   * reason to throw.
   */
  ipcMain.handle(IPC.updateApply, async (event): Promise<UpdateApplyResult> => {
    const result = await applyUpdate((progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.updateProgress, progress)
    })

    // The one operation here that rewrites the launcher's own files, so its
    // outcome is written down whichever way it went.
    if (result.ok) console.info(`Update installed via ${result.command ?? 'unknown command'}.`)
    else console.error(`Update not installed: ${result.error ?? 'no reason given'}`)

    return result
  })

  /**
   * Restarts into the version just installed, or says it could not.
   *
   * The boolean is the whole point of the change. `restartIntoUpdate` refuses
   * rather than quitting whenever it cannot bring the launcher back — a Flatpak
   * with `--talk-name=org.freedesktop.Flatpak` revoked being the case that
   * matters — and a refusal the renderer never heard about leaves the notice
   * counting down to a restart that is not coming, then sitting on
   * "Restarting…" for good.
   */
  ipcMain.handle(IPC.updateRestart, async (): Promise<boolean> => {
    const restarting = await restartIntoUpdate()
    if (!restarting) {
      console.warn('Restart into update refused: this build cannot restart itself.')
    }
    return restarting
  })

  /**
   * What to put in a bug report.
   *
   * Answered here rather than assembled in the renderer because every field is
   * a fact only this process holds, and the log path in particular differs
   * between the Flatpak and everything else. No payload, so nothing to
   * validate — the same arrangement as `app:openDonation`.
   */
  ipcMain.handle(
    IPC.appDiagnostics,
    async (): Promise<Diagnostics> => ({
      logPath: logFilePath(),
      version: app.getVersion(),
      channel: updateChannel(),
      sandboxed: IS_SANDBOXED
    })
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
      console.error(`Refused an unknown power action from the renderer: ${String(action)}`)
      return { ok: false, command: null, error: `Unknown power action: ${String(action)}` }
    }
    // Before it runs, not after: `poweroff` and `reboot` never come back, and a
    // line written afterwards would be a line never written. This is also what
    // tells the next session's log what ended the last one.
    console.info(`Power action requested: ${action}`)
    const result = await runPowerAction(action)
    if (!result.ok) console.warn(`Power action refused: ${result.error ?? 'no reason given'}`)
    return result
  })

  ipcMain.handle(IPC.appOpenDonation, async (): Promise<OpenResult> => {
    // No parameter, deliberately. Everywhere else on this boundary the renderer
    // hands over a value and the main side validates it; here it hands over
    // nothing, and both sides read the same constant. There is no argument to
    // forge, so this is not `openExternal(url)` with a host allow-list bolted
    // on — it is one link that cannot be anything else.
    try {
      await shell.openExternal(DONATION_URL)
      return { ok: true, error: null }
      // On Linux this is `xdg-open`, which on a machine with no registered
      // http handler can exit 0 having done nothing. A rejection is reported;
      // a silent no-op cannot be, which is the other reason the QR code is the
      // primary path and this is the convenience.
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // `on`, not `handle`: nothing comes back. Also the second channel on this
  // boundary with no payload, and for the same reason as `app:openDonation` —
  // there is no argument to forge. The most a renderer could do by shouting
  // this is keep the television on, which is a thing the user can see.
  ipcMain.on(IPC.appPadActivity, () => displayWakeLock.padActivity())

  /**
   * What the kernel says each attached controller is.
   *
   * **No payload, so there is nothing to validate** — the same arrangement as
   * `app:openDonation` and `app:diagnostics`, and written down here so it does
   * not read as the rule being skipped. What goes *out* is a description of
   * hardware, read from `/sys`: no path, no handle, nothing the renderer can
   * turn back into a file. Never throws; a machine with no pad and a sandbox
   * with no `/sys` both answer with an empty list.
   */
  ipcMain.handle(IPC.padList, async (): Promise<PadProfile[]> => listPadProfiles())
}
